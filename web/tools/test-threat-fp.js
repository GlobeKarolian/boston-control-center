// tools/test-threat-fp.js
//
// False positives in the threat lexicon, which are worse than misses.
//
// A missed signal is a story that reads routine. A false signal is a story
// that reads as an emergency, and because GRAVE and HEAVY ids drive the
// severity floor directly, one wrong word promotes a nothing call to the top
// of the board and pushes a real one down.
//
// Both of these were found in live QA on 17 August, on the Shift Change page:
//
//   "Brighton wellness check, seizure at Branton St"  BIG STORY
//      why it's here: heard on the radio: hostage
//
//   "Quincy crash and state police activity"          BIG STORY
//      why it's here: heard on the radio: shooting
//
// A four-year-old having a seizure is not a hostage situation and a multi-car
// crash is not a shooting. The lexicon matched the bare word "barricade",
// which on a scanner is a traffic barrier several times an hour, and matched
// "shooting pain", which is how EMS describes a cardiac complaint.

'use strict';

const threat = require('../lib/threat');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fail++;
  console.log('  FAIL ' + name + (extra ? '  ' + extra : ''));
}

/* Does any signal with this id fire on this text? */
function fires(text, id) {
  const sigs = threat.signalsIn(text) || [];
  return sigs.some(s => (s.id || s) === id);
}

/* --- must NOT fire: ordinary traffic that used to score tier 3 --------- */

const NOT_HOSTAGE = [
  'crash barricade on the median',
  'we have a barricade set up for traffic',
  'vehicle barricade in the roadway',
  'put a barricade at the end of the street',
  'he is refusing to come out for the wellness check',
];
for (const s of NOT_HOSTAGE) {
  ok('not a hostage: "' + s.slice(0, 42) + '"', !fires(s, 'hostage'));
}

const NOT_SHOOTING = [
  'shooting pain in his chest',
  'the pain is shooting down her arm',
  'complaining of shooting pains in the left leg',
  'shooting at the range',
  'multi-car crash on 495 southbound, exit 88',
];
for (const s of NOT_SHOOTING) {
  ok('not a shooting: "' + s.slice(0, 42) + '"', !fires(s, 'shooting'));
}

/* The two exact calls from the QA session, end to end through assess(). */
{
  const seizure = 'Report of a four-year-old male seizing, not breathing, at 9 Branton Street, second floor.';
  const a = threat.assess(seizure);
  ok('a child seizure carries no violence signal',
     !fires(seizure, 'hostage') && !fires(seizure, 'shooting'),
     JSON.stringify((threat.signalsIn(seizure) || []).map(x => x.id || x)));
  ok('and does not reach the top tier', (a && a.tier ? a.tier : 0) < 3, 'tier=' + (a && a.tier));

  const crash = 'Mass State Police reported a multi-car crash on 495 southbound, exit 88, median.';
  ok('a highway crash is not a shooting', !fires(crash, 'shooting'),
     JSON.stringify((threat.signalsIn(crash) || []).map(x => x.id || x)));
}

/* --- must STILL fire: the real thing ---------------------------------- */

const REAL_HOSTAGE = [
  'we have a hostage situation at the bank',
  'barricaded subject in the rear apartment',
  'male barricaded himself in the bathroom',
  'suspect is barricaded upstairs',
  'party refusing to come out of the house and armed',
];
for (const s of REAL_HOSTAGE) {
  ok('still a hostage: "' + s.slice(0, 42) + '"', fires(s, 'hostage'));
}

const REAL_SHOOTING = [
  'report of a shooting on Blue Hill Ave',
  'shots fired, shooting reported at the corner',
  'possible shooting, one victim down',
];
for (const s of REAL_SHOOTING) {
  ok('still a shooting: "' + s.slice(0, 42) + '"', fires(s, 'shooting'));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
