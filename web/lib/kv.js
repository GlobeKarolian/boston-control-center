/* ============================================================================
   lib/kv.js - the only place this app talks to Redis.

   Zero dependencies, on purpose. The rest of the Control Center is built the
   same way, and a Vercel deploy that needs a healthy npm install is a deploy
   that can break for reasons having nothing to do with Boston.

   Backend is any Upstash-compatible REST endpoint. Vercel injects credentials
   when you provision Redis from the Marketplace. The variable names have
   changed over the years, so every known spelling is accepted.

   With no credentials present this falls back to an in-process Map, which is
   useful for `vercel dev` and useless in production, where the next request
   lands on a different machine. The fallback says so, loudly, once.
   ========================================================================== */

const URL_VARS   = ['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL', 'REDIS_REST_URL'];
const TOKEN_VARS = ['KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN', 'REDIS_REST_TOKEN'];

const pick = names => { for (const n of names) if (process.env[n]) return String(process.env[n]).trim(); return ''; };
const BASE  = pick(URL_VARS).replace(/\/+$/, '');
const TOKEN = pick(TOKEN_VARS);
const LIVE  = !!(BASE && TOKEN);

/* Anything larger than this is split across numbered keys. Upstash caps a
   single request body and the forecast payload is the one thing here big
   enough to reach it. Splitting once is cheaper than rediscovering the cap. */
const CHUNK    = 400000;
const SENTINEL = '@@bcc-chunks@@:';

/* ---- the meter ------------------------------------------------------------
   Upstash bills and caps by command, not by request, so a pipeline of five
   SETs is five. The free tier is 500,000 a month, which is 11 a minute for the
   whole system, and nothing anywhere told us how close we were until writes
   started failing and the newsroom board went blank.

   Counting per process only sees one warm container's slice of the traffic, so
   the projection below is a floor and not a bill. That is still the difference
   between a number somebody can watch and a wall nobody saw. */
const METER = { commands: 0, calls: 0, since: Date.now(), errors: 0, capped: 0 };

/* When the cap is hit, every further command is refused for this long. Two
   reasons. The obvious one is that a request which cannot succeed should not
   be paid for. The load-bearing one is what happens at the reset: four crons
   on * * * * * plus a relay retrying on a short backoff will drain a freshly
   refilled quota in a couple of days flat, and it will do it while everything
   looks fine. Failing fast and locally also means a blown cap costs one round
   trip per handler instead of one per command. */
const CAP_COOLOFF_MS = 60000;
let cappedUntil = 0;

function quotaError(detail) {
  const e = new Error('redis: ' + detail);
  /* 503, not 500. Scanner Relay holds its batch and lengthens its backoff on a
     503; on a 500 it says "dashboard unreachable" and keeps knocking, which is
     the behaviour that turns a quota problem into a quota spiral. */
  e.status = 503;
  e.quota = true;
  return e;
}

const isQuota = msg => /max requests limit exceeded|max daily request limit|quota/i.test(String(msg || ''));

function meter() {
  const mins = Math.max(1, (Date.now() - METER.since) / 60000);
  const perMin = METER.commands / mins;
  return {
    commands: METER.commands,
    calls: METER.calls,
    errors: METER.errors,
    capped: METER.capped,
    upMin: Math.round(mins),
    perMin: Math.round(perMin * 10) / 10,
    /* What this one container would spend in a month at its current rate. The
       real bill is the sum across every warm container plus every cold start,
       so read this as "at least this much". */
    projectedMonthly: Math.round(perMin * 60 * 24 * 30),
    freeTier: 500000,
    coolingOff: Date.now() < cappedUntil,
  };
}

/* ---- raw transport -------------------------------------------------------- */

/* Everything goes through /pipeline, including single commands. Arguments
   travel in the JSON body rather than the URL path, so a transcript with a
   slash or a newline in it cannot corrupt the request. */
async function pipe(commands, timeoutMs = 10000) {
  if (!commands.length) return [];

  /* Test seam, and the only one that lives on the hot path. tools/test-sitlink
     sets `kv.raw.fail` to a message and every command throws it, because "what
     does the board do when the store is gone" is the behaviour most worth a
     test and the hardest to arrange any other way. Unset in production, where
     the cost is one property read per pipeline. */
  if (pipe.fail) throw new Error('redis: ' + pipe.fail);

  /* No credentials: run the same commands against the process Map instead.
     This branch is load-bearing. `raw` is the transport every other helper is
     built on, and those helpers each guard on LIVE while `raw` is exported
     straight out. Anything reaching for raw directly (rendering the output
     keys, claiming a transcript sequence, a health PING) would otherwise build
     the relative URL "/pipeline" and throw on a machine that has no Redis yet,
     which is every machine before `vercel install upstash` runs. */
  if (!LIVE) { METER.calls++; METER.commands += commands.length; return memPipe(commands); }

  /* Refuse locally while cooling off. Nothing here can succeed and every
     attempt is another command billed against a quota that is already gone. */
  if (Date.now() < cappedUntil) {
    METER.capped++;
    throw quotaError('command quota exhausted, holding for '
      + Math.ceil((cappedUntil - Date.now()) / 1000) + 's');
  }

  METER.calls++;
  METER.commands += commands.length;

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(BASE + '/pipeline', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify(commands.map(c => c.map(x => (x === null || x === undefined ? '' : String(x))))),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const body = (await r.text()).slice(0, 200);
      /* Upstash answers 429 for the cap, but has also been seen returning it
         inside a 200 body, so both shapes are checked. */
      if (r.status === 429 || isQuota(body)) {
        cappedUntil = Date.now() + CAP_COOLOFF_MS;
        METER.capped++;
        throw quotaError(body || ('http ' + r.status));
      }
      METER.errors++;
      throw new Error('redis http ' + r.status + ' ' + body);
    }
    const j = await r.json();
    if (!Array.isArray(j)) { METER.errors++; throw new Error('redis: unexpected response shape'); }
    return j.map(x => {
      if (x && x.error) {
        if (isQuota(x.error)) {
          cappedUntil = Date.now() + CAP_COOLOFF_MS;
          METER.capped++;
          throw quotaError(x.error);
        }
        METER.errors++;
        throw new Error('redis: ' + x.error);
      }
      return x ? x.result : null;
    });
  } finally { clearTimeout(to); }
}

const one = async (...args) => (await pipe([args]))[0];

/* ---- memory fallback ------------------------------------------------------ */

let warned = false;
const M = new Map();      // key -> { v, exp }   v is a string, an array, or a plain object
function memWarn() {
  if (warned) return; warned = true;
  console.error('[kv] No Redis credentials (' + URL_VARS.join(' / ') + ').');
  console.error('[kv] Using process memory. Fine for local dev. In production every write is');
  console.error('[kv] lost, because the next request is a different process. Provision Redis:');
  console.error('[kv]   vercel install upstash');
}
function mem(key) {
  memWarn();
  const e = M.get(key);
  if (e && e.exp && Date.now() > e.exp) { M.delete(key); return null; }
  return e || null;
}
function memPut(key, v, ttlSec) {
  memWarn();
  M.set(key, { v, exp: ttlSec ? Date.now() + ttlSec * 1000 : 0 });
}

/* ---- test seams -----------------------------------------------------------
   tools/test-sitlink.js and tools/race-check.js drive the real route handlers
   against the Map above. They need to seed a board and read it back without
   going through the route under test, because a test that checks a write by
   calling the same code that did the writing is a test of nothing.

   Values go in and come out as JSON, which is what every real caller stores,
   so a test that seeds an array reads back an array while the handler in the
   middle sees exactly the string it would see in production. */
function _reset() { M.clear(); }

function _put(key, value, ttlSec) {
  memPut(String(key), typeof value === 'string' ? value : JSON.stringify(value), ttlSec);
}

function _get(key) {
  const e = mem(String(key));
  if (!e) return null;
  if (typeof e.v !== 'string') return e.v;
  try { return JSON.parse(e.v); } catch (err) { return e.v; }
}

/* The subset of Redis this app actually speaks, served from the Map above.
   Deliberately not a Redis emulator: an unknown command throws by name rather
   than returning a plausible-looking null, because a silent wrong answer in
   dev is how a bug reaches production wearing a disguise. */
function memPipe(commands) {
  memWarn();
  return commands.map((cmd) => {
    const op = String(cmd[0] || '').toUpperCase();
    const k = cmd[1] === undefined ? '' : String(cmd[1]);
    const entry = () => mem(k);
    switch (op) {
      case 'PING': return 'PONG';

      case 'GET': { const e = entry(); return e && typeof e.v === 'string' ? e.v : null; }

      case 'MGET': return cmd.slice(1).map((key) => {
        const e = mem(String(key));
        return e && typeof e.v === 'string' ? e.v : null;
      });

      case 'SET': {
        const opts = cmd.slice(3).map(String);
        const up = opts.map(x => x.toUpperCase());
        const present = !!entry();
        if (up.includes('NX') && present) return null;
        if (up.includes('XX') && !present) return null;
        let ttlSec = 0;
        const iex = up.indexOf('EX'); if (iex >= 0 && opts[iex + 1] !== undefined) ttlSec = Number(opts[iex + 1]);
        const ipx = up.indexOf('PX'); if (ipx >= 0 && opts[ipx + 1] !== undefined) ttlSec = Number(opts[ipx + 1]) / 1000;
        memPut(k, String(cmd[2]), ttlSec > 0 ? ttlSec : 0);
        return 'OK';
      }

      case 'SETEX': { memPut(k, String(cmd[3]), Number(cmd[2]) || 0); return 'OK'; }

      case 'DEL': { let n = 0; for (const key of cmd.slice(1)) if (M.delete(String(key))) n++; return n; }

      case 'EXISTS': { let n = 0; for (const key of cmd.slice(1)) if (mem(String(key))) n++; return n; }

      case 'INCR': case 'DECR': {
        const step = op === 'INCR' ? 1 : -1;
        const e = entry();
        const next = (e && typeof e.v === 'string' ? (Number(e.v) || 0) : 0) + step;
        M.set(k, { v: String(next), exp: e ? e.exp : 0 });
        return next;
      }

      case 'EXPIRE': {
        const e = entry(); if (!e) return 0;
        e.exp = Date.now() + (Number(cmd[2]) || 0) * 1000; return 1;
      }

      case 'TTL': {
        const e = entry(); if (!e) return -2;
        return e.exp ? Math.max(0, Math.round((e.exp - Date.now()) / 1000)) : -1;
      }

      case 'HSET': {
        const e = entry();
        const h = (e && e.v && typeof e.v === 'object' && !Array.isArray(e.v)) ? e.v : {};
        for (let i = 2; i + 1 < cmd.length; i += 2) h[String(cmd[i])] = String(cmd[i + 1]);
        memPut(k, h); return 1;
      }
      case 'HGETALL': {
        const e = entry();
        return (e && e.v && typeof e.v === 'object' && !Array.isArray(e.v)) ? { ...e.v } : {};
      }
      case 'HDEL': {
        const e = entry();
        if (!e || !e.v || typeof e.v !== 'object') return 0;
        let n = 0; for (const f of cmd.slice(2)) if (delete e.v[String(f)]) n++;
        return n;
      }

      case 'LPUSH': {
        const e = entry();
        const arr = (e && Array.isArray(e.v)) ? e.v : [];
        for (const v of cmd.slice(2)) arr.unshift(String(v));
        memPut(k, arr); return arr.length;
      }
      case 'LTRIM': {
        const e = entry();
        const arr = (e && Array.isArray(e.v)) ? e.v : [];
        const stop = Number(cmd[3]);
        memPut(k, arr.slice(Number(cmd[2]), stop < 0 ? undefined : stop + 1));
        return 'OK';
      }
      case 'LRANGE': {
        const e = entry();
        const arr = (e && Array.isArray(e.v)) ? e.v : [];
        const stop = Number(cmd[3]);
        return arr.slice(Number(cmd[2]), stop < 0 ? undefined : stop + 1);
      }

      /* The only script this app runs is the compare-and-delete unlock. */
      case 'EVAL': {
        if (String(cmd[1]) !== UNLOCK_LUA) throw new Error('kv memory fallback: unknown EVAL script');
        const key = String(cmd[3]); const token = String(cmd[4]);
        const e = mem(key);
        if (e && e.v === token) { M.delete(key); return 1; }
        return 0;
      }

      default:
        throw new Error('kv memory fallback: unsupported command ' + op);
    }
  });
}

/* ---- public API ----------------------------------------------------------- */

async function get(key) {
  if (!LIVE) { const e = mem(key); return e && typeof e.v === 'string' ? e.v : null; }
  return await one('GET', key);
}

async function set(key, val, ttlSec) {
  if (!LIVE) return memPut(key, String(val), ttlSec);
  if (ttlSec) return void await one('SET', key, val, 'EX', Math.max(1, Math.round(ttlSec)));
  return void await one('SET', key, val);
}

async function del(...keys) {
  keys = keys.filter(Boolean);
  if (!keys.length) return;
  if (!LIVE) { keys.forEach(k => M.delete(k)); return; }
  await one('DEL', ...keys);
}

async function mget(keys) {
  if (!keys.length) return [];
  if (!LIVE) return keys.map(k => { const e = mem(k); return e && typeof e.v === 'string' ? e.v : null; });
  return await one('MGET', ...keys);
}

/* SET NX. True when this caller created the key. Used for the ingest mutex and
   for dropping transcripts a Mac has already delivered once. */
async function setIfAbsent(key, val, ttlSec) {
  if (!LIVE) { if (mem(key)) return false; memPut(key, String(val), ttlSec); return true; }
  const r = await one('SET', key, val, 'NX', 'EX', Math.max(1, Math.round(ttlSec || 60)));
  return r === 'OK';
}

/* ---- compression ----------------------------------------------------------

   Upstash meters bandwidth in both directions, and this app's single largest
   consumer is the store blob: every ingest that carries new transmissions
   reads the whole thing and writes the whole thing back. Nothing about that
   shape is wrong for a working set, but shipping it as raw JSON meant paying
   full price for text that is mostly repeated field names.

   Measured on this project's own data, gzip takes 83-86% off:

     incidents.json             26,285 -> 4,461   (83.0%)
     incidents.json.prerestart  92,393 -> 12,741  (86.2%)
     archive.jsonl             773,339 -> 129,459 (83.3%)

   So a hundred gigabytes of month becomes roughly fifteen, for one gzip call
   on each side. Values are stored base64 behind a magic prefix, which is what
   makes this safe to deploy into a live store: anything written before this
   change has no prefix and reads back exactly as it always did, so there is
   no migration and no flag day. New writes are compressed, old ones expire on
   their own TTL, and the two coexist for a day. */
const GZ = 'gz64:';
const zlib = require('zlib');
const { promisify } = require('util');
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

/* Below a couple of kilobytes the gzip header and the base64 tax can make a
   value BIGGER, and the round trip is not free either. The savings live in the
   store blob and the board payloads, which are all far above this line. */
const GZ_MIN = 2048;

async function packBig(str) {
  if (str.length < GZ_MIN) return str;
  try {
    const packed = GZ + (await gzip(Buffer.from(str, 'utf8'), { level: 6 })).toString('base64');
    return packed.length < str.length ? packed : str;
  } catch (e) { return str; }
}

async function unpackBig(str) {
  if (typeof str !== 'string' || !str.startsWith(GZ)) return str;
  try {
    return (await gunzip(Buffer.from(str.slice(GZ.length), 'base64'))).toString('utf8');
  } catch (e) {
    /* A value that claims to be compressed and will not decompress is a
       corrupt value, and hydrate() already knows how to start clean rather
       than wedge ingestion forever. */
    return null;
  }
}

/* ---- chunked values ------------------------------------------------------- */

async function setBig(key, str, ttlSec) {
  str = await packBig(String(str));
  const ex = ttlSec ? Math.max(1, Math.round(ttlSec)) : 0;
  if (!LIVE) { memPut(key, str, ttlSec); return; }
  if (str.length <= CHUNK) {
    await pipe([ex ? ['SET', key, str, 'EX', ex] : ['SET', key, str]], 20000);
    return;
  }
  const parts = [];
  for (let i = 0; i < str.length; i += CHUNK) parts.push(str.slice(i, i + CHUNK));
  const cmds = parts.map((p, i) => (ex ? ['SET', key + ':p' + i, p, 'EX', ex] : ['SET', key + ':p' + i, p]));
  cmds.push(ex ? ['SET', key, SENTINEL + parts.length, 'EX', ex] : ['SET', key, SENTINEL + parts.length]);
  await pipe(cmds, 30000);
}

async function getBig(key) {
  const head = await get(key);
  if (head === null || head === undefined) return null;
  if (typeof head !== 'string' || !head.startsWith(SENTINEL)) return unpackBig(head);
  const n = parseInt(head.slice(SENTINEL.length), 10);
  if (!(n > 0)) return null;
  const keys = []; for (let i = 0; i < n; i++) keys.push(key + ':p' + i);
  const parts = await mget(keys);
  if (parts.some(p => p === null || p === undefined)) return null;   // a chunk expired: treat as absent
  return unpackBig(parts.join(''));
}

async function getJSON(key, fallback = null) {
  try { const s = await getBig(key); return s ? JSON.parse(s) : fallback; }
  catch (e) { console.error('[kv] getJSON ' + key + ': ' + e.message); return fallback; }
}
const setJSON = (key, obj, ttlSec) => setBig(key, JSON.stringify(obj), ttlSec);

/* ---- hashes (fleet health lives here) ------------------------------------- */

/* Two shapes: hset(key, field, val) and hset(key, {field: val, ...}). The
   object form writes every field in a single HSET, which is what the fleet
   health hash needs: one round trip per POST rather than one per feed, and
   all of a machine's feeds landing in the same instant so the dashboard can
   never show half of a check-in. */
async function hset(key, fieldOrPairs, val) {
  const pairs = (fieldOrPairs && typeof fieldOrPairs === 'object')
    ? fieldOrPairs
    : { [fieldOrPairs]: val };
  const flat = [];
  for (const f in pairs) flat.push(String(f), String(pairs[f]));
  if (!flat.length) return;
  if (!LIVE) {
    const e = mem(key);
    const h = (e && e.v && typeof e.v === 'object' && !Array.isArray(e.v)) ? e.v : {};
    for (let i = 0; i + 1 < flat.length; i += 2) h[flat[i]] = flat[i + 1];
    memPut(key, h);
    return;
  }
  await one('HSET', key, ...flat);
}
async function hgetall(key) {
  if (!LIVE) { const e = mem(key); return (e && e.v && typeof e.v === 'object' && !Array.isArray(e.v)) ? { ...e.v } : {}; }
  const r = await one('HGETALL', key);
  if (!r) return {};
  if (!Array.isArray(r)) return r;                // some servers already return an object
  const out = {}; for (let i = 0; i + 1 < r.length; i += 2) out[r[i]] = r[i + 1];
  return out;
}
async function hdel(key, field) {
  if (!LIVE) { const e = mem(key); if (e && e.v && typeof e.v === 'object') delete e.v[field]; return; }
  await one('HDEL', key, field);
}

/* ---- capped lists (rolling history) --------------------------------------- */

async function lpushCapped(key, val, cap) {
  if (!LIVE) {
    const e = mem(key); const arr = (e && Array.isArray(e.v)) ? e.v : [];
    arr.unshift(String(val)); if (arr.length > cap) arr.length = cap; memPut(key, arr); return;
  }
  await pipe([['LPUSH', key, val], ['LTRIM', key, 0, cap - 1]]);
}
async function lrange(key, start, stop) {
  if (!LIVE) { const e = mem(key); const arr = (e && Array.isArray(e.v)) ? e.v : []; return arr.slice(start, stop < 0 ? undefined : stop + 1); }
  return (await one('LRANGE', key, start, stop)) || [];
}

/* ---- mutex ----------------------------------------------------------------
   Only the ingest path takes this, and only around the read, mutate and write
   of the correlation store. Extraction and geocoding happen outside it, so the
   hold is two Redis round trips rather than an Anthropic call. */

const UNLOCK_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

async function lock(key, ttlMs = 15000, waitMs = 6000) {
  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const deadline = Date.now() + waitMs;
  let delay = 60;
  for (;;) {
    if (!LIVE) { if (!mem(key)) { memPut(key, token, ttlMs / 1000); return token; } }
    else {
      const r = await one('SET', key, token, 'NX', 'PX', Math.round(ttlMs));
      if (r === 'OK') return token;
    }
    if (Date.now() >= deadline) return null;
    await new Promise(r => setTimeout(r, delay));
    delay = Math.min(400, Math.round(delay * 1.6));
  }
}

async function unlock(key, token) {
  if (!token) return;
  if (!LIVE) { const e = mem(key); if (e && e.v === token) M.delete(key); return; }
  try { await one('EVAL', UNLOCK_LUA, 1, key, token); } catch (e) { /* the lease expires on its own */ }
}

module.exports = {
  live: LIVE, get, set, del, mget, setIfAbsent,
  getBig, setBig, getJSON, setJSON,
  hset, hgetall, hdel, lpushCapped, lrange,
  lock, unlock, raw: pipe,
  meter, isQuota,

  /* Test seams, all underscored so nothing in api/ or lib/ is tempted.

     cron-cost drives the real handlers with fake credentials and a stubbed
     fetch rather than through the memory fallback, because thirteen of the
     helpers below short-circuit on !LIVE and never reach pipe(), where the
     meter lives. Measuring through the fallback reported zero commands for
     exactly the handlers the crons lean on hardest. */
  _meterReset: () => { METER.commands = 0; METER.calls = 0; METER.errors = 0; METER.capped = 0; METER.since = Date.now(); cappedUntil = 0; },
  _reset, _put, _get,
};
