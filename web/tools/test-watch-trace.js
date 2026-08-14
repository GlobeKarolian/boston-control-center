// tools/test-watch-trace.js
//
//   node tools/test-watch-trace.js
//
// lib/trace.js turns prose back into transmissions, and everything it returns
// becomes a play button. It has to point at the right audio or at nothing,
// because a play button that lies teaches a reporter the panel lies.

const trace = require('../lib/trace.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '   ' + detail : '')); }
};

const ROWS = [
  { at: '2026-08-14T05:09:00Z', text: 'At the Four Corners Geneva area, four Hispanic males, one went into the building', clip: 'c1' },
  { at: '2026-08-14T05:12:00Z', text: 'Footchase down Geneva Street toward the back of the apartment building on Columbia', clip: 'c2' },
  { at: '2026-08-14T05:13:00Z', text: 'Units responding to 405 Geneva', clip: 'c3' },
  { at: '2026-08-14T05:21:00Z', text: 'So if I can swing by 7-Eleven and see if this employee wants to file a report', clip: 'c4' },
  { at: '2026-08-14T05:20:00Z', text: 'Daniel, it is 22, Boston, 240 Mount Vernon Street on Lobby Hill 2', clip: 'c5' },
  { at: '2026-08-14T04:03:00Z', text: 'Report of a possible burglary in progress, 2565 Washington Street', clip: 'c6' },
  { at: '2026-08-14T04:04:00Z', text: 'We have an alarm going off at 592 East 3rd Street, unknown type', clip: 'c7' },
];

/* The real answer from the desk on 14 August, verbatim. */
const ANSWER = 'At 05:12Z Boston Police reported a footchase down Geneva Street toward '
  + 'the back of the apartment building on Columbia, units responding to 405 Geneva. '
  + 'At 05:09Z at the Four Corners/Geneva area, an officer observed four Hispanic males; '
  + 'one went into the building and through the backyard into the basement door.';

const cited = trace.cited(ANSWER, ROWS);
ok('an answer finds the transmissions it describes', cited.n >= 3, 'n=' + cited.n);
ok('including the two it cited by clock time',
   cited.at.includes('2026-08-14T05:12:00Z') && cited.at.includes('2026-08-14T05:09:00Z'),
   JSON.stringify(cited.at));
ok('and the street number it named', cited.at.includes('2026-08-14T05:13:00Z'));
ok('the 7-Eleven call is not part of it', !cited.at.includes('2026-08-14T05:21:00Z'));
ok('nor is the unrelated Mount Vernon run', !cited.at.includes('2026-08-14T05:20:00Z'));
ok('nor the burglary an hour earlier', !cited.at.includes('2026-08-14T04:03:00Z'));
ok('it comes back in the order it was said',
   cited.at.every((a, i, arr) => i === 0 || arr[i - 1] <= a), JSON.stringify(cited.at));
ok('and it carries audio', cited.clips.length === cited.n);

/* Watch items, the other caller. */
const burg = trace.toTransmissions('possible burglary at 2565 Washington Street', ROWS);
ok('a street number alone is a citation', burg.length === 1 && /2565/.test(burg[0].text));

/* The failures that matter. */
ok('a fabricated claim traces to nothing',
   trace.toTransmissions('active shooter at 81 Walden Street', ROWS).length === 0);
ok('a vague claim traces to nothing',
   trace.toTransmissions('some kind of situation downtown', ROWS).length === 0);
ok('a single echoed word is not a citation',
   trace.toTransmissions('something about a building', ROWS).length === 0);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
