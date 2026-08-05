// app/track.js
//
// Helicopters over a scene are the most useful thing on this map and the least
// legible. A single icon tells you one is up there. It does not tell you whether
// it arrived a minute ago from the north or has been grinding out circles over
// the same block for a quarter of an hour, which is the part that says a story
// is happening. This file keeps the recent positions of every aircraft the feed
// reports and turns them into lines the map can draw.
//
// It touches no DOM and reads no clock. Every function takes the time as an
// argument, so the tests can fly a helicopter across the state in eight
// milliseconds, and so a slow poll can never make a straight line look like a
// 200 knot dash.
//
//   node tools/test-track.js
(function (root) {
  'use strict';

  // How much history a line shows. Long enough that a chopper which turned up
  // while nobody was looking still shows how it got there, short enough that
  // the line over a busy scene stays a shape rather than a ball of wool.
  var TRAIL_MS = 30 * 60 * 1000;

  // ADS-B drops out over the harbour and behind the Blue Hills. Joining the two
  // sides of a dropout with a straight line draws a flight path never flown, so
  // anything past this starts a new line instead.
  var GAP_MS = 3 * 60 * 1000;

  // Below this a fix is the same fix again with noise on it. Storing one costs
  // a slot and draws nothing.
  var MIN_MOVE_M = 30;

  // A hover still has to leave a mark, or the circling test has no elapsed time
  // to measure against and a helicopter parked over a scene reads as one stale
  // point.
  var HEARTBEAT_MS = 45 * 1000;

  // The fastest civil rotorcraft in service is a shade under 200 knots. A fix
  // implying more than this is the feed being wrong about where the aircraft
  // is, not the aircraft being quick.
  var MAX_KT = 250;

  // Three of those in a row is no longer noise. It is the aircraft genuinely
  // being somewhere else, so the fourth is taken and the line broken in front
  // of it rather than dragged across the map and back.
  var MAX_BAD = 3;

  // Two fixes inside the same second give a division that blows up into a false
  // teleport, so the second one waits.
  var MIN_DT_MS = 1000;

  // A ceiling on points per aircraft, so a tight orbit reporting twice a second
  // cannot outgrow the trail window on a wall display left up for days.
  var MAX_FIX = 240;

  // Gone this long and the aircraft has left the radius. Its lane goes with it.
  var DROP_MS = 5 * 60 * 1000;

  /* Circling means the aircraft stayed inside this radius for at least this
     long while below this altitude, and the two numbers have to be chosen
     together, because they set a speed between them. Anything that cannot cross
     the circle inside the time counts as holding station, so the cut here falls
     at 3000 m over 150 s, which is 39 knots. A helicopter transiting at less
     than 39 knots is not going anywhere, it is working. One doing 90 knots
     crosses out and is left alone.

     The radius is 1500 m because that is about the widest orbit a news or police
     aircraft flies over a scene. The window below is only a ceiling on how far
     back the answer looks, so "circling 14m" is as long as the readout can say. */
  var LOITER_MS = 150 * 1000;
  var LOITER_M = 1500;
  var LOITER_WINDOW_MS = 15 * 60 * 1000;
  var LOITER_ALT_FT = 3500;

  // The brighter overlay on the newest stretch of a line. It shows which way
  // the aircraft is going without drawing two hundred coloured segments.
  var TIP_MS = 2 * 60 * 1000;

  var R_EARTH = 6371000;
  var RAD = Math.PI / 180;

  /* Haversine. Flat arithmetic on raw degrees is what the old loiter test did,
     and it quietly made a north-south orbit count for more than an east-west
     orbit of the same size, because a degree of longitude up here runs about
     three quarters of a degree of latitude. */
  function metres(a, b) {
    if (!a || !b) return 0;
    var p1 = a.lat * RAD, p2 = b.lat * RAD;
    var dp = (b.lat - a.lat) * RAD, dl = (b.lon - a.lon) * RAD;
    var s = Math.sin(dp / 2) * Math.sin(dp / 2) +
            Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * R_EARTH * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }

  /* Exactly zero, zero is what a feed sends when it means "no idea". It is also
     a real spot in the Atlantic, which is why it has to be named here: nothing
     this map covers is ever legitimately sitting on it. */
  function usable(p) {
    if (!p) return false;
    var la = p.lat, lo = p.lon;
    if (typeof la !== 'number' || typeof lo !== 'number') return false;
    if (!isFinite(la) || !isFinite(lo)) return false;
    if (la < -90 || la > 90 || lo < -180 || lo > 180) return false;
    if (la === 0 && lo === 0) return false;
    return true;
  }

  function ms(n, fallback) {
    return (typeof n === 'number' && isFinite(n)) ? n : fallback;
  }

  /* The widest gap between any two points in a set. Sizing a cluster by its
     centroid instead looks like the obvious move and is a trap: the centroid
     moves every time a point joins, so a set can get smaller by getting bigger
     and the walk below would have nothing solid to stop on. The widest gap only
     ever grows, which is what makes stopping at the first point that breaks the
     cluster a sound thing to do. */
  function widest(pts, p, known) {
    var w = known || 0;
    for (var i = 0; i < pts.length; i++) {
      var d = metres(p, pts[i]);
      if (d > w) w = d;
    }
    return w;
  }

  function trim(pts, now) {
    var floor = now - TRAIL_MS, i = 0;
    while (i < pts.length && pts[i].at < floor) i++;
    if (i) pts.splice(0, i);
    if (pts.length > MAX_FIX) pts.splice(0, pts.length - MAX_FIX);
  }

  function lane(store, key, now) {
    var l = store[key];
    if (!l) l = store[key] = { fixes: [], bad: 0, seen: now };
    l.seen = now;
    return l;
  }

  function add(l, fix, now, cut, why) {
    l.fixes.push({ lat: fix.lat, lon: fix.lon, at: now, cut: !!cut });
    l.bad = 0;
    trim(l.fixes, now);
    return { added: true, why: why };
  }

  /* Every reason a fix gets turned away is a reason the line would otherwise be
     a lie: a repeat that spends a slot and adds no shape, a dropout bridged
     into a journey, a garbled position that flings the aircraft across the
     state and back on the next poll. The one case that is not a lie is a hover,
     which is what the heartbeat exists to let through. */
  function push(store, key, fix, now) {
    if (!store || !key) return { added: false, why: 'no key' };
    if (!usable(fix)) return { added: false, why: 'unusable fix' };
    var t = ms(now, 0);
    var l = lane(store, key, t);
    var pts = l.fixes;
    var last = pts.length ? pts[pts.length - 1] : null;
    if (!last) return add(l, fix, t, true, 'first');
    var dt = t - last.at;
    if (dt < 0) return { added: false, why: 'out of order' };
    if (dt >= GAP_MS) return add(l, fix, t, true, 'after gap');
    if (dt < MIN_DT_MS) return { added: false, why: 'too soon' };
    var d = metres(last, fix);
    var kt = (d / 1852) / (dt / 3600000);
    if (kt > MAX_KT) {
      if (l.bad < MAX_BAD) { l.bad += 1; return { added: false, why: 'teleport' }; }
      return add(l, fix, t, true, 'moved for real');
    }
    l.bad = 0;
    if (d < MIN_MOVE_M && dt < HEARTBEAT_MS) return { added: false, why: 'has not moved' };
    return add(l, fix, t, false, d < MIN_MOVE_M ? 'heartbeat' : 'moved');
  }

  /* One aircraft can own several lines. A cut marks a place the map is not
     allowed to draw across. A leg of one point is dropped because Leaflet
     renders a one-point polyline as nothing at all, so keeping it only makes
     the caller loop over things that never appear. */
  function legs(store, key, now) {
    var l = store && store[key];
    if (!l || !l.fixes.length) return [];
    var t = ms(now, l.fixes[l.fixes.length - 1].at);
    var floor = t - TRAIL_MS;
    var out = [], cur = [];
    for (var i = 0; i < l.fixes.length; i++) {
      var f = l.fixes[i];
      if (f.at < floor) continue;
      if (f.cut && cur.length) { out.push(cur); cur = []; }
      cur.push(f);
    }
    if (cur.length) out.push(cur);
    return out.filter(function (g) { return g.length > 1; });
  }

  /* The tail of a leg, for the brighter overlay. Walking back from the newest
     point rather than filtering on time keeps the join with the dim line exact:
     the two share a point, so nothing shows between them at any zoom. */
  function tip(leg, span) {
    if (!leg || leg.length < 2) return [];
    var reach = ms(span, TIP_MS);
    var floor = leg[leg.length - 1].at - reach;
    var i = leg.length - 1;
    while (i > 0 && leg[i - 1].at >= floor) i--;
    var out = leg.slice(i);
    return out.length > 1 ? out : [];
  }

  function latlngs(list) {
    var out = [];
    for (var i = 0; i < (list || []).length; i++) out.push([list[i].lat, list[i].lon]);
    return out;
  }

  function head(store, key) {
    var l = store && store[key];
    if (!l || !l.fixes.length) return null;
    return l.fixes[l.fixes.length - 1];
  }

  function tracked(store, key) {
    var l = store && store[key];
    return l ? l.fixes.length : 0;
  }

  /* Sized in metres, because the old test added a span of latitude to a span of
     longitude and called the result a size, which quietly graded a north-south
     orbit as bigger than an east-west one of exactly the same shape.

     The walk grows backwards from the newest fix and stops at the fix that
     would break the cluster, which is the difference between asking "has it
     been over this spot" and asking "was it over this spot for the whole of the
     last quarter of an hour". A chopper that flies in and settles answers yes
     ninety seconds after the orbit starts. Under a fixed window it would have
     had to wait out its own inbound leg first, which on a breaking story is
     several minutes of the map knowing and not saying.

     Each fix is taken before its cut is tested, because a cut marks the start
     of a leg rather than the end of one: the newest fix can carry one, and
     testing first would step over the break and measure straight across it. */
  function circling(store, key, alt, now) {
    var no = { yes: false, radius: 0, forMs: 0 };
    var l = store && store[key];
    if (!l || l.fixes.length < 2) return no;
    if (alt === 'ground') return no;
    if (typeof alt === 'number' && isFinite(alt) && alt > LOITER_ALT_FT) return no;
    var newest = l.fixes[l.fixes.length - 1];
    var t = ms(now, newest.at);
    if (t - newest.at > GAP_MS) return no;
    var floor = t - LOITER_WINDOW_MS;
    var pts = [], dia = 0;
    for (var i = l.fixes.length - 1; i >= 0; i--) {
      var f = l.fixes[i];
      if (f.at < floor) break;
      var wide = widest(pts, f, dia);
      if (wide > LOITER_M * 2 && pts.length) break;
      pts.unshift(f);
      dia = wide;
      if (f.cut) break;
    }
    if (pts.length < 2) return no;
    var forMs = pts[pts.length - 1].at - pts[0].at;
    if (forMs < LOITER_MS) return no;
    return { yes: dia <= LOITER_M * 2, radius: Math.round(dia / 2), forMs: forMs };
  }

  /* Keyed by hex and never swept, the old buffer held every helicopter that had
     crossed New England since the tab was opened. On a newsroom wall that is a
     week of them. */
  function prune(store, now) {
    if (!store) return 0;
    var t = ms(now, 0), gone = 0;
    for (var k in store) {
      if (!Object.prototype.hasOwnProperty.call(store, k)) continue;
      var l = store[k];
      if (!l) { delete store[k]; gone++; continue; }
      if (t - l.seen > DROP_MS) { delete store[k]; gone++; continue; }
      trim(l.fixes, t);
      if (!l.fixes.length) { delete store[k]; gone++; }
    }
    return gone;
  }

  var api = {
    metres: metres, usable: usable, push: push, legs: legs, tip: tip,
    latlngs: latlngs, head: head, tracked: tracked, circling: circling,
    prune: prune,
    _consts: {
      TRAIL_MS: TRAIL_MS, GAP_MS: GAP_MS, MIN_MOVE_M: MIN_MOVE_M,
      HEARTBEAT_MS: HEARTBEAT_MS, MAX_KT: MAX_KT, MAX_BAD: MAX_BAD,
      MIN_DT_MS: MIN_DT_MS, MAX_FIX: MAX_FIX, DROP_MS: DROP_MS,
      LOITER_MS: LOITER_MS, LOITER_M: LOITER_M,
      LOITER_WINDOW_MS: LOITER_WINDOW_MS, LOITER_ALT_FT: LOITER_ALT_FT,
      TIP_MS: TIP_MS,
    },
  };

  root.BCCTrack = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof window !== 'undefined' ? window : this));
