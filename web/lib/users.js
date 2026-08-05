/* ============================================================================
   lib/users.js - the people who may look at the map, and where they live.

   Logins used to be a Vercel environment variable. That meant adding one
   person was a dashboard visit, a redeploy, and a wait, and it meant no page
   in this app could ever manage its own users, because a function cannot
   write to the environment it was started with. An admin screen backed by
   env vars is not a hard problem, it is an impossible one.

   So the table lives in Redis, next to everything else this app keeps, and
   /admin edits it while the site is running. AUTH_USERS and AUTH_PASS are
   still honoured and still checked, because a store that must be populated
   before anyone can log in is a store nobody can populate.

   What is written is a scrypt hash, never the secret. That matters more here
   than it did in an env var: the Redis credentials are handed to every
   function, get copied into .env.local, and get pasted into terminals, and a
   database of recoverable newsroom passwords is a far worse thing to leak
   than a database of hashes. It also means this module cannot hand a password
   back to anybody, including whoever is looking at the admin page. That is
   the intended behaviour and not a missing feature.
   ========================================================================== */

const crypto = require('crypto');
const kv = require('./kv');

const KEY = 'bcc:users';                 // Redis hash: name -> JSON record

/* Eight is the floor, not the advice. It is here because this dashboard sits
   on the open internet in front of live police and fire traffic, and a
   four-character login is not a lock. Change this one number if you disagree;
   nothing else in the file depends on it. */
const MIN_SECRET = 8;

/* ---- hashing --------------------------------------------------------------

   scrypt, with the parameters written into every record rather than assumed.
   Raising them later then costs nothing: old records keep verifying against
   the numbers they were made with, and each one moves up the next time its
   secret is set. A hash format that hardcodes its own cost is a hash format
   you can never make more expensive. */

const SCRYPT = { N: 16384, r: 8, p: 1, len: 32 };
const MAXMEM = 128 * 1024 * 1024;

function hash(secret) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(secret), salt, SCRYPT.len,
    { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: MAXMEM });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p,
    salt.toString('base64'), dk.toString('base64')].join('$');
}

/* A well-formed record that nothing can ever match, built without running
   scrypt so it costs nothing at module load. An unknown username is verified
   against this, so a wrong name and a wrong secret take the same time and the
   login form cannot be used to enumerate who works here. */
const DUMMY = ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p,
  crypto.randomBytes(16).toString('base64'),
  crypto.randomBytes(SCRYPT.len).toString('base64')].join('$');

function verifyHash(secret, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
  /* Cost comes out of the record, so it is attacker-controlled the moment
     anyone can write to Redis. Bounded here so a doctored record cannot turn
     one login attempt into a memory exhaustion. */
  if (!(N >= 2 && N <= 1048576 && r >= 1 && r <= 32 && p >= 1 && p <= 16)) return false;
  const salt = Buffer.from(parts[4], 'base64');
  const want = Buffer.from(parts[5], 'base64');
  if (salt.length < 8 || want.length < 16) return false;
  let got;
  try { got = crypto.scryptSync(String(secret), salt, want.length, { N, r, p, maxmem: MAXMEM }); }
  catch (e) { return false; }
  return crypto.timingSafeEqual(got, want);
}

/* ---- the verify cache -----------------------------------------------------

   scrypt is deliberately slow, and Basic auth re-sends the credential on every
   single request. The dashboard polls /api/state every few seconds per open
   tab, so without this a newsroom of six people would burn most of a CPU doing
   nothing but re-deriving the same six keys.

   Two properties make this safe:

   Only successes are cached. A wrong secret pays the full cost every time it
   is tried, which is the right way round: ordinary polling is nearly free and
   guessing is not.

   The key includes the stored hash, so an entry answers "does this secret
   match this exact hash" and nothing else. Change somebody's secret or delete
   them and every cached answer about them is unreachable by construction,
   rather than correct-until-a-timer-expires. Revocation is then only as slow
   as the table cache below, and there is no window where a deleted user is
   still admitted by a warm instance. */

const VC = new Map();
const VC_TTL_MS = 5 * 60 * 1000;
const VC_MAX = 500;

const vcKey = (secret, stored) => crypto.createHash('sha256')
  .update(String(stored)).update('\0').update(String(secret)).digest('base64');

/* Has this exact pair already been accepted recently? Asked separately from
   verify so the caller can tell an ordinary poll from an attempt, and charge
   the throttle for one and not the other. No I/O and no derivation: it is a
   Map lookup, and answering it wrongly only costs a throttle check. */
function warm(secret, stored) {
  if (!stored) return false;
  const exp = VC.get(vcKey(secret, stored));
  return !!(exp && exp > Date.now());
}

function verify(secret, stored) {
  if (!stored) return false;
  const k = vcKey(secret, stored);
  const now = Date.now();
  const exp = VC.get(k);
  if (exp && exp > now) return true;
  const ok = verifyHash(secret, stored);
  if (ok) {
    if (VC.size >= VC_MAX) VC.clear();   // a bound, not an eviction policy
    VC.set(k, now + VC_TTL_MS);
  }
  return ok;
}

/* ---- the table ------------------------------------------------------------

   Cached in the process for a few seconds. A warm Vercel instance serves many
   requests, and one Redis read per poll per viewer is a cost with nothing to
   show for it. The cost of the cache is that revoking somebody can take up to
   TTL to reach an instance that is already warm, which for a viewer login is
   the right trade. Every mutation below clears it locally, so the instance
   doing the revoking is correct immediately.

   A read failure returns the last good table rather than an empty one. Redis
   being briefly unreachable must not log the newsroom out mid-incident. When
   there is no last good table the error is reported rather than swallowed,
   because the caller has to be able to tell "no users are configured", which
   means the site is open, apart from "I could not find out", which must not. */

let TABLE = null, TABLE_AT = 0;
const TABLE_TTL_MS = 10000;

async function load(force) {
  const now = Date.now();
  if (!force && TABLE && now - TABLE_AT < TABLE_TTL_MS) return { users: TABLE, error: null };
  let raw;
  try {
    raw = await kv.hgetall(KEY);
  } catch (e) {
    const why = String(e.message || e).slice(0, 160);
    if (TABLE) return { users: TABLE, error: null, stale: true };
    return { users: {}, error: why };
  }
  const out = {};
  for (const name of Object.keys(raw || {})) {
    let rec = null;
    try { rec = JSON.parse(raw[name]); } catch (e) { continue; }   // corrupt row: not a login
    if (rec && typeof rec.h === 'string' && rec.h) out[name] = rec;
  }
  TABLE = out; TABLE_AT = now;
  return { users: out, error: null };
}

const forget = () => { TABLE = null; TABLE_AT = 0; };

/* ---- names ----------------------------------------------------------------

   Basic auth packs the credential as "name:secret" and splits on the first
   colon, so a name containing one can never be presented and the login would
   be created broken. Rejected here, loudly, rather than accepted and puzzled
   over later. Whitespace and control characters go the same way: a login
   nobody can type accurately is not a login. */
function cleanName(name) {
  const n = String(name == null ? '' : name).trim();
  if (!n) throw new Error('a username is required');
  if (n.length > 60) throw new Error('username is too long (60 characters max)');
  if (n.includes(':')) throw new Error('a username cannot contain a colon: HTTP Basic auth splits on it');
  if (/[\s\x00-\x1f\x7f]/.test(n)) throw new Error('a username cannot contain spaces or control characters');
  return n;
}

/* ---- who may administer ---------------------------------------------------

   Two sources, and the store wins for any name it lists, which is the same
   precedence the secrets themselves use. Without that rule a name could be
   demoted in the store and stay an admin through the environment, which is
   exactly the kind of quiet contradiction that makes a permission system
   untrustworthy.

   ADMIN_USERS names the administrators. Unset, it is the single legacy login,
   which is what makes this work on Matt's deployment without touching
   anything: he is already newsroom, so he is already the admin. */
function adminNames() {
  const raw = (process.env.ADMIN_USERS || '').trim();
  if (!raw) return [(process.env.AUTH_USER || 'newsroom').trim()].filter(Boolean);
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function isAdmin(name, users) {
  if (!name) return false;
  const rec = users && users[name];
  if (rec) return !!rec.admin && !expired(rec);
  return adminNames().indexOf(name) >= 0;
}

/* ---- when a login lapses --------------------------------------------------

   A guest login should be able to die on its own. Somebody who is here for a
   week gets a week, and nobody has to remember to take it away afterwards,
   because remembering is the part that never happens.

   No expiry means no expiry: a record without the field is permanent, which
   is what every existing record is. An unparseable date is treated the same
   way rather than as expired, so a typo locks nobody out. That is the safe
   direction here, because the account still has a real secret in front of it
   and a bad date is a mistake, not an attack. */
function expired(rec) {
  if (!rec || !rec.expires) return false;
  const t = Date.parse(rec.expires);
  return Number.isFinite(t) && t <= Date.now();
}

/* Turns whatever a caller offers into a stored ISO date, or null for never.
   A number is days from now, because that is how the request actually arrives
   ("give him a week"); a string is a date. A date already in the past is
   refused rather than stored, since writing an expiry that has already
   happened is always a mistake and produces a login that is dead the moment
   it is created. */
function parseExpires(input) {
  if (input === null || input === '' || input === false) return null;
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input <= 0) throw new Error('an expiry in days must be a positive number');
    return new Date(Date.now() + input * 86400000).toISOString();
  }
  const t = Date.parse(String(input));
  if (!Number.isFinite(t)) throw new Error('cannot read that as a date: ' + String(input));
  if (t <= Date.now()) throw new Error('that expiry has already passed');
  return new Date(t).toISOString();
}

/* Everything the admin page is allowed to know about somebody. Note what is
   absent: there is no field here that could carry a secret, so no future
   caller can leak one by forgetting to strip it. */
const summary = (name, rec) => ({
  name,
  admin: !!rec.admin,
  note: String(rec.note || ''),
  added: rec.added || null,
  changed: rec.changed || null,
  by: rec.by || null,
  seen: rec.seen || null,
  expires: rec.expires || null,
  expired: expired(rec),
});

async function list() {
  const { users, error } = await load(true);
  if (error) throw new Error(error);
  return Object.keys(users).sort((a, b) => a.localeCompare(b)).map(n => summary(n, users[n]));
}

/* ---- the environment table ------------------------------------------------

   The original way of configuring logins, still supported and still checked.
   It lives here rather than in http.js so that this module owns the whole
   question of who may log in, and so that http.js can require this file
   without the two requiring each other.

     AUTH_USERS   a JSON object {"newsroom":"..."} or the short form
                  name:secret,name:secret
     AUTH_USER    the original single login
     AUTH_PASS    its secret

   Prefer the JSON form. The short form splits on commas, so a secret
   containing one silently truncates; colons are safe, only the first splits.
   Better still, prefer the store: these are plaintext in a dashboard that
   several people can read, and they cannot be changed without a redeploy. */

/* Constant-time compare that does not leak length through an early return.
   Defined here because the env table needs it; http.js re-exports it so the
   fleet and cron doors can go on using it from where they always did. */
function safeEq(a, b) {
  const A = crypto.createHash('sha256').update(String(a)).digest();
  const B = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(A, B);
}

function envTable() {
  const out = {};
  const raw = (process.env.AUTH_USERS || '').trim();
  if (raw.startsWith('{')) {
    try { Object.assign(out, JSON.parse(raw)); } catch (e) { /* malformed: handled below */ }
  } else if (raw) {
    for (const pair of raw.split(',')) {
      const i = pair.indexOf(':');
      if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    }
  }
  /* The original login, added only when the table does not already name it,
     so moving somebody into AUTH_USERS is how you change their secret rather
     than something that leaves the old one quietly working. */
  const user = (process.env.AUTH_USER || 'newsroom').trim();
  const pass = process.env.AUTH_PASS || '';
  if (pass && !out[user]) out[user] = pass;
  /* An entry with an empty secret is a configuration slip. Dropped here, where
     it is one line, rather than special-cased in the compare, where it would
     be one more thing to get right under a constant-time constraint. */
  for (const k of Object.keys(out)) if (!k || !String(out[k] || '')) delete out[k];
  /* A typo in AUTH_USERS must not open the site. An unset AUTH_USERS means
     "no password yet", which is a first install and is allowed to be open. A
     set one that parsed to nothing means somebody dropped a brace, and
     treating those two the same would take the door off its hinges on a
     deploy nobody thought was risky. So configured-but-broken locks rather
     than opens, and it locks with a value that cannot be presented: a name no
     header can carry and a secret generated per call. */
  if (raw && !Object.keys(out).length) out[' unparsed'] = crypto.randomBytes(32).toString('hex');
  return out;
}

/* ---- the actual question --------------------------------------------------

   Returns { ok, name, open, users }. `name` is who they are, `open` means no
   login is configured anywhere and the site is deliberately unlocked.

   On timing. The store is looked up by name and then verified against exactly
   one hash, real or the dummy above, so a username that exists and one that
   does not cost the same scrypt. Verifying against every record instead would
   also be constant time but would multiply the cost of every login by the
   size of the newsroom, and would make adding a colleague slow down the site.
   The env table is still compared entry by entry with no early exit, because
   those comparisons are hashes rather than key derivations and cost nothing.

   The one thing deliberately not equalised is the shape of the request: no
   Authorization header at all returns immediately. That leaks nothing, since
   the client already knows whether it sent one. */
async function authenticate(user, secret, ip) {
  const store = await load();
  const env = envTable();
  const envNames = Object.keys(env);
  const storeNames = Object.keys(store.users);

  if (!storeNames.length && !envNames.length) {
    /* Nothing configured. Either this is a first install and the site is
       meant to be open, or Redis is unreachable and we have no idea. Those
       must not look the same, so an unreadable store denies. */
    if (store.error) return { ok: false, name: null, users: store.users, error: store.error };
    return { ok: true, name: '', open: true, users: store.users };
  }

  /* Nothing presented. Answered without a derivation, because otherwise any
     stranger could spend sixteen megabytes and sixty milliseconds of this
     function per request without ever guessing at a password. */
  if (user === null || user === undefined) {
    return { ok: false, name: null, users: store.users };
  }

  const rec = store.users[user] || null;

  /* A credential this instance accepted in the last few minutes is somebody's
     browser polling the map, not somebody guessing, so it skips the throttle
     entirely. Everything else pays a Redis read before it is allowed to cost
     a key derivation, which is what makes the limit a real ceiling on work
     rather than a counter that notices afterwards. */
  const repeat = !!rec && warm(secret, rec.h);
  const g = repeat || !ip ? null : await gate(ip);
  if (g && g.blocked) {
    return { ok: false, name: null, users: store.users, throttled: true, retryAfter: g.retryAfter };
  }

  /* An expired login is still verified, against its real hash, and only then
     discarded. Skipping the derivation would make "this account expired" and
     "this account never existed" tell themselves apart by the clock. */
  const live = !!rec && !expired(rec);
  const okStore = verify(secret, rec ? rec.h : DUMMY) && live;

  let okEnv = false;
  for (const name of envNames) {
    const okU = safeEq(user, name);
    const okP = safeEq(secret, env[name]);
    if (okU && okP) okEnv = true;
  }
  if (rec) okEnv = false;          // the store is authoritative for names it lists

  const ok = okStore || okEnv;
  if (ok && rec) touch(user, rec);
  /* Counted after the fact and never awaited on the way in. A wrong answer
     costs the guesser a write; a right one clears the slate, but only on the
     first acceptance, so a polling dashboard is not issuing a DEL every three
     seconds for the rest of the afternoon. */
  if (ip) {
    if (!ok) noteFail(ip);
    else if (!repeat && g && g.count) clearFails(ip);
  }
  return { ok, name: ok ? user : null, users: store.users };
}

/* Last-seen, written at most once a day and never on the critical path. It
   exists to answer the only question that matters when you are deciding
   whether to revoke a guest: has this login ever actually been used. */
const TOUCHED = new Set();
const TOUCH_EVERY_MS = 12 * 60 * 60 * 1000;
function touch(name, rec) {
  if (TOUCHED.has(name)) return;
  const last = rec.seen ? Date.parse(rec.seen) : 0;
  if (last && Date.now() - last < TOUCH_EVERY_MS) return;
  TOUCHED.add(name);
  const next = { ...rec, seen: new Date().toISOString() };
  Promise.resolve()
    .then(() => kv.hset(KEY, name, JSON.stringify(next)))
    .catch(() => { TOUCHED.delete(name); });   // best effort: never fail a login over a timestamp
}

/* ---- changing the table ---------------------------------------------------

   Every mutation first asks what the table would look like afterwards and
   refuses if the answer is a building with no key. Locking yourself out of
   your own admin page is recoverable only by going back to the Vercel
   dashboard and redeploying, which is the exact errand this whole file exists
   to abolish. */

function usableAdmins(users, env) {
  const out = new Set();
  /* Expired counts as gone. An admin whose login lapsed on Tuesday is not a
     way back into the dashboard, and treating it as one is how a deployment
     ends up with an admin list full of people who cannot log in. */
  for (const n of Object.keys(users)) if (users[n] && users[n].admin && !expired(users[n])) out.add(n);
  /* An environment admin only counts if it is not shadowed by a store record
     and it actually has a secret to log in with. A name in ADMIN_USERS that
     cannot authenticate is not a way back in. */
  for (const n of adminNames()) if (!users[n] && env[n]) out.add(n);
  return out;
}

function assertAdminsRemain(users, name, next) {
  const after = Object.assign({}, users);
  if (next === null) delete after[name];
  else after[name] = Object.assign({}, users[name] || { h: 'x' }, { admin: next });
  if (usableAdmins(after, envTable()).size) return;
  throw new Error('that would leave nobody able to reach /admin. Make somebody else an admin first, or set ADMIN_USERS.');
}

async function fresh() {
  const { users, error } = await load(true);
  if (error) throw new Error('cannot reach the user store: ' + error);
  return users;
}

async function put(name, secret, opts = {}) {
  const n = cleanName(name);
  const s = String(secret == null ? '' : secret);
  if (s.length < MIN_SECRET) throw new Error('the secret must be at least ' + MIN_SECRET + ' characters');
  const users = await fresh();
  const cur = users[n] || null;
  const admin = opts.admin === undefined ? !!(cur && cur.admin) : !!opts.admin;
  if (cur && cur.admin && !admin) assertAdminsRemain(users, n, false);
  const rec = {
    h: hash(s),
    admin,
    note: String((opts.note === undefined ? (cur && cur.note) : opts.note) || '').slice(0, 120),
    added: (cur && cur.added) || new Date().toISOString(),
    changed: new Date().toISOString(),
    by: String(opts.by || '').slice(0, 60),
    seen: (cur && cur.seen) || null,
    /* Undefined leaves the expiry where it was, so changing somebody's secret
       does not silently extend their stay. Passing null is how you say the
       login is permanent now, and it has to be said out loud. */
    expires: opts.expires === undefined ? ((cur && cur.expires) || null) : parseExpires(opts.expires),
  };
  await kv.hset(KEY, n, JSON.stringify(rec));
  forget();
  return { created: !cur, user: summary(n, rec) };
}

async function setAdmin(name, admin, by) {
  const n = cleanName(name);
  const users = await fresh();
  const cur = users[n];
  if (!cur) throw new Error('no stored login named ' + n);
  if (!admin) assertAdminsRemain(users, n, false);
  const rec = Object.assign({}, cur, { admin: !!admin, changed: new Date().toISOString(), by: String(by || '').slice(0, 60) });
  await kv.hset(KEY, n, JSON.stringify(rec));
  forget();
  return summary(n, rec);
}

/* Changing when a login lapses without touching the secret, so extending a
   guest by a week does not mean issuing them a new one. Handing an admin an
   expiry is allowed, but only while somebody else can still get in after it
   passes, which is the same question every other mutation here asks. */
async function setExpires(name, expires, by) {
  const n = cleanName(name);
  const users = await fresh();
  const cur = users[n];
  if (!cur) throw new Error('no stored login named ' + n);
  const at = parseExpires(expires === undefined ? null : expires);
  if (cur.admin && at) assertAdminsRemain(users, n, false);
  const rec = Object.assign({}, cur, { expires: at, changed: new Date().toISOString(), by: String(by || '').slice(0, 60) });
  await kv.hset(KEY, n, JSON.stringify(rec));
  forget();
  return summary(n, rec);
}

async function remove(name) {
  const n = cleanName(name);
  const users = await fresh();
  if (!users[n]) throw new Error('no stored login named ' + n + '. Logins set through AUTH_USERS are removed in Vercel, not here.');
  assertAdminsRemain(users, n, null);
  await kv.hdel(KEY, n);
  forget();
  return { removed: n };
}

/* ---- slowing down guessing ------------------------------------------------

   There was nothing in front of this login before, which meant a short secret
   was worth roughly as much as no secret. Twelve wrong answers from one
   address in ten minutes and that address stops being answered.

   Counted per address only, never per username. A per-username lockout sounds
   stricter and is worse: anybody who knows Matt logs in as `newsroom` could
   then lock him out of his own dashboard from a cafe, on purpose, forever. A
   defence that hands strangers a switch labelled "turn off the newsroom" is
   not a defence.

   The window slides on each failure, so patience does not earn a fresh twelve.
   And the address is hashed rather than stored, because a list of who has been
   reading a police scanner is not something worth keeping.

   This does not stop a distributed attempt from many addresses. It is a speed
   bump on the cheapest attack, not a wall, and the length of the secret is
   still what actually protects the site. */

const FAIL_WINDOW_S = 600;
const FAIL_MAX = 12;
const failKey = ip => 'bcc:authfail:' + crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 24);

/* Vercel's own headers first. The plain x-forwarded-for can be set by whoever
   is calling, so trusting it would let an attacker get a clean slate per
   request by making one up. */
function clientIp(req) {
  const h = (req && req.headers) || {};
  const first = v => String(v || '').split(',')[0].trim();
  return first(h['x-vercel-forwarded-for']) || first(h['x-real-ip']) ||
         String(h['x-forwarded-for'] || '').split(',').pop().trim() || 'unknown';
}

/* A Redis blip must not lock the newsroom out: the throttle fails open, since
   it is a speed bump on top of a lock rather than the lock itself. */
async function gate(ip) {
  let n = 0;
  try { n = Number(await kv.get(failKey(ip))) || 0; } catch (e) { return { blocked: false, count: 0, retryAfter: 0 }; }
  return { blocked: n >= FAIL_MAX, count: n, retryAfter: FAIL_WINDOW_S };
}

async function noteFail(ip) {
  const k = failKey(ip);
  try { await kv.raw([['INCR', k], ['EXPIRE', k, FAIL_WINDOW_S]]); } catch (e) { /* best effort */ }
}

async function clearFails(ip) {
  try { await kv.del(failKey(ip)); } catch (e) { /* best effort */ }
}

module.exports = {
  KEY, MIN_SECRET, FAIL_MAX, FAIL_WINDOW_S,
  hash, verify, safeEq,
  load, forget, list, put, setAdmin, setExpires, remove,
  envTable, adminNames, isAdmin, cleanName, authenticate,
  expired, parseExpires,
  clientIp, gate, noteFail, clearFails,
};
