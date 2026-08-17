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

/* THE WORD AFTER DECIDES WHETHER THIS IS A PLACE OR A STREET.
 *
 * Half the landmarks in eastern Massachusetts are also street names somewhere
 * else in eastern Massachusetts. "155 Harvard Street, Needham" put a Needham
 * fire on the Red Line platform in Cambridge, at station precision, because
 * the scan saw the word "harvard" and stopped reading. Washington, Lincoln,
 * Adams, Beacon, Newton, Brighton and Dorchester all have the same shape.
 *
 * A name immediately followed by a street type is a street. Nothing else needs
 * to be known about it. The longest alias already wins, so a genuine
 * multi-word place whose own name ends in a street type ("Newbury Street")
 * matches whole and is never followed by a second street type.
 *
 * This one rule is worth more than it looks: a scene geocoded into the wrong
 * town cannot join the transmissions it belongs with, so a wrong pin does not
 * just misplace a card, it splits one. */
const STREET_TYPE = new Set(['street', 'st', 'avenue', 'ave', 'av', 'road', 'rd', 'drive', 'dr',
  'lane', 'ln', 'place', 'pl', 'court', 'ct', 'circle', 'cir', 'terrace', 'ter', 'way',
  'boulevard', 'blvd', 'parkway', 'pkwy', 'highway', 'hwy', 'row', 'wharf', 'path',
  'alley', 'crescent', 'extension', 'ext']);

/* A house number in front says the same thing from the other side: "155
   Harvard" is an address even when the speaker drops the "Street". */
const isHouseNumber = w => /^\d{1,5}[a-z]?$/.test(w || '');

/* STOPS NAMED AFTER THE STREET THEY SIT ON.
 *
 * The Green Line and the Mattapan line name most of their surface stops after
 * the street: Washington Street, Park Street, South Street, Harvard Avenue,
 * Massachusetts Avenue, Central Avenue, Valley Road, Allston Street. Every one
 * of those is also an ordinary street somewhere in the coverage area, usually
 * in several towns at once, and the trolley stop is by far the rarer thing to
 * be talking about. Left alone, one of these hijacks every mention of that
 * street across the region and pins it to a platform in Brookline.
 *
 * So a bare street name resolves to the stop only when the transmission sounds
 * like transit. The gazetteer already carries "<name> station" as a separate,
 * longer alias, and longest-alias-first means anybody who says the word gets
 * the stop without needing any of this. */
const ST_TYPE_TAIL = /\b(street|st|avenue|ave|av|road|rd|drive|dr|lane|ln|place|pl|court|ct|circle|cir|terrace|ter|way|boulevard|blvd|parkway|pkwy|highway|hwy|row|path)$/;
const TRANSIT_CUE = /\b(station|platform|inbound|outbound|trolley|streetcar|train|tracks|green line|red line|orange line|blue line|silver line|mattapan|mbta|transit|the t|t stop|conductor|derail|third rail|fare)\b/;

function usable(alias, place, text, ctx) {
  if (TOO_COMMON.has(alias)) return false;
  if (place.kind === 'road' && /\d/.test(alias)) {
    // require a cue word near the number, or a direction after it
    const near = new RegExp('(' + ROAD_CUE.source + '\\s+' + alias + '\\b)|(\\b' + alias + '\\s+(north|south|east|west|bound)\\b)');
    if (!near.test(text)) return false;
  }
  if (ctx && place.kind !== 'road' && place.kind !== 'town') {
    if (STREET_TYPE.has(ctx.next)) return false;
    const namedForItsStreet = ST_TYPE_TAIL.test(alias);
    /* "155 Harvard" and "22 Washington Street" are both addresses. The first
       needs the single-word test because the speaker dropped the street type;
       the second is caught because the alias carries it. "1 Fenway Park" is
       neither and stays a place. */
    if (isHouseNumber(ctx.prev) && (namedForItsStreet || alias.indexOf(' ') === -1)) return false;
    if (namedForItsStreet && place.kind === 'station' && !TRANSIT_CUE.test(text)) return false;
    /* Same argument, different collision: several stops are named after towns
       ("Arlington", "Brookline Village", "Newton Centre"). On a scanner the
       town is the far more common meaning, so the stop needs the sentence to
       sound like transit before it can claim the word. */
    if (place.kind === 'station' && TOWNS.has(alias) && !TRANSIT_CUE.test(text)) return false;
    /* "Arlington and Boylston" is a corner, and both arms of it happen to be
       Green Line stops. A name sitting next to "and" is one street of two, not
       a platform, unless the sentence says otherwise. The corner path in
       lib/geo.js runs well before this scan and resolves these properly; this
       only stops the last-resort scan from planting a precise pin on the wrong
       thing when the corner could not be found. */
    if (place.kind === 'station' && (ctx.next === 'and' || ctx.prev === 'and') && !TRANSIT_CUE.test(text)) return false;
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
      const ctx = { prev: words[i - 1] || '', next: words[i + n] || '' };
      for (const p of hits) {
        if (!usable(phrase, p, t, ctx)) continue;
        const scoped = inScope(p, towns);
        /* A town centroid is only ever a fallback, and a fallback to a town
           this feed does not cover is not a fallback, it is a wrong pin in
           another county. Named places out of scope are still allowed through
           at low confidence, because a landmark is a specific claim and the
           feed's declared coverage is sometimes just incomplete. */
        if (!scoped && p.kind === 'town' && towns && towns.length) continue;
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
