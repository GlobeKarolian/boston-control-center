// tools/test-vault-query.js
//
//   node tools/test-vault-query.js
//
// The archive search has one job a newsroom can check: when a reporter names
// a thing that happened, the thing comes back and the rest of the night does
// not. These are the cases that were failing in production on 2026-08-13.

'use strict';

const vq = require('../lib/vault-query');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '   ' + detail : '')); }
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
}

const NOW = '2026-08-13T04:00:00Z';           // just after midnight, Eastern

/* Hours after 6pm Eastern on Aug 12, which is where "last night" starts. Written
   as an offset rather than a UTC hour because the bug this file exists to catch
   is exactly the kind that hides behind a hand-converted timestamp. */
const NIGHT_START = Date.UTC(2026, 7, 12, 22, 0, 0);
const T = (h, m) => new Date(NIGHT_START + h * 3600000 + (m || 0) * 60000).toISOString();

/* ---------------------------------------------------------------- parsing --- */

console.log('\nparse');
{
  const f = vq.parse('body found at the TD Garden parking garage', NOW);
  eq('the type is a death, not a medical', f.type, 'death');
  eq('the landmark is the Garden', f.landmark, 'td garden');
  ok('parking garage is one phrase, not two loose words',
     (f.phrases || []).some(set => set.includes('parking garage')), JSON.stringify(f.phrases));
  ok('landmark words are not double counted as free text',
     !f.words.includes('garden') && !f.words.includes('td'), JSON.stringify(f.words));
}
{
  const f = vq.parse('big fire last night in Back Bay', NOW);
  eq('type', f.type, 'fire');
  eq('place', f.place, 'back bay');
  eq('big', f.big, true);
  eq('when', f.when, 'last night');
}
{
  const f = vq.parse('anything from north station', NOW);
  eq('north station resolves to the Garden complex', f.landmark, 'td garden');
}
{
  const f = vq.parse('shooting in southie yesterday', NOW);
  eq('nickname resolves', f.place, 'south boston');
  eq('type', f.type, 'shooting');
}

/* A reporter names a date the way a person names one: a weekday, a day
   number, sometimes both. Until 15 August 2026 "stabbing at South Station
   Wednesday the 12th" came back with 'the last two days' for a window and
   'wednesday, 12th' as search words, which is how the big one gets missed:
   the window is wrong and the words match nothing. */
{
  /* Asked on Saturday 15 August 2026 (ET). Wednesday the 12th is three days
     back, 00:00 to 23:59 Eastern on the 12th. */
  const NOW3 = '2026-08-15T04:00:00Z';
  const f = vq.parse('stabbing at South Station Wednesday the 12th', NOW3);
  eq('a bare day number is a date, not a search word', f.when, 'wed aug 12');
  eq('the window opens at midnight Eastern on the 12th',
     f.from.toISOString(), '2026-08-12T04:00:00.000Z');
  eq('and closes at midnight Eastern on the 13th',
     f.to.toISOString(), '2026-08-13T04:00:00.000Z');
  ok('wednesday is not a search word', !f.words.includes('wednesday'), JSON.stringify(f.words));
  ok('and 12th is not a search word', !f.words.includes('12th'), JSON.stringify(f.words));
  eq('the landmark still parses', f.landmark, 'south station');
  eq('the type still parses', f.type, 'stabbing');
}
{
  /* The same question without the weekday: "the 12th" alone is enough. */
  const NOW3 = '2026-08-15T04:00:00Z';
  const f = vq.parse('stabbing at south station on the 12th', NOW3);
  eq('a bare "the 12th" is the same window', f.when, 'wed aug 12');
  eq('from', f.from.toISOString(), '2026-08-12T04:00:00.000Z');
  eq('to', f.to.toISOString(), '2026-08-13T04:00:00.000Z');
}
{
  /* A weekday on its own: the most recent Wednesday, not next week's. */
  const NOW3 = '2026-08-15T04:00:00Z';
  const f = vq.parse('stabbing at south station wednesday', NOW3);
  eq('a bare weekday is the most recent one', f.when, 'wed aug 12');
  eq('from', f.from.toISOString(), '2026-08-12T04:00:00.000Z');
}
{
  /* Today IS the named day: "wednesday" asked on a Wednesday means today,
     not a week ago. */
  const NOW4 = '2026-08-12T16:00:00Z';   // Wednesday Aug 12, noon ET
  const f = vq.parse('stabbing at south station wednesday', NOW4);
  eq('wednesday asked on wednesday is today', f.when, 'wed aug 12');
  eq('from', f.from.toISOString(), '2026-08-12T04:00:00.000Z');
}
{
  /* A day number that is still in the future this month means last month.
     Asked on the 10th, "the 22nd" is July 22nd. */
  const NOW5 = '2026-08-10T16:00:00Z';
  const f = vq.parse('fire on the 22nd', NOW5);
  eq('a future day number rolls back a month', f.when, 'wed jul 22');
  eq('from', f.from.toISOString(), '2026-07-22T04:00:00.000Z');
}
{
  /* Date words must not leak into free text even when the date parse wins. */
  const NOW3 = '2026-08-15T04:00:00Z';
  const f = vq.parse('shooting wednesday the 12th in dorchester', NOW3);
  ok('dorchester parses as the place', f.place === 'dorchester', JSON.stringify(f.place));
  ok('no date words in the free-text list',
     !f.words.some(w => /wednesday|12th|aug/.test(w)), JSON.stringify(f.words));
}

/* ------------------------------------------------------------- the corpus --- */

/* Lines that contain the letters b-o-d-y and are not about a body. Seventeen
   of these came back from the real archive for the real question. 
   This is the real shape of the false positives the old search returned. */
const NOISE = [
  'Can somebody check the tablet out for the moped, sir?',
  'Somebody call for a tow on that one',
  'Is anybody down there with him',
  'Somebody said the door was open',
  'Nobody answering at that address',
  'Have somebody meet us at the corner',
  'Anybody got a spare portable',
].map((text, i) => ({
  at: T(1, i), feed: 'boston-fire', text, callType: 'medical', town: 'Boston',
}));

const GARDEN = [
  { at: T(5, 10), feed: 'boston-police', town: 'Boston', callType: 'medical',
    address: '100 Legends Way', matched: 'TD Garden',
    text: 'We have an unresponsive party in the parking garage at the Garden, level three' },
  { at: T(5, 14), feed: 'boston-police', town: 'Boston', callType: 'death',
    address: '100 Legends Way', matched: 'TD Garden', tier: 3, priority: 'high',
    text: 'Confirming a body in the North Station garage, notify the medical examiner' },
];

const BACKBAY_FIRE = [
  { at: T(3, 0), feed: 'boston-fire', town: 'Boston', callType: 'fire', tier: 3,
    address: '500 Boylston St', matched: 'Back Bay', alarm: true, priority: 'high',
    text: 'Working fire, second alarm, heavy smoke showing from the third floor' },
];

const ELSEWHERE = [
  { at: T(4, 0), feed: 'boston-fire', town: 'Dorchester', callType: 'fire',
    address: '10 Adams St', text: 'Car fire on the ramp, one engine responding' },
  { at: T(2, 0), feed: 'boston-police', town: 'Revere', callType: 'crash',
    address: '5 Ocean Ave', text: 'Two car crash, no injuries reported' },
];

const CORPUS = [...NOISE, ...GARDEN, ...BACKBAY_FIRE, ...ELSEWHERE];

function search(q) {
  const f = vq.parse(q, NOW);
  return CORPUS
    .map(tx => ({ tx, s: vq.score(tx, f) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s);
}

/* ------------------------------------------------------------- the search --- */

console.log('\nthe question that failed in production');
{
  const hits = search('body found at the TD Garden parking garage');
  eq('two transmissions come back, both from the Garden', hits.length, 2);
  ok('no line containing "somebody" comes back',
     !hits.some(h => /somebody|anybody|nobody/i.test(h.tx.text)),
     hits.map(h => h.tx.text).join(' | '));
  ok('the confirmed body sorts above the unresponsive party',
     /Confirming a body/.test(hits[0].tx.text), hits[0].tx.text);
}

console.log('\nthe question the archive was built for');
{
  const hits = search('big fire last night in Back Bay');
  eq('only the Back Bay fire', hits.length, 1);
  eq('and it is the right one', hits[0].tx.matched, 'Back Bay');
}

console.log('\nprecision');
{
  eq('a fire question does not return crashes',
     search('fire last night').every(h => /fire|smoke/i.test(h.tx.text)), true);
  eq('a landmark question does not return the rest of the city',
     search('what happened at fenway park last night').length, 0);
  eq('a question about a word nobody said returns nothing',
     search('the call about the dog').length, 0);
}

console.log('\nbrowse');
{
  /* A bare time range is not a failed search, it is a request for the window,
     and it is the one case where returning everything is right. */
  const hits = search('last night');
  eq('a bare time range returns the window', hits.length, CORPUS.length);
}

console.log('\nthe window is still a hard gate');
{
  const f = vq.parse('body at the garden', NOW);
  const old = { at: '2026-07-01T23:10:00Z', text: 'body in the garage at TD Garden' };
  eq('a match outside the window is not a match', vq.score(old, f), 0);
}

console.log('\nthe lancaster street flood');
{
  /* The failure of August 13, in miniature: the real call, the real BPD scene
     traffic with no address on it, and the day's ordinary medicals that all
     mention some street. The first scorer returned every one of them. */
  /* Its own clock: 2pm Eastern on the 13th, with the incident that morning.
     The main suite's NOW sits at midnight, where "today" is zero minutes
     wide, which is a fine fact about midnight and a useless one here. */
  const NOW2 = '2026-08-13T18:00:00Z';
  const T2 = (h, m) => new Date(Date.UTC(2026, 7, 13, 12 + h, m || 0)).toISOString();
  const CORPUS2 = [
    { at: T2(2, 0), feed: 'boston-ems', callType: null, town: 'Boston',
      address: '30 Lancaster Street', matched: '30 LANCASTER ST, BOSTON, MA, 02114',
      text: 'P1 A15 reports of a person being stabbed, 30 Lancaster Street' },
    { at: T2(2, 18), feed: 'boston-police', callType: null, town: 'Boston',
      text: 'We have one stab in the abdomen, he was holding the knife, two victims' },
    { at: T2(2, 30), feed: 'boston-police', callType: 'weapons', town: 'Boston',
      text: 'Take me off at the stabbing and make full notifications' },
    { at: T2(1, 0), feed: 'lowell-police-department', callType: 'medical', town: 'Lowell',
      address: '20 Williams Street', text: 'Head over to 20 Williams Street, tires were slashed yesterday' },
    { at: T2(1, 30), feed: 'lowell-police-department', callType: 'medical', town: 'Lowell',
      address: '65 summer street', text: 'Respond 65 summer street for medical' },
    { at: T2(3, 0), feed: 'boston-ems', callType: 'medical', town: 'Boston',
      text: 'Minor illness, West Parkway, ambulance 22' },
  ];
  const f = vq.parse('stabbing on lancaster street today', NOW2);
  ok('lancaster street parses as one phrase',
     (f.phrases || []).some(set => set.includes('lancaster street')), JSON.stringify(f.phrases));
  ok('street alone is not a search word', !f.words.includes('street'), JSON.stringify(f.words));
  const hits = CORPUS2.map(tx => ({ tx, s: vq.score(tx, f) })).filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s);
  eq('only lancaster comes back, not the day\'s medicals', hits.length, 1);
  ok('and it is the dispatch', /30 Lancaster/.test(hits[0].tx.text), hits.map(h => h.tx.text).join('|'));

  /* The scene traffic has no address, so it cannot match "lancaster". It must
     still surface for the plain-type question, which is how a reporter walks
     from the dispatch to the scene. */
  const f2 = vq.parse('stabbings today', NOW2);
  const hits2 = CORPUS2.map(tx => ({ tx, s: vq.score(tx, f2) })).filter(x => x.s > 0);
  eq('a type-only query finds all three stabbing lines', hits2.length, 3);
  ok('and none of the medicals ride along on kinship',
     !hits2.some(h => /Williams|summer street|West Parkway/.test((h.tx.address || '') + h.tx.text)),
     hits2.map(h => h.tx.text).join('|'));
}

console.log('\nthe pedestrian "shooting" that was a struck');
{
  /* The failure of August 15: a reporter asked for "a pedestrian shooting
     reported at Back Bay near 145 Dartmouth Street around 5:37 p.m" and got a
     40-line card of bomb squads, cardiacs, and a missing juvenile, because a
     pedestrian-STRUCK call is kin to a shooting (medical) and matched "back
     bay" and "pedestrian", and kin + named > 0 was enough to get in. */
  const NOW3 = '2026-08-14T22:10:00Z';   // 6:10pm ET on the 14th, after the calls
  const T3 = (h, m) => new Date(Date.UTC(2026, 7, 14, 20 + h, m || 0)).toISOString();
  const CORPUS3 = [
    { at: T3(0, 54), feed: 'boston-ems', callType: 'medical', town: 'Boston',
      address: '145 Dartmouth Street', matched: '145 DARTMOUTH ST, BOSTON, MA, 02116',
      text: 'A8, pedestrian struck near Back Bay, 145 Dartmouth Street' },
    { at: T3(1, 3), feed: 'boston-ems', callType: 'medical', town: 'Boston',
      text: 'We have been dismissed by the bomb squad. Everyone dismissed by the bomb squad' },
    { at: T3(1, 1), feed: 'boston-ems', callType: 'medical', town: 'Charlestown',
      text: 'Start back into Charlestown for the cardiac, 42 Tufts' },
    { at: T3(1, 30), feed: 'boston-police', callType: 'shooting', town: 'Boston',
      address: '145 Dartmouth Street', matched: '145 DARTMOUTH ST, BOSTON, MA, 02116',
      text: 'Shots fired, pedestrian hit, 145 Dartmouth Street, Back Bay' },
  ];
  const f = vq.parse('a pedestrian shooting reported at Back Bay near 145 Dartmouth Street around 5:37 p.m', NOW3);
  const hits = CORPUS3.map(tx => ({ tx, s: vq.score(tx, f) })).filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s);
  /* The real shooting is the strongest hit. The struck is a valid answer to
     "pedestrian near 145 Dartmouth" and sorts below it. The bomb squad and
     the cardiac share nothing with the question and stay out. */
  eq('two hits: the shooting and the struck', hits.length, 2);
  ok('the shooting sorts first', /Shots fired/.test(hits[0].tx.text), hits.map(h => h.tx.text).join('|'));
  ok('the struck sorts second', /pedestrian struck/.test(hits[1].tx.text), hits.map(h => h.tx.text).join('|'));
  /* A plain "shootings today" finds the shooting and NOT the struck: kin is
     a tiebreak, never a door, and a pedestrian struck is a car accident,
     not a shooting that arrived as a medical. */
  const f2 = vq.parse('shootings today', NOW3);
  const hits2 = CORPUS3.map(tx => ({ tx, s: vq.score(tx, f2) })).filter(x => x.s > 0);
  eq('a type-only shooting query finds only the shooting', hits2.length, 1);
  ok('and it is the shots fired line', /Shots fired/.test(hits2[0].tx.text), hits2.map(h => h.tx.text).join('|'));
}

console.log('\ntokens');
{
  const bag = vq.tokenize('Can somebody check the tablet');
  eq('somebody does not contain body', vq.hasWord(bag, 'body'), false);
  eq('plurals fold', vq.hasWord(vq.tokenize('two garages'), 'garage'), true);
}


/* --- a landmark is a place, not a spelling --------------------------------
 *
 * 16 August, 10:42pm: eight men brawling outside Russell House Tavern, 14 JFK
 * Street, dead centre of Harvard Square. It was in the archive with audio and
 * correctly labelled a fight. Searching "bar fight in Harvard Square" returned
 * nothing, because dispatch said the street and never said the square, and the
 * landmark test was a substring match on the transcript. A reporter who named
 * the place correctly got zero results.
 *
 * Landmarks are points with a radius now, and anything the pipeline geocoded
 * inside one is in that place whatever words were spoken. */
{
  /* Pinned to the night it happened. These rows are dated 17 August, and a
     parse against the real clock puts its two-day default window past them
     once the calendar moves on; the test then fails on the date gate and
     looks like a landmark bug. It was one, on 18 August, for a day. */
  const THAT_NIGHT = new Date('2026-08-17T03:00:00Z');
  const f = vq.parse('Bar Fight Harvard Square', THAT_NIGHT);
  ok('the query still parses the landmark', f.landmark === 'harvard square', JSON.stringify(f.landmark));

  const brawl = {
    at: '2026-08-17T02:42:45.000Z', lat: 42.3730, lon: -71.1187,
    text: '419. First on Russell House Tavern, 14 JFK Street for a fight. About 8 men fighting another. No weapons.',
    matched: '14 JFK ST, CAMBRIDGE, MA, 02138', callType: 'fight', town: 'Cambridge',
  };
  ok('the brawl at 14 JFK St is found by "Harvard Square"', vq.score(brawl, f) > 0,
     'score=' + vq.score(brawl, f));

  ok('and it is inside the radius by coordinates alone',
     vq.nearLandmark({ lat: 42.3730, lon: -71.1187 }, 'harvard square') === true);

  /* The radius must stay tight. A landmark that swallows a neighbourhood is
     worse than one that misses. */
  ok('a call 3.5km away is not in Harvard Square',
     vq.nearLandmark({ lat: 42.3348, lon: -71.0730 }, 'harvard square') === false);
  ok('a record with no coordinates is not in any landmark',
     vq.nearLandmark({}, 'harvard square') === false);
  ok('and neither is a null island record',
     vq.nearLandmark({ lat: 0, lon: 0 }, 'harvard square') === false);

  /* Spoken names still work, which is what catches calls never geocoded. */
  const spoken = {
    at: '2026-08-17T02:00:00.000Z',
    text: 'units responding to Harvard Square for a disturbance', callType: 'disturbance',
  };
  ok('a spoken landmark with no coordinates still matches',
     vq.score(spoken, vq.parse('disturbance harvard square', THAT_NIGHT)) > 0);

  /* And an unrelated call at the same moment stays out. */
  const other = {
    at: '2026-08-17T02:40:00.000Z', lat: 42.3000, lon: -71.0700,
    text: 'ambulance for a minor illness on Spencer Street',
    matched: '85 SPENCER ST', callType: 'medical', town: 'Boston',
  };
  ok('an unrelated Dorchester call is not pulled in', vq.score(other, f) === 0);
}

/* ------------------------------------------------------------------
   A NEIGHBOURHOOD IS A PLACE ON THE MAP, NOT A WORD ON THE RADIO.

   The same hole the landmark points closed, one level up. `place` was matched
   by spelling alone, so a Back Bay fire geocoded to "Boylston St, Boston" had
   the words back and bay in no field of the record, and "fire in Back Bay"
   returned nothing while the fire sat in the archive with its audio. Dispatch
   says the street. The reporter says the neighbourhood. Both are right and
   only the coordinates know it.
   ------------------------------------------------------------------ */
{
  const f = vq.parse('fire in back bay last night', new Date(NOW));
  const tx = (o) => Object.assign({
    at: T(4), feed: 'boston-fire', callType: 'fire',
    text: 'Working fire, heavy smoke showing on arrival.',
  }, o);

  ok('a Back Bay fire that only ever named the street is found',
     vq.score(tx({ lat: 42.3486, lon: -71.0810, matched: 'Boylston St, Boston', precision: 'exact' }), f) > 0);
  ok('and the spoken one still scores higher than the inferred one',
     vq.score(tx({ text: 'Working fire in Back Bay, heavy smoke.' }), f) >
     vq.score(tx({ lat: 42.3486, lon: -71.0810, precision: 'exact' }), f));
  ok('a Dorchester fire is not a Back Bay fire',
     vq.score(tx({ lat: 42.2973, lon: -71.0745, matched: 'Dot Ave, Boston', precision: 'exact' }), f) === 0);
  ok('nor is one across the river in Cambridge',
     vq.score(tx({ lat: 42.3736, lon: -71.1097, matched: 'Mass Ave, Cambridge', precision: 'exact' }), f) === 0);

  /* A pin the pipeline already called vague is not evidence of neighbourhood.
     A town centroid sits inside exactly one of them, and without this every
     unplaceable call in the city would answer to whichever neighbourhood is
     nearest City Hall. */
  ok('a vague pin does not put a call in a neighbourhood',
     vq.score(tx({ lat: 42.3486, lon: -71.0810, precision: 'wide' }), f) === 0);
  ok('and neither does no pin at all',
     vq.score(tx({}), f) === 0);

  /* The tight ones have to stay tight, or a place that matches half the city
     is worse than one that matches nothing. */
  const g = vq.parse('anything in the north end last night', new Date(NOW));
  ok('the North End does not reach across to Charlestown',
     vq.score(tx({ callType: null, lat: 42.3779, lon: -71.0620, precision: 'exact' }), g) === 0);
  ok('but does cover the North End itself',
     vq.score(tx({ callType: null, lat: 42.3648, lon: -71.0542, precision: 'exact' }), g) > 0);
}


/* ------------------------------------------------------------------
   PLURALS, WHICH ARE HOW PEOPLE ASK.

   17 August, 02:20: "any fights?" at the desk, answered "There are no fights
   dispatched in this window", over a night that had a brawl outside Russell
   House Tavern.

   Every type pattern was anchored with \b at both ends, so /\bfight\b/ did
   not match "fights". The question parsed to no type at all and fell through
   to a literal substring search for "fights", which does not appear in a
   transmission reading "for a Fight". Zero matched. The word was in the
   archive, the question was in English, and the regex was in the way.
   ------------------------------------------------------------------ */
{
  const P = (q) => vq.parse(q, new Date(NOW)).type;
  const PAIRS = [
    ['any fights?', 'disturbance'], ['a brawl outside a bar', 'disturbance'],
    ['altercations tonight', 'disturbance'],
    ['any fires', 'fire'], ['shootings last night', 'shooting'],
    ['stabbings', 'stabbing'], ['robberies', 'robbery'], ['burglaries', 'robbery'],
    ['pursuits', 'pursuit'], ['searches', 'search'], ['crashes', 'crash'],
    ['gas leaks', 'hazmat'], ['fatalities', 'death'], ['jumpers', 'death'],
  ];
  for (const [q, want] of PAIRS) ok('"' + q + '" is a ' + want, P(q) === want, String(P(q)));

  /* And the singular still parses, which is the thing not to break. */
  for (const [q, want] of [['any fight', 'disturbance'], ['a fire', 'fire'], ['robbery', 'robbery']]) {
    ok('"' + q + '" is still a ' + want, P(q) === want, String(P(q)));
  }

  /* The fight itself, scored. */
  const f = vq.parse('any fights?', new Date(NOW));
  const fight = {
    at: T(4, 42), feed: 'cambridge-ma-police', callType: 'disturbance',
    text: 'Large fight outside Russell House Tavern, 14 JFK Street, eight involved.',
  };
  ok('the Russell House fight answers "any fights?"', vq.score(fight, f) > 0);
  ok('and an ambulance run for a fall does not',
     vq.score({ at: T(4, 43), feed: 'boston-ems', callType: 'medical',
                text: 'Ambulance 7 responding for a fall.' }, f) === 0);
}

/* A word match has to stem, and must not bleed into longer words. The desk
   used to test hay.includes(word), which got both wrong at once. */
ok('a plural question matches a singular transmission',
   vq.wordIn('the 40 Trinity Place for a Fight', 'fights'));
ok('and a singular question matches a plural transmission',
   vq.wordIn('two separate fires overnight', 'fire'));
ok('but a word is not found inside a longer one',
   !vq.wordIn('the firefighter arrived', 'fire'));

/* ------------------------------------------------------------------
   THE WORDS A DESK ASKS WITH ARE NOT THE THING IT IS ASKING ABOUT.

   19 August. "What were the biggest calls tonight" parsed to words:
   ["biggest"], and a question that names a thing returns only lines that
   carry it, so the desk searched a whole night for the literal word
   "biggest" and found nothing. "Any shootings overnight" did the same with
   "overnight": the when-parser had already turned it into hours, and then the
   word went on to be required of every line. "Shots fired" became type
   shooting and then "shots" and "fired" were demanded of every shooting,
   including the ones labelled from "gunshot wounds". None of those words was
   ever the question. */
{
  const NOW = new Date('2026-08-19T03:30:00Z');              // 11:30pm Eastern
  const P = (q) => vq.parse(q, NOW);
  const f1 = P('what were the biggest calls tonight');
  ok('"biggest calls tonight" asks for nothing by name', f1.words.length === 0 && !f1.type && !f1.place, JSON.stringify(f1.words));
  ok('but asks for the big end of it', f1.big === true);
  ok('and tonight is a named window', f1.named === true && f1.when === 'tonight');
  const f2 = P('any shootings overnight');
  ok('"overnight" is hours, not a word', f2.words.length === 0 && f2.type === 'shooting' && f2.named === true, JSON.stringify(f2.words));
  const f3 = P('shots fired dorchester');
  ok('the words the type was recognised by are spent', f3.type === 'shooting' && f3.place === 'dorchester' && f3.words.length === 0, JSON.stringify(f3.words));
  const f4 = P('structure fire in jp');
  ok('"structure" does not survive "structure fire"', f4.type === 'fire' && f4.place === 'jamaica plain' && f4.words.length === 0, JSON.stringify(f4.words));
  const f5 = P('worst thing last night');
  ok('"worst" and "thing" are filler', f5.words.length === 0 && f5.big === true, JSON.stringify(f5.words));
  const f6 = P('anything interesting tonight');
  ok('"interesting" is filler', f6.words.length === 0, JSON.stringify(f6.words));
  const f7 = P('the brawl at russell house');
  ok('a name that is not filler survives', f7.type === 'disturbance' && f7.words.includes('russell'), JSON.stringify(f7.words));
  const f8 = P('any arrests tonight');
  ok('and so does a thing worth searching for', f8.words.includes('arrests'), JSON.stringify(f8.words));

  /* The ways a desk names a time. */
  const hrs = P('any stabbings in the last 6 hours');
  ok('"last 6 hours" is six hours', hrs.named && Math.round((+hrs.to - +hrs.from) / 3600000) === 6 && hrs.words.length === 0, hrs.when);
  const few = P('fights in the last few hours');
  ok('"last few hours" is three', few.named && Math.round((+few.to - +few.from) / 3600000) === 3, few.when);
  const aft = P('fights this afternoon');
  ok('"this afternoon" is noon to six', aft.named && aft.when === 'this afternoon' && aft.words.length === 0);
  const now = P('what is going on right now');
  ok('"right now" is the last hour, and not two words', now.named && Math.round((+now.to - +now.from) / 60000) === 60 && now.words.length === 0, JSON.stringify(now.words));
  const wk = P('shooting this past weekend');
  ok('"this past weekend" is the weekend, not two words', wk.named && wk.when === 'the weekend' && wk.words.length === 0, JSON.stringify(wk.words));
  const ya = P('stabbing yesterday afternoon');
  ok('"yesterday afternoon" is an afternoon, not a day', ya.named && ya.when === 'yesterday afternoon' && Math.round((+ya.to - +ya.from) / 3600000) === 6);
  const bare = P('stabbing on lancaster street');
  ok('no time named means no time named', bare.named === false && bare.when === 'the last two days');
  /* Tuesday 18 August at 11:30pm: "this past weekend" is Sat 15 / Sun 16. */
  ok('and the weekend is the right one', /2026-08-15T04:00/.test(wk.from.toISOString()) && /2026-08-17T04:00/.test(wk.to.toISOString()), [wk.from.toISOString(), wk.to.toISOString()]);

  /* "Last night" at any hour of the day is the night that happened. The QA
     pass of 14 August searched for a fire "last night" at 2pm and was handed
     a window that had not started yet. */
  const E = (d) => new Date(d).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric' });
  const at11am = vq.parse('big fire last night in back bay', new Date('2026-08-19T15:00:00Z'));
  ok('at 11am, last night is the night that ended at six', E(at11am.from) === 'Aug 18, 6 PM' && E(at11am.to) === 'Aug 19, 6 AM', [E(at11am.from), E(at11am.to)]);
  const at2am = vq.parse('fire last night', new Date('2026-08-19T06:00:00Z'));
  ok('at 2am, last night is the night underway', E(at2am.from) === 'Aug 18, 6 PM' && E(at2am.to) === 'Aug 19, 6 AM', [E(at2am.from), E(at2am.to)]);
  const at11pm = vq.parse('fire last night', new Date('2026-08-20T03:30:00Z'));
  ok('at 11:30pm, last night is the previous one', E(at11pm.from) === 'Aug 18, 6 PM' && E(at11pm.to) === 'Aug 19, 6 AM', [E(at11pm.from), E(at11pm.to)]);
  const ton11am = vq.parse('biggest calls tonight', new Date('2026-08-19T15:00:00Z'));
  ok('at 11am, tonight has not started, so it is last night and says so', ton11am.when === 'last night' && E(ton11am.from) === 'Aug 18, 6 PM', [ton11am.when, E(ton11am.from)]);
  const ton8pm = vq.parse('biggest calls tonight', new Date('2026-08-20T00:00:00Z'));
  ok('at 8pm, tonight is the night underway', ton8pm.when === 'tonight' && E(ton8pm.from) === 'Aug 19, 6 PM', [ton8pm.when, E(ton8pm.from)]);
  ok('no window is ever in the future', [at11am, at2am, at11pm, ton11am].every(x => +x.from < Date.parse('2026-08-19T15:00:01Z')));

  /* A name within one letter. Whisper hears "Boylston" as "Boylstone". */
  const NIGHT = new Date('2026-08-19T02:30:00Z');
  const q9 = vq.parse('disturbance on boylston', NIGHT);
  ok('the street is a word to search for', q9.words.includes('boylston'), JSON.stringify(q9.words));
  const heard = { at: '2026-08-19T02:00:00Z', text: 'units to boylstone for a disturbance', callType: 'disturbance', feed: 'boston-police' };
  ok('a street one letter off is still found', vq.score(heard, q9) > 0, vq.score(heard, q9));
  const exact = { at: '2026-08-19T02:00:00Z', text: 'units to boylston for a disturbance', callType: 'disturbance', feed: 'boston-police' };
  ok('and scores below the one spelled right', vq.score(heard, q9) < vq.score(exact, q9));
  ok('short words do not fuzz: shots is not shoes', vq.nearWord(vq.tokenize('new shoes'), 'shots') === false);
  ok('harvard is not howard', vq.nearWord(vq.tokenize('howard st'), 'harvard') === false);

  /* A big browse ranks the serious end first, and still returns the window. */
  const rowAt = (o) => Object.assign({ at: '2026-08-19T02:00:00Z', text: 'x', feed: 'boston-police' }, o);
  ok('a plain line is still in a big browse', vq.score(rowAt({}), f1) >= 1);
  ok('a high-priority tier-3 line outranks it', vq.score(rowAt({ priority: 'high', tier: 3 }), f1) > vq.score(rowAt({}), f1));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);