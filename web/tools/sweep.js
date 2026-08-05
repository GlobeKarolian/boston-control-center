// tools/sweep.js
//
// One command that runs everything: the unit suites, the shape checks on
// index.html, the race check, and the vercel.json guard. Anything that can
// fail a deploy or ship a broken board should fail here, in a run that takes
// a few seconds, rather than in the terminal at the moment somebody is trying
// to get a story out.
//
//   node tools/sweep.js
//   npm run sweep

var cp = require('child_process');
var fs = require('fs');

/* Several of these read paths relative to the working directory, so running
   the sweep from tools/ would report failures that are really just a wrong
   cwd. Say so plainly instead of letting it look like broken code. */
if (!fs.existsSync('vercel.json') || !fs.existsSync('app/index.html')) {
  console.log('run this from the repo root:  cd ~/Developer/bcc/web && node tools/sweep.js');
  process.exit(1);
}

var STEPS = [
  'tools/test-alerts.js',
  'tools/test-freshness.js',
  'tools/test-sitlink.js',
  'tools/test-statepolice.js',
  'tools/test-threads.js',
  'tools/test-threadui.js',
  'tools/test-track.js',
  'tools/test-webcams.js',
  'tools/test-clips.js',
  'tools/test-blob.js',
  'tools/check-html.js',
  'tools/check-header.js',
  'tools/check-vercel.js',
  'tools/check-embed.js',
  'tools/race-check.js',
];

function pad(s) { return (s + '                              ').slice(0, 26); }

var bad = [];
var missing = [];

STEPS.forEach(function (s) {
  if (!fs.existsSync(s)) {
    missing.push(s);
    console.log('  skip  ' + pad(s) + 'not on disk');
    return;
  }
  var r = cp.spawnSync(process.execPath, [s], { encoding: 'utf8' });
  var out = ((r.stdout || '') + (r.stderr || '')).trim();
  var lines = out.split('\n');
  /* Two of these print a loud [kv] notice about Redis not being wired up in a
     local process. That notice is not the result, so pick the line that reads
     like a verdict, and fall back to the last line only if there is not one. */
  var say = lines.filter(function (l) { return /(passed|failed|failures|all clear)/.test(l) || /^ok\b/.test(l.trim()); });
  var tail = (say.length ? say[say.length - 1] : lines[lines.length - 1] || '').trim().slice(0, 150);
  if (r.status === 0) { console.log('  ok    ' + pad(s) + tail); return; }
  bad.push(s);
  console.log('  FAIL  ' + pad(s));
  console.log(lines.map(function (l) { return '          ' + l; }).join('\n'));
});

console.log('');
/* A suite that quietly stopped existing is worth a line of its own. A green
   run with three files missing is not the same thing as a green run. */
if (missing.length) console.log('note: ' + missing.length + ' step(s) missing: ' + missing.join(', '));

if (bad.length) {
  console.log(bad.length + ' of ' + STEPS.length + ' failed: ' + bad.join(', '));
  process.exit(1);
}
console.log((STEPS.length - missing.length) + ' of ' + STEPS.length + ' green, nothing red');
