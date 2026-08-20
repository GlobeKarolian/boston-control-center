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
/* Built once. Constructing an Intl.DateTimeFormat costs about a third of a
   millisecond and this is called for every object listed and every row read;
   the compactor's first test run spent forty seconds in constructors. */
const PARTS_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});
function partsIn(d) {
  const p = {};
  PARTS_FMT.formatToParts(d).forEach(x => { p[x.type] = x.value; });
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

  /* The night that STARTS on the Eastern day `back` days ago: 6pm to 6am. */
  const nightStarting = (back) => {
    const b = new Date(+t - back * dayMs);
    const bp = partsIn(b);
    const from = easternAt(bp.y, bp.m, bp.d, 18, 0, b);
    return { from, to: new Date(+from + 12 * 3600000) };
  };
  /* "Last night" is the most recent night that has happened, whatever the
     clock says: at 2am it is the one underway, at 11am it is the one that
     ended at six, at 11pm it is yesterday's. That is always the night that
     started yesterday.

     This used to be "today's night unless it is before 6am", which at any
     daytime hour is a window that has not started. The QA pass on 14 August
     at 2pm searched "big fire last night in Back Bay", was shown a window of
     Aug 14 6pm to Aug 15 6pm, got nothing, and wrote down that the archive was
     new. The archive was fine; the question had been sent into the future. */
  const night = (back) => Object.assign(nightStarting(back === 0 ? 1 : back), { label: 'last night' });
  /* "Tonight" is the night underway, or the coming one until 6pm; before it
     has started, the night that happened is the one a person at a desk means
     by it, and the label says which they got. */
  const tonight = () => {
    if (p.hh >= 18) return Object.assign(nightStarting(0), { label: 'tonight' });
    if (p.hh < 6) return Object.assign(nightStarting(1), { label: 'tonight' });
    return Object.assign(nightStarting(1), { label: 'last night' });
  };

  /* Every return below is a window somebody NAMED; the default at the bottom
     is not. Callers that treat "said a time" differently from "said nothing"
     (the desk reaches two hours back for a bare question) read `named`
     rather than keeping a second list of time words that drifts from this
     one, which is how "overnight" and "this afternoon" came to be searched
     for as words rather than understood as hours. */
  const named = (r) => Object.assign(r, { named: true });
  if (/\blast night\b|\byesterday night\b|\bovernight\b/i.test(q)) return named(night(0));
  if (/\btonight\b|\bthis evening\b|\bearlier tonight\b/i.test(q)) return named(tonight());
  if (/\byesterday afternoon\b/i.test(q)) {
    const s = startOfDay(1);
    return named({ from: new Date(+s + 12 * 3600000), to: new Date(+s + 18 * 3600000), label: 'yesterday afternoon' });
  }
  if (/\byesterday morning\b/i.test(q)) {
    const s = startOfDay(1);
    return named({ from: s, to: new Date(+s + 12 * 3600000), label: 'yesterday morning' });
  }
  if (/\byesterday\b/i.test(q)) return named({ from: startOfDay(1), to: endOfDay(1), label: 'yesterday' });
  if (/\bthis morning\b/i.test(q)) {
    const s = startOfDay(0);
    return named({ from: s, to: new Date(+easternAt(p.y, p.m, p.d, 12, 0, t)), label: 'this morning' });
  }
  if (/\bthis afternoon\b/i.test(q)) {
    const s = startOfDay(0);
    return named({ from: new Date(+s + 12 * 3600000), to: new Date(Math.min(+t, +s + 18 * 3600000)), label: 'this afternoon' });
  }
  if (/\btoday\b|\bsince midnight\b|\bearlier today\b|\bso far today\b/i.test(q)) return named({ from: startOfDay(0), to: new Date(+t), label: 'today' });
  /* "the weekend", "this past weekend", "over the weekend": the most recent
     Saturday and Sunday that have happened, by Eastern days. Asked on a
     Saturday night it means the one underway. */
  if (/\b(this |this past |last |over the |the )?weekend\b/i.test(q)) {
    const todayW = new Date(+easternAt(p.y, p.m, p.d, 12, 0, t)).getUTCDay();   // 0 Sunday .. 6 Saturday
    const backToSat = (todayW + 1) % 7;                                           // days since the last Saturday
    const sat = startOfDay(backToSat);
    return named({ from: sat, to: new Date(Math.min(+t, +sat + 2 * dayMs)), label: 'the weekend' });
  }
  if (/\blast (week|7 days)\b|\bpast week\b/i.test(q)) return named({ from: new Date(+t - 7 * dayMs), to: new Date(+t), label: 'the last week' });
  if (/\blast (month|30 days)\b|\bpast month\b/i.test(q)) return named({ from: new Date(+t - 30 * dayMs), to: new Date(+t), label: 'the last month' });
  /* "last 6 hours", "past 90 minutes", "last few hours", "last couple of hours". */
  const span = q.match(/\b(?:last|past|previous)\s+(\d{1,3}|a|an|one|two|three|four|five|six|eight|ten|twelve|few|couple(?: of)?|several)\s+(hours?|hrs?|minutes?|mins?|days?)\b/i);
  if (span) {
    const WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, eight: 8, ten: 10, twelve: 12, few: 3, couple: 2, 'couple of': 2, several: 4 };
    const n = /^\d/.test(span[1]) ? +span[1] : (WORDS[span[1].toLowerCase()] || 1);
    const unit = span[2].toLowerCase();
    const msOf = /^d/.test(unit) ? dayMs : /^h/.test(unit) ? 3600000 : 60000;
    const len = Math.min(30 * dayMs, Math.max(60000, n * msOf));
    return named({ from: new Date(+t - len), to: new Date(+t), label: 'the last ' + span[1] + ' ' + span[2] });
  }
  if (/\blast (hour|60 minutes)\b|\bpast hour\b/i.test(q)) return named({ from: new Date(+t - 3600000), to: new Date(+t), label: 'the last hour' });
  /* "right now", "currently", "at the moment": the desk's sense of now, an
     hour, because a call that is on the air now started recently. */
  if (/\bright now\b|\bcurrently\b|\bat the moment\b|\bas we speak\b|\bstill going\b/i.test(q)) return named({ from: new Date(+t - 3600000), to: new Date(+t), label: 'the last hour' });
  const iso = q.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const from = easternAt(+iso[1], +iso[2], +iso[3], 0, 0, t);
    return named({ from, to: new Date(+from + dayMs), label: iso[0] });
  }

  /* A date the way a person names one: a weekday, a day number, or both.
     "Wednesday the 12th", "on the 12th", "wednesday". Until 15 August 2026
     none of these parsed, so "stabbing at South Station Wednesday the 12th"
     got the default two-day window and 'wednesday, 12th' as search words,
     which is how the big one gets missed. */
  const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const wdM = q.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
  const dnM = q.match(/\b(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/i);
  if (wdM || dnM) {
    const p0 = partsIn(t);
    /* The Eastern weekday right now, so "wednesday" means the most recent
       Wednesday including today, never next week's. */
    const todayW = new Date(+easternAt(p0.y, p0.m, p0.d, 12, 0, t)).getUTCDay();
    let y = p0.y, m = p0.m, d = p0.d;
    if (dnM) {
      d = +dnM[1];
      /* A day number still in the future this month is last month's. */
      if (d > p0.d) { m -= 1; if (m < 1) { m = 12; y -= 1; } }
    } else {
      const want = DAYS.indexOf(wdM[1].toLowerCase());
      let back = (todayW - want + 7) % 7;
      const b = new Date(+t - back * dayMs);
      const bp = partsIn(b);
      y = bp.y; m = bp.m; d = bp.d;
    }
    /* A weekday that disagrees with the number loses: the number is the one
       a reporter checked before typing. Nothing to do here — d wins by
       construction. */
    const from = easternAt(y, m, d, 0, 0, t);
    const label = DAYS[new Date(+easternAt(y, m, d, 12, 0, t)).getUTCDay()].slice(0, 3)
      + ' ' + MON[m - 1] + ' ' + d;
    return named({ from, to: new Date(+from + dayMs), label });
  }

  // Nothing said: the last two days, which is what "find me the thing" means
  // in a room that works in shifts.
  return { from: new Date(+t - 2 * dayMs), to: new Date(+t), label: 'the last two days', named: false };
}

/* WHAT. The call types the extractor already assigns, plus the words a person
   actually uses for them. "working fire" and "structure fire" are both fire;
   nobody types "callType:fire".

   Order matters: the first pattern that matches the question wins, so the
   specific sits above the general. "body" has to beat "medical" or a death
   search returns every ambulance run of the night. */
/* PLURALS, WHICH ARE HOW PEOPLE ASK.
 *
 * A reporter types "any fights?", not "any fight?". Every pattern here is
 * anchored with \b at both ends, so /\bfight\b/ does not match "fights", and
 * "any fights?" parsed to no type at all: it fell through to a bare word
 * search for the literal string "fights", which does not appear in a
 * transmission that says "for a Fight". Zero matched, and the desk answered
 * "there are no fights" over a night that had one outside Russell House
 * Tavern. The word was in the archive. The question was in English. The
 * regex was in the way.
 *
 * Every type below now takes the plural, and lib/vault-query exports the same
 * stemming to anything that matches free words. */
const TYPES = {
  death: /\b(body|bodies|deceased|dead|doa|fatal|fatalit(y|ies)|coroner|medical examiner|untimely|jumpers?|drownings?|drowned)\b/i,
  /* Bare "shot" is out. On the first real slice it matched "would you have a
     good shot to 1261 Dorchester Ave" and put an ambulance's phrasing second
     for "shooting in dorchester". A person being shot arrives with grammar
     around it, and that grammar is cheap to demand. */
  shooting: /\b(shootings?|shots?\s+fired|gunshots?|gunfire|shots|(?:was|been|being|got|getting|male|female|party|person|victim|one|someone|somebody|kid|guy)\s+shot|shot\s+(?:in|to)\s+the\s+(?:leg|arm|chest|head|back|neck|face|stomach|shoulder|hand|foot|torso|hip))\b/i,
  /* "slashed" is not here on purpose: on a police channel it is nearly always
     tires, and a person who was slashed arrives with knife or stab words in
     the same breath. */
  stabbing: /\b(stabbings?|stabbed|stab|knife|knives|slashings?)\b/i,
  fire: /\b(fires?|working fire|structure fire|smoke|alarm of fire|box alarms?|arson)\b/i,
  crash: /\b(crash(es)?|accidents?|mva|collisions?|rollovers?|car into|struck by|pedestrian struck)\b/i,
  hazmat: /\b(hazmat|chemical|gas leaks?|spills?|carbon monoxide)\b/i,
  pursuit: /\b(pursuits?|chases?|fleeing|failed to stop)\b/i,
  robbery: /\b(robber(y|ies)|holdups?|larcen(y|ies)|breaking and entering|burglar(y|ies))\b/i,
  search: /\b(search(es)?|missing|water rescue|dive team|well being)\b/i,
  /* "fight" is the word a newsroom uses and it lives here rather than in a
     type of its own, because on the radio it arrives as a disturbance call. */
  disturbance: /\b(disturbances?|fight(s|ing)?|assaults?|disorderly|brawls?|altercations?|melee|jumped)\b/i,
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

/* IS THIS TRANSMISSION THE TYPE THAT WAS ASKED FOR?
 *
 * The extractor labels a call in its own words: "fight", "assault", "mva",
 * "brawl". The question parser speaks in canonical types: "disturbance",
 * "crash". score() compared the two with ===, so a transmission the pipeline
 * itself labelled "fight" earned HALF the type credit of one labelled
 * "disturbance" when somebody asked about a fight. That is the whole of why
 * "Bar Fight in cambridge" ranked the Russell House Tavern brawl nineteenth
 * of twenty on 17 August, under a weapon call whose transcript said "no active
 * disturbance": the brawl was labelled fight, the weapon call was labelled
 * disturbance, and === preferred the label that happened to match the key.
 *
 * A label that belongs to the type's own vocabulary IS the type. */
function ownType(tx, type) {
  if (!type || !tx) return false;
  const label = String(tx.callType || '').toLowerCase();
  if (!label) return false;
  if (label === type) return true;
  const re = TYPES[type];
  return !!(re && re.test(label));
}

/* WORDS A NEWSROOM USES FOR THE SAME THING.
 *
 * "Bar fight" is how the question is asked. "Russell House Tavern" is what the
 * dispatcher said. The word "bar" appears nowhere in that transmission and it
 * scored as though the place had never been mentioned. Kept deliberately small
 * and literal: each entry is a set of words a reporter would accept as the
 * same kind of place or thing, not a thesaurus. */
const WORD_KIN = {
  bar: ['tavern', 'pub', 'lounge', 'nightclub', 'club', 'saloon', 'taproom', 'brewery'],
  tavern: ['bar', 'pub'],
  pub: ['bar', 'tavern'],
  club: ['nightclub', 'bar', 'lounge'],
  store: ['shop', 'market', 'mart', 'bodega', 'supermarket', 'convenience'],
  shop: ['store', 'market'],
  restaurant: ['diner', 'cafe', 'pizzeria', 'eatery', 'grill', 'bistro'],
  hotel: ['motel', 'inn', 'hostel'],
  school: ['academy', 'elementary', 'middle school', 'high school', 'campus'],
  church: ['temple', 'mosque', 'synagogue', 'parish', 'cathedral', 'chapel'],
  hospital: ['medical center', 'emergency room', 'er', 'mgh', 'bmc', 'brigham', 'beth israel', 'tufts medical'],
  car: ['vehicle', 'auto', 'sedan', 'suv', 'motor vehicle', 'mv'],
  truck: ['tractor trailer', 'box truck', 'pickup', 'dump truck', 'eighteen wheeler', '18 wheeler'],
  bus: ['coach', 'mbta bus'],
  train: ['trolley', 'subway', 'commuter rail', 'red line', 'green line', 'orange line', 'blue line', 'silver line'],
  bike: ['bicycle', 'cyclist', 'bicyclist', 'e-bike', 'ebike'],
  motorcycle: ['motorbike', 'dirt bike', 'moped', 'scooter'],
  highway: ['expressway', 'interstate', 'turnpike', 'pike', 'route'],
  gun: ['firearm', 'pistol', 'handgun', 'rifle', 'weapon'],
  knife: ['blade', 'machete'],
  kid: ['child', 'juvenile', 'minor', 'boy', 'girl', 'teen', 'teenager'],
  child: ['kid', 'juvenile', 'minor', 'boy', 'girl'],
  dog: ['k9', 'canine', 'pit bull'],
  water: ['harbor', 'river', 'charles', 'pond', 'lake', 'ocean'],
};

/* Within one letter of the word, for names. Whisper hears "Lansdowne" as
   "Lansdown" and "Dorchester" as "Dorchestor", and a reporter who spells
   the street right should still find the call. Six letters or more, the same
   first letter, one edit: tight enough that "shots" never becomes "shoes",
   loose enough for a dropped or doubled letter in a name. Scored below an
   exact word by the caller, because it is a guess about a spelling. */
function nearWord(bag, w) {
  if (!w || w.length < 6) return false;
  const first = w[0];
  for (const t of bag) {
    if (t === w || t[0] !== first) continue;
    const d = t.length - w.length;
    if (d < -1 || d > 1) continue;
    if (edit1(w, t)) return true;
  }
  return false;
}
function edit1(a, b) {
  if (a === b) return true;
  if (a.length === b.length) {
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++diff > 1) return false;
    return diff === 1;
  }
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  let i = 0, j = 0, skipped = false;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) { i++; j++; continue; }
    if (skipped) return false;
    skipped = true; j++;
  }
  return true;
}

/* Does the record say this word, or one a newsroom would accept for it? */
function saysWord(bag, hay, w) {
  if (hasWord(bag, w)) return true;
  const kin = WORD_KIN[w];
  if (!kin) return false;
  for (const k of kin) {
    if (k.indexOf(' ') !== -1 || k.indexOf('-') !== -1) { if (hay.indexOf(k) !== -1) return true; }
    else if (hasWord(bag, k)) return true;
  }
  return false;
}

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
/* WHERE THE LANDMARKS ACTUALLY ARE.
 *
 * Matching a landmark by its spelling is how "bar fight in Harvard Square"
 * returned nothing on the night eight men brawled outside Russell House
 * Tavern. The call was in the archive, with audio, correctly labelled a fight,
 * at 14 JFK ST, Cambridge, which is in the middle of Harvard Square. Dispatch
 * said the street; it never said the square. A reporter naming the place
 * correctly got zero results, which is the fastest way to lose a newsroom's
 * trust in an archive.
 *
 * So a landmark is a POINT with a radius, and any transmission the pipeline
 * geocoded inside that radius is in that place, whatever words were spoken.
 * The vault already stores lat/lon on every record, so this costs nothing but
 * arithmetic. Text matching stays as the first test, because it still catches
 * the calls that were never geocoded.
 *
 * Radii are deliberately tight, a few city blocks, because a landmark that
 * quietly swallows a neighbourhood is worse than one that misses. */
const LANDMARK_POINTS = {
  'td garden': [42.3662, -71.0621, 400],
  'fenway park': [42.3467, -71.0972, 400],
  'logan airport': [42.3656, -71.0096, 1800],
  'south station': [42.3519, -71.0552, 350],
  'back bay station': [42.3474, -71.0757, 300],
  'boston common': [42.3550, -71.0656, 500],
  'public garden': [42.3541, -71.0704, 350],
  'faneuil hall': [42.3600, -71.0568, 300],
  'copley square': [42.3499, -71.0777, 400],
  'prudential center': [42.3473, -71.0821, 400],
  'city hall': [42.3603, -71.0580, 300],
  'mass general': [42.3632, -71.0686, 350],
  'brigham': [42.3362, -71.1065, 350],
  'boston medical center': [42.3348, -71.0730, 350],
  'tufts medical': [42.3497, -71.0632, 300],
  'seaport world trade': [42.3490, -71.0430, 500],
  'bunker hill': [42.3763, -71.0608, 400],
  'harvard square': [42.3736, -71.1190, 500],
  'kendall square': [42.3625, -71.0862, 450],
  'assembly row': [42.3925, -71.0777, 450],
  'encore casino': [42.3960, -71.0660, 400],
  'boston university': [42.3505, -71.1054, 800],
  'northeastern': [42.3398, -71.0892, 500],
  'zakim bridge': [42.3664, -71.0631, 400],
  'tobin bridge': [42.3860, -71.0570, 700],
};

/* Metres between two points. Equirectangular rather than haversine: at these
   distances the error is centimetres and this runs per transmission. */
function metresApart(aLat, aLon, bLat, bLon) {
  const R = 6371000;
  const dLat = (bLat - aLat) * Math.PI / 180;
  const dLon = (bLon - aLon) * Math.PI / 180;
  const mLat = ((aLat + bLat) / 2) * Math.PI / 180;
  const x = dLon * Math.cos(mLat);
  return Math.sqrt(dLat * dLat + x * x) * R;
}

/* Is this transmission physically inside the named landmark? */
/* WHERE THE NEIGHBOURHOODS ARE.
 *
 * The same hole the landmark points closed, one level up. A place was matched
 * by spelling alone: `hay.includes('back bay')`. But dispatch says the street.
 * A Back Bay call geocoded to "Boylston St, Boston" contains the words back
 * and bay in no field of the record, so "fire in Back Bay last night" returned
 * nothing while the fire sat in the archive with its audio. The record has no
 * neighbourhood field and nothing was ever going to give it one.
 *
 * It has coordinates, though, and the pipeline worked hard for those. A
 * transmission geocoded inside the neighbourhood is in the neighbourhood,
 * whatever words were spoken. Same trade the landmarks make, and scored a
 * shade lower for the same reason: a name is a stronger claim than a radius.
 *
 * The radii are per neighbourhood because Boston's are not remotely the same
 * size, and they are deliberately tight. A place that quietly matches half the
 * city is worse than one that matches nothing, because the reporter cannot see
 * it happening. Centroids come from lib/places.json; a few are the T stop
 * rather than the geographic centre, which is close enough at this radius.
 *
 * Towns are not in here. A Cambridge call already carries "Cambridge" in its
 * town or city field, so the spelling path works, and a radius around a town
 * centroid would reach into the three towns next door. */
const PLACE_POINTS = {
  /* Tightened after measuring every radius against the gazetteer's own
     coordinates. The first cut crossed Boston Harbor (East Boston reaching
     Charlestown and the North End), crossed the Neponset into Milton, crossed
     into Brookline, and put the Prudential in the South End. A neighbourhood
     that quietly answers for the one next door is worse than one that answers
     for nothing, because the reporter cannot see it happening.

     Where a radius has to choose, it under-reaches. A call the search misses
     is still findable by street, by unit or by time; a call it wrongly
     includes is a wrong fact with a play button next to it. */
  'chinatown':     [42.35255, -71.06275,  420],
  'north end':     [42.36510, -71.05450,  520],
  'longwood':      [42.34181, -71.10978,  520],
  'beacon hill':   [42.35871, -71.06783,  620],
  'kenmore':       [42.34895, -71.09517,  620],
  'downtown':      [42.35584, -71.05562,  700],
  'mission hill':  [42.33327, -71.10203,  760],
  'south end':     [42.34283, -71.07378,  780],
  'fenway':        [42.34533, -71.10427,  860],
  'seaport':       [42.34576, -71.04374,  900],
  'back bay':      [42.34735, -71.07573,  950],
  'charlestown':   [42.37787, -71.06200, 1050],
  'mattapan':      [42.26756, -71.09223, 1050],
  'east boston':   [42.37510, -71.03922, 1150],
  'allston':       [42.35554, -71.13275, 1200],
  'roxbury':       [42.32891, -71.08509, 1250],
  'brighton':      [42.34916, -71.15339, 1400],
  'south boston':  [42.33343, -71.04949, 1400],
  'roslindale':    [42.29121, -71.12450, 1500],
  'jamaica plain': [42.31160, -71.11438, 1700],
  'west roxbury':  [42.28136, -71.16006, 2000],
  'hyde park':     [42.25503, -71.12553, 2000],
  'dorchester':    [42.29732, -71.07450, 2600],
};


function nearPlace(tx, canon) {
  const p = PLACE_POINTS[canon];
  if (!p) return false;
  const lat = Number(tx && tx.lat), lon = Number(tx && tx.lon);
  if (!isFinite(lat) || !isFinite(lon) || (lat === 0 && lon === 0)) return false;
  /* A pin the pipeline itself called vague is not evidence of which
     neighbourhood something was in. A town centroid sits in exactly one of
     them and would drag every unplaceable call in the city into whichever
     neighbourhood happens to be nearest City Hall. */
  if (tx.precision === 'wide' || tx.precision === 'weak' || tx.precision === 'town') return false;
  return metresApart(lat, lon, p[0], p[1]) <= p[2];
}

function nearLandmark(tx, canon) {
  const p = LANDMARK_POINTS[canon];
  if (!p) return false;
  const lat = Number(tx && tx.lat), lon = Number(tx && tx.lon);
  if (!isFinite(lat) || !isFinite(lon) || (lat === 0 && lon === 0)) return false;
  return metresApart(lat, lon, p[0], p[1]) <= p[2];
}

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

const BIG = /\b(big|bigger|biggest|major|serious|most serious|large|larger|largest|huge|massive|bad|worst|significant|multiple alarm|second alarm|third alarm|working)\b/i;

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
  'happening going down over out ' +
  /* THE WORDS A DESK ASKS WITH. "What were the biggest calls tonight" was
     searched, until 19 August, for the literal word "biggest", and since a
     question that names a thing only returns lines that carry one of the
     named things, it returned nothing. "Anything interesting", "worst thing
     last night", "what happened overnight" all failed the same way: the
     filler a person puts around a question became the question. None of
     these words is ever the thing being asked about. */
  'thing things stuff interesting notable newsworthy news story stories ' +
  'bigger biggest larger largest worst most more kind sort many much lot lots ' +
  'important anyone someone somebody anybody did does do has have had hear ' +
  'heard see seen know tell just still yet ever some also else other area city ' +
  'right now currently happen happens recent recently latest update updates ' +
  'overnight moment earlier ago past previous few couple several hrs mins ' +
  'minute minutes since midnight weekend').split(/\s+/));

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
  if (w.length > 3 && w.endsWith('es') && set.has(w.slice(0, -2))) return true;
  if (w.length > 3 && w.endsWith('s') && set.has(w.slice(0, -1))) return true;
  if (set.has(w + 's')) return true;
  return w.length > 2 && set.has(w + 'es');
}

/* The same question asked of a haystack rather than a token set. Exported
   because api/desk-ask.js was testing hay.includes(word), which is a
   different and worse idea twice over: it misses the plural, and it matches
   inside longer words. */
function wordIn(hay, w) {
  return hasWord(tokenize(String(hay || '')), String(w || '').toLowerCase());
}

function parse(q, now) {
  const raw = String(q || '').trim();
  const when = whenOf(raw, now);
  const lower = ' ' + raw.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' ';

  let type = null;
  let typeHit = null;
  for (const k of Object.keys(TYPES)) {
    const m = TYPES[k].exec(raw);
    if (m) { type = k; typeHit = m[0]; break; }
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
  /* The words the type was recognised BY. "shots fired" became type shooting
     and then "shots" and "fired" went on as free words, which every shooting
     labelled from "gunshot wounds" then failed to carry; "structure fire"
     left "structure" behind the same way. A phrase that named the type is
     spent. So is the phrase that said how serious. */
  if (typeHit) for (const w of typeHit.toLowerCase().split(/[^a-z0-9]+/)) if (w) consumed.add(w);
  const bigHit = BIG.exec(raw);
  if (bigHit) for (const w of bigHit[0].toLowerCase().split(/[^a-z0-9]+/)) if (w) consumed.add(w);
  /* Date words the when parser already used. "stabbing at South Station
     Wednesday the 12th" must not search for 'wednesday' or '12th' on top of
     the window it just built. */
  for (const w of ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
                   'st', 'nd', 'rd', 'th', 'the']) consumed.add(w);
  const dnCons = raw.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/i);
  if (dnCons) { consumed.add(dnCons[1]); consumed.add(dnCons[0].toLowerCase()); }

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
    from: when.from, to: when.to, when: when.label, named: when.named !== false,
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
     browse legitimately returns the window. One that asked for the BIG
     things ("biggest calls tonight") is a browse that wants the serious end
     first, so seriousness ranks it; it still returns the window. */
  if (asked === 0) {
    let b = 1;
    if (f.big) {
      if (tx.priority === 'high') b += 3;
      if ((tx.tier || 0) >= 2) b += 2;
      if (tx.alarm) b += 2;
      if ((tx.tier || 0) >= 3) b += 2;
    }
    return b;
  }

  let s = 0;
  let hit = 0;      // anything at all
  let named = 0;    // the specifics: a phrase, a landmark, a place, a word
  let kin = false;

  /* The pipeline's own label is the strongest evidence in the record, because
     something already read the whole transmission to assign it. It has to
     outweigh a couple of incidental word hits, or "confirming a body" loses to
     a line that merely says "parking garage" twice. */
  if (f.type) {
    if (ownType(tx, f.type)) { s += 10; hit++; }
    else if (TYPES[f.type].test(hay)) { s += 5; hit++; }
    else if ((KIN[f.type] || []).includes(tx.callType)) { kin = true; }
    else return 0;                       // asked for a fire, this is not one
  }

  if (f.landmark) {
    const aliases = LANDMARKS[f.landmark] || [f.landmark];
    if (aliases.some(a => hay.includes(a))) { s += 7; hit++; named++; }
    /* Said the street, not the square. The pipeline geocoded it; trust the
       coordinates over the vocabulary. Scored a shade below a spoken match
       because a name is a stronger signal than a radius. */
    else if (nearLandmark(tx, f.landmark)) { s += 6; hit++; named++; }
    else return 0;                       // asked for the Garden, this is not there
  }

  if (f.place) {
    if (hay.includes(f.place)) { s += 5; hit++; named++; }
    /* Said the street, not the neighbourhood. Trust the coordinates the
       pipeline worked for over the vocabulary that happened to be spoken. */
    else if (nearPlace(tx, f.place)) { s += 4; hit++; named++; }
    else return 0;                       // asked for Back Bay, this is not there
  }

  for (const set of phrases) {
    if (set.some(v => hay.includes(v))) { s += 8; hit++; named++; }
  }

  for (const w of f.words) {
    if (saysWord(bag, hay, w)) { s += 3; hit++; named++; }
    else if (nearWord(bag, w)) { s += 2; hit++; named++; }
  }

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

module.exports = { nearLandmark, metresApart, LANDMARK_POINTS,
  parse, score, whenOf, dayString, tokenize, hasWord, wordIn, nearPlace, ownType, saysWord, nearWord, WORD_KIN,
  TYPES, PLACES, LANDMARKS, KIN, TZ,
};
