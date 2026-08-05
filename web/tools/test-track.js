// tools/test-track.js
//
// Exercises app/track.js against a fixed clock. Nothing here calls Date.now.
// An earlier suite in this repo recomputed a timestamp at the call site and
// only passed when both calls landed in the same millisecond, which made a real
// bug look like a flake, so every time in this file is arithmetic on T0.
//
//   node tools/test-track.js

var T = require('../app/track.js');
var C = T._consts;

var T0 = 1800000000000;
var pass = 0, fail = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fail++;
  console.log('  FAIL  ' + name + (extra === undefined ? '' : '  [' + extra + ']'));
}

function near(a, b, slack) { return Math.abs(a - b) <= slack; }

// Boston, and the metres in a degree here. Latitude is constant enough; the
// longitude figure is the one that makes a square look like a rectangle.
var LAT = 42.36, LON = -71.06;
var M_LAT = 111195;
var M_LON = 111195 * Math.cos(LAT * Math.PI / 180);

function ring(lat, lon, radM, n, step, t0) {
  var out = [];
  for (var i = 0; i < n; i++) {
    var a = (i / n) * Math.PI * 2;
    out.push({ lat: lat + (radM * Math.sin(a)) / M_LAT,
               lon: lon + (radM * Math.cos(a)) / M_LON,
               at: t0 + i * step });
  }
  return out;
}

function feed(store, key, pts) {
  var last = null;
  for (var i = 0; i < pts.length; i++) {
    last = T.push(store, key, { lat: pts[i].lat, lon: pts[i].lon }, pts[i].at);
  }
  return last;
}

// ---------------------------------------------------------------- metres

ok('metres of a point to itself is zero',
  T.metres({ lat: LAT, lon: LON }, { lat: LAT, lon: LON }) === 0);

ok('a thousandth of a degree of latitude is about 111 m',
  near(T.metres({ lat: LAT, lon: LON }, { lat: LAT + 0.001, lon: LON }), 111.2, 1),
  T.metres({ lat: LAT, lon: LON }, { lat: LAT + 0.001, lon: LON }));

ok('a degree of longitude up here is shorter than a degree of latitude',
  T.metres({ lat: LAT, lon: LON }, { lat: LAT, lon: LON + 1 }) <
  T.metres({ lat: LAT, lon: LON }, { lat: LAT + 1, lon: LON }));

ok('and it is about three quarters of one',
  near(T.metres({ lat: LAT, lon: LON }, { lat: LAT, lon: LON + 1 }) /
       T.metres({ lat: LAT, lon: LON }, { lat: LAT + 1, lon: LON }), 0.739, 0.01));

ok('metres is symmetric',
  T.metres({ lat: LAT, lon: LON }, { lat: 42.4, lon: -71.1 }) ===
  T.metres({ lat: 42.4, lon: -71.1 }, { lat: LAT, lon: LON }));

ok('metres of a missing point is zero rather than NaN',
  T.metres(null, { lat: LAT, lon: LON }) === 0);

// ---------------------------------------------------------------- usable

ok('a real fix is usable', T.usable({ lat: LAT, lon: LON }) === true);
ok('nothing is not usable', T.usable(null) === false);
ok('a fix with no lat is not usable', T.usable({ lon: LON }) === false);
ok('a fix with a string lat is not usable', T.usable({ lat: '42.36', lon: LON }) === false);
ok('NaN is not usable', T.usable({ lat: NaN, lon: LON }) === false);
ok('a latitude past the pole is not usable', T.usable({ lat: 91, lon: LON }) === false);
ok('a longitude past the line is not usable', T.usable({ lat: LAT, lon: 181 }) === false);
ok('null island is not usable', T.usable({ lat: 0, lon: 0 }) === false);
ok('but a real point on the equator is', T.usable({ lat: 0, lon: LON }) === true);
ok('and a real point on the meridian is', T.usable({ lat: LAT, lon: 0 }) === true);

// ---------------------------------------------------------------- push

(function firstFix() {
  var s = {};
  var r = T.push(s, 'a1b2c3', { lat: LAT, lon: LON }, T0);
  ok('the first fix is taken', r.added === true, r.why);
  ok('and it is named as the first', r.why === 'first');
  ok('and it starts a line rather than continuing one', s.a1b2c3.fixes[0].cut === true);
  ok('one fix is tracked', T.tracked(s, 'a1b2c3') === 1);
  ok('and it is the head', T.head(s, 'a1b2c3').lat === LAT);
}());

(function movement() {
  var s = {};
  T.push(s, 'h', { lat: LAT, lon: LON }, T0);
  var r = T.push(s, 'h', { lat: LAT + 0.002, lon: LON }, T0 + 5000);
  ok('a fix 222 m on is taken', r.added === true, r.why);
  ok('and it continues the line', s.h.fixes[1].cut === false);
  ok('and it is named as movement', r.why === 'moved');
  ok('two fixes are tracked', T.tracked(s, 'h') === 2);
}());

(function tooSoon() {
  var s = {};
  T.push(s, 'h', { lat: LAT, lon: LON }, T0);
  var r = T.push(s, 'h', { lat: LAT + 0.002, lon: LON }, T0 + 400);
  ok('a fix inside the same second waits', r.added === false, r.why);
  ok('and says why', r.why === 'too soon');
  ok('and nothing was stored', T.tracked(s, 'h') === 1);
}());

(function standingStill() {
  var s = {};
  T.push(s, 'h', { lat: LAT, lon: LON }, T0);
  var r = T.push(s, 'h', { lat: LAT + 0.0001, lon: LON }, T0 + 5000);
  ok('an eleven metre wobble is not movement', r.added === false, r.why);
  ok('and says why', r.why === 'has not moved');
  var r2 = T.push(s, 'h', { lat: LAT + 0.0001, lon: LON }, T0 + 50000);
  ok('but a hover still leaves a heartbeat', r2.added === true, r2.why);
  ok('named as one', r2.why === 'heartbeat');
  ok('and the heartbeat does not break the line', s.h.fixes[1].cut === false);
}());

(function teleport() {
  var s = {};
  T.push(s, 'h', { lat: LAT, lon: LON }, T0);
  var far = { lat: LAT + 1, lon: LON };
  var r = T.push(s, 'h', far, T0 + 5000);
  ok('a hundred kilometres in five seconds is the feed being wrong', r.added === false, r.why);
  ok('and says why', r.why === 'teleport');
  T.push(s, 'h', far, T0 + 10000);
  T.push(s, 'h', far, T0 + 15000);
  ok('three of them are still turned away', T.tracked(s, 'h') === 1);
  var r4 = T.push(s, 'h', far, T0 + 20000);
  ok('the fourth is the aircraft actually being there', r4.added === true, r4.why);
  ok('and says so', r4.why === 'moved for real');
  ok('and the line is broken in front of it', s.h.fixes[1].cut === true);
  ok('the counter resets after a real move', s.h.bad === 0);
}());

(function gap() {
  var s = {};
  T.push(s, 'h', { lat: LAT, lon: LON }, T0);
  var r = T.push(s, 'h', { lat: LAT + 0.05, lon: LON }, T0 + 4 * 60 * 1000);
  ok('a fix after a four minute dropout is taken', r.added === true, r.why);
  ok('and named as such', r.why === 'after gap');
  ok('but the map is not allowed to draw across the dropout',
    s.h.fixes[1].cut === true);
}());

(function outOfOrder() {
  var s = {};
  T.push(s, 'h', { lat: LAT, lon: LON }, T0);
  T.push(s, 'h', { lat: LAT + 0.002, lon: LON }, T0 + 5000);
  var r = T.push(s, 'h', { lat: LAT + 0.004, lon: LON }, T0 + 2000);
  ok('a fix from before the last one is dropped', r.added === false, r.why);
  ok('and says why', r.why === 'out of order');
}());

(function junk() {
  var s = {};
  var r = T.push(s, 'h', { lat: 0, lon: 0 }, T0);
  ok('a junk fix is refused', r.added === false);
  ok('and does not open a lane for an aircraft with no position',
    Object.keys(s).length === 0);
  ok('a push with no key is refused', T.push(s, '', { lat: LAT, lon: LON }, T0).added === false);
  ok('and says why', T.push(s, '', { lat: LAT, lon: LON }, T0).why === 'no key');
  ok('a push with no store is refused', T.push(null, 'h', { lat: LAT, lon: LON }, T0).added === false);
}());

(function ceiling() {
  var s = {};
  for (var i = 0; i < 400; i++) {
    T.push(s, 'h', { lat: LAT + (i % 2 ? 0.002 : 0), lon: LON }, T0 + i * 4000);
  }
  ok('a busy orbit cannot outgrow the ceiling', T.tracked(s, 'h') <= C.MAX_FIX,
    T.tracked(s, 'h'));
  ok('and it is holding the newest fixes, not the oldest',
    T.head(s, 'h').at === T0 + 399 * 4000);
}());

(function ageOut() {
  var s = {};
  T.push(s, 'h', { lat: LAT, lon: LON }, T0);
  T.push(s, 'h', { lat: LAT + 0.05, lon: LON }, T0 + 31 * 60 * 1000);
  ok('a fix older than the trail window is gone', T.tracked(s, 'h') === 1);
  ok('and the one that survived is the new one',
    T.head(s, 'h').at === T0 + 31 * 60 * 1000);
}());

// ---------------------------------------------------------------- legs

(function legShapes() {
  var s = {};
  ok('an empty store has no legs', T.legs(s, 'h').length === 0);
  ok('an unknown aircraft has no legs', T.legs(s, 'nope').length === 0);
  ok('a null store has no legs', T.legs(null, 'h').length === 0);

  T.push(s, 'h', { lat: LAT, lon: LON }, T0);
  ok('one fix draws nothing, so it is not a leg', T.legs(s, 'h', T0).length === 0);

  for (var i = 1; i < 5; i++) {
    T.push(s, 'h', { lat: LAT + i * 0.002, lon: LON }, T0 + i * 5000);
  }
  var L = T.legs(s, 'h', T0 + 20000);
  ok('a clean run is one leg', L.length === 1, L.length);
  ok('with every fix on it', L[0].length === 5, L[0].length);
  ok('oldest first', L[0][0].at < L[0][4].at);
}());

(function legsSplit() {
  var s = {};
  for (var i = 0; i < 4; i++) {
    T.push(s, 'h', { lat: LAT + i * 0.002, lon: LON }, T0 + i * 5000);
  }
  var after = T0 + 4 * 60 * 1000;
  for (i = 0; i < 4; i++) {
    T.push(s, 'h', { lat: LAT + 0.1 + i * 0.002, lon: LON }, after + i * 5000);
  }
  var L = T.legs(s, 'h', after + 15000);
  ok('a dropout splits the trail in two', L.length === 2, L.length);
  ok('four fixes on the first', L[0].length === 4, L[0].length);
  ok('four on the second', L[1].length === 4, L[1].length);
  ok('and no line is drawn across the dropout',
    L[0][3].at < L[1][0].at && L[0][3] !== L[1][0]);
}());

(function legsDropSingletons() {
  var s = {};
  T.push(s, 'h', { lat: LAT, lon: LON }, T0);
  T.push(s, 'h', { lat: LAT + 0.002, lon: LON }, T0 + 5000);
  T.push(s, 'h', { lat: LAT + 0.2, lon: LON }, T0 + 5 * 60 * 1000);
  var L = T.legs(s, 'h', T0 + 5 * 60 * 1000);
  ok('a leg of one point is dropped rather than handed back', L.length === 1, L.length);
  ok('and the leg that survived is the real one', L[0].length === 2);
}());

// ---------------------------------------------------------------- tip

(function tipOfALeg() {
  var leg = [];
  for (var i = 0; i < 10; i++) leg.push({ lat: LAT + i * 0.002, lon: LON, at: T0 + i * 30000 });
  var t = T.tip(leg);
  ok('the tip covers the last two minutes', t.length === 5, t.length);
  ok('it ends where the leg ends', t[t.length - 1] === leg[leg.length - 1]);
  ok('and it shares its first point with the dim line under it',
    leg.indexOf(t[0]) >= 0);
  ok('a shorter window takes fewer points', T.tip(leg, 60000).length === 3,
    T.tip(leg, 60000).length);
  ok('a leg shorter than the window is all tip', T.tip(leg.slice(8)).length === 2);
  ok('a one point leg has no tip', T.tip(leg.slice(9)).length === 0);
  ok('nothing has no tip', T.tip(null).length === 0);
}());

// ---------------------------------------------------------------- latlngs

(function coords() {
  var out = T.latlngs([{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }]);
  ok('coordinates come out in the order Leaflet wants',
    out.length === 2 && out[0][0] === 1 && out[0][1] === 2 && out[1][0] === 3);
  ok('nothing maps to nothing', T.latlngs(null).length === 0);
}());

// ---------------------------------------------------------------- head, tracked

(function lookups() {
  var s = {};
  ok('the head of an unknown aircraft is nothing', T.head(s, 'nope') === null);
  ok('the head of a null store is nothing', T.head(null, 'h') === null);
  ok('an unknown aircraft has no fixes', T.tracked(s, 'nope') === 0);
  ok('a null store has no fixes', T.tracked(null, 'h') === 0);
}());

// ---------------------------------------------------------------- circling

(function tightOrbit() {
  var s = {};
  feed(s, 'h', ring(LAT, LON, 800, 12, 15000, T0));
  var c = T.circling(s, 'h', 1000, T0 + 11 * 15000);
  ok('a helicopter holding an 800 m orbit is circling', c.yes === true, JSON.stringify(c));
  ok('the radius is reported in metres', near(c.radius, 800, 120), c.radius);
  ok('and so is the time it has been at it', c.forMs === 11 * 15000, c.forMs);
}());

(function briefTurn() {
  var s = {};
  feed(s, 'h', ring(LAT, LON, 800, 4, 15000, T0));
  var c = T.circling(s, 'h', 1000, T0 + 3 * 15000);
  ok('forty five seconds of turning is just a turn', c.yes === false, JSON.stringify(c));
}());

(function theSpeedCut() {
  // The radius and the duration set a speed between them, and this is it. A
  // helicopter that cannot cross the circle inside the time is holding station
  // however straight it happens to be flying.
  var slow = {}, quick = {}, i;
  var slowStep = 154 / M_LAT;    // 20 kt
  var quickStep = 347 / M_LAT;   // 45 kt
  for (i = 0; i < 20; i++) {
    T.push(slow, 'h', { lat: LAT + i * slowStep, lon: LON }, T0 + i * 15000);
    T.push(quick, 'h', { lat: LAT + i * quickStep, lon: LON }, T0 + i * 15000);
  }
  var end = T0 + 19 * 15000;
  ok('twenty knots in a straight line is a helicopter working',
    T.circling(slow, 'h', 1000, end).yes === true,
    JSON.stringify(T.circling(slow, 'h', 1000, end)));
  ok('forty five knots is a helicopter going somewhere',
    T.circling(quick, 'h', 1000, end).yes === false,
    JSON.stringify(T.circling(quick, 'h', 1000, end)));
}());

(function tooHigh() {
  var s = {};
  feed(s, 'h', ring(LAT, LON, 800, 12, 15000, T0));
  var c = T.circling(s, 'h', 8000, T0 + 11 * 15000);
  ok('the same orbit at eight thousand feet is a transit, not a scene',
    c.yes === false);
}());

(function onTheGround() {
  var s = {};
  feed(s, 'h', ring(LAT, LON, 800, 12, 15000, T0));
  ok('an aircraft the feed calls ground is not circling',
    T.circling(s, 'h', 'ground', T0 + 11 * 15000).yes === false);
}());

(function altitudeUnknown() {
  var s = {};
  feed(s, 'h', ring(LAT, LON, 800, 12, 15000, T0));
  ok('an aircraft with no altitude is judged on its track alone',
    T.circling(s, 'h', undefined, T0 + 11 * 15000).yes === true);
  ok('and null altitude reads the same way',
    T.circling(s, 'h', null, T0 + 11 * 15000).yes === true);
}());

(function transit() {
  var s = {};
  var pts = [];
  for (var i = 0; i < 10; i++) pts.push({ lat: LAT + i * 0.0222, lon: LON, at: T0 + i * 30000 });
  feed(s, 'h', pts);
  var c = T.circling(s, 'h', 1000, T0 + 9 * 30000);
  ok('a helicopter flying in a straight line is not circling', c.yes === false,
    JSON.stringify(c));
}());

(function wideOrbit() {
  var s = {};
  feed(s, 'h', ring(LAT, LON, 6000, 12, 30000, T0));
  var c = T.circling(s, 'h', 1000, T0 + 11 * 30000);
  ok('a six kilometre orbit is a patrol, not a scene', c.yes === false,
    JSON.stringify(c));
}());

(function eastWestAgainstNorthSouth() {
  // The bug this replaces: the old test added a span of latitude to a span of
  // longitude, so the same shape counted differently depending on which way it
  // pointed. These two shapes are eighteen thousandths of a degree either side
  // of a centre. In metres the east-west one is 3.0 km across and the
  // north-south one is 4.0 km, and only one of them is a scene.
  var ew = {}, ns = {}, i;
  for (i = 0; i < 6; i++) {
    T.push(ew, 'h', { lat: LAT, lon: LON + (i % 2 ? 0.018 : -0.018) }, T0 + i * 60000);
    T.push(ns, 'h', { lat: LAT + (i % 2 ? 0.018 : -0.018), lon: LON }, T0 + i * 60000);
  }
  ok('six fixes went in on the east-west track', T.tracked(ew, 'h') === 6,
    T.tracked(ew, 'h'));
  ok('and six on the north-south one', T.tracked(ns, 'h') === 6,
    T.tracked(ns, 'h'));
  ok('the east-west shape is inside two and a half kilometres',
    T.circling(ew, 'h', 1000, T0 + 5 * 60000).yes === true,
    JSON.stringify(T.circling(ew, 'h', 1000, T0 + 5 * 60000)));
  ok('the north-south shape of the same degrees is not',
    T.circling(ns, 'h', 1000, T0 + 5 * 60000).yes === false,
    JSON.stringify(T.circling(ns, 'h', 1000, T0 + 5 * 60000)));
}());

(function arrivesThenOrbits() {
  // The case the sliding window exists for. Five minutes inbound, then an
  // orbit. The answer has to arrive with the orbit, not five minutes later.
  var s = {}, i;
  var pts = [];
  for (i = 0; i < 10; i++) pts.push({ lat: LAT + 0.25 - i * 0.0222, lon: LON, at: T0 + i * 30000 });
  var t1 = T0 + 9 * 30000 + 30000;
  feed(s, 'h', pts);
  feed(s, 'h', ring(LAT + 0.028, LON, 700, 14, 15000, t1));
  var end = t1 + 13 * 15000;
  var c = T.circling(s, 'h', 900, end);
  ok('a chopper that flies in and settles reads as circling', c.yes === true,
    JSON.stringify(c));
  ok('and it did not have to wait out the inbound leg to say so',
    c.forMs < 6 * 60 * 1000, c.forMs);
  ok('the whole flight is still one unbroken line', T.legs(s, 'h', end).length === 1);
}());

(function cutIsNotCrossed() {
  // A wide transit, a dropout, then a tight orbit. If the walk stepped over the
  // break it would drag the transit into the measurement and call it wide.
  var s = {}, i;
  for (i = 0; i < 6; i++) {
    T.push(s, 'h', { lat: LAT + 0.3 - i * 0.03, lon: LON }, T0 + i * 60000);
  }
  var t1 = T0 + 5 * 60000 + 4 * 60 * 1000;
  feed(s, 'h', ring(LAT, LON, 600, 14, 15000, t1));
  var end = t1 + 13 * 15000;
  var c = T.circling(s, 'h', 1000, end);
  ok('the orbit after a dropout is judged on its own', c.yes === true,
    JSON.stringify(c));
  ok('and only the orbit is counted', c.forMs === 13 * 15000, c.forMs);
}());

(function cutStopsAShortTail() {
  // The other way round. A long orbit, a dropout, then twenty seconds of new
  // fixes over the same spot. Twenty seconds is not a finding.
  var s = {};
  feed(s, 'h', ring(LAT, LON, 600, 12, 15000, T0));
  var t1 = T0 + 11 * 15000 + 5 * 60 * 1000;
  T.push(s, 'h', { lat: LAT, lon: LON }, t1);
  T.push(s, 'h', { lat: LAT + 0.001, lon: LON }, t1 + 20000);
  var c = T.circling(s, 'h', 1000, t1 + 20000);
  ok('a short tail after a dropout does not inherit the old orbit',
    c.yes === false, JSON.stringify(c));
}());

(function staleTrack() {
  var s = {};
  feed(s, 'h', ring(LAT, LON, 800, 12, 15000, T0));
  var last = T0 + 11 * 15000;
  ok('an aircraft nobody has heard from in five minutes is not circling now',
    T.circling(s, 'h', 1000, last + 5 * 60 * 1000).yes === false);
  ok('but a moment later it still is',
    T.circling(s, 'h', 1000, last + 20000).yes === true);
}());

(function circlingEdges() {
  var s = {};
  ok('an unknown aircraft is not circling', T.circling(s, 'nope', 1000, T0).yes === false);
  ok('a null store is not circling', T.circling(null, 'h', 1000, T0).yes === false);
  T.push(s, 'h', { lat: LAT, lon: LON }, T0);
  ok('one fix is not enough to say', T.circling(s, 'h', 1000, T0).yes === false);
  ok('and the answer carries a radius and a duration even when it is no',
    typeof T.circling(s, 'h', 1000, T0).radius === 'number' &&
    typeof T.circling(s, 'h', 1000, T0).forMs === 'number');
}());

// ---------------------------------------------------------------- prune

(function pruning() {
  var s = {};
  T.push(s, 'gone', { lat: LAT, lon: LON }, T0);
  T.push(s, 'here', { lat: LAT, lon: LON }, T0);
  var later = T0 + 6 * 60 * 1000;
  T.push(s, 'here', { lat: LAT + 0.01, lon: LON }, later);
  var n = T.prune(s, later);
  ok('an aircraft that has left the radius is dropped', s.gone === undefined);
  ok('one that is still up is kept', s.here !== undefined);
  ok('and prune says how many it dropped', n === 1, n);
  ok('pruning a null store is not an error', T.prune(null, later) === 0);
}());

(function pruneAgesFixes() {
  var s = {};
  T.push(s, 'h', { lat: LAT, lon: LON }, T0);
  T.push(s, 'h', { lat: LAT + 0.01, lon: LON }, T0 + 60000);
  T.prune(s, T0 + 31 * 60 * 1000);
  ok('a lane whose whole trail aged out goes with it', s.h === undefined);
}());

(function pruneKeepsRecentHistory() {
  var s = {};
  for (var i = 0; i < 20; i++) {
    T.push(s, 'h', { lat: LAT + i * 0.002, lon: LON }, T0 + i * 60000);
  }
  var end = T0 + 19 * 60000;
  var before = T.tracked(s, 'h');
  T.prune(s, end);
  ok('pruning does not touch a trail inside the window',
    T.tracked(s, 'h') === before, before + ' then ' + T.tracked(s, 'h'));
}());

// ---------------------------------------------------------------- constants

(function sanity() {
  ok('the heartbeat is shorter than a dropout', C.HEARTBEAT_MS < C.GAP_MS);
  ok('a dropout is shorter than the drop', C.GAP_MS < C.DROP_MS);
  ok('the loiter window fits inside the trail', C.LOITER_WINDOW_MS <= C.TRAIL_MS);
  ok('the tip fits inside the loiter window', C.TIP_MS < C.LOITER_WINDOW_MS);
  ok('the loiter test needs less time than a dropout allows',
    C.LOITER_MS < C.GAP_MS);
}());

console.log((fail ? 'FAILED ' : 'ok ') + 'track ' + (pass + fail) +
  ' tests, ' + fail + ' failures');
process.exit(fail ? 1 : 0);
