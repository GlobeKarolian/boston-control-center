// tools/test-venue.js
//
// A radio that never leaves one building.
//
// On 18 August the relay grew a feed for Fenway Park's own security and
// operations radio. Every other feed on the board covers a town and the
// pipeline's whole job is to work out WHERE in it a call is; this one is at
// the ballpark before a word is transcribed, and letting the geocoder read
// the transcript anyway makes things worse in three specific ways that this
// file pins down:
//
//   "Section 24" is nothing to any geocoder, so the call went to the town
//   centroid, which is City Hall. "Transport to Mass General" put the patient
//   at the hospital rather than in the stands. And with every call at one
//   point, the store's distance rules could not tell one medical from the
//   next, so a game night would have been one card with forty transmissions.
//
// lib/venues.js is the table; lib/geo.js, lib/extractor.js and
// lib/incident-store.js read it. This drives all of them, offline.
//
//   node tools/test-venue.js

'use strict';

const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fail++;
  console.log('  FAIL ' + name + (extra !== undefined ? '  ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : ''));
}

const venues = require('../lib/venues.js');
const geo = require('../lib/geo.js');
const { townFromFeed } = require('../lib/extractor.js');
const { createStore } = require('../lib/incident-store.js');
const { ANALYST_SYSTEM } = require('../lib/analyst-core.js');

const FENWAY = venues.VENUES.find(v => v.id === 'fenway-park');
ok('Fenway Park is in the table', !!FENWAY);
ok('and stands in Boston', FENWAY && FENWAY.town === 'Boston');
ok('at the ballpark, not City Hall',
   FENWAY && Math.abs(FENWAY.lat - 42.3467) < 0.002 && Math.abs(FENWAY.lon + 71.0972) < 0.002,
   FENWAY && [FENWAY.lat, FENWAY.lon]);

/* --- which feeds are venue feeds -------------------------------------- */

ok('the live feed slug is a venue feed', venues.forFeed('fenway-security', ['Fenway Park']) === FENWAY);
ok('the slug alone is enough, coverage left at the relay default',
   venues.forFeed('fenway-security', ['Boston']) === FENWAY);
ok('coverage naming the venue is enough, whatever the slug',
   venues.forFeed('gate-ops', ['Fenway Park']) === FENWAY);
ok('an alias in the coverage box works too', venues.forFeed('ops-2', ['Red Sox']) === FENWAY);
ok('a Boston Police channel is not a venue', venues.forFeed('boston-police', ['Boston']) === null);
ok('nor is a district channel named for the neighbourhood',
   venues.forFeed('bpd-d4-fenway-kenmore', ['Boston']) === null, 'the district covers streets, not the park');
ok('nor a fire channel that happens to say fenway',
   venues.forFeed('boston-fire-fenway', ['Boston']) === null);
ok('but an operator who declares the venue for a district channel is believed',
   venues.forFeed('bpd-d4-fenway-kenmore', ['Fenway Park']) === FENWAY);
ok('nothing at all is not a venue', venues.forFeed('', []) === null && venues.forFeed(null, null) === null);

/* --- the town the extractor infers ------------------------------------ */

ok('the extractor files the feed under Boston, not under "Fenway Park"',
   townFromFeed('fenway-security', ['Fenway Park']) === 'Boston');
ok('and still files a Boston feed under Boston', townFromFeed('boston-police', ['Boston']) === 'Boston');

/* --- where inside the building ---------------------------------------- */

const D = venues.detail;
ok('a section number', D('medical at section 24, row 5') === 'Section 24 · Row 5', D('medical at section 24, row 5'));
ok('sec, abbreviated', D('sec 12 ejection') === 'Section 12', D('sec 12 ejection'));
ok('a gate letter', D('lost child at gate e, blue shirt') === 'Gate E', D('lost child at gate e, blue shirt'));
ok('a stand', D('intox in the bleachers') === 'Bleachers', D('intox in the bleachers'));
ok('the wall', D('fan on the green monster') === 'Green Monster', D('fan on the green monster'));
ok('a street the park fronts', D('disturbance on lansdowne') === 'Lansdowne', D('disturbance on lansdowne'));
ok('a section with no number is not a spot', D('meet me at the section office') === null);
ok('nothing said, nothing claimed', D('copy, en route') === null && D('') === null && D(null) === null);
ok('never longer than a label', D('section 123a') !== null && D('section 123a').length <= 40);

/* --- the fix ------------------------------------------------------------ */

{
  const f = venues.fix(FENWAY, 'medical section 24 patient fainted');
  ok('the fix is at the venue', f.lat === FENWAY.lat && f.lon === FENWAY.lon);
  ok('matched is the venue name alone, so scenes and searches see one place', f.matched === 'Fenway Park');
  ok('the spot rides beside it', f.detail === 'Section 24');
  ok('flagged as a venue fix', f.src === 'venue' && f.kind === 'venue' && f.venue === 'Fenway Park');
  ok('exact, not approximate, not wide', !f.approx && !f.wide && !f.weak);
  ok('in Boston', f.town === 'Boston');
}

/* --- the geocoder short-circuits, offline, before the cascade ---------- */

(async () => {
  const cases = [
    ['a section number that resolves to nothing', { address: null, landmark: null }, 'Medical, section 24, patient fainted', 'Section 24'],
    ['a hospital that is where the patient is going', { landmark: 'Mass General' }, 'Transport to Mass General, patient stable', null],
    ['a two-mile street', { street: 'Boylston' }, 'Disturbance out on Boylston by gate D', 'Gate D'],
    ['a town said out loud that would move a city call', { town: 'Cambridge', address: '10 Main St' }, 'Cambridge unit is en route to section 5', 'Section 5'],
  ];
  for (const [name, ex, text, detail] of cases) {
    const g = await geo.geocodeEx(ex, 'Boston', { towns: ['Fenway Park'], text, src: 'fenway-security' });
    ok('venue feed: ' + name + ' lands at the park', g && g.venue === 'Fenway Park' && g.lat === FENWAY.lat, g);
    ok('venue feed: ' + name + ' keeps the spot', g && g.detail === detail, g && g.detail);
  }
  {
    const g = await geo.geocodeEx({}, 'Boston', { towns: ['Fenway Park'], text: 'copy', src: 'fenway-security' });
    ok('venue feed: even a bare "copy" is placed', g && g.venue === 'Fenway Park');
  }
  {
    const batch = await geo.geocodeBatch([{ ex: {}, city: 'Boston', towns: ['Fenway Park'], text: 'medical section 30', src: 'fenway-security' }]);
    ok('geocodeBatch carries the feed through', batch[0] && batch[0].venue === 'Fenway Park' && batch[0].detail === 'Section 30', batch[0]);
  }

  /* --- the store: one game night, threaded by kind, spot and time --------- */

  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'incident-store.js'), 'utf8');
  const SAME = /const VENUE_SAME_TYPE_WINDOW_MS\s*=\s*(\d+)\s*\*\s*60\s*\*\s*1000/.exec(src);
  const FOLLOW = /const VENUE_FOLLOWUP_WINDOW_MS\s*=\s*(\d+)\s*\*\s*60\s*\*\s*1000/.exec(src);
  ok('a same-type window exists', !!SAME);
  ok('a follow-up window exists', !!FOLLOW);
  const sameMin = SAME ? +SAME[1] : 0, followMin = FOLLOW ? +FOLLOW[1] : 0;
  ok('the same-type window is long enough for one call to play out and short enough that two are two',
     sameMin >= 15 && sameMin <= 40, sameMin);
  ok('the follow-up window is a few minutes', followMin >= 2 && followMin <= 8, followMin);

  const noGeocode = async () => { throw new Error('the store must not geocode a venue line'); };
  const store = createStore(noGeocode, async () => { throw new Error('the store must not extract, pre.ex is given'); });

  const T0 = Date.parse('2026-08-18T23:05:00Z');
  const at = (m) => new Date(T0 + m * 60000).toISOString();
  const EX = (o) => Object.assign({ units: [], callType: null, address: null, isClear: false, isOnScene: false, priority: 'normal', role: 'dispatch' }, o || {});
  async function say(min, text, ex, feed) {
    const source = feed || 'fenway-security';
    const g = await geo.geocodeEx(ex, 'Boston', { towns: ['Fenway Park'], text, src: source });
    return store.ingest({ source, city: 'Boston', text, time: at(min), pre: { ex, geo: g } });
  }

  const a = await say(0, 'Medical, section 24, patient fainted, Medic 1 respond', EX({ units: ['Medic 1'], callType: 'medical' }));
  ok('a medical opens a scene', !!a, 'nothing opened');
  ok('at the ballpark', a && a.lat === FENWAY.lat && a.lon === FENWAY.lon);
  ok('labelled with the venue and the spot', a && a.location === 'Fenway Park · Section 24', a && a.location);
  ok('and carries the venue on the record', a && a.venue === 'Fenway Park' && a.detail === 'Section 24');
  ok('matched is the venue, so an archive search for it finds this', a && a.matched === 'Fenway Park');
  ok('the record says the fix came from the venue table', a && a.geoVia === 'venue');
  ok('and is exact, so later lines may gather on it', a && a.precision === 'exact');
  ok('in Boston', a && a.town === 'Boston');

  const a2 = await say(2, 'Copy, en route', EX());
  ok('"copy, en route" a moment later joins that call rather than opening one', a2 && a2.id === a.id, a2 && a2.id);
  ok('and does not move the pin', a2 && a2.lat === FENWAY.lat);

  const b = await say(5, 'Ejection, section 12, two males fighting, Sup 2 respond', EX({ units: ['Sup 2'], callType: 'disturbance' }));
  ok('a different kind of call at the same point is a different scene', b && b.id !== a.id, b && b.id);
  ok('with its own spot', b && b.location === 'Fenway Park · Section 12', b && b.location);

  const c = await say(8, 'Medical, gate E, elderly female fell', EX({ callType: 'medical' }));
  ok('a second medical at a different spot is a second medical, not the first patient again',
     c && c.id !== a.id && c.id !== b.id, c && c.id);
  ok('labelled at the gate', c && c.location === 'Fenway Park · Gate E', c && c.location);

  const a3 = await say(9, 'Medical, section 24, patient conscious now, EMS on the way', EX({ callType: 'medical' }));
  ok('a medical that names the first spot rejoins the first call, not the newest one',
     a3 && a3.id === a.id, a3 && a3.id);

  const a4 = await say(10, 'Medic 1, ambulance is at section 24', EX({ units: ['Medic 1'] }));
  ok('a unit already on a call stays on it when the spot agrees', a4 && a4.id === a.id, a4 && a4.id);

  const d = await say(11, 'Medic 1, second medical, section 30', EX({ units: ['Medic 1'], callType: 'medical' }));
  ok('the same medic sent to a new section is a new call, not the old one following it',
     d && d.id !== a.id, d && d.id);

  const chatter = await say(12, 'Base copies, standing by', EX());
  ok('typeless chatter with nothing to join at the venue does not become a pin',
     chatter === null || (chatter && chatter.id !== undefined && [a.id, b.id, c.id, d.id].includes(chatter.id)),
     chatter && chatter.id);

  const later = await say(sameMin + 12, 'Medical, section 24', EX({ callType: 'medical' }));
  ok('the same spot and kind past the window is a new call', later && later.id !== a.id, later && later.id);

  const e = await say(sameMin + 13, 'Medic 3 to gate B', EX({ units: ['Medic 3'] }));
  ok('a unit sent to a named spot opens a call even when nobody said what kind', e && e.id && ![a.id, b.id, c.id, d.id, later.id].includes(e.id), e && e.id);

  const check = await say(sameMin + 20, 'Radio check, base', EX());
  ok('a radio check with nothing open at the venue in the last few minutes is not a pin', check === null, check && check.id);

  /* --- the street outside is not the park ------------------------------ */

  {
    /* Boston Police, geocoded by the gazetteer to the same point. On a game
       night that radio works the streets around the park; a call that lands
       on the ballpark's coordinates is still a city call, and it must neither
       join a venue scene nor pull one into itself. */
    const cityFix = { lat: FENWAY.lat, lon: FENWAY.lon, matched: 'Fenway Park', src: 'gazetteer', town: 'Boston', approx: true };
    const before = Object.keys(store._incidents).length;
    const p = await store.ingest({ source: 'boston-police', city: 'Boston', text: 'Units respond to Fenway Park, fight at the gate on Lansdowne', time: at(sameMin + 21), pre: { ex: EX({ units: ['Car 401'], callType: 'disturbance' }), geo: cityFix } });
    ok('a city call at the venue point opens its own scene', p && !p.venue && Object.keys(store._incidents).length === before + 1, p && p.id);
    ok('and is not labelled as a venue call', p && p.location === 'Fenway Park' && p.venue === undefined);
    const q = await say(sameMin + 22, 'Disturbance, gate C, Sup 2 respond', EX({ units: ['Sup 4'], callType: 'disturbance' }));
    ok('and a venue disturbance a minute later does not join the police scene', q && q.id !== p.id && q.venue === 'Fenway Park', q && q.id);
  }

  /* --- the record survives the wire ---------------------------------- */

  {
    const dumped = store.dump();
    const again = createStore(noGeocode, async () => ({}));
    again.hydrate(JSON.parse(JSON.stringify(dumped)));
    const back = again._incidents[a.id];
    ok('venue and spot survive dump and hydrate', back && back.venue === 'Fenway Park' && back.detail === 'Section 24', back && [back.venue, back.detail]);
    ok('and the label with them', back && back.location === 'Fenway Park · Section 24');
    const snap = again.snapshotIncidents().find(i => i.id === a.id);
    ok('and reach the board snapshot whole', snap && snap.venue === 'Fenway Park');
  }

  /* --- the analyst is told ----------------------------------------------- */

  ok('the analyst prompt names the venue feed', /fenway/i.test(ANALYST_SYSTEM) && /Fenway Park/.test(ANALYST_SYSTEM));
  ok('and what is routine there', /routine/.test(ANALYST_SYSTEM) && /medicals/.test(ANALYST_SYSTEM));
  ok('and what is not', /stabbing|shooting/.test(ANALYST_SYSTEM) && /evacuation/.test(ANALYST_SYSTEM));
  ok('the note is built from the table, not typed twice', ANALYST_SYSTEM.includes(venues.analystNote()));

  /* --- the board draws it apart -------------------------------------- */

  {
    const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
    ok('the pin glyph knows a venue call', /inc-ico\.venue/.test(html) && /inc\.venue\?' venue'/.test(html));
    ok('pins on one point are spread so each can be tapped', /function stackOffsets/.test(html) && /stackOffsets\(scanner\)/.test(html));
    ok('the building is drawn while its radio has a call', /function drawVenues/.test(html) && /drawVenues\(scanner\)/.test(html));
    ok('the popup says the pin is the building, not the call', /pin is the building, not the call/.test(html));
    ok('and so does the full log', /class="dvenue"/.test(html));
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  FAIL threw: ' + (e && e.stack || e)); process.exit(1); });
