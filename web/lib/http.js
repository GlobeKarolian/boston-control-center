/* ============================================================================
   lib/http.js - auth, headers and JSON responses.

   Two completely separate doors, and they must not be confused:

     People  ->  HTTP Basic, one entry per person (AUTH_USERS).
     Macs    ->  Bearer token on /api/ingest only, one token per machine.

   A leaked newsroom password lets someone read the map. A leaked ingest token
   lets someone write to it. That is why they are different secrets with
   different lifetimes, and why revoking one machine does not log out the
   newsroom.

   Neither door does both jobs. Every dashboard route goes through requireRead
   and serves pre-rendered state out of Redis, so a Basic credential can look
   at the map and has no way to change anything on it; writing is the Bearer
   door on /api/ingest and the crons, which are separate secrets. That is what
   makes handing a login to somebody outside the newsroom a small decision
   rather than a large one.
   ========================================================================== */

const users = require('./users.js');

/* Constant-time compare that does not leak length through an early return.
   Lives in users.js now, alongside the table it compares against, and is
   re-exported here because half the codebase imports it from this file. */
const safeEq = users.safeEq;

/* ---- the newsroom door ---------------------------------------------------- */

/* The people door is a table, not a single password.

   One shared login was right while there was one newsroom. It stops being
   right the moment somebody needs in who should not also hold everybody
   else's credential, because then revoking that one person means changing the
   password for all of them, which in practice means nobody is ever revoked.

     AUTH_USERS   a JSON object {"newsroom":"...","RedSox":"..."}, or the
                  short form  name:secret,name:secret
     AUTH_USER    the original single login, still honoured
     AUTH_PASS    its secret

   With none of the three set the site is open, exactly as an empty AUTH_PASS
   used to mean on its own.

   Prefer the JSON form. The short form splits on commas, so a secret
   containing one silently truncates; colons are safe, only the first splits.

   Same shape as tokenTable() below and the same argument for it, but
   deliberately a separate table: reading the map and writing to it are not
   the same permission, and a guest who gets one must not get the other. */
/* The env half of that table only. Logins added from the terminal or the
   admin page live in Redis, because a function on Vercel can read the
   environment it was started with and cannot write to it, so an admin screen
   backed by env vars could never save anything anybody typed into it.

   The merge, and the rule that a stored login wins for any name it lists, are
   in users.js next to the table itself. This is the env reader, moved there
   unchanged and re-exported here because the routes have always imported it
   from this file. */
const userTable = users.envTable;

/* The credentials out of the header, or null when there are none to read.
   Split on the first colon only: a colon is legal inside a secret and is not
   legal inside a username, so the first one is always the separator. */
function parseBasic(req) {
  const h = req.headers.authorization || '';
  if (!/^Basic /i.test(h)) return null;
  let decoded = '';
  try { decoded = Buffer.from(h.slice(6).trim(), 'base64').toString('utf8'); } catch (e) { return null; }
  const i = decoded.indexOf(':');
  if (i < 0) return null;
  return { user: decoded.slice(0, i), secret: decoded.slice(i + 1) };
}

/* Who is at the door?

   Asynchronous now, because half the answer is in Redis. Every caller has to
   await it. A caller that forgets gets a Promise, a Promise is truthy, and a
   truthy answer here means the route opens for anybody who asks. That is the
   one way this change can fail silently, so the call sites were walked as
   part of making it, and test/auth.js asserts on them.

   The comparison itself, the dummy hash that keeps a wrong username costing
   the same as a wrong password, the per-IP throttle and the verify cache are
   all in users.authenticate. They belong beside the table they read rather
   than split across two files where only one of them can see the cache. */
function readAuth(req) {
  const p = parseBasic(req);
  return users.authenticate(p ? p.user : null, p ? p.secret : null, users.clientIp(req));
}

/* The matched name, '' when nothing is configured anywhere and the site is
   open, or null when this request does not get in. */
async function readAuthUser(req) {
  const r = await readAuth(req);
  return r.ok ? r.name : null;
}

async function readAuthOk(req) { return (await readAuthUser(req)) !== null; }

/* One place that turns a refusal into a response, so the read door and the
   admin door cannot drift apart on what they tell a stranger. */
function deny(res, r) {
  if (r.throttled) {
    res.setHeader('Retry-After', String(r.retryAfter || 60));
    /* No Basic challenge on a 429. Re-prompting somebody who is already being
       rate limited just invites them to spend the rest of the window guessing,
       and the browser would happily hand them the box to do it in. */
    res.status(429).send('Too many failed sign-in attempts. Try again in ' + (r.retryAfter || 60) + ' seconds.\n');
    return false;
  }
  if (r.error) {
    /* The stored table could not be read at all. Locking is the only honest
       answer, and saying so beats a password prompt that could not have
       worked no matter what was typed into it. */
    res.status(503).send('Sign-in is temporarily unavailable.\n');
    return false;
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="Boston Newsroom Control Center", charset="UTF-8"');
  res.status(401).send('Authentication required.');
  return false;
}

/* Call at the top of every read route, with await. Returns false when it has
   already answered the request. */
async function requireRead(req, res) {
  harden(res);
  const r = await readAuth(req);
  /* Left on the request so a route that has already been through the gate can
     say who is asking without paying for a second lookup, and so nothing
     downstream is tempted to re-parse the header itself and get it wrong. */
  if (r.ok) { req.bccUser = r.name; return true; }
  return deny(res, r);
}

/* Admin routes. Reading the map and handing somebody else a login are
   different permissions, and the second one is the permission that can give
   away the first, so it is checked separately rather than assumed. */
async function requireAdmin(req, res) {
  harden(res);
  const r = await readAuth(req);
  if (!r.ok) return deny(res, r);
  /* An open site has nobody to be an admin, so the answer is no rather than
     yes. The alternative is that forgetting to configure a password hands the
     account editor to the whole internet, which is the exact failure the
     account editor exists to prevent. */
  if (r.open || !r.name) {
    json(res, { ok: false, error: 'admin access needs a stored login' }, { status: 403 });
    return false;
  }
  if (!users.isAdmin(r.name, r.users)) {
    json(res, { ok: false, error: 'not an admin' }, { status: 403 });
    return false;
  }
  req.bccUser = r.name;
  return true;
}

/* ---- the fleet door ------------------------------------------------------- */

/* Tokens come from either:
     INGEST_TOKENS  a JSON object {"studio-mac":"abc..."} or "studio-mac:abc,spare:def"
     INGEST_SECRET  one token any machine may use
   Per-machine is the right answer for a fleet, because a laptop that walks out
   of the building can be revoked without touching the others. The shared one
   exists so a first install works before you have decided on names. */
function tokenTable() {
  const raw = (process.env.INGEST_TOKENS || '').trim();
  if (!raw) return {};
  if (raw.startsWith('{')) { try { return JSON.parse(raw); } catch (e) { return {}; } }
  const out = {};
  for (const pair of raw.split(',')) {
    const i = pair.indexOf(':');
    if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
}

function ingestAuth(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return { ok: false, why: 'missing bearer token' };
  const presented = m[1].trim();
  const claimed = String(req.headers['x-bcc-machine'] || '').trim() || 'unnamed';

  const table = tokenTable();
  const names = Object.keys(table);
  if (names.length) {
    // Check every entry rather than looking up the claimed name, so a machine
    // cannot skip its own token by lying in the header.
    for (const name of names) {
      if (table[name] && safeEq(presented, table[name])) return { ok: true, machine: name };
    }
  }
  const shared = (process.env.INGEST_SECRET || '').trim();
  if (shared && safeEq(presented, shared)) return { ok: true, machine: claimed };

  if (!names.length && !shared) return { ok: false, why: 'server has no INGEST_TOKENS or INGEST_SECRET configured' };
  return { ok: false, why: 'token not recognised' };
}

/* ---- responses ------------------------------------------------------------ */

function harden(res) {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

/* swr: how long the CDN may serve this to the newsroom before asking again.
   The dashboard polls on a timer and a dozen people watching the same incident
   should not become a dozen Redis reads per tick. */
// swr  -> shared CDN cache. ONLY for routes with no Basic auth on them.
// priv -> browser-only cache. Use this for anything behind auth.
//
// This distinction is load-bearing. Vercel's CDN keys its cache on the URL,
// not on the Authorization header, so putting s-maxage on an auth-gated route
// would let the CDN serve a cached 200 to a stranger who never reached the
// function that checks the password.
function json(res, body, { swr = 0, priv = 0, status = 200 } = {}) {
  harden(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (swr > 0) {
    res.setHeader('Cache-Control', 's-maxage=' + swr + ', stale-while-revalidate=' + (swr * 6));
  } else if (priv > 0) {
    res.setHeader('Cache-Control', 'private, max-age=' + priv + ', stale-while-revalidate=' + (priv * 4));
  } else {
    res.setHeader('Cache-Control', 'no-store');
  }
  res.status(status).send(typeof body === 'string' ? body : JSON.stringify(body));
}

/* Cron routes. Vercel signs its own cron requests; anything else needs the
   secret. Without this a stranger can make you pay for a BestTime sweep. */
function cronAuth(req) {
  const secret = (process.env.CRON_SECRET || '').trim();
  if (!secret) return true;                    // not configured: Vercel's own header is the only gate
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (m && safeEq(m[1].trim(), secret)) return true;
  const q = req.query && req.query.key;
  return !!(q && safeEq(String(q), secret));
}

module.exports = {
  readAuthOk, readAuthUser, userTable, requireRead, requireAdmin,
  parseBasic, users,
  ingestAuth, cronAuth, json, harden, safeEq,
};
