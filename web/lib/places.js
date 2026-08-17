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
  'lane', 'ln', 'court', 'ct', 'terrace', 'ter', 'boulevard', 'blvd', 'parkway', 'pkwy',
  'highway', 'hwy']);
/* Deliberately NOT here: circle, way, row, path, wharf. Each is the tail of a
   real named place a dispatcher says out loud, and adding them cost Charles
   Circle, which is a rotary rather than a street and resolved fine before. */

/* A house number in front says the same thing from the other side: "155
   Harvard" is an address even when the speaker drops the "Street".
 *
 * The hard part is that a scanner is made of numbers in front of words.
 * "Engine 4, Ladder 24, Fenway" is not an address on Fenway, and neither are
 * "Car 12, Andrew", "District 4, Copley", "Sector 3, Chinatown" or
 * "Box 2242, Nubian". Two things separate them from "155 Harvard":
 *
 *   the comma      a unit designator is punctuated off from what follows, and
 *                  an address never is. This is checked against the RAW text,
 *                  because norm() strips punctuation and takes the evidence
 *                  with it.
 *   the word before the number, which on the radio names the apparatus.
 *
 * Both have to be clean before a number is read as a house number. Getting
 * this wrong costs a real place on every transmission that names its units,
 * which is most of them. */
const UNIT_WORD = /\b(engine|ladder|truck|tower|car|unit|units|district|sector|box|ems|medic|ambulance|rescue|squad|brush|tanker|marine|division|group|tac|cruiser|companies|company|command|air|boat|dive|haz|hazmat|special|support)\s*$/i;
const RX_ESC = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function addressedBy(alias, raw) {
  const m = new RegExp('(^|[^\\w])(\\w+\\s+)?(\\d{1,5}[a-z]?)\\s+' + RX_ESC(alias) + '\\b', 'i').exec(String(raw || ''));
  if (!m) return false;                      // no number directly in front at all
  if (UNIT_WORD.test(m[2] || '')) return false;   // "Ladder 24 Fenway" is apparatus
  return true;
}

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
const TRANSIT_CUE = /\b(platform|inbound|outbound|trolley|streetcar|train|tracks|green line|red line|orange line|blue line|silver line|commuter rail|mbta|transit|t stop|turnstile|conductor|derail|third rail|fare|busway)\b/;
/* "station" is not in there on purpose. On a fire or police channel the most
   common things said about a station are gas station, fire station, police
   station and back at the station, and letting any of them arm this guard puts
   a Brighton trolley stop on a Washington Street gas fire. The gazetteer
   already carries "<name> station" as its own, longer alias, so anyone who
   actually says it gets the stop without needing a cue at all. */

/* The gazetteer files trolley stops, subway stops and commuter rail as
   different kinds. All three are equally capable of being named after the
   street they sit on: Blue Hill Avenue, Morton Street and Talbot Avenue are
   commuter rail stops AND arterials that run for miles. */
const RAIL_KIND = new Set(['station', 'commuter rail']);

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
       the second is caught because the alias carries it. "1 Fenway Park" is a
       place and survives, and so does "Ladder 24, Fenway", because
       addressedBy() reads the raw text and refuses a number that is punctuated
       off or that follows an apparatus word. */
    if ((namedForItsStreet || alias.indexOf(' ') === -1) && addressedBy(alias, ctx.raw)) return false;
    if (namedForItsStreet && RAIL_KIND.has(place.kind) && !TRANSIT_CUE.test(text)) return false;
    /* Same argument, different collision: several stops are named after towns
       ("Arlington", "Brookline Village", "Newton Centre"). On a scanner the
       town is the far more common meaning, so the stop needs the sentence to
       sound like transit before it can claim the word. */
    if (RAIL_KIND.has(place.kind) && TOWNS.has(alias) && !TRANSIT_CUE.test(text)) return false;
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
      const ctx = { prev: words[i - 1] || '', next: words[i + n] || '', raw: text };
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
    /* And a town centroid is weaker than that: it is a point that means "this
       municipality", not "this spot". Saying so is what stops the archive
       search from concluding that every call naming only "Boston" happened
       downtown, because the centroid physically sits there. */
    weak: best.place.kind === 'town' ? true : undefined,
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
    weak: scoped.kind === 'town' ? true : undefined,
    confident: inScope(scoped, towns),
  };
}

function townCentroid(town) {
  const p = TOWNS.get(townKey(town));
  if (!p) return null;
  return { lat: p.lat, lon: p.lon, matched: p.name, src: 'gazetteer', kind: 'town', town: p.name, approx: true, weak: true, confident: true };
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
