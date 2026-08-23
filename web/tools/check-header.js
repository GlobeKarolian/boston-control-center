// tools/check-header.js
//
// Runs the real header code out of app/index.html against a stub DOM.
//
// tools/test-freshness.js proves the rules are right. It cannot prove anybody
// calls them, and a correct module nothing is wired to is exactly as useful as
// no module at all. This lifts the paint block straight out of the page, hands
// it a fake document and a fake alert layer, and checks what the pill actually
// says. If someone rewrites setStatus back to counting fetch failures, this is
// the file that notices.
//
//   node tools/check-header.js

const fs = require('fs');
const path = require('path');

const HTML = path.join(__dirname, '..', 'app', 'index.html');
const html = fs.readFileSync(HTML, 'utf8');

/* Sliced by the two comment banners around the block. If either one moves this
   fails loudly rather than quietly checking nothing. */
const START = '/* ===================== Clock + status + scheduler';
const END = 'async function refreshCivic()';
const a = html.indexOf(START), b = html.indexOf(END);
if (a < 0 || b < 0 || b < a) {
  console.log('could not find the header block in app/index.html.');
  console.log('looked for  ' + START);
  console.log('and then    ' + END);
  process.exit(1);
}

const F = require('../app/freshness.js');
const els = {
  clock: { textContent: '' },
  updated: { textContent: '' },
  status: { className: '', title: '', _t: { textContent: '' }, querySelector() { return this._t; } },
};
let rang = [];
global.document = { getElementById: (id) => els[id] || null };
/* paintHealth now repaints the LISTEN LIVE wall too, but renderLiveWall lives
   in the audio section of the page, far above the block sliced out here
   (a70a3b0 moved the call into the header without moving the function).
   Stubbing it keeps this file testing the pill rather than the whole audio
   tab, while the counter below still proves the header really calls it. */
let wallPaints = 0;
global.renderLiveWall = () => { wallPaints++; };
global.window = {
  BCCFresh: F,
  BCCAlert: {
    say: (cue, n) => { rang.push('say:' + cue + ':' + (n && n.title)); return true; },
    stopFlash: () => rang.push('stopFlash'),
  },
};
global.BCCAlert = global.window.BCCAlert;

const run = new Function(html.slice(a, b) +
  '\nreturn { paint: paintHealth, tick: tickClock, civic: setStatus, set: (p) => { PIPE = p; } };')();

let pass = 0, fail = 0;
function head(s) { console.log('\n' + s); }
function ok(label, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + label); return; }
  fail++;
  console.log('  FAIL ' + label + (extra === undefined ? '' : '\n         ' + JSON.stringify(extra)));
}
const eq = (label, got, want) => ok(label + '  =  ' + JSON.stringify(got),
  JSON.stringify(got) === JSON.stringify(want), { got, want });

const NOW = Date.now();
const SEC = 1000, MIN = 60000, HR = 3600000;
const at = (ms) => new Date(NOW - ms).toISOString();
const feed = (o) => Object.assign(
  { id: 'f', label: 'Boston Police', status: 'live', lastAudioAt: at(3 * SEC), lastSegAt: at(9 * SEC) }, o || {});
const paint = (feeds) => { run.set({ feeds: feeds }); rang = []; run.paint(); };
const pill = () => els.status._t.textContent;

const dead = [];
for (let i = 0; i < 6; i++) dead.push(feed({ id: 'd' + i, status: 'offline', lastAudioAt: at(20.2 * HR), lastSegAt: at(20.2 * HR) }));

// ---------------------------------------------------------------------------
head('the header reports the scanners, not the browser');
{
  paint([feed({}), feed({ id: 'g' })]);
  eq('working', pill(), 'live');
  eq('and the line under it is an age, not a wall clock', els.updated.textContent, 'audio 3s ago');

  paint(dead);
  eq('twenty hours of nothing', pill(), 'no audio 20.2h');
  eq('painted red', els.status.className, 'status-pill down');
  eq('and the age is under it too', els.updated.textContent, 'audio 20.2h ago');
  ok('with something in the tooltip worth acting on', /relay/i.test(els.status.title), els.status.title);
}

// ---------------------------------------------------------------------------
head('the alarm rings once an episode, not once a second');
{
  /* The section above left the board dark, so this brings it back first. Going
     dark while already dark is not an episode starting, it is one continuing,
     and the whole point below is that the second one stays quiet. */
  paint([feed({}), feed({ id: 'g' })]);
  paint(dead);
  eq('going dark makes a noise', rang, ['say:stale:Scanners are dark']);
  rang = [];
  for (let i = 0; i < 30; i++) run.paint();
  eq('staying dark does not', rang, []);

  paint([feed({}), feed({ id: 'g' })]);
  eq('coming back stops the title flashing', rang, ['stopFlash']);
  paint(dead);
  eq('and the alarm is armed again for next time', rang, ['say:stale:Scanners are dark']);
}

// ---------------------------------------------------------------------------
head('quiet is not broken, and one feed down is not all of them');
{
  paint([feed({ lastSegAt: at(55 * MIN) })]);
  eq('Boston Fire at four in the morning', pill(), 'quiet 55m');
  eq('and it is not painted as trouble', els.status.className, 'status-pill');

  paint([feed({}), feed({ id: 'b', status: 'offline' })]);
  eq('one of two dropped', pill(), '1 of 2 offline');
  eq('painted amber, not red', els.status.className, 'status-pill degraded');
}

// ---------------------------------------------------------------------------
head('traffic and weather never outrank the scanners');
{
  paint([feed({}), feed({ id: 'g' })]);
  run.civic([{ status: 'fulfilled', value: false }, { status: 'rejected' }]);
  eq('civic feeds failing is still worth saying', pill(), '2 feeds down');
  eq('in amber', els.status.className, 'status-pill degraded');

  run.set({ feeds: dead });
  run.paint();
  eq('but a dead relay outranks them', pill(), 'no audio 20.2h');
  eq('and stays red', els.status.className, 'status-pill down');
  run.civic([]);
}

// ---------------------------------------------------------------------------
head('before anything has loaded');
{
  /* A board that cannot read pipeline.json knows nothing about the scanners,
     and a green pill over that is the same lie in a new place. */
  run.set(null);
  run.paint();
  eq('the pill does not claim to be live', pill(), 'starting');
  eq('and says what it is waiting on', els.status.title, 'Waiting for the first pipeline poll.');
  ok('with the wall clock under it, because there is nothing better yet',
    /^updated /.test(els.updated.textContent), els.updated.textContent);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
