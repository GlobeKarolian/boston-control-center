// lib/places.js
// A Boston-area gazetteer that lives in the deployment, not on the network.
//
// The old cascade sent every location string to Nominatim, which is rate
// limited to one call per second across the whole fleet and answers "no" to
// anything it does not recognise verbatim. Measured on live traffic, 76% of
// transmissions produced no location field at all and only 58% of the ones
// that did ever resolved.
//
// Most of what a Boston scanner says is not an address. It is "Fenway", "the
// Brigham", "Nubian", "93 north in Somerville", "Harvard Square". Those are a
// closed set. They are in places.json, resolved once against real geocoders at
// build time, and matched here in microseconds with no network call and no
// rate limit.
//
// The second thing this file does is answer the question a street name alone
// cannot: WHICH TOWN. Every town in Massachusetts has a Main Street. A feed
// declares the municipalities its transmitter covers, and a name is only
// accepted if it sits in one of them. A state police feed covering forty towns
// gets no pin from a bare street name, on purpose, because a pin in the wrong
// town is worse than no pin at all.

const TABLE = require('./places.json');

/* Compact rows keep the shipped file small: [name, aliases, lat, lon, town, kind, linear] */
const PLACES = TABLE.map(r => ({
  name: r[0], aliases: r[1], lat: r[2], lon: r[3], town: r[4], kind: r[5], linear: !!r[6],
}));

const norm = s => String(s || '')
  .toLowerCase()
  .replace(/[^a-z0-9 ]+/g, ' ')     // apostrophes, periods and hyphens all vanish
  .replace(/\s+/g, ' ')
  .trim();

/* alias -> [place]. One alias can legitimately name two places ("central
   square" is in Cambridge and in East Boston), which is what town scoping is
   for. */
const INDEX = new Map();
for (const p of PLACES) {
  for (const a of p.aliases) {
    const k = norm(a);
    if (!k) continue;
    if (!INDEX.has(k)) INDEX.set(k, []);
    INDEX.get(k).push(p);
  }
}

/* Longest alias first. "harvard square" must win over "harvard", and
   "east boston" over "boston". */
const ALIASES = [...INDEX.keys()].sort((a, b) => b.length - a.length);
const MAX_WORDS = Math.max(...ALIASES.map(a => a.split(' ').length));

const TOWNS = new Map();
for (const p of PLACES) if (p.kind === 'town') TOWNS.set(norm(p.town), p);

/* A one-word alias that is also an ordinary English word would fire constantly.
   These are the ones worth blocking outright. */
const TOO_COMMON = new Set(['common', 'garden', 'station', 'center', 'centre', 'square', 'the garden',
  'park', 'hospital', 'library', 'the airport', 'the tunnel', 'downtown', 'union square', 'city hall']);

/* Numbered roads need context. "93" inside "93 Beacon Street" is a house
   number; "on 93" is a highway. Only the second is a place. */
const ROAD_CUE = /\b(route|rt|interstate|i|highway|hwy|on|off|northbound|southbound|eastbound|westbound|exit)\b/;

function usable(alias, place, text) {
  if (TOO_COMMON.has(alias)) return false;
  if (place.kind === 'road' && /\d/.test(alias)) {
    // require a cue word near the number, or a direction after it
    const near = new RegExp('(' + ROAD_CUE.source + '\\s+' + alias + '\\b)|(\\b' + alias + '\\s+(north|south|east|west|bound)\\b)');
    if (!near.test(text)) return false;
  }
  return true;
}

const townKey = t => norm(t).replace(/\bma\b|\bmass\b|\bmassachusetts\b/g, '').trim();

/* Scoping. `towns` is the feed's declared coverage. An empty list means the
   feed did not say, so nothing is filtered and confidence drops instead. */
function inScope(place, towns) {
  if (!towns || !towns.length) return true;
  const want = towns.map(townKey);
  return want.includes(townKey(place.town));
}

/* Read a transcript and return the most specific known place named in it.
   This runs on the RAW TEXT, not on the extractor's output, which is the whole
   point: it catches "there's a fight outside the Brigham" even when the model
   returned no landmark at all. */
function scanText(text, towns) {
  const t = norm(text);
  if (!t) return null;
  const words = t.split(' ');
  let best = null;

  for (let n = Math.min(MAX_WORDS, words.length); n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const phrase = words.slice(i, i + n).join(' ');
      const hits = INDEX.get(phrase);
      if (!hits) continue;
      for (const p of hits) {
        if (!usable(phrase, p, t)) continue;
        const scoped = inScope(p, towns);
        // A town centroid is the weakest useful answer, so it never beats a
        // named place, and an out-of-scope hit never beats an in-scope one.
        const score = (scoped ? 100 : 0) + (p.kind === 'town' ? 0 : 40) + phrase.length;
        if (!best || score > best.score) {
          best = { score, place: p, alias: phrase, scoped };
        }
      }
    }
    if (best && best.score >= 140) break;   // an in-scope named place is good enough
  }
  if (!best) return null;

  return {
    lat: best.place.lat,
    lon: best.place.lon,
    matched: best.place.name + (best.place.town && best.place.kind !== 'town' ? ', ' + best.place.town : ''),
    src: 'gazetteer',
    kind: best.place.kind,
    town: best.place.town,
    // A road or a town centroid is a neighbourhood-level answer and should not
    // be drawn as though someone stood on that spot.
    approx: best.place.linear || best.place.kind === 'town',
    confident: best.scoped,
  };
}

/* Look up a name the extractor handed us, e.g. landmark: "Fenway Park". */
function byName(name, towns) {
  if (!name) return null;
  const k = norm(name);
  const hits = INDEX.get(k);
  if (!hits || !hits.length) return null;
  const scoped = hits.find(p => inScope(p, towns)) || hits[0];
  return {
    lat: scoped.lat, lon: scoped.lon,
    matched: scoped.name + (scoped.town && scoped.kind !== 'town' ? ', ' + scoped.town : ''),
    src: 'gazetteer', kind: scoped.kind, town: scoped.town,
    approx: scoped.linear || scoped.kind === 'town',
    confident: inScope(scoped, towns),
  };
}

function townCentroid(town) {
  const p = TOWNS.get(townKey(town));
  if (!p) return null;
  return { lat: p.lat, lon: p.lon, matched: p.name, src: 'gazetteer', kind: 'town', town: p.name, approx: true, confident: true };
}

/* Which town is this transmission about? A town named out loud beats the
   feed's default, which is how a state police feed ever gets placed. */
function townInText(text, towns) {
  const t = norm(text);
  const words = t.split(' ');
  for (let n = 2; n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const phrase = words.slice(i, i + n).join(' ');
      if (TOWNS.has(phrase) && (!towns || !towns.length || inScope({ town: phrase }, towns))) {
        return TOWNS.get(phrase).name;
      }
    }
  }
  return null;
}

const isKnownTown = t => TOWNS.has(townKey(t));

module.exports = { scanText, byName, townCentroid, townInText, isKnownTown, count: PLACES.length };
