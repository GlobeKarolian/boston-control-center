// lib/vault-query.js
//
// Turns what a reporter types into what the archive can answer.
//
//   "big fire last night in Back Bay"
//     -> { from, to, type: 'fire', place: 'back bay', big: true, words: [] }
//
// No model here on purpose. The question a newsroom asks about a scanner
// archive is almost always made of four things: when, what kind of call,
// where, and how serious. All four already exist as fields on every archived
// transmission, because the pipeline computed them to put the pin on the map.
// So the common case is a database query wearing a sentence, and plain code
// answers it instantly, for free, and identically every time.
//
// A model earns its place on the questions this cannot reach: "the call where
// somebody was yelling about a dog". Those fall through to the leftover words
// and get matched against the transcript text, which covers most of the rest.
// If that stops being enough, this is the seam where a model gets added, and
// nothing above it has to change.
//
// WHAT THIS GOT WRONG THE FIRST TIME, because it is the whole reason the
// search was useless and the failure mode is worth naming:
//
//   1. Every transmission inside the time window started at score 1. A query
//      with no type and no place therefore matched all of them, and "1,768
//      scanned, 1,768 matched" is not a search, it is a date filter wearing
//      one. Evidence is now required: if the question carries any criteria at
//      all, a transmission has to satisfy at least one of them to come back.
//
//   2. Words were matched with String.includes, so "body" matched "somebody"
//      seventeen times in one night and never once meant a body. Matching is
//      now on token boundaries.
//
//   3. There was nowhere to put "TD Garden". The archive knows neighborhoods
//      and towns; a newsroom says landmarks. A body in the Garden parking
//      garage was unfindable by the name every reporter in the building would
//      use for it.
//
//   node tools/test-vault-query.js

'use strict';

const TZ = 'America/New_York';

/* Eastern wall-clock parts for an instant, so "last night" means the night the
   newsroom lived through rather than a UTC day boundary that splits it. */
function partsIn(d) {
  const p = {};
  new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).forEach(x => { p[x.type] = x.value; });
  return { y: +p.year, m: +p.month, d: +p.day, hh: (+p.hour) % 24, mm: +p.minute };
}

/* Eastern offset at an instant, as milliseconds, so a local wall time can be
   turned back into a real one across both halves of the year. */
function offsetMs(at) {
  const p = partsIn(at);
  const asUTC = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
  return asUTC - (Math.floor(+at / 60000) * 60000);
}

/* A local Eastern wall time on a given day, as a real instant. */
function easternAt(y, m, d, hh, mm, near) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const off = offsetMs(new Date(near || guess));
  return new Date(guess - off);
}

function dayString(at) {
  const p = partsIn(at);
  return p.y + '-' + String(p.m).padStart(2, '0') + '-' + String(p.d).padStart(2, '0');
}

/* WHEN.

   "last night" is the one that matters and the one a naive parser gets wrong.
   A newsroom saying it at 2am on Wednesday means Tuesday evening through the
   small hours it is currently sitting in, not Tuesday 00:00 to 23:59. So a
   night runs 6pm to 6am and, when it is currently before 6am, it is the night
   that is still happening. Everything else is ordinary. */
function whenOf(q, now) {
  const t = now ? new Date(now) : new Date();
  const p = partsIn(t);
  const dayMs = 86400000;
  const startOfDay = (back) => {
    const b = new Date(+t - back * dayMs);
    const bp = partsIn(b);
    return easternAt(bp.y, bp.m, bp.d, 0, 0, b);
  };
  const endOfDay = (back) => new Date(+startOfDay(back) + dayMs);

  const night = (back) => {
    /* Before 6am, "last night" is the evening that ran into right now. */
    const shift = (p.hh < 6 && back === 0) ? 1 : back;
    const b = new Date(+t - shift * dayMs);
    const bp = partsIn(b);
    return {
      from: easternAt(bp.y, bp.m, bp.d, 18, 0, b),
      to: new Date(+easternAt(bp.y, bp.m, bp.d, 18, 0, b) + 12 * 3600000),
      label: shift === 0 ? 'tonight' : 'last night',
    };
  };

  if (/\blast night\b|\byesterday night\b|\bovernight\b/i.test(q)) return night(0);
  if (/\btonight\b|\bthis evening\b/i.test(q)) {
    const r = night(p.hh < 6 ? 1 : 0); r.label = 'tonight'; return r;
  }
  if (/\byesterday\b/i.test(q)) return { from: startOfDay(1), to: endOfDay(1), label: 'yesterday' };
  if (/\bthis morning\b/i.test(q)) {
    const s = startOfDay(0);
    return { from: s, to: new Date(+easternAt(p.y, p.m, p.d, 12, 0, t)), label: 'this morning' };
  }
  if (/\btoday\b/i.test(q)) return { from: startOfDay(0), to: new Date(+t), label: 'today' };
  if (/\blast (week|7 days)\b|\bpast week\b/i.test(q)) return { from: new Date(+t - 7 * dayMs), to: new Date(+t), label: 'the last week' };
  if (/\blast (month|30 days)\b|\bpast month\b/i.test(q)) return { from: new Date(+t - 30 * dayMs), to: new Date(+t), label: 'the last month' };
  if (/\blast (hour|60 minutes)\b/i.test(q)) return { from: new Date(+t - 3600000), to: new Date(+t), label: 'the last hour' };
  const iso = q.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const from = easternAt(+iso[1], +iso[2], +iso[3], 0, 0, t);
    return { from, to: new Date(+from + dayMs), label: iso[0] };
  }
  // Nothing said: the last two days, which is what "find me the thing" means
  // in a room that works in shifts.
  return { from: new Date(+t - 2 * dayMs), to: new Date(+t), label: 'the last two days' };
}

/* WHAT. The call types the extractor already assigns, plus the words a person
   actually uses for them. "working fire" and "structure fire" are both fire;
   nobody types "callType:fire".

   Order matters: the first pattern that matches the question wins, so the
   specific sits above the general. "body" has to beat "medical" or a death
   search returns every ambulance run of the night. */
const TYPES = {
  death: /\b(body|bodies|deceased|dead|doa|fatal|fatality|fatalities|coroner|medical examiner|untimely|jumper|drowning|drowned)\b/i,
  shooting: /\b(shootings?|shots fired|gunshots?|gunfire|shot)\b/i,
  /* "slashed" is not here on purpose: on a police channel it is nearly always
     tires, and a person who was slashed arrives with knife or stab words in
     the same breath. */
  stabbing: /\b(stabbings?|stabbed|stab|knife|knives|slashing)\b/i,
  fire: /\b(fires?|working fire|structure fire|smoke|alarm of fire|box alarm|arson)\b/i,
  crash: /\b(crash(es)?|accidents?|mva|collisions?|rollover|car into|struck by|pedestrian struck)\b/i,
  hazmat: /\b(hazmat|chemical|gas leak|spill|carbon monoxide)\b/i,
  pursuit: /\b(pursuit|chase|fleeing|failed to stop)\b/i,
  robbery: /\b(robbery|holdup|larceny|breaking and entering|burglary)\b/i,
  search: /\b(search|missing|water rescue|dive team|well being)\b/i,
  disturbance: /\b(disturbance|fight|assault|disorderly|brawl)\b/i,
  medical: /\b(medical|ems|ambulance|cardiac|overdose|seizure|unresponsive|injur)\w*\b/i,
};

/* Call types that are the same night from a different angle. A body is very
   often filed as a medical; a shooting almost always drags a medical with it.

   Kin is a TIEBREAK, never a door. The first version let a kin label count as
   evidence by itself, and "stabbing on lancaster street" came back wearing
   every ambulance run in the archive: one real result and thirty-eight
   decoys, because each medical cleared the bar on cousinhood alone. Now a
   kin-labeled transmission gets in only when something else on it matched,
   and the kinship just nudges it upward once it is already inside. */
const KIN = {
  death: ['medical', 'search'],
  medical: ['death'],
  shooting: ['medical', 'death'],
  stabbing: ['medical', 'death'],
  crash: ['medical'],
  fire: ['hazmat'],
  hazmat: ['fire'],
  robbery: ['disturbance'],
  disturbance: ['robbery'],
};

/* WHERE, part one. Boston's neighborhoods are what a reporter says; the
   archive stores a town and a matched address. Both get searched, so "Back
   Bay" finds a call whose town is Boston and whose address landed on
   Boylston St. */
const PLACES = [
  'back bay', 'south end', 'north end', 'east boston', 'south boston', 'southie',
  'dorchester', 'roxbury', 'mattapan', 'jamaica plain', 'roslindale', 'west roxbury',
  'hyde park', 'allston', 'brighton', 'charlestown', 'fenway', 'kenmore', 'seaport',
  'beacon hill', 'downtown', 'chinatown', 'mission hill', 'longwood',
  'cambridge', 'somerville', 'brookline', 'quincy', 'newton', 'medford', 'malden',
  'everett', 'chelsea', 'revere', 'winthrop', 'watertown', 'belmont', 'arlington',
  'lowell', 'lynn', 'waltham', 'framingham', 'braintree', 'milton', 'dedham',
];

const PLACE_ALIASES = {
  southie: 'south boston',
  eastie: 'east boston',
  jp: 'jamaica plain',
};

/* WHERE, part two, and the reason the Garden was unfindable.

   A reporter does not say "Causeway Street", they say "the Garden". The
   archive stores whatever came over the radio, which might be the street, the
   venue, the station, or the neighborhood, and any of the four is the same
   place to the person asking. Each entry is a canonical name and the strings
   that mean it, and matching any one of them counts.

   Aliases are kept tight on purpose. "Copley" does not list Boylston Street,
   because Boylston runs for two miles and half of it is nowhere near Copley;
   a landmark that quietly matches a whole neighborhood is worse than one that
   matches nothing, because the reporter cannot see it happening. */
const LANDMARKS = {
  'td garden': ['td garden', 'the garden', 'boston garden', 'fleetcenter', 'fleet center',
                'north station', 'causeway st', 'causeway street', 'legends way'],
  'fenway park': ['fenway park', 'lansdowne', 'yawkey way', 'jersey st', 'jersey street'],
  'logan airport': ['logan airport', 'logan intl', 'massport', 'terminal a', 'terminal b',
                    'terminal c', 'terminal e'],
  'south station': ['south station'],
  'back bay station': ['back bay station'],
  'boston common': ['boston common', 'the common', 'frog pond'],
  'public garden': ['public garden', 'swan boat'],
  'faneuil hall': ['faneuil hall', 'faneuil', 'quincy market'],
  'copley square': ['copley square', 'copley place', 'copley'],
  'prudential center': ['prudential center', 'prudential', 'the pru'],
  'city hall': ['city hall', 'government center'],
  'mass general': ['mass general', 'massachusetts general', 'mgh'],
  'brigham': ['brigham and women', 'the brigham'],
  'boston medical center': ['boston medical center', 'bmc'],
  'tufts medical': ['tufts medical', 'tufts med'],
  'seaport world trade': ['world trade center', 'convention center', 'bcec'],
  'bunker hill': ['bunker hill'],
  'harvard square': ['harvard square', 'harvard sq'],
  'kendall square': ['kendall square', 'kendall sq'],
  'assembly row': ['assembly row', 'assembly square'],
  'encore casino': ['encore boston', 'encore casino', 'wynn casino'],
  'gillette stadium': ['gillette stadium'],
  'boston university': ['boston university'],
  'northeastern': ['northeastern'],
  'zakim bridge': ['zakim'],
  'tobin bridge': ['tobin bridge'],
  'sumner tunnel': ['sumner tunnel'],
  'callahan tunnel': ['callahan tunnel'],
  'ted williams tunnel': ['ted williams tunnel'],
};

const BIG = /\b(big|major|serious|large|massive|bad|worst|significant|multiple alarm|second alarm|third alarm|working)\b/i;

/* Words that carry no signal for matching. Everything left after the parse is
   used as free text against the transcript, and leaving these in would match
   every line on the radio. */
const STOP = new Set(('the a an of in on at from to for and or all any me i we my our ' +
  'need needs want find finding show get give please can could would ' +
  'scanner transmissions transmission calls call audio radio recording ' +
  'about with was were is are be been there here that this those these ' +
  'last night yesterday today tonight morning evening afternoon week weeks ' +
  'hour hours day days month months big major serious large what when where ' +
  'who why how happened something anything everything ' +
  /* Verbs a question is built out of rather than about. "Body FOUND at the
     Garden" turns on the body and the Garden; "found" on its own would match
     every lost wallet on the radio and dilute the ranking of the ones that
     matched something real. */
  'found find located locate involving involved near around report reported ' +
  'happening going down over out').split(/\s+/));

/* Token set for a haystack, with a naive singular folded in beside every
   plural. Tokens rather than substrings because "body" is inside "somebody",
   which is how a search for a death in a parking garage came back with
   seventeen people asking somebody to check a tablet. */
function tokenize(s) {
  const set = new Set();
  for (const w of String(s || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (!w) continue;
    set.add(w);
    if (w.length > 3 && w.endsWith('s')) set.add(w.slice(0, -1));
    if (w.length > 4 && w.endsWith('es')) set.add(w.slice(0, -2));
    if (w.length > 5 && w.endsWith('ing')) set.add(w.slice(0, -3));
  }
  return set;
}

function hasWord(set, w) {
  if (set.has(w)) return true;
  if (w.length > 3 && w.endsWith('s') && set.has(w.slice(0, -1))) return true;
  return set.has(w + 's');
}

function parse(q, now) {
  const raw = String(q || '').trim();
  const when = whenOf(raw, now);
  const lower = ' ' + raw.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' ';

  let type = null;
  for (const k of Object.keys(TYPES)) {
    if (TYPES[k].test(raw)) { type = k; break; }
  }

  /* Landmark before neighborhood, because "the Garden" is a sharper constraint
     than "downtown" and a question that names one rarely means the other. */
  let landmark = null;
  let landmarkHit = null;
  outer:
  for (const canon of Object.keys(LANDMARKS)) {
    for (const alias of LANDMARKS[canon]) {
      if (lower.includes(' ' + alias + ' ')) { landmark = canon; landmarkHit = alias; break outer; }
    }
  }

  let place = null;
  for (const p of PLACES) {
    if (lower.includes(' ' + p + ' ')) { place = p; break; }
  }
  if (!place) {
    for (const a of Object.keys(PLACE_ALIASES)) {
      if (lower.includes(' ' + a + ' ')) { place = a; break; }
    }
  }
  if (place && PLACE_ALIASES[place]) place = PLACE_ALIASES[place];

  /* "Fenway Park" names the park, and the neighborhood called Fenway is a
     square mile around it. Holding both would demand a transmission satisfy
     the narrow constraint and the broad one, which the narrow one already
     implies. The landmark wins. */
  if (landmark && place && landmark.includes(place)) place = null;

  /* What is left after when/what/where have taken their words. Used against
     the transcript text, which is how a question with no structured handle
     still finds something. */
  const consumed = new Set();
  if (place) for (const w of place.split(' ')) consumed.add(w);
  if (landmark) {
    for (const w of landmark.split(' ')) consumed.add(w);
    if (landmarkHit) for (const w of landmarkHit.split(' ')) consumed.add(w);
  }

  /* "Lancaster Street" is one thing, not two. Split into tokens, "street"
     matches every transmission in Massachusetts that mentions any street,
     which is most of them, and the name gets lost in its own suffix. So
     name-plus-suffix pairs become phrases matched whole, in both spellings,
     and a suffix on its own carries no signal at all. */
  const SUFFIX = {
    street: 'st', st: 'street', road: 'rd', rd: 'road', avenue: 'ave', ave: 'avenue',
    boulevard: 'blvd', blvd: 'boulevard', square: 'sq', sq: 'square',
    court: 'ct', drive: 'dr', lane: 'ln', place: 'pl',
    park: null, bridge: null, tunnel: null, station: null, garage: null,
  };
  const toks = lower.split(/\s+/).filter(Boolean);
  const phrases = [];
  const phrased = new Set();
  for (let i = 0; i + 1 < toks.length; i++) {
    const w = toks[i], sfx = toks[i + 1];
    if (!(sfx in SUFFIX)) continue;
    if (w.length < 3 || STOP.has(w) || consumed.has(w) || (sfx in SUFFIX && SUFFIX[w] !== undefined && w in SUFFIX)) continue;
    if (type && TYPES[type].test(w)) continue;
    const alt = SUFFIX[sfx];
    const set = [w + ' ' + sfx];
    if (alt) set.push(w + ' ' + alt);
    phrases.push(set);
    phrased.add(w); phrased.add(sfx);
  }

  const words = lower
    .split(/\s+/)
    .filter(Boolean)
    .filter(w => w.length > 2 && !STOP.has(w))
    .filter(w => !consumed.has(w))
    .filter(w => !phrased.has(w))
    .filter(w => !(w in SUFFIX))
    .filter(w => !type || !TYPES[type].test(w))
    .filter((w, i, a) => a.indexOf(w) === i)
    .slice(0, 8);

  return {
    from: when.from, to: when.to, when: when.label,
    type, place, landmark, phrases, big: BIG.test(raw), words, q: raw,
  };
}

/* Does one archived transmission answer this question?

   Scored rather than boolean, so the best match sorts to the top and a
   near-miss still shows up rather than vanishing. But a score of zero has to
   mean something: a transmission earns its place by matching a criterion the
   question actually stated. The only query that matches everything in the
   window is a query that asked for nothing else. */
function score(tx, f) {
  const at = +new Date(tx.at);
  if (!(at >= +f.from && at <= +f.to)) return 0;

  /* Two haystacks, and the split matters.

     What was said and where it was is content, and a call type has to be found
     in there. The feed name, the department and the unit numbers are labels the
     system attached, and a feed called "boston-fire" carries the word fire on
     every transmission it ever hands over, including the seven about somebody
     checking a tablet. Testing the fire pattern against that turns a whole
     channel into a permanent false positive.

     Free-text words still search the labels, because "boston fire" and "engine
     33" are things a reporter reasonably types and expects to work. */
  const hay = ((tx.text || '') + ' ' + (tx.matched || '') + ' ' + (tx.town || '') + ' ' +
               (tx.address || '') + ' ' + (tx.street || '') + ' ' + (tx.crossStreet || '') + ' ' +
               (tx.landmark || '') + ' ' + (tx.city || '')).toLowerCase();
  const labels = ((tx.feed || '') + ' ' + (tx.dept || '') + ' ' +
                  (tx.units || []).join(' ')).toLowerCase();
  const bag = tokenize(hay + ' ' + labels);

  const phrases = f.phrases || [];
  const asked = (f.type ? 1 : 0) + (f.place ? 1 : 0) + (f.landmark ? 1 : 0)
    + phrases.length + f.words.length;
  /* A question with no handle on it beyond a time range is a browse, and a
     browse legitimately returns the window. */
  if (asked === 0) return 1;

  let s = 0;
  let hit = 0;      // anything at all
  let named = 0;    // the specifics: a phrase, a landmark, a place, a word
  let kin = false;

  /* The pipeline's own label is the strongest evidence in the record, because
     something already read the whole transmission to assign it. It has to
     outweigh a couple of incidental word hits, or "confirming a body" loses to
     a line that merely says "parking garage" twice. */
  if (f.type) {
    if (tx.callType === f.type) { s += 10; hit++; }
    else if (TYPES[f.type].test(hay)) { s += 5; hit++; }
    else if ((KIN[f.type] || []).includes(tx.callType)) { kin = true; }
    else return 0;                       // asked for a fire, this is not one
  }

  if (f.landmark) {
    const aliases = LANDMARKS[f.landmark] || [f.landmark];
    if (aliases.some(a => hay.includes(a))) { s += 7; hit++; named++; }
    else return 0;                       // asked for the Garden, this is not there
  }

  if (f.place) {
    if (hay.includes(f.place)) { s += 5; hit++; named++; }
    else return 0;                       // asked for Back Bay, this is not there
  }

  for (const set of phrases) {
    if (set.some(v => hay.includes(v))) { s += 8; hit++; named++; }
  }

  for (const w of f.words) if (hasWord(bag, w)) { s += 3; hit++; named++; }

  /* A kin label alone opens no doors, and it never counts toward how much of
     the question was answered. A medical that matched the place must not
     outrank the transmission the pipeline itself labeled a death, which is
     exactly what happened when kinship padded the coverage ratio. One point,
     once inside, nothing more. */
  if (kin) {
    if (named === 0) return 0;
    s += 1;
  }

  /* When the reporter named a thing, a transmission has to carry one of the
     named things. Matching only the call type is how "stabbing on lancaster
     street" returned every stabbing-adjacent run of the day: right category,
     wrong question. Type-only queries ("stabbings today") still work, because
     nothing was named. */
  if ((phrases.length || f.words.length || f.landmark || f.place) && named === 0) return 0;

  /* Seriousness sharpens a ranking but never stands in as evidence. "Big fire"
     with nothing else matched is still not this transmission. */
  if (f.big) {
    if (tx.priority === 'high') s += 3;
    if ((tx.tier || 0) >= 2) s += 2;
    if (tx.alarm) s += 2;
  }

  if (hit === 0) return 0;

  /* Matching three of three stated things beats matching one of three, whatever
     the raw points say. */
  return s * (1 + hit / Math.max(asked, 1));
}

module.exports = {
  parse, score, whenOf, dayString, tokenize, hasWord,
  TYPES, PLACES, LANDMARKS, KIN, TZ,
};
