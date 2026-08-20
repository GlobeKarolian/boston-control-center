// tools/preview.js
//
// Serves app/ at the root with a fabricated newsroom behind it, so a view can
// be looked at without a deploy and without the password.
//
// Why this and not `vercel dev`: vercel dev wants a login, a network and the
// real Redis, and what it hands back is whatever the scanners happen to be
// doing at that moment, which at four in the afternoon on a Tuesday is one
// car stop. A layout question needs a board with a working fire on it, a
// story that closed twenty minutes ago, forty routine calls and a wire with
// words in it, on demand, the same way every time.
//
// Nothing here is real. Every timestamp is minted relative to the moment the
// request lands, so the clocks tick and the freshness pill reads live rather
// than reading dark on a fixture that was written last week. The layers that
// go out to the open internet are left alone and will fill in for real if the
// machine has a network, which is the point: the fake data is only the part
// that normally needs a password.
//
//   node tools/preview.js          → http://127.0.0.1:8787
//   node tools/preview.js 9000     → somewhere else
//   node tools/preview.js 8787 dark
//
// The third argument seeds nothing but a mood: pass "quiet" for an empty
// board, "dark" for a relay that stopped talking forty minutes ago, "game" for
// a night the Fenway Park radio has six calls open at once. All are states
// the views have to have an answer for and none is easy to catch in the wild,
// because you cannot ask the scanners to stop, or the Red Sox to play.
//
// Not registered in tools/sweep.js. This is a thing you look at, not a thing
// that passes or fails.

var http = require('http');
var fs = require('fs');
var path = require('path');
var url = require('url');

var PORT = Number(process.argv[2]) || 8787;
var MOOD = String(process.argv[3] || 'busy').toLowerCase();
var DIR = path.join(__dirname, '..', 'app');

var TYPE = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
};

/* Minutes back from right now, as the ISO string every reader in the app
   parses. Computed per request rather than once at boot so a preview left
   open for an hour does not slide into the stale branch on its own. */
function ago(min) { return new Date(Date.now() - min * 60000).toISOString(); }
function id(s) { return 'pv-' + s; }

/* ---- the board ----
   Six situations chosen to put every treatment in the two views on screen at
   once: one high priority and running, one high priority that closed, three
   ordinary, and one with no coordinates at all, because a situation the
   geocoder could not place is common and is the case a map-centred layout is
   most likely to have forgotten. */
var CAST = [
  { at: 2, up: 0, pri: 'high', status: 'active', type: 'structure fire',
    head: 'Working fire in a three-decker on Hancock Street',
    sum: 'Heavy smoke from the second floor with a second alarm struck. Ladder 4 is on the roof and the street is shut between Bowdoin and Quincy.',
    loc: 'Hancock St at Bowdoin St, Dorchester', lat: 42.3105, lon: -71.0698,
    matched: 'street', feeds: ['Boston Fire'],
    beats: ['Box alarm struck for smoke in the building.',
      'Second alarm. Companies are going in from the Bowdoin side.',
      'All companies out, going defensive. Ladder pipe in operation.'] },

  { at: 74, up: 21, pri: 'high', status: 'closed', type: 'pursuit',
    head: 'Pursuit out of Chelsea ends on the Tobin',
    sum: 'A stolen vehicle ran from Chelsea police onto the Tobin Bridge and stopped at the toll gantry. Two in custody, no injuries reported.',
    loc: 'Tobin Bridge, Chelsea', lat: 42.3862, lon: -71.0523,
    matched: 'landmark', feeds: ['State Police', 'Chelsea Police'],
    beats: ['Vehicle failed to stop, heading north on Broadway.',
      'Onto the Tobin, speeds are coming down.',
      'Vehicle stopped at the gantry. Two out, both in custody.',
      'All units clear. Scene is being turned over to the barracks.'] },

  { at: 12, up: 3, pri: 'normal', status: 'developing', type: 'crash',
    head: 'Two-car crash blocking the Storrow eastbound',
    sum: 'Left lane blocked past the Fenway exit with one vehicle facing the wrong way. Fire and EMS on scene, no extrication.',
    loc: 'Storrow Dr eastbound at Fenway, Boston', lat: 42.3521, lon: -71.1005,
    matched: 'street', feeds: ['Boston Fire', 'Boston EMS'],
    beats: ['Two cars, one on its side. Send EMS.',
      'One transported, minor. Left lane still blocked for the tow.'] },

  { at: 34, up: 9, pri: 'normal', status: 'active', type: 'water main',
    head: 'Water main break floods Centre Street',
    sum: 'A main let go outside the fire station and the northbound side is under several inches. BWSC is on the way and the 39 bus is detouring.',
    loc: 'Centre St at Burroughs St, Jamaica Plain', lat: 42.3172, lon: -71.1148,
    matched: 'street', feeds: ['Boston Fire', 'MBTA'],
    beats: ['Water in the street, looks like a main.',
      'BWSC notified. Shut the northbound side.',
      'Bus detour is up, 39 running via South Huntington.'] },

  { at: 51, up: 44, pri: 'normal', status: 'winding down', type: 'medical',
    head: 'Person struck crossing Massachusetts Avenue',
    sum: 'One pedestrian down at the Newbury Street crossing, transported to a Boston hospital. The driver stayed. Intersection reopened.',
    loc: 'Massachusetts Ave at Newbury St, Boston', lat: 42.3487, lon: -71.0863,
    matched: 'street', feeds: ['Boston EMS', 'Boston Police'],
    beats: ['Pedestrian struck, one down in the roadway.',
      'One transported priority one.',
      'Intersection back open, units clearing.'] },

  /* No lat, no lon, on purpose. The geocoder gets a place name it cannot
     resolve several times an hour, and a card with nowhere to sit on the map
     is the one every map-first layout forgets to draw. */
  { at: 8, up: 1, pri: 'normal', status: 'developing', type: 'search',
    head: 'Search underway for a missing swimmer off the harbor islands',
    sum: 'The Coast Guard and State Police Marine are working a reported swimmer in the water. The location on the air has changed twice and has not been pinned down.',
    loc: 'Boston Harbor, near the islands', lat: null, lon: null,
    matched: null, feeds: ['State Police', 'Coast Guard'],
    beats: ['Report of a swimmer in the water off the channel.',
      'Marine unit is underway, aircraft requested.'] },
];

/* One radio voice per situation, plus the routine chatter underneath. The
   sources are named the way the real payload names them, because a column
   that lines its labels up in a fixed width has to be tested against real
   label lengths and not against three-letter placeholders. */
var ROUTINE = [
  ['Boston Police', 'C-11 units, motor vehicle stop, Dorchester Ave and Freeport.'],
  ['Boston Police', 'Well-being check requested, third floor, no answer at the door.'],
  ['Boston Fire', 'Engine 33 responding, box alarm, commercial smoke detector.'],
  ['Boston EMS', 'A-6 transporting one to Beth Israel, stable, no lights.'],
  ['Boston Police', 'Alarm company reporting an interior motion, keyholder en route.'],
  ['Boston Fire', 'Engine 7 on scene, nothing showing, investigating.'],
  ['State Police', 'Disabled vehicle in the breakdown lane, 93 south past Columbia.'],
  ['Boston Police', 'Party in the lobby reporting a lost wallet, non-emergency.'],
  ['Boston EMS', 'A-2 clear from the hospital, back in service.'],
  ['Boston Fire', 'Engine 33 clear, faulty detector, no incident.'],
];

function cast() { return MOOD === 'quiet' ? [] : CAST; }

function situations() {
  return cast().map(function (c, i) {
    var firstSeen = ago(c.at), updated = ago(c.up);
    /* Beats are laid out backwards from the update, one every few minutes, so
       a thread reads in the order it was heard and the newest beat carries the
       same stamp as the card. threadui counts these, so a card with four of
       them has to actually have four. */
    var step = c.at > c.up ? (c.at - c.up) / Math.max(1, c.beats.length - 1) : 3;
    var events = c.beats.map(function (t, n) {
      return {
        kind: n === 0 ? 'opened' : (n === c.beats.length - 1 && c.status === 'closed' ? 'closed' : 'update'),
        text: t, type: c.type, at: ago(c.at - step * n),
      };
    });
    return {
      id: id('sit' + i), headline: c.head, summary: c.sum, type: c.type,
      priority: c.pri, confidence: c.matched ? 'confirmed' : 'reported',
      location: c.loc, lat: c.lat, lon: c.lon, matched: c.matched, approx: true,
      status: c.status, feeds: c.feeds, firstSeen: firstSeen, updated: updated,
      events: events, alertKey: id('sit' + i) + ':' + c.status,
    };
  });
}

function transcripts() {
  var out = [];
  /* Newest first, which is the order the real endpoint answers in and the
     order every reader here assumes. Getting this backwards would show up as
     a wire that scrolls the wrong way and a freshness pill that never leaves
     stale, and both would look like bugs in the view. */
  cast().forEach(function (c, i) {
    c.beats.slice().reverse().forEach(function (t, n) {
      out.push({ time: ago(c.up + n * 2 + i), source: c.feeds[0], text: t,
        role: n === 0 ? 'field' : 'dispatch', incidentId: id('sit' + i), tags: {} });
    });
  });
  ROUTINE.forEach(function (r, i) {
    out.push({ time: ago(i * 4 + 1), source: r[0], text: r[1], role: 'dispatch' });
  });
  out.sort(function (a, b) { return Date.parse(b.time) - Date.parse(a.time); });
  return MOOD === 'dark' ? [] : out;
}

/* incidents.json is the scanner layer, and every record in it comes back out
   of pollScanner flagged isScanner. That flag is the whole basis of the split
   the Desk makes between a routine call and something worth a row, so the
   preview has to produce both kinds out of this one file or the routine
   counter is always zero and the finding it demonstrates goes untested. */
/* A game night on the ballpark's own radio (lib/venues.js). Every one of these
   is at the same point, because the feed puts it there, and that is the case
   the map has to answer for: six pins on one pixel with the building drawn
   under them, each one readable, each one tappable, and a Boston Police call
   from the street outside standing apart at the same coordinates. */
var GAME = [
  [1, 0, 'active', 'medical', 'Fenway Park \u00b7 Section 24', 'Section 24', ['Medic 1'],
    ['Medical, section 24, patient fainted, Medic 1 respond.', 'Copy, en route.', 'Patient conscious now, EMS on the way.']],
  [4, 2, 'active', 'disturbance', 'Fenway Park \u00b7 Section 12', 'Section 12', ['Sup 2'],
    ['Ejection, section 12, two males fighting, Sup 2 respond.', 'Sup 2 on scene, both parties separated.']],
  [7, 5, 'active', 'medical', 'Fenway Park \u00b7 Gate E', 'Gate E', ['Medic 3'],
    ['Medical, gate E, elderly female fell.', 'Medic 3 arriving gate E.']],
  [11, 9, 'active', 'missing person', 'Fenway Park \u00b7 Gate B', 'Gate B', ['Gate 5'],
    ['Lost child at gate B, blue shirt, about six.', 'Parent located, reunited at gate B.']],
  [15, 15, 'active', 'unclassified', 'Fenway Park \u00b7 Bleachers', 'Bleachers', ['Medic 2'],
    ['Medic 2 to the bleachers, intox.']],
  [30, 20, 'cleared', 'medical', 'Fenway Park \u00b7 Section 30', 'Section 30', ['Medic 1'],
    ['Medic 1, second medical, section 30.', 'Section 30 refused transport, Medic 1 clear.']],
];

function incidents() {
  var out = [];
  if (MOOD === 'game') {
    GAME.forEach(function (g, i) {
      out.push({
        id: id('fen' + i), cat: 'scanner', type: g[3], title: g[6].join(', '),
        units: g[6], location: g[4], matched: 'Fenway Park', lat: 42.34655, lon: -71.09731,
        located: true, precision: 'exact', geoVia: 'venue', town: 'Boston',
        venue: 'Fenway Park', detail: g[5], feed: 'fenway-security',
        source: 'Scanner (Boston)', status: g[2], priority: 'normal',
        firstHeard: ago(g[0]), lastUpdate: ago(g[1]),
        timeline: g[7].map(function (t, n) { return { t: ago(g[0] - n * 1.5), source: 'fenway-security', text: t, role: n ? 'field' : 'dispatch' }; }),
      });
    });
    /* The street outside, at the same coordinates by way of the gazetteer. */
    out.push({
      id: id('bpd-fen'), cat: 'scanner', type: 'disturbance', title: 'Car 401',
      units: ['Car 401'], location: 'Fenway Park', matched: 'Fenway Park', lat: 42.34655, lon: -71.09731,
      located: true, precision: 'approx', geoVia: 'gazetteer', town: 'Boston', feed: 'boston-police',
      source: 'Scanner (Boston)', status: 'active', priority: 'normal',
      firstHeard: ago(3), lastUpdate: ago(1),
      timeline: [{ t: ago(3), source: 'boston-police', text: 'Units respond to Fenway Park, fight at the gate on Lansdowne.', role: 'dispatch' }],
    });
  }
  cast().forEach(function (c, i) {
    out.push({
      id: id('inc' + i), cat: 'scanner', type: c.type, title: c.head,
      units: c.feeds, location: c.loc, lat: c.lat, lon: c.lon,
      source: c.feeds[0] + ' scanner', status: c.status === 'closed' ? 'cleared' : 'active',
      priority: c.pri, firstHeard: ago(c.at), lastUpdate: ago(c.up),
      timeline: c.beats.map(function (t) { return { at: ago(c.up), text: t }; }),
    });
  });
  if (MOOD === 'quiet') return out;
  /* Forty of them, spread over the last hour and a half. Thirty-one land
     inside the hour the routine counter looks at and nine fall outside it,
     which is the only way to see that the cutoff is doing anything. */
  for (var n = 0; n < 40; n++) {
    var r = ROUTINE[n % ROUTINE.length];
    out.push({
      id: id('rt' + n), cat: 'scanner', type: 'routine', title: r[1],
      units: [], location: '', lat: null, lon: null, source: r[0] + ' scanner',
      status: n % 5 === 0 ? 'cleared' : 'active', priority: 'normal',
      firstHeard: ago(2 + n * 2.2), lastUpdate: ago(2 + n * 2.2), timeline: [],
    });
  }
  return out;
}

var FEEDS = ['Boston Fire', 'Boston Police', 'Boston EMS', 'State Police', 'Chelsea Police', 'MBTA Transit'];

function pipeline() {
  /* The dark mood pushes every clock past DARK_MS, which is the branch that
     matters most and the one you cannot produce on purpose in production
     without unplugging a Mac in a closet somewhere. */
  var quietMin = MOOD === 'dark' ? 52 : 1;
  return {
    extractor: MOOD === 'dark' ? 'stalled' : 'claude-fable-5',
    builtAt: ago(0),
    feeds: FEEDS.map(function (name, i) {
      var off = MOOD === 'dark';
      return {
        name: name, status: off ? 'offline' : (i === 4 ? 'connected' : 'live'),
        segs: off ? 0 : 40 - i * 3, clips: off ? 0 : 120 - i * 8,
        lastAudioAt: ago(quietMin + i * 0.2),
        lastSegAt: ago(quietMin + (i === 4 ? 22 : i * 0.4)),
      };
    }),
  };
}

function stops() {
  if (MOOD === 'quiet') return [];
  return [
    { id: id('st1'), unit: 'C-11 41', plate: 'MA 8XK230', location: 'Dorchester Ave at Freeport St',
      lat: 42.3169, lon: -71.0553, openedAt: ago(6), status: 'open' },
    { id: id('st2'), unit: 'D-4 62', plate: 'MA 1LP884', location: 'Tremont St at Berkeley St',
      lat: 42.3452, lon: -71.0708, openedAt: ago(41), status: 'open' },
  ];
}

/* Shift Change, the handoff briefing: what is open right now, the major calls
   of the last ten hours, and the compact list under them. Built from the cast
   so the three sections agree with the board, plus one note row and one live
   item so both of those treatments are on screen. */
function shiftChange() {
  var now = Date.now();
  var c0 = CAST[0], c2 = CAST[2], c3 = CAST[3], c4 = CAST[4];
  var tx = function (c, feed) {
    return c.beats.map(function (t, n) { return { at: ago(c.at - n * 3), src: feed || c.feeds[0], text: t, clip: null }; });
  };
  var hm = function (iso) { return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }); };
  var watch = MOOD === 'quiet' ? [] : [
    { kind: 'situation', id: id('sit0'), headline: c0.head, what: c0.sum, status: 'active', priority: 'high',
      major: true, verified: true, severity: 4, label: 'big story', type: c0.type, place: c0.loc,
      feeds: c0.feeds, units: [], since: ago(c0.at), updated: ago(c0.up), n: 3, clips: [], tx: [] },
    { kind: 'scene', id: 'inc-pv-1', headline: 'medical at 850 Boylston St', what: 'Last heard ' + hm(ago(1)) + ': A-6 on scene, one patient, anaphylactic reaction.',
      status: 'active', priority: 'normal', major: false, verified: false, severity: 1, label: null, heat: 34,
      type: 'medical', place: '850 Boylston St', feeds: ['Boston EMS', 'Boston Fire'], units: ['A6', 'E7', 'L17'],
      since: ago(9), updated: ago(1), n: 4, why: ['3 units', '2 departments'], clips: [],
      tx: [{ at: ago(9), src: 'Boston EMS', text: 'A-6 respond to 850 Boylston, allergic reaction.' }, { at: ago(1), src: 'Boston EMS', text: 'A-6 on scene, one patient, anaphylactic reaction.' }] },
  ];
  var mk = function (c, sev, kind, live, head, what, unsure) {
    return { id: 'pv-' + kind, headline: head, what: what, unsure: unsure || '', severity: sev,
      label: sev >= 4 ? 'big story' : 'story', why: ['heard on the radio: ' + kind, c.feeds.length + ' agencies on it'],
      kind: kind, live: !!live, feeds: c.feeds, units: [], from: ago(c.at), to: ago(c.up), place: c.loc,
      type: c.type, n: c.beats.length, clips: [], tx: tx(c) };
  };
  var major = MOOD === 'quiet' ? [] : [
    mk(c0, 4, 'fire', true, 'Second alarm on Hancock Street, companies going defensive', 'Boston Fire struck a second alarm for heavy smoke from the second floor of a three-decker at Hancock and Bowdoin. Ladder 4 on the roof; the street is shut. Still running.', 'Whether anyone was inside.'),
    mk(CAST[1], 3, 'chase', false, 'Pursuit out of Chelsea ends on the Tobin, two in custody', 'A stolen vehicle ran from Chelsea police onto the Tobin Bridge and stopped at the toll gantry. Two out, both in custody; no injuries reported on the air.', ''),
    mk(c4, 3, 'crash', false, 'Pedestrian struck crossing Mass Ave at Newbury', 'One pedestrian down in the roadway at the Newbury Street crossing, transported priority one. The driver stayed. Intersection reopened.', 'Condition of the pedestrian.'),
  ];
  var notes = MOOD === 'quiet' ? [] : [
    { id: 'pv-n1', headline: 'water main · Centre St at Burroughs St · ' + hm(ago(34)), severity: 2, label: 'note', why: ['a tier 2 signal in the transcripts'], kind: 'other', live: false,
      feeds: c3.feeds, units: [], from: ago(c3.at), to: ago(c3.up), place: c3.loc, type: 'water main', n: 3, clips: [], tx: tx(c3) },
    { id: 'pv-n2', headline: 'crash · Storrow Dr eastbound at Fenway · ' + hm(ago(12)), severity: 2, label: 'note', why: ['two agencies on it'], kind: 'crash', live: true,
      feeds: c2.feeds, units: [], from: ago(c2.at), to: ago(c2.up), place: c2.loc, type: 'crash', n: 2, clips: [], tx: tx(c2) },
  ];
  return {
    ok: true,
    window: { from: ago(600), to: ago(0), label: 'Last 10 hours · ' + hm(ago(600)) + ' to ' + hm(ago(0)), hours: 10 },
    lead: MOOD === 'quiet' ? 'Nothing in the last 10 hours cleared the bar. 212 transmissions across 6 feeds, all of it routine.'
      : 'Two things are open as you sit down: the Hancock Street fire is still being worked with a second alarm struck, and EMS has a medical at 850 Boylston. The stretch before it was ordinary for a weeknight, one pursuit out of Chelsea that ended without injury and a pedestrian struck on Mass Ave.',
    watch: watch, major: major, items: major, notes: notes,
    heard: { 'Boston Fire': 120, 'Boston Police': 311, 'Boston EMS': 88 }, offline: MOOD === 'dark' ? ['Boston Fire', 'Lowell Police'] : [],
    coverage: { transmissions: MOOD === 'quiet' ? 212 : 2217, feeds: 6, complete: true, sampled: false },
    generatedAt: ago(0), ms: 4100,
  };
}

/* Everything the page asks for by a relative name, answered here. The real
   deployment routes these through vercel.json to a function apiece; the names
   have to match that list or the preview is testing a page nobody ships. */
var ROUTES = {
  '/situations.json': situations,
  '/transcripts.json': transcripts,
  '/incidents.json': incidents,
  '/pipeline.json': pipeline,
  '/stops.json': stops,
  '/stops-count.json': function () { return { open: stops().length }; },
  '/shift-change.json': shiftChange,
};

function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

http.createServer(function (req, res) {
  var p = url.parse(req.url).pathname;
  if (p === '/') p = '/index.html';

  if (ROUTES[p]) return send(res, 200, TYPE['.json'], JSON.stringify(ROUTES[p](), null, 2));

  /* The page tries the backend proxy first and falls back to public ones on a
     404, so answering 404 here is not a gap. It is the branch that sends the
     open-internet layers out to fetch themselves, which is what makes the
     weather alerts and the quakes on a preview real. */
  if (p.indexOf('/api/') === 0) return send(res, 404, 'text/plain', 'not in preview');

  /* One join and one check that the result is still inside app/, because this
     binds to a port and a request is a string from outside. Nobody is going to
     attack a preview server, and that is exactly the reasoning that puts a
     path traversal in something that later grows a second user. */
  var file = path.join(DIR, p.replace(/^\/+/, ''));
  if (file.indexOf(DIR) !== 0) return send(res, 403, 'text/plain', 'no');

  fs.readFile(file, function (err, buf) {
    if (err) return send(res, 404, 'text/plain', 'no ' + p);
    send(res, 200, TYPE[path.extname(file).toLowerCase()] || 'application/octet-stream', buf);
  });
}).listen(PORT, '127.0.0.1', function () {
  console.log('preview  http://127.0.0.1:' + PORT + '   mood: ' + MOOD +
    '   (' + cast().length + ' situations, ' + incidents().length + ' scanner records)');
  console.log('moods    busy | quiet | dark | game        stop with ctrl-c');
});
