// app/webcams.js
//
// Twelve public live webcams, as a decision module with no DOM in it.
//
// These are not the MassDOT traffic cameras. Those are 386 still JPEGs refreshed
// once a minute from a state catalog in KV. These are twelve YouTube streams a
// human picked, and they carry three problems the traffic layer does not have.
//
// The first is that three of them are the same rooftop. The Museum of Science
// runs an east, a southwest and a west camera off one parapet, so all three
// carry the same coordinates and Leaflet stacks them into one clickable pin
// with two cameras hidden underneath it. placed() nudges each one along the
// bearing it is actually pointed, which separates them and, more usefully,
// means the pin's position on the map tells you which way the camera looks.
// The size of that nudge is a pixel question, not a distance one, so placed()
// takes a zoom: two 18px icons hide each other at any separation under about
// twenty pixels, and how many pixels a hundred metres buys depends entirely on
// how far out the map is. See spreadFor().
//
// The second is that YouTube video ids rotate. When a channel restarts a stream
// it mints a new id and the old one goes dead. All three Museum of Science
// cameras restarted together on 31 Mar 2026. A hardcoded id is a camera that
// works until it silently does not, which on a wall screen is worse than a
// camera that was never there. embedSrc() prefers a channel live-stream embed
// when a channel id is known, because that resolves to whatever is live right
// now, and falls back to the video id only when it has to.
//
// The third is that an embed can fail at run time for reasons no catalog can
// predict: the owner turns embedding off, the stream ends, a region block. So
// every camera carries watchURL() and the popup shows it whether or not the
// frame loads. A dead frame with a working link is a camera. A dead frame
// alone is a bug report.
//
// node tools/test-webcams.js

(function (root) {
  'use strict';

  /* Bearings are degrees clockwise from north, the direction the camera looks,
     and they are approximate on purpose. They exist to separate pins and to
     write "looking east" under a title, not to survey anything. null means
     nobody established a direction and the camera gets fanned instead. */
  var CAMS = [
    { id: 'p-pVYYH4ZCk', site: 'mos', name: 'Museum of Science, east',
      channelId: 'UC8gbWbcNNyb5-NIXvFklkOA',
      place: 'Science Park, Boston', region: 'boston',
      lat: 42.3676, lon: -71.0716, bearing: 90, confirmed: true,
      note: 'Green Line and the Charles River dam' },

    { id: '2lRbwu4TVtA', site: 'boylston', name: 'Boston Common at Boylston',
      channelId: 'UC8gbWbcNNyb5-NIXvFklkOA',
      place: '160 Boylston St, Boston', region: 'boston',
      lat: 42.3525, lon: -71.0664, bearing: 300, confirmed: true,
      note: 'Street level, Boylston at the Common' },

    { id: 'Jq-5u9NNZiM', site: 'mos', name: 'Museum of Science, southwest',
      channelId: 'UC8gbWbcNNyb5-NIXvFklkOA',
      place: 'Science Park, Boston', region: 'boston',
      lat: 42.3676, lon: -71.0716, bearing: 225, confirmed: false,
      note: 'Downtown skyline' },

    { id: 'oezcsH9ZZ24', site: 'mos', name: 'Museum of Science, west',
      channelId: 'UC8gbWbcNNyb5-NIXvFklkOA',
      place: 'Science Park, Boston', region: 'boston',
      lat: 42.3676, lon: -71.0716, bearing: 270, confirmed: true,
      note: 'Charles River basin toward Cambridge' },

    { id: '_OeFhA2XqqA', site: 'canal', name: 'Cape Cod Canal',
      channelId: 'UCiKd90Y9P2dH3QR_AecBYaA',
      place: 'Mass Maritime Academy, Buzzards Bay', region: 'ma',
      lat: 41.7394, lon: -70.6234, bearing: 135, confirmed: true,
      note: 'Canal traffic and the railroad bridge' },

    { id: 'TE6N2eDrsR0', site: 'woodshole', name: 'Woods Hole ferry dock',
      channelId: 'UCGfre1YJATN850wNq-jzgEw',
      place: '10 Water St, Woods Hole', region: 'ma',
      lat: 41.5233, lon: -70.6689, bearing: 200, confirmed: true,
      note: 'Steamship Authority berth and the harbour' },

    { id: 'LkZZTkRHLVQ', site: 'portsmouth', name: 'Market Square, Portsmouth',
      channelId: 'UC8gbWbcNNyb5-NIXvFklkOA',
      place: 'Market Square, Portsmouth NH', region: 'nh',
      lat: 43.0770, lon: -70.7576, bearing: null, confirmed: true,
      note: 'Downtown Portsmouth, street level' },

    { id: 'H8bFFw-0ZQE', site: 'conway', name: 'North Conway',
      channelId: 'UC8gbWbcNNyb5-NIXvFklkOA',
      place: 'Norcross Place, North Conway NH', region: 'nh',
      lat: 44.0545, lon: -71.1294, bearing: null, confirmed: false,
      note: 'Village centre and the Moat range' },

    { id: 'qaKsuZF9ZT8', site: 'loon', name: 'Loon Peak summit',
      channelId: 'UCGtdI1KTGu-p1g1fOaMS7nQ',
      place: 'Loon Mountain, Lincoln NH', region: 'nh',
      lat: 44.0346, lon: -71.6208, bearing: null, confirmed: false,
      note: 'Summit, weather at altitude' },

    { id: 'RLIRtD89O7g', site: 'ogunquit', name: 'Marginal Way, Ogunquit',
      channelId: 'UCALmdjIUxpKqyUTxg5QOSMQ',
      place: 'Lobster Point Light, Ogunquit ME', region: 'me',
      lat: 43.2438, lon: -70.5900, bearing: 100, confirmed: true,
      note: 'Open ocean, southern Maine coast' },

    { id: 'catvjIWNrZg', site: 'york', name: 'York Harbor Beach',
      channelId: 'UC8gbWbcNNyb5-NIXvFklkOA',
      place: 'Stage Neck Inn, York ME', region: 'me',
      lat: 43.1311, lon: -70.6386, bearing: 60, confirmed: true,
      note: 'Harbour mouth and the beach' },

    { id: 'OteVW3af3BU', site: 'barharbor', name: 'Bar Harbor, west',
      channelId: 'UC8gbWbcNNyb5-NIXvFklkOA',
      place: 'Bar Harbor Inn, Bar Harbor ME', region: 'me',
      lat: 44.3904, lon: -68.2025, bearing: 270, confirmed: true,
      note: 'Frenchman Bay and the town pier' }
  ];

  /* Ids these cameras have carried before. Not shown anywhere. They are here so
     that a resolver added later has something to walk, and so the next person to
     find a dead stream can see the rotation is expected rather than a mistake. */
  var KNOWN_ALTS = {
    mos: ['dCtg7Y1KSgg', '_oWwfJ3v0oE', 'RManbLSTXuc', 'rjyNLYKDYfQ', 'sWF5RQ_OzpM']
  };

  /* Mass Maritime publishes the canal on its own page under a different id than
     the aggregator does. Both are live. The academy's is the one that outlives
     an aggregator going out of business, so it is recorded as the preferred
     replacement rather than swapped in blind. */
  var SITE_ALT = { canal: 'UMC7mXIegBI' };

  var SPREAD_M = 110;    // fallback fan radius when nobody passes a zoom
  var M_PER_DEG = 111320;

  /* Web Mercator ground resolution. Latitude is in it because a pixel covers more
     ground near the equator than near the pole, and Boston at 42N is already a 26%
     correction. */
  function metresPerPixel(lat, zoom) {
    return 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom);
  }

  /* The fan is sized in pixels because the thing it fixes is a pixel collision, and
     then clamped at both ends in metres because the map still has to be true.
     FAN_PX is 28 rather than the 20 that two icons need, because the tightest pair
     here is the museum's southwest and west cameras at 45 degrees apart, and two pins
     45 degrees apart on a circle of radius r are only 0.77r from each other. 28 buys
     that pair about 21 pixels.
     MIN_M stops the three from merging again at street zoom, where 28 pixels is a few
     metres and the cameras really are further apart than that on the roof. MAX_M is
     the honesty limit: past a couple of hundred metres a pin is not an approximate
     position any more, it is a wrong one. So at metro zoom the fan gives up and the
     three read as one place, which at that scale is exactly what they are, and the
     sibling links in the popup are what make the other two reachable there. */
  var FAN_PX = 28, MIN_M = 30, MAX_M = 250;

  function spreadFor(lat, zoom) {
    if (!num(zoom)) return SPREAD_M;
    var m = FAN_PX * metresPerPixel(num(lat) ? lat : 42.36, zoom);
    return Math.max(MIN_M, Math.min(MAX_M, m));
  }

  function num(v) { return typeof v === 'number' && isFinite(v); }

  function ok(c) {
    return !!c && typeof c.id === 'string' && c.id.length >= 6 &&
      num(c.lat) && num(c.lon) &&
      c.lat >= -90 && c.lat <= 90 && c.lon >= -180 && c.lon <= 180;
  }

  function list() { return CAMS.filter(ok); }

  function byRegion(region) {
    return list().filter(function (c) { return c.region === region; });
  }

  function get(id) {
    var all = list(), i;
    for (i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }

  function alts(cam) {
    if (!cam) return [];
    var out = [];
    if (SITE_ALT[cam.site]) out.push(SITE_ALT[cam.site]);
    if (KNOWN_ALTS[cam.site]) {
      KNOWN_ALTS[cam.site].forEach(function (a) {
        if (a !== cam.id && out.indexOf(a) < 0) out.push(a);
      });
    }
    return out;
  }

  /* Group key is the rounded pair rather than the site name, because two
     cameras can share a roof without anybody having thought to give them the
     same site string, and the thing that actually causes the stack is the
     coordinates being equal. Five decimals is about a metre. */
  function cellOf(c) { return c.lat.toFixed(5) + ',' + c.lon.toFixed(5); }

  function stacks() {
    var by = {}, out = [];
    list().forEach(function (c) {
      var k = cellOf(c);
      if (!by[k]) { by[k] = []; out.push(k); }
      by[k].push(c);
    });
    return out.map(function (k) { return by[k]; });
  }

  /* The other cameras standing on the same spot. This exists because the fan is
     not enough on its own. spreadFor clamps at MAX_M, which at metro zoom works
     out to about nine pixels of radius, and the museum's southwest and west
     bearings are only 45 degrees apart, so at the zoom the dashboard opens at
     the three rooftop pins are still one pin with two cameras hidden under it.
     Rather than lie about the distance to force them apart, the popup on the pin
     you can click lists the ones you cannot, and the page turns each into a
     control that opens it. So the stack resolves through the interface at every
     zoom, and the fan becomes what it should have been all along: a nicety that
     makes the three reachable directly once you are close enough to see them. */
  function siblings(cam) {
    if (!ok(cam)) return [];
    var k = cellOf(cam);
    return list().filter(function (c) {
      return c.id !== cam.id && cellOf(c) === k;
    });
  }

  /* Metres east and north, converted to degrees at this latitude. Longitude
     degrees shrink toward the poles and at 44N that is already a 28% error if
     you skip the cosine, which at 110m is small but shows up as a lopsided fan. */
  function nudge(lat, lon, bearingDeg, metres) {
    var rad = bearingDeg * Math.PI / 180;
    var dNorth = Math.cos(rad) * metres;
    var dEast = Math.sin(rad) * metres;
    var cos = Math.cos(lat * Math.PI / 180);
    if (Math.abs(cos) < 1e-6) cos = 1e-6;
    return [lat + dNorth / M_PER_DEG, lon + dEast / (M_PER_DEG * cos)];
  }

  /* A camera that is alone stays exactly where it is. Moving a single pin off
     its real position to satisfy a rule that has nothing to do with it is how
     a map starts lying. */
  function placed(zoom) {
    var out = [];
    stacks().forEach(function (grp) {
      if (grp.length === 1) {
        out.push(mark(grp[0], grp[0].lat, grp[0].lon, false, 0));
        return;
      }
      var spread = spreadFor(grp[0].lat, zoom);
      grp.forEach(function (c, i) {
        var b = num(c.bearing) ? c.bearing : (360 / grp.length) * i;
        var p = nudge(c.lat, c.lon, b, spread);
        out.push(mark(c, p[0], p[1], true, spread));
      });
    });
    return out;
  }

  function mark(c, lat, lon, moved, spread) {
    return {
      cam: c, id: c.id, name: c.name, place: c.place, note: c.note,
      region: c.region, site: c.site, bearing: c.bearing,
      lat: lat, lon: lon, offset: moved, spread: spread || 0,
      trueLat: c.lat, trueLon: c.lon
    };
  }

  var COMPASS = [
    [22.5, 'north'], [67.5, 'northeast'], [112.5, 'east'], [157.5, 'southeast'],
    [202.5, 'south'], [247.5, 'southwest'], [292.5, 'west'], [337.5, 'northwest']
  ];

  function facing(bearing) {
    if (!num(bearing)) return '';
    var b = ((bearing % 360) + 360) % 360, i;
    for (i = 0; i < COMPASS.length; i++) if (b < COMPASS[i][0]) return COMPASS[i][1];
    return 'north';
  }

  /* How many catalog cameras share each channel. A channel embed shows ONE
     stream, whichever the channel happens to have live when the iframe asks,
     so it is only a safe address for a channel that owns a single camera in
     this catalog. Boston and Maine Live runs eight of these twelve at once,
     and eight pins showing the same picture is worse than eight pins that
     occasionally rot. Their durable fix is a title-matching resolver against
     the channel's streams page, and it is a later piece of work. */
  var CHANNEL_OWNS = {};
  CAMS.forEach(function (c) {
    if (c.channelId) CHANNEL_OWNS[c.channelId] = (CHANNEL_OWNS[c.channelId] || 0) + 1;
  });

  /* A channel embed resolves to whatever that channel has live at the moment
     the iframe loads, which is the only address here that survives an id
     rotation. Every catalog row now records its channel, and the branch takes
     it exactly when the channel owns one camera, per CHANNEL_OWNS above. */
  function embedSrc(cam, opts) {
    if (!ok(cam)) return '';
    var o = opts || {};
    var q = ['autoplay=' + (o.autoplay === false ? '0' : '1'),
             'mute=' + (o.mute === false ? '0' : '1'),
             'playsinline=1', 'rel=0', 'modestbranding=1'];
    if (o.origin) q.push('origin=' + encodeURIComponent(o.origin));
    if (cam.channelId && CHANNEL_OWNS[cam.channelId] === 1) {
      return 'https://www.youtube.com/embed/live_stream?channel=' +
        encodeURIComponent(cam.channelId) + '&' + q.join('&');
    }
    return 'https://www.youtube.com/embed/' + encodeURIComponent(cam.id) +
      '?' + q.join('&');
  }

  function watchURL(cam) {
    if (!ok(cam)) return '';
    return 'https://www.youtube.com/watch?v=' + encodeURIComponent(cam.id);
  }

  /* Not every camera has been observed embedded on a third-party page. The three
     that have not are still shipped, because oembed answered 200 for them and a
     401 is what a disabled embed returns, but they are flagged so a failure on
     one of them reads as a known risk rather than a new mystery. */
  function unproven() {
    return list().filter(function (c) { return !c.confirmed; })
      .map(function (c) { return c.id; });
  }

  function counts() {
    var out = { total: 0, boston: 0, ma: 0, nh: 0, me: 0, stacked: 0 };
    list().forEach(function (c) {
      out.total++;
      if (out[c.region] !== undefined) out[c.region]++;
    });
    stacks().forEach(function (g) { if (g.length > 1) out.stacked += g.length; });
    return out;
  }

  var API = {
    CAMS: CAMS, SPREAD_M: SPREAD_M, FAN_PX: FAN_PX, MIN_M: MIN_M, MAX_M: MAX_M,
    ok: ok, list: list, get: get, byRegion: byRegion,
    stacks: stacks, placed: placed, nudge: nudge, cellOf: cellOf,
    facing: facing, embedSrc: embedSrc, watchURL: watchURL,
    alts: alts, unproven: unproven, counts: counts,
    spreadFor: spreadFor, metresPerPixel: metresPerPixel, siblings: siblings
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.BCCWebcams = API;
})(this);
