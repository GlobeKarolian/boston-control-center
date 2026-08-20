// tools/test-desk-ask.js
//
// Drives api/desk-ask.js against an in-process archive.
//
// The ask box answered poorly on 19 August, and the shape of the failure was
// retrieval: the model was handed a hundred and fifty loose lines of forty
// calls and asked to say which were the biggest. It now reads SCENES
// (lib/scenes.js), chosen and ranked before the model sees them. What is
// checked here is that contract:
//
//   - a bare question gets the scenes that mattered, biggest first, each one
//     whole enough to write about
//   - a question that names a thing gets the scenes that contain it, with the
//     lines that did not repeat the word riding along
//   - a question that matches nothing says so, and still shows what happened
//   - the model is handed scenes, labelled as scenes, in Eastern time
//   - the transmissions come back to the panel so the answer can be audited
//
//   node tools/test-desk-ask.js

'use strict';

const stream = require('../lib/stream');
const llm = require('../lib/llm');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fail++;
  console.log('  FAIL ' + name + (extra === undefined ? '' : '  ' + (typeof extra === 'string' ? extra : JSON.stringify(extra))));
}
function section(t) { console.log('\n' + t); }

const NOW = Date.parse('2026-08-19T03:30:00Z');           // 11:30 PM Eastern, Aug 18
const ago = (m) => new Date(NOW - m * 60000).toISOString();
function row(min, feed, text, o) {
  const r = Object.assign({ at: ago(min), feed, src: feed, text, units: [], callType: null, matched: null, address: null,
    incidentId: null, tier: 0, signals: [], clip: null, town: 'Boston', city: 'Boston', lat: null, lon: null }, o || {});
  /* Every geocoded vault row carries a precision; the grouper trusts only
     exact and approx pins, so a fixture with coordinates gets one too. */
  if (Number.isFinite(r.lat) && r.lat && !r.precision) r.precision = 'exact';
  return r;
}
const H = { lat: 42.3105, lon: -71.0698 };
const ROWS = [
  /* The fire: three radios, one event, the biggest thing tonight. */
  row(95, 'boston-fire', 'Box 2112, Hancock and Bowdoin, heavy smoke showing second floor.', { incidentId: 'fire', units: ['E17', 'L7'], callType: 'fire', matched: 'Hancock St & Bowdoin St, Boston', tier: 3, signals: [{ id: 'working-fire', tier: 3 }], clip: 'https://c/f1.mp3', lat: H.lat, lon: H.lon }),
  row(90, 'boston-fire', 'Command to fire alarm, strike the second alarm.', { incidentId: 'fire', units: ['C6'], callType: 'fire', matched: 'Hancock St & Bowdoin St, Boston', tier: 3, signals: [{ id: 'alarm-escalate', tier: 3 }], clip: 'https://c/f2.mp3', lat: H.lat, lon: H.lon }),
  row(86, 'boston-ems', 'A-3 staging at Hancock and Bowdoin for the fire.', { incidentId: 'ems', units: ['A3'], matched: 'Hancock St & Bowdoin St, Boston', lat: H.lat + 0.0003, lon: H.lon }),
  row(80, 'boston-police', 'Shut Hancock between Bowdoin and Quincy for the fire.', { incidentId: 'pd', units: ['C11'], matched: 'Hancock St, Boston', lat: H.lat - 0.0004, lon: H.lon }),
  row(70, 'boston-fire', 'Primary search negative on floors one and two.', { incidentId: 'fire', units: ['L7'], matched: 'Hancock St & Bowdoin St, Boston', clip: 'https://c/f3.mp3', lat: H.lat, lon: H.lon }),
  row(55, 'boston-fire', 'Fire is knocked down, companies overhauling.', { incidentId: 'fire', units: ['C6'], callType: 'fire', matched: 'Hancock St & Bowdoin St, Boston', clip: 'https://c/f4.mp3', lat: H.lat, lon: H.lon }),
  /* The stabbing: the word is said once; what followed never says it. */
  row(40, 'boston-police', 'Units respond, stabbing, 1100 Blue Hill Ave, one victim.', { incidentId: 'stab', units: ['B3', 'B7'], callType: 'stabbing', matched: '1100 Blue Hill Ave, Boston', tier: 3, signals: [{ id: 'stabbing', tier: 3 }], clip: 'https://c/s1.mp3', lat: 42.2945, lon: -71.0876 }),
  row(36, 'boston-police', 'B3 on scene, one male, wound to the arm, EMS en route.', { incidentId: 'stab', units: ['B3'], matched: '1100 Blue Hill Ave, Boston', clip: 'https://c/s2.mp3', lat: 42.2945, lon: -71.0876 }),
  row(31, 'boston-police', 'Suspect fled on foot towards Morton, dark hoodie.', { incidentId: 'stab', units: ['B7'], matched: '1100 Blue Hill Ave, Boston', lat: 42.2945, lon: -71.0876 }),
  row(27, 'boston-ems', 'P1 transporting one to BMC, stable.', { incidentId: 'stab', units: ['P1'], matched: '1100 Blue Hill Ave, Boston', clip: 'https://c/s3.mp3', lat: 42.2945, lon: -71.0876 }),
  /* A medical, tier 2, and a car stop: the texture. */
  row(50, 'boston-ems', 'A-6 respond, 850 Boylston, unresponsive party.', { incidentId: 'med', units: ['A6'], callType: 'medical', matched: '850 Boylston St, Boston', tier: 2, signals: [{ id: 'unresponsive', tier: 2 }], lat: 42.3490, lon: -71.0820 }),
  row(46, 'boston-ems', 'A-6 on scene, patient breathing, transporting.', { incidentId: 'med', units: ['A6'], matched: '850 Boylston St, Boston', lat: 42.3490, lon: -71.0820 }),
  row(20, 'boston-police', 'Car 402 out with a vehicle, Dot Ave and Freeport.', { units: ['C402'], matched: 'Dorchester Ave & Freeport St, Boston' }),
  row(14, 'boston-police', 'Car 402 clear, verbal warning.', { units: ['C402'] }),
  row(8, 'mbta-transit', 'Operator, proceed on the signal.', {}),
  /* A fight in Cambridge, in the same window. */
  row(60, 'cambridge-police', 'Units to 14 JFK Street, Russell House Tavern, for a fight, about eight bikers.', { incidentId: 'brawl', units: ['C3', 'C5'], callType: 'fight', matched: '14 JFK ST, Cambridge', town: 'Cambridge', city: 'Cambridge', tier: 2, signals: [], clip: 'https://c/b1.mp3', lat: 42.3731, lon: -71.1208 }),
  row(57, 'cambridge-police', 'C3 on scene, parties separated, one refusing medical.', { incidentId: 'brawl', units: ['C3'], matched: '14 JFK ST, Cambridge', town: 'Cambridge', city: 'Cambridge', lat: 42.3731, lon: -71.1208 }),
];

/* ---- seams ---------------------------------------------------------------- */

let lastWindow = null;
stream.since = async function (fromISO, toISO, opts) {
  lastWindow = { from: fromISO, to: toISO, opts };
  const from = +new Date(fromISO), to = +new Date(toISO);
  const rows = ROWS.filter(r => { const t = +new Date(r.at); return t > from && t <= to; }).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return { rows, from: new Date(from), to: new Date(to), cursor: fromISO, complete: true, skipped: 0, sampled: false, objects: 2 };
};
stream.bufferSince = async () => [];
llm.enabled = () => true;
let modelSaw = null, modelMode = 'answer';
llm.chat = async function (o) {
  modelSaw = o;
  if (modelMode === 'down') throw new Error('no model tonight');
  return 'At 10:00 PM Boston Fire struck a second alarm at Hancock and Bowdoin; the fire was knocked down by 10:35 PM. At 10:50 PM police went to 1100 Blue Hill Ave for a stabbing, one transported to BMC.';
};

const handler = require('../api/desk-ask');

async function ask(q) {
  const req = { method: 'POST', body: { q }, headers: {} };
  let captured = null;
  const res = {
    _s: 200, setHeader() {},
    status(c) { this._s = c; return this; },
    send(b) { captured = { status: this._s, body: typeof b === 'string' ? JSON.parse(b) : b }; },
  };
  const RealDate = Date;
  global.Date = class extends RealDate {
    constructor(...a) { if (!a.length) { super(NOW); return; } super(...a); }
    static now() { return NOW; }
  };
  try { await handler(req, res); } finally { global.Date = RealDate; }
  return captured;
}
const sceneIds = (r) => (r.body.scenes || []).map(s => s.id);

(async function run() {

  section('a bare question: the scenes that mattered, biggest first');
  {
    const r = await ask('what were the biggest calls tonight');
    ok('answers', r && r.status === 200 && r.body.ok, r && r.body);
    ok('tonight is a named window, not the two-hour default', r.body.window.named === true && /tonight/.test(r.body.window.label), r.body.window);
    const ids = sceneIds(r);
    ok('the fire leads', ids[0] && ['fire', 'ems', 'pd'].includes(ids[0]), ids);
    ok('the stabbing is next', ids[1] === 'stab', ids);
    ok('the brawl and the medical are on it', ids.includes('brawl') && ids.includes('med'), ids);
    const fire = r.body.scenes.find(s => ['fire', 'ems', 'pd'].includes(s.id));
    ok('the fire is one scene across three radios', fire && fire.feeds.length === 3 && fire.n === 6, fire);
    ok('with its units', fire && fire.units.length === 5, fire && fire.units);
    ok('the car stop and the transit line are not scenes that mattered', !ids.some(i => /loose/.test(i)), ids);
    ok('the model was told these are scenes, biggest first', modelSaw && /The most significant scenes in the window, biggest first/.test(modelSaw.user));
    ok('and handed the fire as one block with its span, radios, place and units',
       modelSaw && /SCENE 1 — \d{1,2}:\d\d( to \d{1,2}:\d\d)? ET — boston-fire, boston-ems, boston-police — at Hancock St & Bowdoin St, Boston — fire — units E17 L7 C6 A3 C11 — 6 transmissions/.test(modelSaw.user), modelSaw && modelSaw.user.split('\n').find(l => /^SCENE 1/.test(l)));
    ok('every line of the fire is under that block, in order', modelSaw && /Box 2112[\s\S]*second alarm[\s\S]*staging[\s\S]*Shut Hancock[\s\S]*Primary search[\s\S]*knocked down/.test(modelSaw.user));
    ok('times are Eastern on every line', modelSaw && /\d{1,2}:\d\d ET \[boston-fire\]/.test(modelSaw.user) && !/Z\]/.test(modelSaw.user) && /21:55 ET/.test(modelSaw.user), modelSaw && modelSaw.user.split('\n').slice(3, 5));
    ok('the stronger model answers the ask', modelSaw && modelSaw.model === llm.SCENE_MODEL && modelSaw.fallback === llm.PRIMARY, modelSaw && [modelSaw.model, modelSaw.fallback]);
    ok('the transmissions come back for the panel', Array.isArray(r.body.tx) && r.body.tx.length >= 14 && r.body.tx[0].src, r.body.tx && r.body.tx.length);
    ok('and the answer traces to its audio', r.body.cited && r.body.cited.n >= 2, r.body.cited);
    ok('the answer is the model\'s', /second alarm/.test(r.body.answer));
  }

  section('a question that names a thing: the scene, whole');
  {
    const r = await ask('any stabbings tonight');
    const ids = sceneIds(r);
    ok('the stabbing is the only matching scene', ids.length === 1 && ids[0] === 'stab', ids);
    const stab = r.body.scenes[0];
    ok('and it comes whole: four lines, one of which says stabbing', stab.n === 4 && stab.matched === 1, stab);
    ok('the lines that never said the word are in the prompt', modelSaw && /Suspect fled on foot/.test(modelSaw.user) && /transporting one to BMC/.test(modelSaw.user));
    ok('the model is told they match what was asked', modelSaw && /Scenes with at least one transmission matching what was asked about/.test(modelSaw.user));
    ok('context rides along, because one match is thin', /For context, the most significant OTHER scenes/.test(modelSaw.user) && /CONTEXT 1/.test(modelSaw.user));
    ok('and the fire is that context, not the car stop', /CONTEXT 1 — [^\n]*boston-fire/.test(modelSaw.user) && !/Car 402/.test(modelSaw.user), modelSaw && modelSaw.user.split('\n').filter(l => /^CONTEXT/.test(l)));
    ok('matched count is the matching lines', r.body.matched === 4);
  }

  section('a place: the brawl in Harvard Square, said by street');
  {
    const r = await ask('fight in harvard square tonight');
    const ids = sceneIds(r);
    ok('the Russell House brawl is found by the square it stands in', ids[0] === 'brawl', ids);
    ok('and only it', ids.length === 1, ids);
  }

  section('a question that matches nothing says so, and shows what happened');
  {
    const r = await ask('any hazmat tonight');
    ok('no matching scenes', r.body.scenes.length === 0, r.body.scenes);
    ok('the model is told nothing matched, plainly, and that the window was complete', modelSaw && /NOTHING in the \d+ transmissions heard matches what was asked about, and those are ALL of them/.test(modelSaw.user));
    ok('and is given the biggest scenes as context', /CONTEXT 1 — [^\n]*boston-fire/.test(modelSaw.user));
    ok('the panel still gets those lines', r.body.tx.length > 0 && r.body.matched === 0);
  }

  section('a bare question with no time reaches back two hours');
  {
    const r = await ask('anything going on');
    ok('two-hour window', r.body.window.named === false && /last 2 hours/.test(r.body.window.label), r.body.window);
    ok('read exactly that', lastWindow && Math.abs((+new Date(lastWindow.to)) - NOW) < 1000 && Math.abs((+new Date(lastWindow.from)) - (NOW - 2 * 3600000)) < 1000);
    const ids = sceneIds(r);
    ok('the fire, the stabbing, the brawl, the medical, ranked', ids.length >= 4 && ['fire', 'ems', 'pd'].includes(ids[0]) && ids[1] === 'stab', ids);
  }

  section('no model: the shortlist still comes back');
  {
    modelMode = 'down';
    const r = await ask('what were the biggest calls tonight');
    ok('ok, no answer, a reason, the transmissions', r.body.ok && r.body.answer === null && /no model tonight/.test(r.body.why) && r.body.tx.length > 10, r.body.why);
    modelMode = 'answer';
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  FAIL threw: ' + (e && e.stack || e)); process.exit(1); });
