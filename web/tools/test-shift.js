// tools/test-shift.js
//
// Drives api/shift-change.js against an in-process archive and board.
//
// The handoff briefing stopped asking "day or night" on 19 August. It is the
// last ten hours from the moment it loads, in three parts: what is open as
// you sit down, the major calls of the stretch, and the compact list of
// everything else that was more than routine. What is checked here is the
// contract a person arriving at the desk depends on, not that a handler
// answers 200:
//
//   - the window is ten hours back from now, whatever the clock says, and
//     the label says so in Eastern time
//   - a fire still running is in the open list AND marked live in the major
//     list, because the two lists answer different questions
//   - the open list is ranked the way a desk would rank it, and a store scene
//     standing on a board situation is not listed twice
//   - a single routine unit is not a thing to watch, and a scene nobody has
//     mentioned in two hours is not open
//   - the major list is the floor's ranking, and the notes are what cleared
//     the bar without clearing it by much
//   - with no model, the briefing still comes back whole with the items and
//     their audio
//
//   node tools/test-shift.js

'use strict';

const kv = require('../lib/kv');
const { K } = require('../lib/store-io');
const stream = require('../lib/stream');
const llm = require('../lib/llm');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fail++;
  console.log('  FAIL ' + name + (extra === undefined ? '' : '  ' + (typeof extra === 'string' ? extra : JSON.stringify(extra))));
}
function section(t) { console.log('\n' + t); }

/* ---- a fixed clock, and a fixed archive under it ------------------------ */

const NOW = Date.parse('2026-08-19T15:00:00Z');            // 11:00 AM Eastern
const ago = (m) => new Date(NOW - m * 60000).toISOString();

/* Vault rows the way lib/vault.txRecord writes them: at, feed, text, units,
   callType, matched, incidentId, tier, signals, clip. */
function row(min, feed, text, o) {
  return Object.assign({
    at: ago(min), feed, src: feed, text, units: [], callType: null, matched: null, address: null,
    incidentId: null, tier: 0, signals: [], clip: null,
  }, o || {});
}

const FIRE = 'inc-fire-hancock';      // still running as the reader sits down
const STAB = 'inc-stab-blue-hill';    // over, hours ago
const MED = 'inc-med-boylston';       // tier 2, a note
const ROWS = [
  /* The fire: three feeds, fireground language, working-fire signal, live. */
  row(58, 'boston-fire', 'Box 2112, Hancock and Bowdoin, heavy smoke showing from the second floor.',
      { incidentId: FIRE, units: ['E17', 'L7'], callType: 'fire', matched: 'Hancock St & Bowdoin St', tier: 3,
        signals: [{ id: 'working-fire', tier: 3 }], clip: 'https://clips.example/fire-1.mp3' }),
  row(52, 'boston-fire', 'Command to fire alarm, strike a second alarm, we have a working fire.',
      { incidentId: FIRE, units: ['C6'], callType: 'fire', matched: 'Hancock St & Bowdoin St', tier: 3,
        signals: [{ id: 'alarm-escalate', tier: 3 }], clip: 'https://clips.example/fire-2.mp3' }),
  row(40, 'boston-ems', 'A-3 staging at Hancock and Bowdoin for the fire.',
      { incidentId: FIRE, units: ['A3'], matched: 'Hancock St & Bowdoin St', clip: 'https://clips.example/fire-3.mp3' }),
  row(30, 'boston-police', 'Shut Hancock between Bowdoin and Quincy for the fire.',
      { incidentId: FIRE, units: ['C11'], matched: 'Hancock St & Bowdoin St' }),
  row(5, 'boston-fire', 'Ladder pipe in operation, all companies out of the building.',
      { incidentId: FIRE, units: ['L7'], callType: 'fire', matched: 'Hancock St & Bowdoin St', clip: 'https://clips.example/fire-4.mp3' }),

  /* The stabbing: two feeds, over by 3am. */
  row(480, 'boston-police', 'Units respond, stabbing, 1100 Blue Hill Ave, one victim.',
      { incidentId: STAB, units: ['B3', 'B7'], callType: 'stabbing', matched: '1100 Blue Hill Ave', tier: 3,
        signals: [{ id: 'stabbing', tier: 3 }], clip: 'https://clips.example/stab-1.mp3' }),
  row(474, 'boston-ems', 'P1 transporting one to BMC, stab wound to the arm, stable.',
      { incidentId: STAB, units: ['P1'], matched: '1100 Blue Hill Ave', clip: 'https://clips.example/stab-2.mp3' }),
  row(470, 'boston-police', 'B3, scene is secure, suspect fled on foot.',
      { incidentId: STAB, units: ['B3'], matched: '1100 Blue Hill Ave' }),

  /* A medical with a tier-2 signal: a note, not a story. */
  row(200, 'boston-ems', 'A-6 respond, 850 Boylston, unresponsive party.',
      { incidentId: MED, units: ['A6'], callType: 'medical', matched: '850 Boylston St', tier: 2,
        signals: [{ id: 'unresponsive', tier: 2 }], clip: 'https://clips.example/med-1.mp3' }),
  row(196, 'boston-ems', 'A-6 on scene, patient is breathing, transporting.',
      { incidentId: MED, units: ['A6'], matched: '850 Boylston St' }),

  /* Routine, loose, no scene: must not appear anywhere but the counts. */
  row(300, 'boston-police', 'Car 402 clear, back in service.', {}),
  row(120, 'cambridge-police', 'Records check on a plate, stand by.', {}),
  row(90, 'mbta-transit', 'Operator, proceed on the signal.', {}),

  /* Before the window: must not be read at all (the fake archive honours from/to). */
  row(700, 'boston-police', 'Shots fired, 50 Warren St, multiple callers.',
      { incidentId: 'inc-old', units: ['B2'], callType: 'shooting', tier: 3, signals: [{ id: 'shots-fired', tier: 3 }] }),
];

/* The board the analyst keeps, and the store under it. */
const SITUATIONS = [
  { id: 'sit-fire', headline: 'Second alarm on Hancock Street', summary: 'Heavy smoke from a three-decker, ladder pipe in operation.',
    type: 'fire', priority: 'high', status: 'active', major: true, verified: true, severity: 4, severityLabel: 'big',
    location: 'Hancock St at Bowdoin St, Dorchester', lat: 42.3105, lon: -71.0698, feeds: ['boston-fire', 'boston-ems'],
    firstSeen: ago(55), updated: ago(4),
    events: [{ kind: 'opened', text: 'Second alarm on Hancock Street', at: ago(55), clips: ['https://clips.example/fire-1.mp3', 'https://clips.example/fire-2.mp3'] }] },
  { id: 'sit-closed', headline: 'Stabbing on Blue Hill Ave', summary: 'One transported.', type: 'stabbing', priority: 'high',
    status: 'closed', location: '1100 Blue Hill Ave', lat: 42.2945, lon: -71.0876, feeds: ['boston-police'], firstSeen: ago(480), updated: ago(420), events: [] },
  { id: 'sit-dev', headline: 'Water main break on Centre Street', summary: 'Northbound side under water, BWSC on the way.',
    type: 'water main', priority: 'normal', status: 'developing', location: 'Centre St at Burroughs St', lat: 42.3172, lon: -71.1148,
    feeds: ['boston-fire'], firstSeen: ago(34), updated: ago(9), events: [] },
];
const INCIDENTS = [
  /* The fire scene in the store, standing on the board situation: listed once. */
  { id: FIRE, status: 'active', type: 'fire', location: 'Hancock St & Bowdoin St', lat: 42.3106, lon: -71.0699,
    units: ['E17', 'L7', 'C6', 'A3', 'C11'], tier: 3, tierName: 'big', heat: 71, alarm: 2, priority: 'high',
    firstHeard: ago(58), lastUpdate: ago(5), feed: 'boston-fire', depts: ['boston-fire', 'boston-ems', 'boston-police'],
    timeline: [{ t: ago(5), source: 'boston-fire', text: 'Ladder pipe in operation.', clip: 'https://clips.example/fire-4.mp3' }] },
  /* A live scene the analyst has not written up: worth half an eye. */
  { id: 'inc-crash', status: 'active', type: 'crash', location: 'Storrow Dr EB at Fenway', lat: 42.3521, lon: -71.1005,
    units: ['E33', 'A2', 'C14'], tier: 1, heat: 36, priority: 'normal', firstHeard: ago(14), lastUpdate: ago(2), feed: 'boston-fire',
    depts: ['boston-fire', 'boston-ems'], why: ['3 units', '2 departments'],
    timeline: [{ t: ago(14), source: 'boston-fire', text: 'Two cars, one on its side, send EMS.' },
               { t: ago(2), source: 'boston-ems', text: 'A-2 transporting one, minor.', clip: 'https://clips.example/crash-2.mp3' }] },
  /* One unit, nothing said: the radio working, not a thing to watch. */
  { id: 'inc-routine', status: 'active', type: 'unclassified', location: '12 Main St', lat: 42.36, lon: -71.06,
    units: ['C402'], tier: 0, heat: 8, firstHeard: ago(6), lastUpdate: ago(3), feed: 'boston-police', timeline: [] },
  /* Active in the store but silent for two hours: not open. */
  { id: 'inc-stale', status: 'active', type: 'disturbance', location: '5 Park St', lat: 42.357, lon: -71.063,
    units: ['B1', 'B2', 'B3', 'B4'], tier: 2, heat: 44, firstHeard: ago(200), lastUpdate: ago(130), feed: 'boston-police', timeline: [] },
  /* Cleared: not open. */
  { id: 'inc-cleared', status: 'cleared', type: 'fire', location: '9 Elm St', lat: 42.35, lon: -71.07,
    units: ['E1', 'E2', 'L1'], tier: 3, heat: 60, firstHeard: ago(300), lastUpdate: ago(280), feed: 'boston-fire', timeline: [] },
];

/* ---- the seams ---------------------------------------------------------- */

let lastWindow = null;
stream.since = async function (fromISO, toISO, opts) {
  lastWindow = { from: fromISO, to: toISO, opts };
  const from = +new Date(fromISO), to = +new Date(toISO);
  const rows = ROWS.filter(r => { const t = +new Date(r.at); return t > from && t <= to; })
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return { rows, from: new Date(from), to: new Date(to), cursor: rows.length ? rows[rows.length - 1].at : fromISO,
           complete: true, skipped: 0, sampled: false, objects: 3 };
};

let modelMode = 'write';       // 'write' | 'down'
let modelSaw = null;
llm.chatJSON = async function (o) {
  modelSaw = o;
  if (modelMode === 'down') throw new Error('no model configured');
  const n = (String(o.user).match(/^ITEM \d+/gm) || []).length;
  return {
    lead: 'The Hancock Street fire is still being worked as you sit down. Before it, a stabbing on Blue Hill Ave overnight; otherwise a quiet stretch.',
    items: Array.from({ length: n }, (_, i) => ({ headline: 'Item ' + (i + 1) + ' headline', what: 'What happened on item ' + (i + 1) + '.', unsure: i === 0 ? 'whether anyone was inside' : '' })),
  };
};

kv._reset();
kv._put(K.outSituations, JSON.stringify(SITUATIONS));
kv._put(K.outIncidents, JSON.stringify(INCIDENTS));

const handler = require('../api/shift-change');

async function call(query) {
  const req = { method: 'GET', query: query || {}, headers: {} };
  let captured = null;
  const res = {
    _s: 200,
    setHeader() {},
    status(c) { this._s = c; return this; },
    send(b) { captured = { status: this._s, body: typeof b === 'string' ? JSON.parse(b) : b }; },
  };
  /* The handler reads the clock; pin it. */
  const realNow = Date.now;
  Date.now = () => NOW;
  const RealDate = Date;
  global.Date = class extends RealDate {
    constructor(...a) { if (!a.length) { super(NOW); return; } super(...a); }
    static now() { return NOW; }
  };
  try { await handler(req, res); }
  finally { global.Date = RealDate; Date.now = realNow; }
  return captured;
}

/* ========================================================================== */

(async function run() {

  section('the window is ten hours back from now, not a shift on a clock');
  {
    const r = await call({});
    ok('answers', r && r.status === 200 && r.body.ok, r && r.body);
    const w = r.body.window;
    ok('ten hours', w && Math.round(w.hours) === 10, w);
    ok('ends now', w && Math.abs(+new Date(w.to) - NOW) < 1000, w && w.to);
    ok('starts ten hours ago', w && Math.abs(+new Date(w.from) - (NOW - 10 * 3600000)) < 1000, w && w.from);
    ok('and says so, in Eastern, as a stretch and not a shift name',
       w && /^Last 10 hours · 1:00 AM to 11:00 AM$/.test(w.label), w && w.label);
    ok('the archive was read for exactly that window',
       lastWindow && Math.abs(+new Date(lastWindow.to) - NOW) < 1000 && Math.abs(+new Date(lastWindow.from) - (NOW - 10 * 3600000)) < 1000, lastWindow);
    ok('and read evenly across it, not the newest slice', lastWindow && lastWindow.opts && lastWindow.opts.evenly === true);
    ok('the old day/night field is gone', w && w.shift === undefined);

    const nope = await call({ shift: 'night' });
    ok('asking for a shift by name gets the last ten hours anyway', nope.body.ok && Math.round(nope.body.window.hours) === 10, nope.body.window);
    const six = await call({ hours: '6' });
    ok('hours= is honoured', six.body.ok && six.body.window.hours === 6 && /^Last 6 hours/.test(six.body.window.label), six.body.window);
    const big = await call({ hours: '90' });
    ok('and capped at a day', big.body.ok && big.body.window.hours === 24, big.body.window);
    const bad = await call({ hours: 'soon' });
    ok('nonsense falls back to ten', bad.body.ok && Math.round(bad.body.window.hours) === 10, bad.body.window);
    const custom = await call({ from: ago(120), to: ago(60) });
    ok('an explicit from/to still works for the archive tab', custom.body.ok && Math.round(custom.body.window.hours) === 1, custom.body.window);
  }

  section('things to watch: what is open as you sit down');
  {
    const r = await call({});
    const watch = r.body.watch;
    ok('the list exists', Array.isArray(watch));
    const ids = watch.map(w => w.id);
    ok('the fire on the board is first: high priority, major, live', ids[0] === 'sit-fire', ids);
    ok('the crash the analyst has not written up is on it', ids.includes('inc-crash'), ids);
    ok('the developing water main is on it', ids.includes('sit-dev'), ids);
    ok('the closed stabbing is not', !ids.includes('sit-closed'), ids);
    ok('the store copy of the fire is not listed a second time under the situation', !ids.includes(FIRE), ids);
    ok('one routine unit is not a thing to watch', !ids.includes('inc-routine'), ids);
    ok('a scene silent for two hours is not open', !ids.includes('inc-stale'), ids);
    ok('a cleared scene is not open', !ids.includes('inc-cleared'), ids);
    const fire = watch.find(w => w.id === 'sit-fire');
    ok('a situation carries its headline and summary', fire && fire.headline === 'Second alarm on Hancock Street' && /ladder pipe/i.test(fire.what));
    ok('and the clips off its beats', fire && fire.clips.length === 2, fire && fire.clips);
    ok('and its status and priority', fire && fire.status === 'active' && fire.priority === 'high' && fire.major === true);
    const crash = watch.find(w => w.id === 'inc-crash');
    ok('a store scene is named by type and place', crash && crash.headline === 'crash at Storrow Dr EB at Fenway', crash && crash.headline);
    ok('says what was last heard on it, with the clock', crash && /^Last heard \d{1,2}:\d\d (AM|PM): A-2 transporting one/.test(crash.what), crash && crash.what);
    ok('carries its units and its reasons', crash && crash.units.length === 3 && crash.why.length === 2);
    ok('and the transmissions behind it with their clips', crash && crash.tx.length === 2 && crash.clips.length === 1);
    ok('the high-priority situation ranks above the normal one', ids.indexOf('sit-fire') < ids.indexOf('sit-dev'));
  }

  section('major calls: the floor ranks, the model writes, live is marked');
  {
    modelMode = 'write';
    const r = await call({});
    const major = r.body.major;
    ok('the fire and the stabbing cleared the bar', major.length === 2, major.map(m => m.id));
    ok('the fire leads: three agencies and a second alarm', major[0].id === FIRE, major.map(m => m.id));
    ok('the fire is marked live, the store still has it active', major[0].live === true);
    ok('the stabbing, over for seven hours, is not', major[1].live === false);
    ok('each carries the model\'s headline and what', major.every(m => /headline$/.test(m.headline) && /^What happened/.test(m.what)));
    ok('the first carries what to confirm', major[0].unsure === 'whether anyone was inside');
    ok('and its kind', major[0].kind === 'fire' && major[1].kind === 'crime', major.map(m => m.kind));
    ok('and its audio, oldest first', major[0].clips.length >= 3 && /fire-1/.test(major[0].clips[0]), major[0].clips);
    ok('and the transmissions it was built from', major[0].tx.length === 5 && major[0].n === 5);
    ok('and why the floor picked it', major[0].why.some(w => /heard on the radio/.test(w)) && major[0].why.some(w => /agencies/.test(w)), major[0].why);
    ok('the shooting before the window was never read', !major.some(m => m.id === 'inc-old'));
    ok('`items` still answers for anything reading the old name', Array.isArray(r.body.items) && r.body.items.length === major.length);
    ok('the model was told the fire is still running', modelSaw && /STILL RUNNING/.test(modelSaw.user));
    ok('and given the open list for the lead', modelSaw && /OPEN RIGHT NOW/.test(modelSaw.user) && /Second alarm on Hancock Street/.test(modelSaw.user));
    ok('and told the window in hours, not a shift', modelSaw && /last 10 hours/.test(modelSaw.system) && !/shift that's ending/.test(modelSaw.system));
    ok('the lead is the model\'s', /still being worked as you sit down/.test(r.body.lead));
  }

  section('also heard: more than routine, less than a story');
  {
    const r = await call({});
    const notes = r.body.notes;
    ok('the tier-2 medical is a note', notes.length === 1 && notes[0].id === MED, notes.map(n => n.id));
    ok('named by type, place and clock, with no prose', notes[0] && /^medical · 850 Boylston St · \d{1,2}:\d\d (AM|PM)$/.test(notes[0].headline) && notes[0].what === undefined, notes[0] && notes[0].headline);
    ok('with its clip and its lines', notes[0] && notes[0].clips.length === 1 && notes[0].tx.length === 2);
    ok('and not marked live: three hours old', notes[0] && notes[0].live === false);
    ok('loose routine chatter is in the count and nowhere else',
       r.body.coverage.transmissions === ROWS.filter(x => +new Date(x.at) > NOW - 10 * 3600000).length
       && !notes.some(n => /loose/.test(n.id)) && !r.body.major.some(m => /loose/.test(m.id)));
    ok('feeds heard are counted', r.body.heard && r.body.heard['boston-fire'] >= 3, r.body.heard);
  }

  section('no model: the briefing still comes back whole');
  {
    modelMode = 'down';
    const r = await call({});
    ok('still ok', r.body.ok);
    ok('the lead says the summary is unavailable and why', /Written summary unavailable/.test(r.body.lead) && /no model configured/.test(r.body.lead), r.body.lead);
    ok('the items are still there, named by type and time', r.body.major.length === 2 && /^fire, /.test(r.body.major[0].headline), r.body.major.map(m => m.headline));
    ok('with their audio', r.body.major[0].clips.length >= 3);
    ok('and the open list is untouched by the model being down', r.body.watch.length === 3, r.body.watch.map(w => w.id));
    modelMode = 'write';
  }

  section('a quiet stretch, honestly');
  {
    const saved = ROWS.splice(0, ROWS.length);
    ROWS.push(row(30, 'boston-police', 'Car 402 clear, back in service.'), row(20, 'mbta-transit', 'Proceed on the signal.'));
    const r = await call({});
    ok('ok with nothing to write', r.body.ok && r.body.major.length === 0 && r.body.notes.length === 0);
    ok('the lead counts what was open and says the rest was routine',
       /3 things open right now/.test(r.body.lead) && /2 transmissions across 2 feeds, all of it routine/.test(r.body.lead), r.body.lead);
    ok('the open list is still the open list', r.body.watch.length === 3);
    ROWS.push(...saved);
    ROWS.splice(0, 2);
  }

  section('nothing at all');
  {
    const saved = ROWS.splice(0, ROWS.length);
    kv._put(K.outSituations, '[]');
    kv._put(K.outIncidents, '[]');
    const r = await call({});
    ok('ok, empty, honest', r.body.ok && r.body.watch.length === 0 && /No transmissions are archived/.test(r.body.lead), r.body.lead);
    ROWS.push(...saved);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  FAIL threw: ' + (e && e.stack || e)); process.exit(1); });
