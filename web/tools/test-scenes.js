// tools/test-scenes.js
//
// lib/scenes.js turns archived transmissions back into the calls they came
// from, for the Archive, the desk's ask box and Shift Change together. What is
// checked here is each of the three passes against the cases that made it
// necessary: a fire three radios worked coming back as one card, a unit that
// works all night NOT welding two calls together, and loose lines landing on
// the scene they belong to instead of in a bag per feed.
//
//   node tools/test-scenes.js

'use strict';

const sc = require('../lib/scenes');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fail++;
  console.log('  FAIL ' + name + (extra === undefined ? '' : '  ' + (typeof extra === 'string' ? extra : JSON.stringify(extra))));
}
function section(t) { console.log('\n' + t); }

const T0 = Date.parse('2026-08-19T02:00:00Z');
const at = (m) => new Date(T0 + m * 60000).toISOString();
function row(min, feed, text, o) {
  const r = Object.assign({ at: at(min), feed, text, units: [], callType: null, matched: null, address: null,
    incidentId: null, lat: null, lon: null, town: 'Boston', city: 'Boston', precision: null }, o || {});
  /* The vault stamps a precision on every geocoded row, and the grouper now
     trusts only exact and approx pins. A fixture with coordinates and no
     precision would model a row the pipeline never writes. */
  if (Number.isFinite(r.lat) && r.lat && !r.precision) r.precision = 'exact';
  return r;
}
const HANCOCK = { lat: 42.3105, lon: -71.0698 };
const ids = (scenes) => scenes.map(s => s.id);
const find = (scenes, pred) => scenes.find(pred);
const texts = (s) => s.tx.map(t => t.text);

section('seed: the store\'s incidentId is the first word');
{
  const scenes = sc.assemble([
    row(0, 'boston-fire', 'Box 2112, Hancock and Bowdoin.', { incidentId: 'A', units: ['E17'] }),
    row(3, 'boston-fire', 'Second alarm.', { incidentId: 'A', units: ['C6'] }),
    row(30, 'boston-police', 'Car 402 on a stop, Dot Ave.', { incidentId: 'B', units: ['C402'] }),
  ]);
  ok('one scene per incidentId', scenes.length === 2 && ids(scenes).includes('A') && ids(scenes).includes('B'), ids(scenes));
  const a = find(scenes, s => s.id === 'A');
  ok('lines in time order, units and feeds collected', a.tx.length === 2 && a.units.join() === 'E17,C6' && a.feeds.join() === 'boston-fire');
  ok('from and to are the span', a.from === at(0) && a.to === at(3));
  ok('not loose', a.loose === false);
}

section('merge: one fire, three radios, one card');
{
  const scenes = sc.assemble([
    row(0, 'boston-fire', 'Box 2112, Hancock and Bowdoin, heavy smoke.', { incidentId: 'fire', units: ['E17', 'L7'], callType: 'fire', matched: 'Hancock St & Bowdoin St, Boston', lat: HANCOCK.lat, lon: HANCOCK.lon }),
    row(4, 'boston-ems', 'A-3 staging at Hancock and Bowdoin for the fire.', { incidentId: 'ems', units: ['A3'], matched: 'Hancock St & Bowdoin St, Boston', lat: HANCOCK.lat + 0.0004, lon: HANCOCK.lon + 0.0003 }),
    row(9, 'boston-police', 'Shut Hancock between Bowdoin and Quincy.', { incidentId: 'pd', units: ['C11'], matched: 'Hancock St, Boston', lat: HANCOCK.lat - 0.0005, lon: HANCOCK.lon }),
    row(12, 'boston-fire', 'All companies out, going defensive.', { incidentId: 'fire', units: ['C6'], callType: 'fire', matched: 'Hancock St & Bowdoin St, Boston', lat: HANCOCK.lat, lon: HANCOCK.lon }),
  ]);
  ok('three incidentIds at one corner become one scene', scenes.length === 1, ids(scenes));
  const s = scenes[0];
  ok('named by a seeded id', ['fire', 'ems', 'pd'].includes(s.id), s.id);
  ok('carrying all three incidentIds', s.incidentIds.length === 3, s.incidentIds);
  ok('and all three feeds', s.feeds.length === 3, s.feeds);
  ok('and every unit', s.units.length === 5, s.units);
  ok('typed by its lines', s.type === 'fire');
  ok('placed at the corner', /Hancock St & Bowdoin/.test(s.place), s.place);
  ok('in time order across feeds', texts(s)[0].startsWith('Box 2112') && texts(s)[3].startsWith('All companies'));
}

section('merge: a unit is never a thread between two scenes the store kept apart');
{
  const scenes = sc.assemble([
    row(0, 'boston-ems', 'A-8 respond, cardiac, 10 Main St Charlestown.', { incidentId: 'cardiac', units: ['A8'], callType: 'medical', matched: '10 Main St, Charlestown', lat: 42.3782, lon: -71.0602 }),
    row(5, 'boston-ems', 'A-8 transporting to MGH.', { incidentId: 'cardiac', units: ['A8'] }),
    row(40, 'boston-police', 'Shots fired, 200 Newbury St, A-8 respond for one down.', { incidentId: 'shooting', units: ['A8', 'D4'], callType: 'shooting', matched: '200 Newbury St, Boston', lat: 42.3505, lon: -71.0790 }),
  ]);
  ok('the cardiac and the shooting stay two scenes', scenes.length === 2, ids(scenes));
  const near = sc.assemble([
    row(0, 'boston-ems', 'A-6 transporting one to BMC.', { incidentId: 'first', units: ['A6'], callType: 'medical', matched: '10 Elm St, Boston', lat: 42.35, lon: -71.07 }),
    row(9, 'boston-ems', 'A-6 respond, 850 Boylston, unresponsive party.', { incidentId: 'second', units: ['A6'], callType: 'medical', matched: '850 Boylston St, Boston', lat: 42.3490, lon: -71.0820 }),
  ]);
  ok('an ambulance taking its next call nine minutes later is two calls', near.length === 2, ids(near));
  /* The self-feeding shape, which a unit thread produces on any busy channel:
     each merge widens the unit set for the next. Forty medicals on one EMS
     channel, one unit in common between neighbours, must stay forty. */
  const chain = [];
  for (let i = 0; i < 40; i++) chain.push(row(i * 6, 'boston-ems', 'A-' + (i % 4) + ' respond, ' + (100 + i) + ' Main St.', { incidentId: 'm' + i, units: ['A' + (i % 4)], callType: 'medical', matched: (100 + i) + ' Main St, Boston', lat: 42.3 + i * 0.003, lon: -71.1 }));
  ok('forty medicals sharing four ambulances, a few blocks apart, are forty scenes', sc.assemble(chain).length === 40, sc.assemble(chain).length);
  /* And a footprint cannot walk down a street: five calls a hundred metres
     apart in a row merge pairwise at most, never into one. */
  const walk = [];
  for (let i = 0; i < 6; i++) walk.push(row(i * 5, 'boston-ems', 'A-' + i + ' respond, ' + (10 + i) + ' Elm St.', { incidentId: 'w' + i, units: ['A' + i], callType: 'medical', matched: (10 + i) + ' Elm St, Boston', lat: 42.3 + i * 0.001, lon: -71.1 }));
  ok('six calls a hundred metres apart in a line do not become one scene', sc.assemble(walk).length >= 3, sc.assemble(walk).length);
}

section('merge: words are the weakest thread');
{
  const oneWord = sc.assemble([
    row(0, 'boston-fire', 'Fire, 800 Boylston St.', { incidentId: 'fire', units: ['E33'], callType: 'fire', address: '800 Boylston St', matched: '800 Boylston St, Boston', lat: 42.3490, lon: -71.0820 }),
    row(15, 'boston-police', 'Disturbance on Boylston, by the Common.', { incidentId: 'dist', units: ['A1'], callType: 'disturbance', street: 'Boylston St', matched: 'Boylston St, Boston', lat: 42.3525, lon: -71.0650 }),
  ]);
  ok('one shared street word with coordinates a mile apart is two scenes', oneWord.length === 2, ids(oneWord));
  const addr = sc.assemble([
    row(0, 'boston-ems', 'A-1 respond, 14 JFK Street, fight with injuries.', { incidentId: 'ems', units: ['A1'], address: '14 JFK Street', town: 'Cambridge', city: 'Cambridge' }),
    row(8, 'cambridge-police', 'Units to 14 JFK St, Russell House Tavern, eight bikers.', { incidentId: 'pd', units: ['C3'], address: '14 JFK St', town: 'Cambridge', city: 'Cambridge' }),
  ]);
  ok('the same numbered address with no coordinates is one scene', addr.length === 1, ids(addr));
  const twoWords = sc.assemble([
    row(0, 'boston-police', 'Units to Ruggles station, fight on the platform.', { incidentId: 'a', units: ['B2'], landmark: 'Ruggles Station' }),
    row(10, 'mbta-transit', 'Transit police to Ruggles station, upper busway.', { incidentId: 'b', units: ['T4'], landmark: 'Ruggles Station' }),
  ]);
  ok('two shared place words with no coordinates on either side is one scene', twoWords.length === 1, ids(twoWords));
  const towns = sc.assemble([
    row(0, 'boston-police', 'Units to 50 Main St, fight.', { incidentId: 'a', units: ['B2'], address: '50 Main St', town: 'Boston', city: 'Boston' }),
    row(5, 'cambridge-police', 'Units to 50 Main St, fight.', { incidentId: 'b', units: ['C2'], address: '50 Main St', town: 'Cambridge', city: 'Cambridge' }),
  ]);
  ok('the same address in two towns is two scenes', towns.length === 2, ids(towns));
}

section('attach: a loose line lands on the scene it belongs to');
{
  const scenes = sc.assemble([
    row(0, 'boston-fire', 'Box 2112, Hancock and Bowdoin.', { incidentId: 'fire', units: ['E17', 'L7'], callType: 'fire', matched: 'Hancock St & Bowdoin St, Boston', lat: HANCOCK.lat, lon: HANCOCK.lon }),
    row(6, 'boston-fire', 'L7 to command, roof is open.', { units: ['L7'] }),                       // by unit
    row(9, 'boston-police', 'Traffic post at Hancock and Bowdoin, street is shut.', { matched: 'Hancock St & Bowdoin St, Boston', lat: HANCOCK.lat, lon: HANCOCK.lon }),   // by place
    row(11, 'boston-fire', 'Copy, all companies.', {}),                                              // nothing: a burst
    row(14, 'boston-fire', 'Received.', {}),                                                        // joins that burst
    row(40, 'boston-fire', 'Engine 5 back in service.', { units: ['E5'] }),                        // too late for anything
  ]);
  const fire = find(scenes, s => s.id === 'fire');
  ok('the unit line attached', fire && texts(fire).includes('L7 to command, roof is open.'), fire && texts(fire));
  ok('the place line attached, across feeds', fire && texts(fire).includes('Traffic post at Hancock and Bowdoin, street is shut.'));
  ok('so the scene has two feeds', fire && fire.feeds.length === 2, fire && fire.feeds);
  const bursts = scenes.filter(s => s.loose);
  ok('the bare acknowledgements are a burst of their own, not part of the fire', bursts.some(b => texts(b).includes('Copy, all companies.') && texts(b).includes('Received.')), bursts.map(texts));
  ok('and the late engine is its own burst', bursts.some(b => texts(b).length === 1 && texts(b)[0].startsWith('Engine 5')), bursts.map(texts));
}

section('bursts: feed and a short gap, and never each other');
{
  const scenes = sc.assemble([
    row(0, 'cambridge-police', 'P&P for a disturbance.', {}),
    row(5, 'cambridge-police', 'Newtown Court for a disturbance.', {}),
    row(30, 'cambridge-police', 'No disturbance right yet.', {}),
    row(31, 'boston-police', 'Records check, stand by.', {}),
    row(33, 'boston-police', 'Comes back clear.', {}),
  ]);
  ok('five loose lines, three bursts', scenes.length === 3 && scenes.every(s => s.loose), scenes.map(texts));
  ok('five minutes on one feed is one burst', scenes.some(s => s.tx.length === 2 && s.feeds[0] === 'cambridge-police'));
  ok('twenty-five minutes is a new one', scenes.some(s => s.tx.length === 1 && s.feeds[0] === 'cambridge-police'));
  ok('feeds never share a burst', scenes.every(s => s.feeds.length === 1));
  const same = sc.assemble([
    row(0, 'boston-police', 'Units to 10 Elm St.', { address: '10 Elm St', lat: 42.35, lon: -71.07 }),
    row(2, 'boston-ems', 'A-1 to 10 Elm St.', { address: '10 Elm St', lat: 42.35, lon: -71.07 }),
  ]);
  ok('two loose bursts at one address stay two: nothing vouched for either', same.length === 2, ids(same));
}

section('the index answers which scene a row landed in');
{
  const rows = [
    row(0, 'boston-fire', 'Box 2112.', { incidentId: 'fire', units: ['E17'] }),
    row(2, 'boston-fire', 'E17 on scene.', { units: ['E17'] }),
  ];
  const scenes = sc.assemble(rows);
  const ix = sc.index(scenes);
  ok('both rows map to the fire', ix.get(rows[0]) && ix.get(rows[0]) === ix.get(rows[1]) && ix.get(rows[0]).id === 'fire');
}

section('nothing in, nothing out');
{
  ok('empty', sc.assemble([]).length === 0 && sc.assemble(null).length === 0);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
