// tools/test-places-street.js
//
// A landmark's name is also a street name somewhere else, and that costs twice.
//
// Live QA on 17 August: a Needham fire alarm at "155 Harvard Street" was
// pinned on the Red Line platform in Harvard Square, four towns away, at
// station precision. The gazetteer scan reads the raw transcript looking for
// any known place named in it, saw the word "harvard", and stopped reading.
//
// Half the landmarks in eastern Massachusetts have this shape. Washington,
// Lincoln, Adams, Beacon, Brighton, Dorchester, Newton and Harvard are all
// simultaneously a place and a street name in some other town.
//
// It costs twice because of what the wrong pin does downstream. The incident
// store joins a transmission to a scene that is already on the map within
// ninety metres of it, so a call geocoded into the wrong town cannot join the
// transmissions it belongs with. A wrong pin does not merely misplace a card,
// it splits one, and splitting is a direct failure of this product's second
// job: knit the traffic for one event together.
//
// Two rules, both about context rather than about the name:
//   the word after   "harvard street" is a street, whatever harvard is
//   the word before  "155 harvard" is an address, whatever harvard is
// and one about scope: once a town is known, a place in another town is not
// the answer.

'use strict';

const places = require('../lib/places');
const geo = require('../lib/geo');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fail++;
  console.log('  FAIL ' + name + (extra ? '  ' + extra : ''));
}
const matched = (t, towns) => { const r = places.scanText(t, towns || []); return r ? r.matched : null; };
const townOf = (t, towns) => { const r = places.scanText(t, towns || []); return r ? r.town : null; };

/* --- the call that started it -------------------------------------------- */

{
  const t = 'Engine 3 responding to 155 Harvard Street, Needham, for an alarm activation.';
  ok('a Needham street address is not the Harvard Square T stop',
     townOf(t) !== 'Cambridge', matched(t));
  ok('and it lands in the town that was actually said', townOf(t) === 'Needham', matched(t));
}

/* --- the word after ------------------------------------------------------ */

const STREETS = [
  'Car 4 out at 22 Washington Street.',
  'MVA at Lincoln Ave and Elm.',
  'Report of smoke, 40 Beacon Road, Needham.',
  'Ambulance to 88 Brighton Ave.',
  'Wires down on Dorchester Terrace.',
  'Alarm at 12 Newton Place.',
];
for (const t of STREETS) {
  const r = places.scanText(t, []);
  ok('a street is not a landmark: "' + t.slice(0, 40) + '"',
     !r || r.kind === 'town' || r.kind === 'road', r && (r.matched + ' (' + r.kind + ')'));
}

/* --- the word before ----------------------------------------------------- */

ok('a house number in front makes it an address, even with the street dropped',
   !/Cambridge/.test(String(matched('Party at 155 Harvard, second floor.'))),
   matched('Party at 155 Harvard, second floor.'));

/* --- and the real places still resolve, which is the whole point ---------- */

const REAL = [
  ['Disturbance outside the pit at Harvard Square.', 'Cambridge'],
  ['Party down on the platform at Harvard.', 'Cambridge'],
  ['Fight outside the Brigham.', 'Boston'],
  ['Medical at Fenway Park, gate C.', 'Boston'],
];
for (const [t, town] of REAL) {
  ok('still finds it: "' + t.slice(0, 38) + '"', townOf(t) === town, String(matched(t)));
}

ok('a numbered highway still needs its cue word',
   /93/.test(String(matched('Trooper out on 93 north in Somerville.'))),
   matched('Trooper out on 93 north in Somerville.'));
ok('and a bare house number on a street is still not a highway',
   !/^93,/.test(String(matched('Alarm sounding at 93 Beacon.'))),
   matched('Alarm sounding at 93 Beacon.'));

/* --- the trolley stops named after their own street ---------------------- */
/*
   The Green Line and the Mattapan line name most surface stops after the
   street they sit on: Washington Street, Park Street, South Street, Harvard
   Avenue, Massachusetts Avenue, Central Avenue, Valley Road. Each of those is
   also an ordinary street in several towns, and the street is by far the more
   likely thing to be on the radio. Unchecked, one gazetteer row pins every
   mention of that street region-wide onto one platform. */
{
  const STREET_NOT_STOP = [
    'Two car crash, Washington Street and Beacon, Somerville.',
    'Party refusing to leave, Park Street, Stoneham.',
    'Wires down across South Street.',
    'Ambulance responding to Central Avenue for a fall.',
  ];
  for (const t of STREET_NOT_STOP) {
    const r = places.scanText(t, []);
    ok('a street with no transit in the sentence is a street: "' + t.slice(0, 36) + '"',
       !r || r.kind !== 'station', r && (r.matched + ' (' + r.kind + ')'));
  }

  const REALLY_THE_STOP = [
    'Disorderly on the platform at Washington Street station.',
    'Green line trolley disabled at Washington Street.',
    'Party struck by an inbound train at Park Street.',
  ];
  for (const t of REALLY_THE_STOP) {
    const r = places.scanText(t, []);
    ok('but transit in the sentence still finds the stop: "' + t.slice(0, 36) + '"',
       !!r && r.kind === 'station', r && (r.matched + ' (' + r.kind + ')'));
  }
}

/* --- stops named after towns, and corners made of two of them ------------ */

{
  ok('a town named on the radio is the town, not the Green Line stop',
     townOf('Alarm activation, Massachusetts Avenue, Arlington.', []) === 'Arlington',
     matched('Alarm activation, Massachusetts Avenue, Arlington.', []));
  ok('unless the sentence is plainly about transit',
     (places.scanText('Party struck by an inbound train at Arlington.', ['Boston']) || {}).kind === 'station',
     matched('Party struck by an inbound train at Arlington.', ['Boston']));
  ok('a corner made of two stop names is a corner, not a platform',
     (places.scanText('Disorderly at Arlington and Boylston.', ['Boston']) || {}).kind !== 'station',
     matched('Disorderly at Arlington and Boylston.', ['Boston']));
  ok('and a stop that is not also a street or a town still resolves plainly',
     !!places.scanText('Assault at Downtown Crossing.', ['Boston']),
     matched('Assault at Downtown Crossing.', ['Boston']));
}

/* An out-of-scope town centroid is not a fallback, it is a pin in another
   county. A named place out of scope is still allowed, at low confidence,
   because a landmark is a specific claim and a feed's declared coverage is
   sometimes merely incomplete. */
{
  const r = places.scanText('Engine 4 responding, structure fire in Worcester.', ['Boston']);
  ok('a town the feed does not cover is not offered as a location',
     !r || r.kind !== 'town', r && r.matched);
}

/* --- scope: a known town beats a famous name elsewhere -------------------- */

{
  const t = 'Needham Fire responding, 155 Harvard Street, alarm activation.';
  ok('scoped to the town, a Cambridge landmark cannot answer a Needham call',
     townOf(t, ['Needham']) !== 'Cambridge', matched(t, ['Needham']));
}

/* And the plumbing: geocodeEx must pass the DECIDED town to the scan, not the
   feed's whole coverage. A regional feed declares forty municipalities, which
   is no scope at all. */
{
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'geo.js'), 'utf8');
  ok('the gazetteer scan is scoped to the decided town',
     /places\.scanText\(text,\s*town\s*\?/.test(src),
     'geocodeEx still scans with the feed-wide town list');
}

/* --- the reason it matters: same address, same scene ---------------------- */
/* Two transmissions about one Needham alarm must land in the same place, or
   the incident store has no way to know they are the same call. */
{
  const a = places.scanText('Engine 3 to 155 Harvard Street, Needham, alarm activation.', ['Needham']);
  const b = places.scanText('Ladder 1 also responding, 155 Harvard Street in Needham.', ['Needham']);
  ok('two transmissions about one address agree on where it is',
     !!a && !!b && a.lat === b.lat && a.lon === b.lon,
     JSON.stringify([a && a.matched, b && b.matched]));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
