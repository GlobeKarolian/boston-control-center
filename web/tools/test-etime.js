// tools/test-etime.js
//
// The clock, and the thing the clock broke.
//
// On 14 August at 1:40am the desk panel showed a transmission at "05:39".
// The row was right, the window was right, and the number was four hours
// wrong, because the UI sliced the UTC clock out of the stored ISO string and
// printed it. The same UTC clock went to the model under a prompt ending "Use
// Eastern times in the answer", so the model was told the times were Eastern
// and handed times that were not.
//
// Both halves of that are tested here. The formatting half, which is what an
// editor reads. And the tracing half, which is what happens when the model
// does the right thing: an answer written in Eastern has to still match the
// transmission it came from, or the play button dies quietly and the panel
// becomes decoration.

'use strict';

const et = require('../lib/etime');
const trace = require('../lib/trace');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fail++;
  console.log('  FAIL ' + name + (extra ? '  ' + extra : ''));
}
function eq(name, got, want) { ok(name, got === want, 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)); }

/* --- the clock itself ------------------------------------------------- */

/* The exact row from the screenshot. */
eq('the 05:39 row is 01:39 Eastern', et.clock('2026-08-14T05:39:12.000Z'), '01:39');
eq('the 05:22 row is 01:22 Eastern', et.clock('2026-08-14T05:22:10.000Z'), '01:22');

/* Midnight, which some ICU builds render as 24:00 under hour12:false. A
   "24:00" key matches no transmission ever and would have been found at
   quarter past midnight by somebody who was not looking for it. */
eq('midnight is 00:00 not 24:00', et.clock('2026-08-14T04:00:00.000Z'), '00:00');

/* DST, in both directions, without anybody hardcoding an offset. */
eq('summer is UTC-4', et.clock('2026-08-14T16:00:00.000Z'), '12:00');
eq('winter is UTC-5', et.clock('2026-01-15T16:00:00.000Z'), '11:00');

/* The day boundary runs on Eastern, so late-evening UTC belongs to yesterday. */
eq('03:59Z is the previous evening', et.clock('2026-08-14T03:59:00.000Z'), '23:59');
ok('and it says so with the date', et.full('2026-08-14T03:59:00.000Z').indexOf('Aug 13') === 0,
   et.full('2026-08-14T03:59:00.000Z'));

/* Garbage in returns empty rather than "NaN:NaN" on a newsroom board. */
eq('junk is empty', et.clock('not a date'), '');
eq('null is empty', et.clock(null), '');
eq('junk stamp is empty', et.stamp('nope'), '');

eq('spoken form', et.stamp('2026-08-14T05:39:12.000Z'), '1:39 AM');
eq('utc is still available', et.utcClock('2026-08-14T05:39:12.000Z'), '05:39');

/* --- tracing an answer back to the radio ------------------------------ */

const rows = [
  { at: '2026-08-14T05:39:12.000Z', text: 'We just received 2172 for 61 Willow Street immediately after 2171', clip: 'a.opus' },
  { at: '2026-08-14T05:22:10.000Z', text: 'for a motor vehicle accident, no injuries at this time', clip: 'b.opus' },
  { at: '2026-08-14T17:39:00.000Z', text: 'something entirely unrelated in the afternoon', clip: 'c.opus' },
];

/* The case the fix exists for: the model correctly answers in Eastern and the
   citation still has to land. Before this, trace compared against the UTC
   clock only, so a correct answer traced to nothing. */
let hit = trace.toTransmissions('At 01:39 Cambridge fire took a second box at 61 Willow Street.', rows);
ok('an Eastern time in the answer finds the row', hit.length === 1 && hit[0].clip === 'a.opus',
   JSON.stringify(hit.map(r => r.clip)));

/* And the other branch: a model that ignores the instruction and echoes the
   stored time should not cost the reporter the audio either. */
hit = trace.toTransmissions('At 05:39 Cambridge fire took a second box at 61 Willow Street.', rows);
ok('a UTC time in the answer still finds it', hit.length === 1 && hit[0].clip === 'a.opus',
   JSON.stringify(hit.map(r => r.clip)));

/* Spoken form, which is how prose actually reads. */
hit = trace.toTransmissions('At 1:39 AM a second box came in for 61 Willow Street.', rows);
ok('1:39 AM finds the 05:39Z row', hit.some(r => r.clip === 'a.opus'),
   JSON.stringify(hit.map(r => r.clip)));

/* "1:39 AM" must not drag in the 1:39 PM row. Padding a 12 hour time blindly,
   which is what the old parser did, cited the wrong half of the day. */
ok('1:39 AM does not also cite the afternoon', !hit.some(r => r.clip === 'c.opus'),
   JSON.stringify(hit.map(r => r.clip)));

hit = trace.toTransmissions('At 1:39 PM something unrelated happened.', rows);
ok('1:39 PM finds the afternoon row', hit.some(r => r.clip === 'c.opus'),
   JSON.stringify(hit.map(r => r.clip)));
ok('1:39 PM does not cite the small hours', !hit.some(r => r.clip === 'a.opus'),
   JSON.stringify(hit.map(r => r.clip)));

/* A bare 24 hour time is unambiguous and should stay that way. */
hit = trace.toTransmissions('At 17:39 something unrelated happened.', rows);
ok('17:39 is only the afternoon', hit.length === 1 && hit[0].clip === 'c.opus',
   JSON.stringify(hit.map(r => r.clip)));

/* Still refuses to invent a citation out of shared vocabulary. */
hit = trace.toTransmissions('Some routine traffic came across the radio.', rows);
eq('vague prose traces to nothing', hit.length, 0);

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
