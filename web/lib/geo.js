// lib/geo.js
// Geocode cascade ported from scanner-worker/worker.js.
//
// Differences from the Mac version:
//   1. The cache is in Redis, not process memory. On Vercel a process-local
//      cache is close to useless: the container that geocoded "123 Main St"
//      is probably not the one that sees it again. Cached in Redis it is
//      shared by every invocation and every machine in the fleet.
//   2. Negative results are cached too, with a shorter TTL. A scanner
//      transcript with a garbled address will repeat for as long as the
//      incident is live, and re-discovering that it does not geocode costs
//      two network calls every time.
//   3. Nominatim is rate limited through Redis. On the Mac it was one
//      residential IP making occasional calls. From Vercel it is a shared
//      datacenter IP calling a free community service on behalf of a fleet,
//      which is exactly the pattern their usage policy exists to stop. One
//      call per second across the whole deployment, and it degrades to "no
//      geocode" rather than queueing, because a stale pin is worse than none.

const kv = require('./kv');

const TTL_HIT = 30 * 24 * 3600;   // a street corner does not move
const TTL_MISS = 6 * 3600;        // give a garbled address a fresh try tomorrow
const NOMINATIM_QPS = Number(process.env.NOMINATIM_QPS || 1);
const NOMINATIM_ON = String(process.env.NOMINATIM_ENABLED || '1') !== '0';
const UA = process.env.GEO_USER_AGENT || 'BostonNewsroomControlCenter/1.0 (newsroom scanner map; matt@karolian.com)';

const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
// Cache keys carry the raw query, not a hash. Redis keys are cheap and a
// readable key means a bad geocode can be found and deleted by hand.
const ckey = (kind, q) => 'bcc:geo:' + kind + ':' + norm(q).replace(/[^a-z0-9 ,&.'-]/g, '').slice(0, 180);

const MISS = '@@miss@@';

async function cacheGet(key) {
  try {
    const v = await kv.get(key);
    if (v === null || v === undefined) return undefined;   // not cached
    if (v === MISS) return null;                           // cached miss
    const o = JSON.parse(v);
    return (o && typeof o.lat === 'number') ? o : undefined;
  } catch (e) { return undefined; }
}
async function cachePut(key, val) {
  try {
    if (val) await kv.set(key, JSON.stringify(val), TTL_HIT);
    else await kv.set(key, MISS, TTL_MISS);
  } catch (e) { /* a cold cache is slow, not broken */ }
}

// --------------------------------------------------------------- US Census

async function censusRaw(address, city, state = 'MA') {
  const url = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=' +
    encodeURIComponent(address + ', ' + city + ', ' + state) + '&benchmark=Public_AR_Current&format=json';
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('census ' + r.status);
  const j = await r.json();
  const match = j.result && j.result.addressMatches && j.result.addressMatches[0];
  if (!match) return null;
  return { lat: match.coordinates.y, lon: match.coordinates.x, matched: match.matchedAddress, src: 'census' };
}

async function geocode(address, city, state = 'MA') {
  if (!address) return null;
  const key = ckey('census', address + '|' + city + '|' + state);
  const hit = await cacheGet(key);
  if (hit !== undefined) return hit;
  let out = null;
  try { out = await censusRaw(address, city, state); } catch (e) { return null; }  // do not cache a transport failure
  await cachePut(key, out);
  return out;
}

// --------------------------------------------------------------- Nominatim

// One global call per second, enforced in Redis. INCR on a per-second key is
// atomic, so N concurrent invocations cannot all believe they are first.
async function claimNominatimSlot() {
  if (!kv.live) return true;                      // local dev, no fleet to coordinate
  const sec = Math.floor(Date.now() / 1000);
  const k = 'bcc:geo:nomrate:' + sec;
  try {
    const [n] = await kv.raw([['INCR', k], ['EXPIRE', k, 3]], 5000);
    return Number(n) <= NOMINATIM_QPS;
  } catch (e) { return false; }                   // if the limiter is unreachable, do not call
}

async function nominatimRaw(q) {
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us' +
    '&viewbox=-71.35,42.50,-70.85,42.15&q=' + encodeURIComponent(q);
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('nominatim ' + r.status);
  const j = await r.json();
  if (!(j && j[0] && j[0].lat)) return null;
  return {
    lat: parseFloat(j[0].lat),
    lon: parseFloat(j[0].lon),
    matched: (j[0].display_name || '').split(',').slice(0, 3).join(',').trim(),
    src: 'osm',
  };
}

async function nominatim(q) {
  if (!q) return null;
  const key = ckey('osm', q);
  const hit = await cacheGet(key);
  if (hit !== undefined) return hit;              // cache first, so cached queries never spend rate budget
  if (!NOMINATIM_ON) return null;
  if (!(await claimNominatimSlot())) return null;
  let out = null;
  try { out = await nominatimRaw(q); } catch (e) { return null; }
  await cachePut(key, out);
  return out;
}

// --------------------------------------------------------------- cascade

// Numbered address (Census, then OSM as backup) -> landmark (OSM) -> cross
// street (OSM). Unchanged from the Mac: more paths means more pins land.
async function geocodeEx(ex, city) {
  if (!ex) return null;
  const c = city || 'Boston';
  if (ex.address) {
    const g = await geocode(ex.address, c); if (g) return g;
    const n = await nominatim(ex.address + ', ' + c + ', MA'); if (n) return n;
  }
  if (ex.landmark) { const g = await nominatim(ex.landmark + ', ' + c + ', MA'); if (g) return g; }
  if (ex.crossStreet) { const g = await nominatim(ex.crossStreet.replace(/\s+and\s+/i, ' & ') + ', ' + c + ', MA'); if (g) return g; }
  return null;
}

// Resolve a whole batch before the store mutex is taken. Census is fine with
// parallel calls; Nominatim's limiter serialises itself, so a batch that
// leans on OSM simply gets fewer pins rather than a ban.
async function geocodeBatch(items, { concurrency = 6 } = {}) {
  const out = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      try { out[i] = await geocodeEx(items[i].ex, items[i].city); }
      catch (e) { out[i] = null; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

module.exports = { geocode, nominatim, geocodeEx, geocodeBatch };
