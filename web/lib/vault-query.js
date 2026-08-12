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
   nobody types "callType:fire". */
const TYPES = {
  fire: /\b(fire|working fire|structure fire|smoke|alarm of fire|box alarm)\b/i,
  medical: /\b(medical|ems|ambulance|cardiac|overdose|od|seizure|unresponsive|injur)\w*\b/i,
  crash: /\b(crash|accident|mva|collision|rollover|car into|struck by)\b/i,
  pursuit: /\b(pursuit|chase|fleeing|failed to stop)\b/i,
  shooting: /\b(shooting|shots fired|gunshot|shot)\b/i,
  stabbing: /\b(stabbing|stabbed|knife)\b/i,
  hazmat: /\b(hazmat|chemical|gas leak|spill|carbon monoxide)\b/i,
  search: /\b(search|missing|water rescue|dive team)\b/i,
  disturbance: /\b(disturbance|fight|assault|disorderly)\b/i,
  robbery: /\b(robbery|holdup|larceny|breaking and entering|b&e)\b/i,
};

/* WHERE. Boston's neighborhoods are what a reporter says; the archive stores a
   town and a matched address. Both get searched, so "Back Bay" finds a call
   whose town is Boston and whose address landed on Boylston St. */
const PLACES = [
  'back bay', 'south end', 'north end', 'east boston', 'south boston', 'southie',
  'dorchester', 'roxbury', 'mattapan', 'jamaica plain', 'roslindale', 'west roxbury',
  'hyde park', 'allston', 'brighton', 'charlestown', 'fenway', 'kenmore', 'seaport',
  'beacon hill', 'downtown', 'chinatown', 'mission hill', 'longwood',
  'cambridge', 'somerville', 'brookline', 'quincy', 'newton', 'medford', 'malden',
  'everett', 'chelsea', 'revere', 'winthrop', 'watertown', 'belmont', 'arlington',
  'lowell', 'lynn', 'waltham', 'framingham', 'braintree', 'milton', 'dedham',
];

const BIG = /\b(big|major|serious|large|massive|bad|worst|significant|multiple alarm|second alarm|third alarm|working)\b/i;

/* Words that carry no signal for matching. Everything left after the parse is
   used as free text against the transcript, and leaving these in would match
   every line on the radio. */
const STOP = new Set(('the a an of in on at from to for and or all any me i we ' +
  'need want find show get give please scanner transmissions transmission calls call ' +
  'audio radio about with was were is are there that this last night yesterday today ' +
  'tonight morning evening week hour big major serious large').split(' '));

function parse(q, now) {
  const raw = String(q || '').trim();
  const when = whenOf(raw, now);

  let type = null;
  for (const k of Object.keys(TYPES)) {
    if (TYPES[k].test(raw)) { type = k; break; }
  }

  const lower = raw.toLowerCase();
  let place = null;
  for (const p of PLACES) {
    if (lower.includes(p)) { place = p; break; }
  }

  /* What is left after when/what/where have taken their words. Used against
     the transcript text, which is how a question with no structured handle
     still finds something. */
  const words = lower
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP.has(w))
    .filter(w => !place || !place.includes(w))
    .filter(w => !type || !TYPES[type].test(w))
    .slice(0, 8);

  return { from: when.from, to: when.to, when: when.label, type, place, big: BIG.test(raw), words, q: raw };
}

/* Does one archived transmission answer this question?
   Scored rather than boolean, so the best match sorts to the top and a
   near-miss still shows up rather than vanishing. */
function score(tx, f) {
  const at = +new Date(tx.at);
  if (!(at >= +f.from && at <= +f.to)) return 0;

  let s = 1;
  const hay = ((tx.text || '') + ' ' + (tx.matched || '') + ' ' + (tx.town || '') + ' ' +
               (tx.address || '') + ' ' + (tx.street || '') + ' ' + (tx.landmark || '') + ' ' +
               (tx.city || '') + ' ' + (tx.feed || '')).toLowerCase();

  if (f.type) {
    if (tx.callType === f.type) s += 6;
    else if (TYPES[f.type].test(hay)) s += 3;
    else return 0;                       // asked for a fire, this is not one
  }
  if (f.place) {
    if (hay.includes(f.place)) s += 5;
    else return 0;                       // asked for Back Bay, this is not there
  }
  if (f.big) {
    if (tx.priority === 'high') s += 3;
    if ((tx.tier || 0) >= 2) s += 2;
    if (tx.alarm) s += 2;
  }
  for (const w of f.words) if (hay.includes(w)) s += 2;
  return s;
}

module.exports = { parse, score, whenOf, dayString, TYPES, PLACES, TZ };
