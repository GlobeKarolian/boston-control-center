/* ============================================================================
   test/auth.js - the login door, checked the way it can actually break.

   Run: node test/auth.js        (no Redis needed; kv falls back to memory)

   The interesting failures here are not "wrong password gets in". They are the
   quiet ones:

     A route that forgets to await requireRead. The call returns a Promise,
     every Promise is truthy, and that route is then open to the internet while
     looking exactly like the routes that are not. Checked by reading the
     sources, because no request to a correct route can reveal it.

     A plaintext secret reaching disk or a response. Checked by looking for the
     actual string in what comes back.

     The admin door answering yes to somebody who only has a read login, or to
     everybody at once because nothing was configured.

     A cross-site form post arriving with the browser's own Basic credentials
     already attached to it.
   ========================================================================== */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

process.env.AUTH_USERS = '';
process.env.AUTH_USER = 'newsroom';
process.env.AUTH_PASS = 'the-env-password';

const http = require(path.join(ROOT, 'lib', 'http.js'));
const users = require(path.join(ROOT, 'lib', 'users.js'));
const kv = require(path.join(ROOT, 'lib', 'kv.js'));

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '\n          ' + detail : '')); }
};
const section = s => console.log('\n=== ' + s + ' ===');

/* ---- fakes ---------------------------------------------------------------- */

function req(opts = {}) {
  const h = Object.assign({}, opts.headers || {});
  if (opts.user !== undefined && opts.user !== null) {
    h.authorization = 'Basic ' + Buffer.from(opts.user + ':' + (opts.secret || '')).toString('base64');
  }
  if (opts.ip) h['x-real-ip'] = opts.ip;
  const r = {
    headers: h,
    method: opts.method || 'GET',
    url: opts.url || '/admin',
    query: opts.query || {},
    body: opts.body,
  };
  /* api/admin.js can read the body as a stream when Vercel has not parsed it. */
  r[Symbol.asyncIterator] = async function* () { if (opts.raw) yield Buffer.from(opts.raw); };
  return r;
}

function res() {
  const r = { code: 0, headers: {}, body: '', ended: false };
  r.setHeader = (k, v) => { r.headers[String(k).toLowerCase()] = v; };
  r.getHeader = k => r.headers[String(k).toLowerCase()];
  r.status = c => { r.code = c || 200; return r; };
  r.send = b => { r.body = typeof b === 'string' ? b : String(b); r.ended = true; return r; };
  return r;
}

const json = r => { try { return JSON.parse(r.body); } catch (e) { return null; } };

/* ---- 1. every read route awaits its gate ---------------------------------- */

function callSites() {
  const skip = new Set(['node_modules', '.git', '.vercel', 'test']);
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) {
        fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
          if (/\b(requireRead|requireAdmin)\s*\(/.test(line) && !/^\s*(async\s+)?function\s/.test(line)) {
            out.push({ file: path.relative(ROOT, p), line: i + 1, text: line.trim() });
          }
        });
      }
    }
  })(ROOT);
  return out;
}

section('1. the gate is awaited everywhere it is called');
const sites = callSites();
ok('found the call sites at all', sites.length >= 6, 'found ' + sites.length);
for (const s of sites) {
  ok(s.file + ':' + s.line + ' awaits it',
    /await\s+require(Read|Admin)\s*\(/.test(s.text),
    s.text + '\n          A missing await returns a Promise, and a Promise is truthy, so this route would be open.');
}

/* ---- the rest runs async -------------------------------------------------- */

(async () => {

  section('2. the env table, which is how production is configured today');
  ok('right credential gets in',       await http.readAuthUser(req({ user: 'newsroom', secret: 'the-env-password', ip: '1.0.0.1' })) === 'newsroom');
  ok('wrong secret refused',           await http.readAuthUser(req({ user: 'newsroom', secret: 'nope', ip: '1.0.0.2' })) === null);
  ok('unknown name refused',           await http.readAuthUser(req({ user: 'ghost', secret: 'the-env-password', ip: '1.0.0.3' })) === null);
  ok('no header refused',              await http.readAuthUser(req({ ip: '1.0.0.4' })) === null);
  ok('malformed header refused',       await http.readAuthUser(req({ headers: { authorization: 'Basic !!!!' }, ip: '1.0.0.5' })) === null);
  ok('bearer at the people door refused',
     await http.readAuthUser(req({ headers: { authorization: 'Bearer abc' }, ip: '1.0.0.6' })) === null);

  {
    const r = res();
    ok('a refusal is a 401 with a challenge',
      (await http.requireRead(req({ user: 'newsroom', secret: 'x', ip: '1.0.0.7' }), r)) === false &&
      r.code === 401 && /^Basic realm=/.test(r.headers['www-authenticate'] || ''));
  }

  section('3. a configured-but-broken table locks rather than opens');
  process.env.AUTH_USERS = '{"broken": ';       // somebody dropped a brace
  ok('unparseable AUTH_USERS refuses everyone',
     await http.readAuthUser(req({ user: 'broken', secret: 'anything', ip: '1.0.1.1' })) === null);
  ok('  ...and does not fall back to open',
     await http.readAuthUser(req({ ip: '1.0.1.2' })) === null);
  process.env.AUTH_USERS = '';

  section('4. the store, and its precedence over the environment');
  const GUEST = 'guest-secret-1234';
  await users.put('RedSox', GUEST, { note: 'a friend', by: 'test' });
  ok('a stored login gets in',         await http.readAuthUser(req({ user: 'RedSox', secret: GUEST, ip: '2.0.0.1' })) === 'RedSox');
  ok('one character off is refused',   await http.readAuthUser(req({ user: 'RedSox', secret: 'guest-secret-1233', ip: '2.0.0.2' })) === null);

  await users.put('newsroom', 'moved-into-the-store', { admin: true, by: 'test' });
  ok('the store shadows the env secret',
     await http.readAuthUser(req({ user: 'newsroom', secret: 'the-env-password', ip: '2.0.0.3' })) === null);
  ok('  ...and the stored secret works',
     await http.readAuthUser(req({ user: 'newsroom', secret: 'moved-into-the-store', ip: '2.0.0.4' })) === 'newsroom');

  section('5. nothing anywhere holds the plaintext');
  const rec = (await users.list()).find(u => u.name === 'RedSox');
  ok('the summary carries no secret field', rec && !JSON.stringify(rec).includes(GUEST), JSON.stringify(rec));
  const dump = JSON.stringify(await users.load(true));
  ok('the stored record is a hash, not the secret', !dump.includes(GUEST));
  ok('  ...and it looks like scrypt', /scrypt\$\d+\$\d+\$\d+\$/.test(dump));

  section('6. expiry');
  await users.setExpires('RedSox', 1.5 / 86400, 'test');            // a second and a half
  ok('a live login still works',       await http.readAuthUser(req({ user: 'RedSox', secret: GUEST, ip: '3.0.0.1' })) === 'RedSox');
  await new Promise(s => setTimeout(s, 1700));
  ok('an expired login is refused',    await http.readAuthUser(req({ user: 'RedSox', secret: GUEST, ip: '3.0.0.2' })) === null);
  const back = (await users.list()).find(u => u.name === 'RedSox');
  ok('  ...and the list says so plainly', back && back.expired === true);
  await users.setExpires('RedSox', null, 'test');
  ok('  ...and it can be brought back', await http.readAuthUser(req({ user: 'RedSox', secret: GUEST, ip: '3.0.0.3' })) === 'RedSox');

  section('7. the admin door is not the read door');
  {
    let r = res();
    ok('an admin gets through',
      (await http.requireAdmin(req({ user: 'newsroom', secret: 'moved-into-the-store', ip: '4.0.0.1' }), r)) === true);

    r = res();
    ok('a read-only login gets 403, not 401',
      (await http.requireAdmin(req({ user: 'RedSox', secret: GUEST, ip: '4.0.0.2' }), r)) === false && r.code === 403);
    ok('  ...and is told why without a password box',
      !(r.headers['www-authenticate']) && /not an admin/.test(r.body));

    r = res();
    ok('a stranger gets 401 from the admin door',
      (await http.requireAdmin(req({ user: 'RedSox', secret: 'wrong', ip: '4.0.0.3' }), r)) === false && r.code === 401);
  }

  section('8. the door cannot be closed on the last way in');
  const refuses = async fn => { try { await fn(); return ''; } catch (e) { return String(e.message || e); } };

  /* Two changes that look equally dangerous and are not, which is the whole
     point of checking both.

     Demoting the stored newsroom record leaves nobody, because a stored record
     shadows the environment one, so the AUTH_PASS in Vercel would no longer
     work either. Removing that record leaves the environment login, which
     starts working again the moment the store stops naming it. Getting these
     two the same way round would either lock Matt out of his own dashboard or
     let him think he was locked out when he was not. */
  ok('demoting the last stored admin is refused',
     !!(await refuses(() => users.setAdmin('newsroom', false, 'test'))));

  ok('removing it is allowed, because the env login is the way back',
     !(await refuses(() => users.remove('newsroom'))));
  ok('  ...and the env password does start working again',
     await http.readAuthUser(req({ user: 'newsroom', secret: 'the-env-password', ip: '8.0.0.1' })) === 'newsroom');
  {
    const r = res();
    ok('  ...and it reaches the admin page',
      (await http.requireAdmin(req({ user: 'newsroom', secret: 'the-env-password', ip: '8.0.0.2' }), r)) === true);
  }

  /* Now take the environment away, so the store is the only way in and the
     protection has to hold on its own. */
  await users.put('newsroom', 'moved-into-the-store', { admin: true, by: 'test' });
  const KEPT = { user: process.env.AUTH_USER, pass: process.env.AUTH_PASS };
  process.env.AUTH_USER = ''; process.env.AUTH_PASS = '';
  ok('with no env login, removing the last admin is refused',
     !!(await refuses(() => users.remove('newsroom'))));
  ok('  ...and so is demoting it',
     !!(await refuses(() => users.setAdmin('newsroom', false, 'test'))));
  ok('  ...and so is expiring it out of existence',
     !!(await refuses(() => users.setExpires('newsroom', 1, 'test'))));
  process.env.AUTH_USER = KEPT.user; process.env.AUTH_PASS = KEPT.pass;

  ok('the admin still works afterwards',
     await http.readAuthUser(req({ user: 'newsroom', secret: 'moved-into-the-store', ip: '8.0.0.3' })) === 'newsroom');

  section('9. the per-address throttle');
  {
    const IP = '9.9.9.9';
    let blocked = 0, seen = 0;
    for (let i = 0; i < users.FAIL_MAX + 4; i++) {
      const r = res();
      await http.requireRead(req({ user: 'newsroom', secret: 'guess-' + i, ip: IP }), r);
      seen++;
      if (r.code === 429) blocked++;
    }
    ok('guessing from one address gets cut off', blocked > 0, blocked + ' of ' + seen + ' refused with 429');
    const r = res();
    await http.requireRead(req({ user: 'newsroom', secret: 'guess-again', ip: IP }), r);
    ok('  ...with a Retry-After the client can act on', r.code === 429 && Number(r.headers['retry-after']) > 0);
    ok('  ...and no password box to keep guessing in', r.code === 429 && !r.headers['www-authenticate']);

    const other = res();
    ok('a different address is unaffected',
      (await http.requireRead(req({ user: 'newsroom', secret: 'moved-into-the-store', ip: '9.9.9.10' }), other)) === true);

    await users.clearFails(IP);
    const cleared = res();
    ok('unlocking that address lets it back in',
      (await http.requireRead(req({ user: 'newsroom', secret: 'moved-into-the-store', ip: IP }), cleared)) === true);
  }

  section('10. a wrong name costs what a wrong password costs');
  {
    /* Timing, measured crudely and asserted loosely. The point is that an
       unknown username still runs a real key derivation, so the login form
       cannot be used to find out who works here. A tight bound would flake on
       a laptop that decided to index something, so this only catches the
       failure that matters: one path skipping scrypt entirely, which shows up
       as an order of magnitude, not as a few percent. */
    const time = async (user, secret) => {
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < 6; i++) await http.readAuthUser(req({ user, secret: secret + i, ip: '' }));
      return Number(process.hrtime.bigint() - t0) / 1e6;
    };
    const known = await time('newsroom', 'wrong-but-the-name-is-real');
    const ghost = await time('nobody-by-that-name', 'wrong-and-so-is-the-name');
    const ratio = known / ghost;
    ok('an unknown name is not answered faster', ratio < 4 && ratio > 0.25,
      'known ' + known.toFixed(1) + 'ms vs unknown ' + ghost.toFixed(1) + 'ms (ratio ' + ratio.toFixed(2) + ')');
  }

  section('11. the admin page itself');
  const admin = require(path.join(ROOT, 'api', 'admin.js'));
  const AS_ADMIN = { user: 'newsroom', secret: 'moved-into-the-store', ip: '5.0.0.1' };
  const AS_GUEST = { user: 'RedSox', secret: GUEST, ip: '5.0.0.2' };

  {
    const r = res();
    await admin(req(Object.assign({}, AS_ADMIN)), r);
    ok('the page renders for an admin', r.code === 200 && /<h1>Logins<\/h1>/.test(r.body));
    ok('  ...and is never cached', r.headers['cache-control'] === 'no-store');
    ok('  ...and is not indexed', /noindex/.test(String(r.headers['x-robots-tag'] || '')));
    ok('  ...and lists the stored logins', /RedSox/.test(r.body));
    ok('  ...without any secret in the html', !r.body.includes(GUEST) && !r.body.includes('moved-into-the-store'));
    ok('  ...and without the env plaintext either', !r.body.includes('the-env-password'));
    ok('  ...and no scrypt hash goes to the browser', !/scrypt\$/.test(r.body));
  }

  {
    const r = res();
    await admin(req(Object.assign({}, AS_GUEST)), r);
    ok('a read-only login cannot open the page', r.code === 403 && !/<h1>Logins/.test(r.body));
  }

  const POST = extra => req(Object.assign({
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bcc-admin': '1', 'sec-fetch-site': 'same-origin' },
  }, AS_ADMIN, extra));

  section('12. a cross-site post cannot ride in on the browser credentials');
  {
    /* All three of these arrive fully authenticated, because a browser attaches
       Basic credentials to cross-site requests without being asked. What stops
       them is that none of them is a request a form could have sent. */
    let r = res();
    await admin(POST({ headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-bcc-admin': '1' },
                       raw: 'action=remove&name=newsroom' }), r);
    ok('a form-encoded post is refused', r.code === 403);

    r = res();
    await admin(POST({ headers: { 'content-type': 'application/json' },
                       raw: JSON.stringify({ action: 'remove', name: 'RedSox' }) }), r);
    ok('json without the custom header is refused', r.code === 403);

    r = res();
    await admin(POST({ headers: { 'content-type': 'application/json', 'x-bcc-admin': '1', 'sec-fetch-site': 'cross-site' },
                       raw: JSON.stringify({ action: 'remove', name: 'RedSox' }) }), r);
    ok('a cross-site fetch is refused', r.code === 403);

    ok('  ...and RedSox is still there', !!(await users.list()).find(u => u.name === 'RedSox'));
  }

  section('13. with nowhere to save, the page says so instead of pretending');
  {
    /* This is the state a fresh deploy is in before KV_REST_API_URL is set, and
       the failure worth guarding against is a form that looks like it saved and
       did not. So the refusal has to be loud, and it has to say what to do about
       it, because the person reading it is standing at the screen. */
    const r = res();
    await admin(POST({ raw: JSON.stringify({ action: 'add', name: 'Nowhere', secret: 'a-perfectly-fine-secret' }) }), r);
    ok('a save with nowhere to save to is refused', r.code === 503, r.body.slice(0, 200));
    ok('  ...and the refusal names the two variables to set',
      /KV_REST_API_URL/.test(r.body) && /KV_REST_API_TOKEN/.test(r.body));
    ok('  ...and says outright that nothing changed', /othing was changed/.test(r.body));
    ok('  ...and nothing was', !(await users.list()).some(u => u.name === 'Nowhere'));
  }

  /* Everything above this line ran against kv's in-memory fallback, which is
     what the store falls back to when no Redis credentials are present, and
     sections 4 through 12 have been reading and writing through it the whole
     way down. The one thing this changes is kv's answer to "is a store
     configured", which is the question api/admin.js asks before it will save
     anything. The reads and writes underneath stay the ones that just ran. */
  kv.live = true;

  section('14. the admin api does the work');
  {
    let r = res();
    await admin(POST({ raw: JSON.stringify({ action: 'add', name: 'Fenway', secret: 'another-good-secret', expires: 7 }) }), r);
    let out = json(r);
    ok('adding a login works', r.code === 200 && out && out.ok, r.body.slice(0, 200));
    ok('  ...and the reply carries the fresh list', out && out.users.some(u => u.name === 'Fenway'));
    ok('  ...with an expiry set', out && out.users.find(u => u.name === 'Fenway').expires);
    ok('  ...and no secret comes back', !r.body.includes('another-good-secret'));
    ok('  ...and the new login can sign in',
      await http.readAuthUser(req({ user: 'Fenway', secret: 'another-good-secret', ip: '6.0.0.1' })) === 'Fenway');

    r = res();
    await admin(POST({ raw: JSON.stringify({ action: 'set', name: 'Fenway', secret: 'a-replacement-secret' }) }), r);
    ok('changing a secret works', json(r) && json(r).ok);
    ok('  ...the old secret stops working',
      await http.readAuthUser(req({ user: 'Fenway', secret: 'another-good-secret', ip: '6.0.0.2' })) === null);
    ok('  ...the new one works',
      await http.readAuthUser(req({ user: 'Fenway', secret: 'a-replacement-secret', ip: '6.0.0.3' })) === 'Fenway');
    ok('  ...and the expiry was not quietly extended',
      !!json(r).users.find(u => u.name === 'Fenway').expires);

    r = res();
    await admin(POST({ raw: JSON.stringify({ action: 'remove', name: 'Fenway' }) }), r);
    ok('removing a login works', json(r) && json(r).ok);
    ok('  ...and it stops working at once',
      await http.readAuthUser(req({ user: 'Fenway', secret: 'a-replacement-secret', ip: '6.0.0.4' })) === null);

    r = res();
    await admin(POST({ raw: JSON.stringify({ action: 'add', name: 'Shorty', secret: 'abc' }) }), r);
    ok('a too-short secret is refused with a sentence', r.code === 400 && /at least/.test(r.body));
  }

  section('15. a name somebody else chose cannot become markup');
  {
    /* The store refuses whitespace outright, which happens to remove the
       textbook payload and most of its relatives. It does not remove the
       problem. Everything below is a legal username by that rule, and every
       one of them lands inside a <script> block on the admin page. */
    let r = res();
    await admin(POST({ raw: JSON.stringify({ action: 'add', name: 'a b', secret: 'a-perfectly-fine-secret' }) }), r);
    ok('a username with a space is refused with a sentence', r.code === 400 && /spaces/.test(r.body));

    r = res();
    await admin(POST({ raw: JSON.stringify({ action: 'add', name: 'a:b', secret: 'a-perfectly-fine-secret' }) }), r);
    ok('  ...and so is one with a colon, which Basic auth would split on',
      r.code === 400 && /colon/.test(r.body));

    const NASTY = 'x</script><svg/onload=alert(1)>';
    await users.put(NASTY, 'a-perfectly-fine-secret', { note: '</script><b>bold</b>', by: 'test' });
    r = res();
    await admin(req(Object.assign({}, AS_ADMIN)), r);
    ok('the page still renders', r.code === 200);
    ok('  ...and the script block was not closed early', !/<\/script><svg/.test(r.body));
    ok('  ...and the payload is escaped in the embedded json', r.body.includes('\\u003c/script'));
    ok('  ...and so is the note, which is free text by design',
      !r.body.includes('</script><b>bold'));
    ok('  ...and the row is still there, escaped rather than dropped',
      r.body.includes('\\u003csvg/onload'));
    await users.remove(NASTY);
  }

  section('16. the read routes still behave');
  {
    /* The point of this section is regression, not coverage. These four were
       synchronous yesterday and every one of them had to grow an await. */
    for (const f of ['api/state.js', 'api/status.js', 'api/pulse.js', 'api/app.js']) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      ok(f + ' still gates itself', /await\s+requireRead\s*\(/.test(src));
    }
    const rr = fs.readFileSync(path.join(ROOT, 'lib', 'read-route.js'), 'utf8');
    ok('lib/read-route.js gates both of its route builders',
      (rr.match(/await\s+requireRead\s*\(/g) || []).length === 2);
  }

  section('17. the wiring is in vercel.json');
  {
    const vj = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
    ok('/admin is rewritten to the function',
      vj.rewrites.some(r => r.source === '/admin' && r.destination === '/api/admin'));
    ok('  ...and the function has a duration', !!(vj.functions && vj.functions['api/admin.js']));
  }

  section('18. Redis going down does not lock the newsroom out');
  {
    /* This deploy moves the user table into Redis, which creates a failure the
       site did not have yesterday: the store unreachable at the moment somebody
       signs in. The rule is that an unreadable store cannot cost anybody their
       env login, because that is the credential the newsroom already has and
       the one it would be falling back to at two in the morning.

       load() keeps the last good table for ten seconds and hands it back on a
       read failure, which is correct and would also hide the thing being tested
       here. forget() drops it, so the outage lands on a cold instance, which is
       the case that actually matters. */
    const real = kv.hgetall;
    kv.hgetall = async () => { throw new Error('ECONNREFUSED (simulated)'); };
    users.forget();

    ok('the env login still gets in with the store unreachable',
      await http.readAuthUser(req({ user: 'newsroom', secret: 'the-env-password', ip: '7.7.0.1' })) === 'newsroom');
    ok('  ...and a wrong secret still does not',
      await http.readAuthUser(req({ user: 'newsroom', secret: 'nope', ip: '7.7.0.2' })) === null);
    ok('  ...and a login that lives only in the store does not either',
      await http.readAuthUser(req({ user: 'RedSox', secret: GUEST, ip: '7.7.0.3' })) === null);

    {
      /* The distinction the whole store is built around: nothing configured
         anywhere means the site is deliberately open, and nothing readable
         means we do not know. Those two must never answer the same way. */
      const KEEP = { user: process.env.AUTH_USER, pass: process.env.AUTH_PASS };
      process.env.AUTH_USER = ''; process.env.AUTH_PASS = '';
      users.forget();

      const r = await users.authenticate('anybody', 'anything', '7.7.0.4');
      ok('nothing configured and nothing readable denies, rather than opening',
        r.ok === false && !!r.error);

      const closed = res();
      ok('  ...and the route says it cannot tell, instead of serving the map',
        (await http.requireRead(req({ ip: '7.7.0.5' }), closed)) === false && closed.code === 503);
      ok('  ...without a password box, which would be a lie about the cause',
        !closed.headers['www-authenticate']);

      process.env.AUTH_USER = KEEP.user; process.env.AUTH_PASS = KEEP.pass;
    }

    kv.hgetall = real;
    users.forget();
    ok('the stored logins come back the moment the store answers',
      await http.readAuthUser(req({ user: 'RedSox', secret: GUEST, ip: '7.7.0.7' })) === 'RedSox');
    ok('  ...and so does the store record for a name the environment also lists',
      await http.readAuthUser(req({ user: 'newsroom', secret: 'moved-into-the-store', ip: '7.7.0.6' })) === 'newsroom');
    /* Which means the env password stops working again, and that is the point
       rather than a wart. During the outage it was the only way in and it
       worked. The instant the store can be read, the newer secret stored under
       that name takes the name back, so an outage cannot be used to roll
       somebody's password back to whatever the environment still holds. */
    ok('  ...so the env password is shadowed once more, as it was before',
      await http.readAuthUser(req({ user: 'newsroom', secret: 'the-env-password', ip: '7.7.0.8' })) === null);
  }

  section('19. the status page still tells the truth about the door');
  {
    /* This endpoint exists to answer "did I forget to set something", and
       moving the logins into Redis quietly invalidated the answer people lean
       on hardest: an empty AUTH_PASS stopped meaning an open site. A
       diagnostics page that says the door is open while it is shut is worse
       than one that says nothing at all.

       It is also a read route, so everybody with a viewer login can open it,
       which is why what follows checks counts and checks that no name comes
       with them. */
    const status = require(path.join(ROOT, 'api', 'status.js'));
    const r = res();
    await status(req({ user: 'newsroom', secret: 'moved-into-the-store', ip: '4.4.0.1' }), r);
    const s = json(r);
    ok('it answers an authenticated read', r.code === 200 && !!s, r.body.slice(0, 120));
    ok('  ...counting the stored logins', !!s && s.logins && s.logins.stored >= 1);
    ok('  ...and the environment ones separately', !!s && s.logins.env >= 1);
    ok('  ...without naming a single one of them',
      !r.body.includes('RedSox') && !r.body.includes('newsroom'));
    ok('  ...and without any secret, which was always the rule here',
      !r.body.includes(GUEST) && !r.body.includes('the-env-password') && !r.body.includes('moved-into-the-store'));
    ok('  ...and it does not call the site open while logins exist',
      !/open to anyone/.test(r.body));
  }

  console.log('');
  if (fail) {
    console.log('AUTH FAILED: ' + fail + ' of ' + (pass + fail));
    process.exit(1);
  }
  console.log('AUTH OK  (' + pass + ' checks)');
  process.exit(0);
})().catch(e => {
  console.error('\nTHREW: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
