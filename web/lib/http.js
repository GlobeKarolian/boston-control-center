/* ============================================================================
   lib/http.js - auth, headers and JSON responses.

   Two completely separate doors, and they must not be confused:

     People  ->  HTTP Basic, one shared newsroom password (AUTH_PASS).
     Macs    ->  Bearer token on /api/ingest only, one token per machine.

   A leaked newsroom password lets someone read the map. A leaked ingest token
   lets someone write to it. That is why they are different secrets with
   different lifetimes, and why revoking one machine does not log out the
   newsroom.
   ========================================================================== */

const crypto = require('crypto');

const AUTH_USER = process.env.AUTH_USER || 'newsroom';
const AUTH_PASS = process.env.AUTH_PASS || '';

/* Constant-time compare that does not leak length through an early return. */
function safeEq(a, b) {
  const A = crypto.createHash('sha256').update(String(a)).digest();
  const B = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(A, B);
}

/* ---- the newsroom door ---------------------------------------------------- */

function readAuthOk(req) {
  if (!AUTH_PASS) return true;                 // no password set: the site is open
  const h = req.headers.authorization || '';
  if (!/^Basic /i.test(h)) return false;
  let decoded = '';
  try { decoded = Buffer.from(h.slice(6).trim(), 'base64').toString('utf8'); } catch (e) { return false; }
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  // Evaluate both halves so a wrong username costs the same as a wrong password.
  const okU = safeEq(decoded.slice(0, i), AUTH_USER);
  const okP = safeEq(decoded.slice(i + 1), AUTH_PASS);
  return okU && okP;
}

/* Call at the top of every read route. Returns false when it has already
   answered the request. */
function requireRead(req, res) {
  harden(res);
  if (readAuthOk(req)) return true;
  res.setHeader('WWW-Authenticate', 'Basic realm="Boston Newsroom Control Center", charset="UTF-8"');
  res.status(401).send('Authentication required.');
  return false;
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

module.exports = { readAuthOk, requireRead, ingestAuth, cronAuth, json, harden, safeEq };
