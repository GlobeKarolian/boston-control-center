// tools/test-watch-trace.js
//
//   node tools/test-watch-trace.js
//
// A watch item on the desk panel is a play button. It has to point at the
// right audio or not exist, because a play button pointed at the wrong
// transmission is worse than no play button.

const path = require('path');
const src = require('fs').readFileSync(path.join(__dirname, '../api/desk-read.js'), 'utf8');
/* traceWatch is module-private on purpose; lift it out rather than widening
   the endpoint's surface just to test it. */
const traceWatch = new Function('WATCH_STOP_SRC', `
  ${src.match(/const WATCH_STOP[\s\S]*?return hits\.slice\(0, 8\)[\s\S]*?\n}/)[0]}
  return traceWatch;
`)();

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '   ' + detail : '')); }
};

const ROWS = [
  { at: '2026-08-14T05:03:00Z', text: 'Report of a possible burglary in progress, 2565 Washington Street', clip: 'c1' },
  { at: '2026-08-14T05:04:00Z', text: 'We have an alarm going off at 592 East 3rd Street, unknown type', clip: 'c2' },
  { at: '2026-08-14T05:05:00Z', text: 'All set on Washington Street, we are clear', clip: 'c3' },
  { at: '2026-08-14T05:06:00Z', text: 'Yeah, thanks. Have a good night.', clip: 'c4' },
  { at: '2026-08-14T05:07:00Z', text: '2565 Washington, units on scene, nothing showing', clip: 'c5' },
];

const burg = traceWatch('possible burglary at 2565 Washington Street', ROWS);
ok('a street number finds its transmissions', burg.length === 2, 'n=' + burg.length);
ok('and only the ones carrying that number',
   burg.every(r => /2565/.test(r.text)), burg.map(r => r.text).join(' | '));
ok('in the order they were said', burg[0].at < burg[1].at);

const alarm = traceWatch('alarm going off at 592 East 3rd Street', ROWS);
ok('a second item finds its own', alarm.length === 1 && /592/.test(alarm[0].text));

/* The case that matters most: the model made something up. */
const ghost = traceWatch('active shooter at 81 Walden Street', ROWS);
ok('an untraceable claim gets no audio', ghost.length === 0, 'n=' + ghost.length);

const vague = traceWatch('some kind of situation', ROWS);
ok('a vague item gets no audio either', vague.length === 0, 'n=' + vague.length);

/* "Washington Street" alone is in three of five rows: common words must not
   masquerade as a citation. */
const common = traceWatch('something on Street', ROWS);
ok('a single common word is not a citation', common.length === 0, 'n=' + common.length);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
