// lib/geo.js
// Geocode cascade.
//
// Measured on 150 live transmissions before the first rewrite: 21 pins. 114 of
// the 150 produced no location field at all, and of the 36 that did, 15 failed
// to resolve. The first rewrite added a local gazetteer, raw-transcript
// scanning, real intersection lookups and a hard town gate.
//
// This pass fixes what live traffic exposed after that shipped.
//
//   1. Whisper garbles street names, and a geocoder handed garbled text returns
//      nothing. "Hopper View Street" is Harborview Street. A local index of
//      every named street in the covered towns snaps the garble back to the
//      street that exists before anything hits the network.
//   2. A wrong pin marked exact is the worst output this file can produce.
//      "720 Murphy" was resolving to a footpath in Brighton and claiming
//      precision. Non-addressable OSM features are now rejected outright, and a
//      result that matched a street but not the house number is demoted.
//   3. The Census geocoder snaps hard. "16 Wild West Street" came back as
//      "16 WEST ST" and claimed exact. Every Census answer is now checked word
//      by word against what was asked, and a snap that dropped a word is
//      demoted or thrown out.
//   4. The extractor keeps putting bare street names in the address field. That
//      is now repaired here, deterministically, instead of being argued about
//      in a prompt.

const kv = require('./kv');
const places = require('./places');

// A missing or broken street index must degrade the cascade, never take ingest
// down with it.
let streets = null;
try { streets = require('./streets'); } catch (e) { streets = null; }

const TTL_HIT = 30 * 24 * 3600;   // a street corner does not move
const TTL_MISS = 6 * 3600;        // give a garbled address a fresh try tomorrow
const NOMINATIM_QPS = Number(process.env.NOMINATIM_QPS || 1);
const NOMINATIM_ON = String(process.env.NOMINATIM_ENABLED || '1') !== '0';
const OVERPASS_ON = String(process.env.OVERPASS_ENABLED || '1') !== '0';
const UA = process.env.GEO_USER_AGENT || 'BostonNewsroomControlCenter/1.0 (newsroom scanner map; matt@karolian.com)';

const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const key9 = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
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

// ------------------------------------------------------- shared name handling

const STREET_TAIL = /\s+(street|st|avenue|ave|av|road|rd|boulevard|blvd|drive|dr|lane|ln|place|pl|court|ct|terrace|ter|way|circle|cir|square|sq|parkway|pkwy|highway|hwy|row|path|turnpike|tpke)\.?$/i;
const cleanStreet = s => String(s || '').trim().replace(STREET_TAIL, '').replace(/[^A-Za-z0-9 '.-]/g, '').trim();

// Words that carry no identity, so a match must not be credited for them.
const NOISE_WORD = new Set(['street', 'st', 'avenue', 'ave', 'av', 'road', 'rd', 'boulevard', 'blvd',
  'drive', 'dr', 'lane', 'ln', 'place', 'pl', 'court', 'ct', 'terrace', 'ter', 'way', 'circle', 'cir',
  'square', 'sq', 'parkway', 'pkwy', 'highway', 'hwy', 'row', 'path', 'turnpike', 'tpke', 'ext',
  'extension', 'ma', 'mass', 'massachusetts', 'usa', 'us', 'united', 'states']);

const DIR_FULL = { n: 'north', s: 'south', e: 'east', w: 'west', ne: 'northeast', nw: 'northwest', se: 'southeast', sw: 'southwest' };

// The words in a location string that actually identify it.
function sigWords(s) {
  return key9(s).split(' ').filter(w => w && !NOISE_WORD.has(w) && !/^\d+$/.test(w));
}

function wordMatches(a, b) {
  if (a === b) return true;
  if (DIR_FULL[a] === b || DIR_FULL[b] === a) return true;
  if (a.length >= 3 && b.startsWith(a)) return true;
  if (b.length >= 3 && a.startsWith(b)) return true;
  return false;
}

/* Did the geocoder answer the question that was asked?
   Every identifying word in the query has to survive into the answer. A search
   engine that drops a word has quietly changed the question, which is how
   "16 Wild West Street" became "16 WEST ST" and claimed to be exact. */
function answersQuery(asked, got) {
  const q = sigWords(asked);
  if (!q.length) return true;
  const g = sigWords(got);
  if (!g.length) return false;
  return q.every(w => g.some(x => wordMatches(w, x)));
}

const HOUSE_RE = /^\s*(\d{1,6})\s*[a-z]?\s+\S/i;
const houseNumber = s => { const m = HOUSE_RE.exec(String(s || '')); return m ? m[1] : null; };
const hasHouseNumber = s => !!houseNumber(s);

// --------------------------------------------------------------- US Census

async function censusRaw(address, city, state = 'MA') {
  const url = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=' +
    encodeURIComponent(address + ', ' + city + ', ' + state) + '&benchmark=Public_AR_Current&format=json';
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('census ' + r.status);
  const j = await r.json();
  const match = j.result && j.result.addressMatches && j.result.addressMatches[0];
  if (!match) return null;

  const matched = match.matchedAddress || '';
  // The Census matcher is a snapper, not a search engine. It will happily throw
  // away a word to reach a record it likes. Check what came back before calling
  // it precise.
  const street = matched.split(',')[0] || '';
  if (!answersQuery(address, street)) return null;

  const want = houseNumber(address), got = houseNumber(street);
  const numberHeld = !want || !got || want === got;

  return {
    lat: match.coordinates.y,
    lon: match.coordinates.x,
    matched,
    src: 'census',
    confident: true,
    approx: numberHeld ? undefined : true,
  };
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

// A footpath, a set of steps and a cycle track all have names and none of them
// is a place a truck gets sent. "720 Murphy" matching the Reverend James J.
// Murphy Footway is the failure this set exists to stop.
const NOT_ADDRESSABLE = new Set(['footway', 'path', 'steps', 'cycleway', 'bridleway', 'track',
  'corridor', 'proposed', 'construction', 'raceway', 'via_ferrata', 'elevator', 'platform',
  'bus_stop', 'crossing', 'traffic_signals', 'street_lamp', 'turning_circle', 'emergency_bay']);

// Classes that describe an area rather than a point. Usable, never precise.
const AREA_CLASS = new Set(['boundary', 'landuse', 'natural', 'waterway']);
const WIDE_PLACE = new Set(['state', 'county', 'region', 'country', 'city', 'town', 'village',
  'municipality', 'suburb', 'borough', 'postcode']);

/* ok: use as is. approx: place the pin, do not claim precision. reject: lie. */
function osmVerdict(row, wantedHouseNumber) {
  const cls = String(row.class || ''), typ = String(row.type || '');
  if (cls === 'highway' && NOT_ADDRESSABLE.has(typ)) return 'reject';
  if (NOT_ADDRESSABLE.has(typ) && cls !== 'building') return 'reject';
  if (wantedHouseNumber && !(row.address && row.address.house_number)) return 'approx';
  if (AREA_CLASS.has(cls)) return 'wide';
  if (cls === 'place' && WIDE_PLACE.has(typ)) return 'wide';
  return 'ok';
}

/* Two very different things were both called "approx".
 *
 * A pub matched by name is a POINT: we know the building, we just did not get
 * a house number off the radio. A town or a postcode is an AREA the size of a
 * map. Collapsing them cost the product a real grouping: on 16 Aug the first
 * call to Russell House Tavern geocoded to "14 JFK ST" (exact) and the
 * follow-up sixty seconds later matched the pub by name (approx), and because
 * lib/incident-store refuses to join anything not exact, one bar fight became
 * two cards a minute apart.
 *
 * `wide` marks only the area-sized fixes. Everything downstream can now let a
 * point-level approx join a scene it is standing on top of, while still
 * refusing to let a town centroid swallow the town. */
function isWide(verdict) { return verdict === 'wide'; }

async function nominatimRaw(q) {
  // bounded=1 turns the viewbox from a preference into a fence. Without it a
  // query for "Main Street" can and does come back with a Main Street in
  // another state, which reads as a successful geocode and is a lie.
  // addressdetails=1 is what makes the house-number check below possible.
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=3&countrycodes=us&bounded=1' +
    '&addressdetails=1&viewbox=-71.60,42.75,-70.60,41.90&q=' + encodeURIComponent(q);
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('nominatim ' + r.status);
  const j = await r.json();
  if (!Array.isArray(j) || !j.length) return null;

  const wantHN = hasHouseNumber(q);
  // Ask for three and take the best usable one. The top hit is often a footway
  // or a fuzzy alias while the second is the real street.
  let fallback = null;
  for (const row of j) {
    if (!row || !row.lat) continue;
    const verdict = osmVerdict(row, wantHN);
    if (verdict === 'reject') continue;
    const display = row.display_name || '';
    // Nominatim will also drop a word to find something. Same rule as Census.
    if (!answersQuery(stripTownTail(q), display)) continue;
    const out = {
      lat: parseFloat(row.lat),
      lon: parseFloat(row.lon),
      matched: display.split(',').slice(0, 3).join(',').trim(),
      src: 'osm',
      confident: true,
      approx: (verdict === 'approx' || verdict === 'wide') ? true : undefined,
      wide: isWide(verdict) ? true : undefined,
    };
    if (verdict === 'ok') return out;
    if (!fallback) fallback = out;
  }
  return fallback;
}

// The query carries ", Boston, MA" for scoping. Those words are not part of the
// thing being asked for, and requiring them in the answer would reject a
// perfectly good hit that names a neighbourhood instead of the city.
function stripTownTail(q) {
  return String(q || '').split(',')[0];
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

// --------------------------------------------------------------- Overpass

// A box around the points we already know, padded, as a string Overpass takes.
// Resolving a town by name costs Overpass a boundary lookup on every call and
// is the slowest part of an intersection query by a wide margin. When the
// street index has already told us roughly where both streets sit, a box drawn
// around them asks a far smaller question. Measured against the same corner: 25
// seconds through the town boundary, under a second through a box.
function boxAround(pts, padDeg) {
  const la = pts.map(p => p[0]), lo = pts.map(p => p[1]);
  return [Math.min(...la) - padDeg, Math.min(...lo) - padDeg * 1.35,
          Math.max(...la) + padDeg, Math.max(...lo) + padDeg * 1.35]
         .map(x => x.toFixed(4)).join(',');
}

// Real intersection geocoding. "Washington and Talbot" is a corner, and OSM
// knows exactly where those two ways cross. Handing that string to a search
// engine as "Washington & Talbot" got nothing; asking for the shared node gets
// the corner. Street names off a scanner are partial ("Washington", not
// "Washington Street"), so a name that did not come out of the index matches on
// a prefix and one that did matches exactly.
async function overpassIntersection(a, b, town, hint) {
  if (!OVERPASS_ON) return null;
  const A = cleanStreet(a), B = cleanStreet(b);
  if (!A || !B || !town) return null;
  const key = ckey('xnode', A + '|' + B + '|' + town);
  const hit = await cacheGet(key);
  if (hit !== undefined) return hit;

  const esc = s => String(s).replace(/["\\]/g, '');
  let q;
  if (hint && hint.length === 2) {
    // Both names came from the index, so they are OSM's own spelling and the
    // box is drawn from OSM's own coordinates.
    q = '[out:json][timeout:12][bbox:' + boxAround(hint, 0.035) + '];' +
      'way["name"="' + esc(a) + '"]["highway"]->.w1;' +
      'way["name"="' + esc(b) + '"]["highway"]->.w2;' +
      'node(w.w1)(w.w2);out center 1;';
  } else {
    // The bbox is not decoration. area["name"="Boston"] resolves globally and
    // matches Boston, Lincolnshire; without the fence a Boston corner can come
    // back from England.
    q = '[out:json][timeout:12][bbox:41.85,-71.70,42.95,-70.55];' +
      'area["name"="' + esc(town) + '"]["boundary"="administrative"]["admin_level"="8"]->.a;' +
      'way(area.a)["name"~"^' + esc(A) + '",i]["highway"]->.w1;' +
      'way(area.a)["name"~"^' + esc(B) + '",i]["highway"]->.w2;' +
      'node(w.w1)(w.w2);out center 1;';
  }

  const j = await overpassRun(q);
  if (!j) return null;                             // transport failure: do not cache
  let out = null;
  const n = (j.elements || [])[0];
  if (n && typeof n.lat === 'number') {
    out = { lat: n.lat, lon: n.lon, matched: A + ' & ' + B + ', ' + town, src: 'overpass', confident: true };
  }
  await cachePut(key, out);
  return out;
}

// The public instance answers 504 under load often enough that one endpoint is
// a single point of failure for every corner in the city. The mirrors run the
// same software over the same data, so a failure is worth one retry elsewhere
// before giving up on the call.
const OVERPASS_EPS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
//
// Ingest runs on a clock, so the mirrors get a shrinking share of one budget
// rather than a fresh timeout each. Three endpoints at twelve seconds apiece is
// thirty six seconds spent on a single corner while the rest of the batch
// waits, and a corner is never worth that.
const OVERPASS_BUDGET_MS = Number(process.env.OVERPASS_BUDGET_MS || 9000);

async function overpassRun(q, budgetMs = OVERPASS_BUDGET_MS) {
  const deadline = Date.now() + budgetMs;
  for (const ep of OVERPASS_EPS) {
    const left = deadline - Date.now();
    if (left < 1200) break;
    try {
      const r = await fetch(ep, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
        body: 'data=' + encodeURIComponent(q),
        signal: AbortSignal.timeout(Math.min(left, 8000)),
      });
      if (!r.ok) continue;
      return await r.json();
    } catch (e) { /* try the next mirror */ }
  }
  return null;
}

/* Every street that actually meets this one. A garbled name matched against all
   four thousand roads in Boston finds whatever is nearest in spelling and means
   nothing by it. Matched against the eleven roads that genuinely cross Chestnut
   Avenue, the same garble has a real answer, because the anchor has already
   ruled out everything that could not be there. Cached hard: which streets meet
   which does not change. */
async function overpassCrossings(street, town, at) {
  if (!OVERPASS_ON || !street || !town || !at) return null;
  const key = 'bcc:geo:xlist:' + norm(street + '|' + town).replace(/[^a-z0-9 ,&.'|-]/g, '').slice(0, 180);
  let cached;
  try { cached = await kv.get(key); } catch (e) { cached = null; }
  if (cached === MISS) return null;
  if (cached) { try { const a = JSON.parse(cached); if (Array.isArray(a)) return a; } catch (e) { /* refetch */ } }

  const esc = s => String(s).replace(/["\\]/g, '');
  const q = '[out:json][timeout:15][bbox:' + boxAround([at], 0.035) + '];' +
    'way["name"="' + esc(street) + '"]["highway"]->.w1;' +
    'node(w.w1)->.n1;' +
    'way(bn.n1)["highway"]["name"];' +
    'out tags;';

  const j = await overpassRun(q);
  if (!j) return null;
  const names = [...new Set((j.elements || [])
    .map(e => e.tags && e.tags.name)
    .filter(n => n && n !== street))];
  try {
    if (names.length) await kv.set(key, JSON.stringify(names), TTL_HIT);
    else await kv.set(key, MISS, TTL_MISS);
  } catch (e) { /* a cold cache is slow, not broken */ }
  return names.length ? names : null;
}

// --------------------------------------------------------------- street index

/* A street name with no house number. The local index answers instantly, has no
   rate limit, and repairs the spelling on the way through. Nominatim is the
   fallback for a town the index does not cover. */
async function streetPoint(name, town) {
  if (streets && streets.has(town)) {
    const c = streets.correct(name, town);
    if (c) {
      return {
        // A street that runs along a town line is filed under one of the two.
        // The label says where the road actually is, because a Cambridge feed
        // calling a Beacon Street incident "Beacon Street, Cambridge" when the
        // pin is on the Somerville side is the kind of small wrong that a
        // reporter finds out about from a reader.
        lat: c.lat, lon: c.lon,
        matched: c.name + ', ' + (c.from || town),
        src: c.exact ? 'street-index' : 'street-index-fuzzy',
        heard: c.exact ? undefined : String(name).trim(),
        confident: true,
      };
    }
  }
  // The index missed, or does not cover this town. Nominatim still knows things
  // the crawl does not: highway ramps, a road that carries its name across a
  // town line, a square that reads like a street. The word check inside
  // nominatim() is what keeps a bounded search from quietly answering a
  // different question.
  return await nominatim(cleanStreet(name) + ' Street, ' + town + ', MA')
      || await nominatim(name + ', ' + town + ', MA');
}

/* One half of a corner arrived clean and the other did not. Take the clean half
   as the anchor, ask OSM which streets cross it, and match the damaged half
   against that list. "Oxnard" against all of Boston finds Oswald Street two
   kilometres from anything; against the roads that truly cross Chestnut Avenue
   it either finds the one that was meant or it finds nothing, and both of those
   are correct answers. */
async function anchorCorner(anchorName, otherName, town) {
  if (!(streets && streets.has(town))) return null;
  const anchor = streets.exactRow(anchorName, town);
  if (!anchor) return null;                        // only a name that came through intact
  if (streets.exactRow(otherName, town)) return null;   // both clean, the pair path had its shot

  const names = await overpassCrossings(anchor.name, town, [anchor.lat, anchor.lon]);
  if (!names || !names.length) return null;
  const pickName = streets.bestOf(otherName, names);
  if (!pickName) return null;

  const other = streets.exactRow(pickName.name, town);
  const hint = other ? [[anchor.lat, anchor.lon], [other.lat, other.lon]] : null;
  const x = await overpassIntersection(anchor.name, pickName.name, town, hint);
  if (!x) return null;
  return {
    ...x,
    matched: anchor.name + ' & ' + pickName.name + ', ' + town,
    src: 'overpass-anchor',
    heard: cleanStreet(anchorName) + ' & ' + cleanStreet(otherName),
  };
}

/* A corner. Guess generously on each half, then prove the guess by asking OSM
   whether the two streets actually share a node. That validation is what makes
   it safe to correct "Ox and Summer" into "Fox and Summer". */
async function cornerPoint(a, b, town) {
  const A = cleanStreet(a), B = cleanStreet(b);
  if (!A || !B || !town) return null;

  // The index gets the name as it was said, not the cleaned one. cleanStreet
  // drops the type word because Nominatim will happily answer a wrong one, but
  // to the index that word is evidence: "Mass Ave" is Massachusetts Avenue and
  // "Mass" on its own scores the Massachusetts Turnpike just as well. Stripping
  // it before the lookup was putting Turnpike labels on Back Bay corners.
  const ra = String(a || '').trim(), rb = String(b || '').trim();

  if (!(streets && streets.has(town))) {
    return await overpassIntersection(A, B, town);
  }

  // Every corner in these towns was crawled once and shipped, so the common
  // case answers from memory with no network at all. This is not only faster.
  // Timed against the public Overpass instances over an hour, the same query
  // took under a second warm, twenty five seconds loaded, and returned a 504
  // often enough that half a test batch came back empty, and a map that goes
  // blank when a server three time zones away is busy is not a map a newsroom
  // can watch during a breaking story.
  //
  // Having the table also widens what the matcher may attempt. Guessing at one
  // garbled street name across four thousand roads is dangerous, because the
  // nearest spelling is usually the wrong road. Guessing at a pair is safe,
  // because a pair that does not appear in the table is never returned, so a
  // wrong guess costs nothing and a right one is proved on the spot.
  const local = streets.cornerFor(ra, rb, town);
  if (local) {
    const fixed = streets.core(local.a) !== streets.core(ra) || streets.core(local.b) !== streets.core(rb);
    return {
      lat: local.lat, lon: local.lon,
      matched: local.a + ' & ' + local.b + ', ' + (local.town || town),
      src: local.exact && !fixed ? 'corner-index' : 'corner-index-fuzzy',
      heard: fixed ? A + ' & ' + B : undefined,
      confident: true,
    };
  }

  // One half clean, the other too damaged to place across a whole city. The
  // roads that genuinely cross the half we trust are a pre-validated shortlist
  // of about thirty names, and a loose match against thirty names means
  // something where the same match against four thousand does not.
  const anchoredLocal = streets.anchoredCorner(ra, rb, town) || streets.anchoredCorner(rb, ra, town);
  if (anchoredLocal) {
    return {
      lat: anchoredLocal.lat, lon: anchoredLocal.lon,
      matched: anchoredLocal.a + ' & ' + anchoredLocal.b + ', ' + town,
      src: 'corner-index-anchor',
      heard: A + ' & ' + B,
      confident: true,
    };
  }

  // Towns the corner crawl has not reached yet fall through to the network.
  // Towns it has reached do not: the table is the whole truth about which roads
  // in them meet, so a miss here is an answer and not a gap to go fill.
  if (streets.hasCorners(town)) {
    const pairsOnly = streets.pairsFor(ra, rb, town, 9000, 3);
    const nearOnly = pairsOnly.find(p => p.apart <= 800);
    return nearOnly ? approxPair(nearOnly, A, B, town) : null;
  }

  const pairs = streets.pairsFor(ra, rb, town, 9000, 3);

  for (const p of pairs.slice(0, 2)) {
    const x = await overpassIntersection(p.a.name, p.b.name, town,
                                         [[p.a.lat, p.a.lon], [p.b.lat, p.b.lon]]);
    if (x) {
      const fixed = streets.core(p.a.name) !== streets.core(A) || streets.core(p.b.name) !== streets.core(B);
      return fixed ? { ...x, heard: A + ' & ' + B } : x;
    }
  }

  // Neither guessed pair meets. That usually means one half came through clean
  // and the other is too mangled for a citywide search to place, which is the
  // case the anchor handles: ask what actually crosses the half we trust, and
  // match the wreckage against that short list instead of against the city.
  const anchored = await anchorCorner(A, B, town) || await anchorCorner(B, A, town);
  if (anchored) return anchored;

  // OSM records no shared node. Two streets that both exist and sit a block or
  // two apart still locate the call well enough to put on a map, so long as it
  // is never called exact.
  const near = pairs.find(p => p.apart <= 800);
  if (near) return approxPair(near, A, B, town);
  return null;
}

// Two streets that both exist and sit a block or two apart still locate a call
// well enough to put on a map, so long as it is never called exact. approx is
// what stops the correlator welding this to a real fix nearby.
function approxPair(p, A, B, town) {
  return {
    lat: (p.a.lat + p.b.lat) / 2,
    lon: (p.a.lon + p.b.lon) / 2,
    matched: p.a.name + ' & ' + p.b.name + ', ' + town,
    src: 'street-index-pair',
    heard: A + ' & ' + B,
    approx: true,
    confident: true,
  };
}

// --------------------------------------------------------------- field repair

const looksLikeNothing = s => {
  const t = String(s || '').trim().toLowerCase();
  // The model occasionally returns the STRING "null", and occasionally invents
  // a "landmark" out of transcription noise. Neither is a place.
  return !t || t === 'null' || t === 'none' || t === 'unknown' || t === 'n/a' || t.length < 3;
};

const CROSS_SPLIT = /\s+(?:and|&|\/|at the corner of|corner of)\s+/i;

/* The extractor is told to put a numbered address in `address` and a bare
   street in `street`, and it does not reliably do it. Live traffic had
   "Hopper View Street" sitting in `address` with `street` empty across every
   event, which sent a bare street name down the house-number path and wasted
   the street index entirely. Sorting the fields out here is deterministic and
   costs nothing, so this stops being a prompt-engineering problem. */
function repairFields(ex, text) {
  if (!ex) return ex;
  const out = { ...ex };

  let addr = looksLikeNothing(out.address) ? '' : String(out.address).trim();

  // A town or neighbourhood riding on the end of an address is a fact worth
  // keeping, and it is not part of the street.
  if (addr.includes(',')) {
    const parts = addr.split(',').map(s => s.trim()).filter(Boolean);
    while (parts.length > 1) {
      const tail = parts[parts.length - 1];
      if (/^(ma|mass|massachusetts|usa|\d{5})$/i.test(tail)) { parts.pop(); continue; }
      if (places.isKnownTown(tail)) { if (looksLikeNothing(out.town)) out.town = tail; parts.pop(); continue; }
      const p = places.byName(tail, []);
      if (p && (p.kind === 'town' || p.kind === 'neighborhood') && p.town) {
        if (looksLikeNothing(out.town)) out.town = p.town;
        parts.pop();
        continue;
      }
      break;
    }
    addr = parts.join(', ');
  }

  // A corner filed as an address.
  if (addr && !hasHouseNumber(addr) && CROSS_SPLIT.test(addr) && looksLikeNothing(out.crossStreet)) {
    out.crossStreet = addr;
    addr = '';
  }

  // A bare street filed as an address. This is the common one.
  if (addr && !hasHouseNumber(addr)) {
    if (looksLikeNothing(out.street)) out.street = addr;
    addr = '';
  }

  // And the mirror image: a numbered address filed as a street.
  const st = looksLikeNothing(out.street) ? '' : String(out.street).trim();
  if (!addr && st && hasHouseNumber(st)) { addr = st; out.street = null; }

  out.address = addr || null;

  // A cross street with only one side named is just a street.
  if (!looksLikeNothing(out.crossStreet)) {
    const parts = String(out.crossStreet).split(CROSS_SPLIT).map(s => cleanStreet(s)).filter(Boolean);
    if (parts.length < 2 && looksLikeNothing(out.street) && !out.address) {
      out.street = String(out.crossStreet).trim();
      out.crossStreet = null;
    }
  }

  return out;
}

// --------------------------------------------------------------- cascade

/* Which town is this transmission about?
   A town said out loud beats the feed's default. A feed that covers exactly one
   town supplies it. A feed that covers forty and never named one leaves this
   null, and everything below that needs a town declines to guess. */
function decideTown(ex, text, city, towns) {
  const scope = Array.isArray(towns) ? towns.filter(Boolean) : [];
  if (ex && !looksLikeNothing(ex.town) && places.isKnownTown(ex.town)) return ex.town;
  const spoken = places.townInText(text || '', scope);
  if (spoken) return spoken;
  if (scope.length === 1) return scope[0];
  if (!scope.length && city) return city;
  return null;                       // ambiguous on purpose
}

/* Resolve one transmission to a point, or honestly to nothing.
   `text` is the raw transcript and is load-bearing: the gazetteer reads it
   directly, so a place named in passing still lands even when the extractor
   returned no fields at all. */
async function geocodeEx(rawEx, city, opts = {}) {
  const towns = Array.isArray(opts.towns) ? opts.towns.filter(Boolean) : (city ? [city] : []);
  const text = opts.text || '';
  const ex = repairFields(rawEx, text);
  const town = decideTown(ex, text, city, towns);
  const ambiguous = !town;          // multi-town feed that never named a town

  if (ex) {
    // 1. a real street address, which is the only precise answer there is
    if (!looksLikeNothing(ex.address) && town) {
      const g = await geocode(ex.address, town); if (g) return { ...g, town };
      const n = await nominatim(ex.address + ', ' + town + ', MA'); if (n) return { ...n, town };
      // The number did not resolve. The street it sits on still might, and a
      // block is a better answer than an empty map.
      const bare = String(ex.address).replace(HOUSE_RE, '').trim() ||
                   String(ex.address).replace(/^\s*\d+\s*[a-z]?\s*/i, '').trim();
      if (bare.length >= 3) {
        const s = await streetPoint(bare, town);
        if (s) return { ...s, town, approx: true };
      }
    }
    // 2. a named place, checked against the local table before the network
    if (!looksLikeNothing(ex.landmark)) {
      const p = places.byName(ex.landmark, towns); if (p) return p;
      if (town) { const n = await nominatim(ex.landmark + ', ' + town + ', MA'); if (n) return { ...n, town }; }
    }
    // 3. a corner
    if (!looksLikeNothing(ex.crossStreet) && town) {
      const parts = String(ex.crossStreet).split(CROSS_SPLIT);
      if (parts.length >= 2) {
        const x = await cornerPoint(parts[0], parts[1], town);
        if (x) return { ...x, town };
      }
    }
    // 4. a street with no number. Not precise, and a great deal better than
    //    nothing when the whole neighbourhood is the story.
    if (!looksLikeNothing(ex.street) && town) {
      const s = await streetPoint(ex.street, town);
      if (s) return { ...s, town, approx: true };
    }
  }

  // 5. anything in the gazetteer named anywhere in the raw transcript. This is
  //    the step that catches the transmissions the model gave up on.
  const scanned = places.scanText(text, towns);
  if (scanned) return scanned;

  // 6. nothing specific, but the town itself is known and worth showing.
  if (town && !ambiguous && places.isKnownTown(town)) {
    const c = places.townCentroid(town);
    if (c) return { ...c, weak: true };
  }
  return null;
}

// Resolve a whole batch before the store mutex is taken.
async function geocodeBatch(items, { concurrency = 6 } = {}) {
  const out = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      try { out[i] = await geocodeEx(items[i].ex, items[i].city, { towns: items[i].towns, text: items[i].text }); }
      catch (e) { out[i] = null; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

module.exports = {
  geocode, nominatim, geocodeEx, geocodeBatch, overpassIntersection, overpassCrossings, anchorCorner, decideTown,
  repairFields, answersQuery, streetPoint, cornerPoint, osmVerdict,
  streetIndexCount: streets ? streets.count : 0,
};
