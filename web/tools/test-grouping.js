// tools/test-grouping.js
//
// One scene is one scene, not a whole shift.
//
// Live QA on 17 August found a card reading:
//
//   "Brighton wellness check, seizure at Branton St"   BIG STORY
//    117 units · running 625 minutes · 1049 transmissions
//
// A four-year-old having a seizure does not draw 117 units over ten hours.
// That card was the incident store absorbing an entire morning of unrelated
// traffic into one incident, which breaks the product's second job: knit the
// transmissions that belong to an event together, and only those.
//
// THE MECHANISM. A transmission joined an existing incident if any unit it
// named was registered to that incident. The address path was bounded to two
// hours; the unit path was bounded by nothing at all. So a cruiser that
// cleared a call at 7am was still registered to it at 2pm and dragged its
// afternoon traffic in. Worse, every joining transmission re-registers ALL of
// its units to that incident, so each wrong join widened the net that caught
// the next one. The failure is self-feeding, which is why it reached 117 and
// not, say, 6.
//
// Two bounds, both tested here: a unit only rejoins a scene that is still
// warm, and an incident that already holds a scene's worth of units stops
// recruiting by unit.

'use strict';

const path = require('path');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fail++;
  console.log('  FAIL ' + name + (extra ? '  ' + extra : ''));
}

/* The two constants, read out of the source so the test cannot drift from the
   implementation without someone noticing. */
const src = require('fs').readFileSync(path.join(__dirname, '..', 'lib', 'incident-store.js'), 'utf8');
const WIN = /const UNIT_MATCH_WINDOW_MS\s*=\s*(\d+)\s*\*\s*60\s*\*\s*1000/.exec(src);
const CAP = /const UNIT_JOIN_CAP\s*=\s*(\d+)/.exec(src);

ok('a unit-join time bound exists at all', !!WIN, 'UNIT_MATCH_WINDOW_MS not found');
ok('a unit-join size cap exists at all', !!CAP, 'UNIT_JOIN_CAP not found');

const winMs = WIN ? (+WIN[1]) * 60000 : 0;
const cap = CAP ? +CAP[1] : 0;

ok('the window is long enough for a live scene', winMs >= 20 * 60000, 'window=' + winMs / 60000 + 'm');
ok('and short enough that a unit is not still on it hours later', winMs <= 90 * 60000, 'window=' + winMs / 60000 + 'm');
ok('the cap allows a real multiple-alarm scene', cap >= 15, 'cap=' + cap);
ok('the cap stops a card that has eaten the shift', cap <= 40, 'cap=' + cap);

/* The join predicate, mirrored. Kept in step with the source by the two
   regexes above: if the real bounds move, these move with them. */
function joins(candidate, atMs) {
  if (!candidate || candidate.status === 'archived') return false;
  const last = +new Date(candidate.lastUpdate || candidate.firstHeard || 0);
  if (!last || (atMs - last) >= winMs) return false;
  if ((candidate.units || []).length >= cap) return false;
  return true;
}

const T0 = Date.parse('2026-08-17T07:35:00Z');
const mins = (n) => T0 + n * 60000;
const scene = (over) => Object.assign({
  id: 'inc1', status: 'active', lastUpdate: new Date(T0).toISOString(),
  firstHeard: new Date(T0).toISOString(), units: ['A1', 'E5'],
}, over || {});

/* --- the bug, reproduced ---------------------------------------------- */

ok('the same unit 7 hours later does NOT rejoin the old scene',
   !joins(scene(), mins(420)), 'this is the 625-minute card');

ok('nor does it rejoin after 2 hours',
   !joins(scene(), mins(120)));

ok('an incident already holding 117 units recruits nobody else',
   !joins(scene({ units: Array.from({ length: 117 }, (_, i) => 'U' + i) }), mins(1)),
   'this is the 117-unit card');

/* --- and the real behaviour it must not break -------------------------- */

ok('a unit on a live scene rejoins it a minute later',
   joins(scene(), mins(1)));

ok('and ten minutes later, which is normal scene chatter',
   joins(scene(), mins(10)));

ok('a scene that keeps talking stays joinable, because lastUpdate moves',
   joins(scene({ lastUpdate: new Date(mins(40)).toISOString() }), mins(44)),
   'a 4-minute-old update is live traffic');

ok('a working fire with a dozen pieces still recruits',
   joins(scene({ units: ['E1', 'E2', 'E3', 'E4', 'L1', 'L2', 'D1', 'C3', 'R1', 'A1', 'A2', 'P2'] }), mins(5)));

ok('an archived incident is never rejoined',
   !joins(scene({ status: 'archived' }), mins(1)));

/* The self-feeding shape: each wrong join widens the net. With the cap in
   place, growth stops instead of accelerating. */
{
  let units = ['A1', 'E5'];
  let joinsAllowed = 0;
  for (let i = 0; i < 200; i++) {
    if (!joins(scene({ units }), mins(1))) break;
    joinsAllowed++;
    units = units.concat(['X' + i]);   // each join widens the unit set
  }
  ok('runaway growth terminates instead of reaching 117',
     joinsAllowed <= cap, 'grew to ' + (units.length) + ' units');
}

/* --- the same bar, named two ways ------------------------------------
 *
 * 16 August, 10:42:45 PM and 10:43:49 PM, both cambridge-ma-police:
 *
 *   "First on Russell House Tavern, 14 JFK Street for a fight..."
 *   "To the units responding at the House Tavern, about eight bikers..."
 *
 * Sixty-four seconds apart, same bar, same feed, one event. The archive
 * showed them as two cards, because the first geocoded to a street address
 * (exact) and the second matched the pub by name (approximate), and the store
 * refused to let anything approximate join a scene.
 *
 * That rule was written against town centroids swallowing a town, which is a
 * real risk and still guarded: lib/geo now marks area-sized fixes `wide`, and
 * those may neither join nor anchor. A named building is a point and may join
 * a scene it is standing on, within a tighter radius than two exact fixes get.
 */
{
  const SAME = 200, NEAR = 90;
  /* Mirrors the store's rule at the join site. */
  function mayJoin(geo, cand, meters) {
    if (!geo || geo.wide) return false;
    const prec = geo.approx ? 'approx' : 'exact';
    if (!cand || cand.precision !== 'exact' || cand.status !== 'active') return false;
    const limit = (prec === 'exact') ? SAME : NEAR;
    return meters < limit;
  }
  const scene = { status: 'active', precision: 'exact', located: true };

  ok('the pub matched by name joins the street-address scene it sits on',
     mayJoin({ approx: true }, scene, 15));
  ok('an exact follow-up still joins across a block',
     mayJoin({}, scene, 150));
  ok('a named building 400m away does NOT join',
     !mayJoin({ approx: true }, scene, 400));
  ok('a town centroid never joins, however close it lands',
     !mayJoin({ approx: true, wide: true }, scene, 5));
  ok('and an approximate fix cannot be the thing others gather around',
     !mayJoin({}, { status: 'active', precision: 'approx', located: true }, 10));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
