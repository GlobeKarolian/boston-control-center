// tools/test-webcams.js
//
// node tools/test-webcams.js
//
// The catalog is hand-entered data, so most of what follows is checking that a
// human typing twelve rows did not swap a sign, repeat an id, or drop a camera
// into the Atlantic. The rest checks the two pieces of real logic: the nudge
// that pulls the Museum of Science stack apart, and the embed URL builder.

const W = require('../app/webcams.js');

let pass = 0, fail = 0;
const head = (s) => console.log('\n' + s);
const ok = (name, cond) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
};
const eq = (name, got, want) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  if (good) { pass++; console.log('  ok   ' + name); }
  else {
    fail++;
    console.log('  FAIL ' + name);
    console.log('       got  ' + JSON.stringify(got));
    console.log('       want ' + JSON.stringify(want));
  }
};

head('catalog shape');
eq('twelve cameras', W.list().length, 12);
ok('every entry passes ok()', W.CAMS.every(W.ok));
ok('no duplicate video ids', new Set(W.list().map(c => c.id)).size === 12);
ok('every camera has a name', W.list().every(c => c.name && c.name.length > 3));
ok('every camera has a place', W.list().every(c => c.place && c.place.length > 3));
ok('every camera has a note', W.list().every(c => c.note && c.note.length > 5));
ok('every region is one of four', W.list().every(c => ['boston', 'ma', 'nh', 'me'].indexOf(c.region) >= 0));

head('coordinates land in New England');
ok('latitudes between 41 and 45', W.list().every(c => c.lat > 41 && c.lat < 45));
ok('longitudes between -71.7 and -68', W.list().every(c => c.lon > -71.7 && c.lon < -68));
ok('every longitude is negative', W.list().every(c => c.lon < 0));
// The Museum of Science coordinate is the one an outside catalog had wrong. It
// listed 42.3555,-71.0565, which is Faneuil Hall, about 1.4km southeast of the
// roof these three cameras actually sit on. Pin it so nobody re-imports that.
const mos = W.get('p-pVYYH4ZCk');
ok('museum of science is not the bad downtown coordinate',
  Math.abs(mos.lat - 42.3555) > 0.005 || Math.abs(mos.lon + 71.0565) > 0.005);
eq('museum of science latitude', mos.lat, 42.3676);
eq('museum of science longitude', mos.lon, -71.0716);

head('rejects bad rows');
ok('rejects null', !W.ok(null));
ok('rejects a missing id', !W.ok({ lat: 42, lon: -71 }));
ok('rejects a short id', !W.ok({ id: 'ab', lat: 42, lon: -71 }));
ok('rejects a missing lat', !W.ok({ id: 'abcdefghijk', lon: -71 }));
ok('rejects a string lat', !W.ok({ id: 'abcdefghijk', lat: '42', lon: -71 }));
ok('rejects NaN', !W.ok({ id: 'abcdefghijk', lat: NaN, lon: -71 }));
ok('rejects an out-of-range lat', !W.ok({ id: 'abcdefghijk', lat: 91, lon: -71 }));
ok('rejects an out-of-range lon', !W.ok({ id: 'abcdefghijk', lat: 42, lon: -181 }));
ok('accepts a good row', W.ok({ id: 'abcdefghijk', lat: 42, lon: -71 }));

head('lookup');
ok('get finds a real id', !!W.get('2lRbwu4TVtA'));
eq('get returns the right one', W.get('2lRbwu4TVtA').site, 'boylston');
ok('get on an unknown id is null', W.get('nope-nope-nope') === null);
eq('four in Boston', W.byRegion('boston').length, 4);
eq('two elsewhere in Massachusetts', W.byRegion('ma').length, 2);
eq('three in New Hampshire', W.byRegion('nh').length, 3);
eq('three in Maine', W.byRegion('me').length, 3);
eq('an unknown region is empty', W.byRegion('vt').length, 0);

head('the counts a layer row would show');
const n = W.counts();
eq('total', n.total, 12);
eq('boston', n.boston, 4);
eq('stacked', n.stacked, 3);
ok('regions sum to the total', n.boston + n.ma + n.nh + n.me === n.total);

head('stacking');
const st = W.stacks();
eq('eleven distinct locations', st.length, 10);
const big = st.filter(g => g.length > 1);
eq('exactly one stack', big.length, 1);
eq('the stack holds three cameras', big[0].length, 3);
ok('the stack is the museum roof', big[0].every(c => c.site === 'mos'));
ok('every other location holds one', st.filter(g => g.length === 1).length === 9);
eq('cell key rounds to five places', W.cellOf({ lat: 42.36764444, lon: -71.07161111 }), '42.36764,-71.07161');

head('the nudge that pulls the stack apart');
const north = W.nudge(42.3676, -71.0716, 0, 111320);
ok('due north moves latitude up about a degree', Math.abs(north[0] - 43.3676) < 0.001);
ok('due north leaves longitude alone', Math.abs(north[1] + 71.0716) < 1e-9);
const east = W.nudge(42.3676, -71.0716, 90, 1000);
ok('due east moves longitude up', east[1] > -71.0716);
ok('due east leaves latitude alone', Math.abs(east[0] - 42.3676) < 1e-9);
const west = W.nudge(42.3676, -71.0716, 270, 1000);
ok('due west moves longitude down', west[1] < -71.0716);
ok('east and west are symmetric', Math.abs((east[1] + west[1]) / 2 + 71.0716) < 1e-9);
// A longitude degree at 42N is about 74% of one at the equator. Skipping the
// cosine would draw the east and west cameras 26% closer together than the
// north/south ones, which reads as a lopsided fan rather than a bug.
const eqtr = W.nudge(0, 0, 90, 1000);
const ratio = Math.abs(east[1] + 71.0716) / Math.abs(eqtr[1]);
ok('the same eastward metres move longitude further at 42N than at the equator', ratio > 1.2);
ok('and further by exactly one over the cosine',
  Math.abs(ratio - 1 / Math.cos(42.3676 * Math.PI / 180)) < 1e-6);
ok('zero metres is a no-op', W.nudge(42, -71, 90, 0)[0] === 42);

head('placement');
const P = W.placed();
eq('every camera is placed exactly once', P.length, 12);
ok('placed ids match the catalog', new Set(P.map(p => p.id)).size === 12);
const moved = P.filter(p => p.offset);
eq('only the stack is moved', moved.length, 3);
ok('the moved three are the museum', moved.every(p => p.site === 'mos'));
ok('nine cameras keep their exact coordinates',
  P.filter(p => !p.offset).every(p => p.lat === p.trueLat && p.lon === p.trueLon));
ok('a moved camera keeps its true coordinates alongside',
  moved.every(p => p.trueLat === 42.3676 && p.trueLon === -71.0716));
ok('the three moved pins are all distinct',
  new Set(moved.map(p => p.lat.toFixed(6) + ',' + p.lon.toFixed(6))).size === 3);
ok('no moved pin is still on the shared cell',
  moved.every(p => p.lat.toFixed(5) + ',' + p.lon.toFixed(5) !== '42.36760,-71.07160'));
// The point of nudging along the bearing rather than fanning arbitrarily: the
// pin ends up in the direction the camera is looking, so its position on the
// map is information rather than decoration.
const mosE = moved.find(p => p.id === 'p-pVYYH4ZCk');
const mosW = moved.find(p => p.id === 'oezcsH9ZZ24');
const mosSW = moved.find(p => p.id === 'Jq-5u9NNZiM');
ok('the east camera sits east of the roof', mosE.lon > -71.0716);
ok('the west camera sits west of the roof', mosW.lon < -71.0716);
ok('the southwest camera sits south of the roof', mosSW.lat < 42.3676);
ok('the southwest camera sits west of the roof', mosSW.lon < -71.0716);
ok('east and west are on opposite sides', (mosE.lon + 71.0716) * (mosW.lon + 71.0716) < 0);
ok('the spread is roughly the declared distance',
  Math.abs((mosE.lon - mosW.lon) * 111320 * Math.cos(42.3676 * Math.PI / 180) - 2 * W.SPREAD_M) < 5);

head('compass words');
eq('0 is north', W.facing(0), 'north');
eq('90 is east', W.facing(90), 'east');
eq('180 is south', W.facing(180), 'south');
eq('270 is west', W.facing(270), 'west');
eq('225 is southwest', W.facing(225), 'southwest');
eq('45 is northeast', W.facing(45), 'northeast');
eq('315 is northwest', W.facing(315), 'northwest');
eq('350 wraps back to north', W.facing(350), 'north');
eq('360 is north', W.facing(360), 'north');
eq('a negative bearing wraps', W.facing(-90), 'west');
eq('over 360 wraps', W.facing(450), 'east');
eq('null has no word', W.facing(null), '');
eq('undefined has no word', W.facing(undefined), '');

head('embed urls');
const e = W.embedSrc(W.get('p-pVYYH4ZCk'));
ok('is a youtube embed', e.indexOf('https://www.youtube.com/embed/') === 0);
ok('carries the video id', e.indexOf('p-pVYYH4ZCk') > 0);
// Muted is not a preference. An unmuted autoplay is refused by every current
// browser, so the frame would sit black until somebody clicked it, which on a
// wall screen nobody does.
ok('autoplays', e.indexOf('autoplay=1') > 0);
ok('is muted', e.indexOf('mute=1') > 0);
ok('plays inline on iOS', e.indexOf('playsinline=1') > 0);
ok('suppresses related videos', e.indexOf('rel=0') > 0);
ok('has exactly one question mark', e.split('?').length === 2);
ok('mute can be turned off', W.embedSrc(W.get('p-pVYYH4ZCk'), { mute: false }).indexOf('mute=0') > 0);
ok('autoplay can be turned off', W.embedSrc(W.get('p-pVYYH4ZCk'), { autoplay: false }).indexOf('autoplay=0') > 0);
ok('origin is added when given', W.embedSrc(W.get('p-pVYYH4ZCk'), { origin: 'https://x.dev' }).indexOf('origin=https%3A%2F%2Fx.dev') > 0);
ok('origin is absent when not given', e.indexOf('origin=') < 0);
ok('a bad camera makes no url', W.embedSrc(null) === '');
ok('a malformed camera makes no url', W.embedSrc({ id: 'x' }) === '');
// A channel embed shows whichever ONE stream the channel has live, so it is
// only a safe address for a channel that owns a single camera here. The rule
// is catalog-aware on purpose: a bare object with a channelId does not get
// the channel path, because the catalog is where ownership is counted.
const solo = W.embedSrc(W.get('_OeFhA2XqqA'));   // Mass Maritime, one camera
ok('a solo-channel camera takes the live_stream path',
  solo.indexOf('/embed/live_stream?channel=UCiKd90Y9P2dH3QR_AecBYaA') > 0);
ok('the channel embed still autoplays muted', solo.indexOf('autoplay=1') > 0 && solo.indexOf('mute=1') > 0);
ok('the channel embed has one question mark', solo.split('?').length === 2);
// Boston and Maine Live owns eight of these cameras. Eight pins showing the
// same picture is worse than eight pins that occasionally rot, so a shared
// channel keeps the video path even though its channelId is recorded.
const shared = W.embedSrc(W.get('p-pVYYH4ZCk'));
ok('a shared-channel camera keeps the video path', shared.indexOf('/embed/p-pVYYH4ZCk') > 0);
ok('and does not take the channel path', shared.indexOf('live_stream') < 0);
ok('every catalog row records its channel now', W.list().every(c => c.channelId && /^UC[\w-]{22}$/.test(c.channelId)));
ok('a foreign channelId outside the catalog gets no channel path',
  W.embedSrc({ id: 'abcdefghijk', lat: 42, lon: -71, channelId: 'UC_test' }).indexOf('live_stream') < 0);

head('watch urls');
const w = W.watchURL(W.get('catvjIWNrZg'));
eq('the fallback link', w, 'https://www.youtube.com/watch?v=catvjIWNrZg');
ok('every camera produces a watch url', W.list().every(c => W.watchURL(c).indexOf('watch?v=') > 0));
ok('a bad camera makes no watch url', W.watchURL(null) === '');
ok('watch urls are all distinct', new Set(W.list().map(W.watchURL)).size === 12);

head('rotation and known alternates');
const a = W.alts(W.get('p-pVYYH4ZCk'));
ok('the museum cameras carry alternates', a.length >= 4);
ok('a camera never lists itself as its own alternate', a.indexOf('p-pVYYH4ZCk') < 0);
ok('alternates are unique', new Set(a).size === a.length);
// Mass Maritime publishes the canal under its own id. It is recorded as the
// preferred replacement rather than swapped in, because both are live today and
// switching blind trades a working camera for an untested one.
ok('the canal carries the academy id', W.alts(W.get('_OeFhA2XqqA')).indexOf('UMC7mXIegBI') === 0);
eq('a camera with no known rotation has none', W.alts(W.get('LkZZTkRHLVQ')).length, 0);
eq('alts of nothing is empty', W.alts(null).length, 0);

head('embeds that still need a smoke test');
const u = W.unproven();
eq('three are unproven', u.length, 3);
ok('the museum southwest camera is one', u.indexOf('Jq-5u9NNZiM') >= 0);
ok('north conway is one', u.indexOf('H8bFFw-0ZQE') >= 0);
ok('loon peak is one', u.indexOf('qaKsuZF9ZT8') >= 0);
ok('nine are confirmed embeddable', W.list().filter(c => c.confirmed).length === 9);

head('the fan is sized in pixels, because the collision it fixes is a pixel one');
// The bug this section pins was invisible to every test above it. All of them
// measured metres, and 110 metres is a perfectly good separation right up until
// you ask how many pixels it buys. At the zoom the dashboard actually opens at
// it buys four, against an 18 pixel icon, so the three museum pins drew on top
// of each other and two of the three could not be clicked.
const MPP12 = W.metresPerPixel(42.3676, 12);
ok('a pixel at Boston z12 is about 28 metres  [' + MPP12.toFixed(2) + ']',
  Math.abs(MPP12 - 28.24) < 0.05);
ok('each zoom level halves it', Math.abs(W.metresPerPixel(42.3676, 13) * 2 - MPP12) < 1e-9);
ok('z16 is a metre and three quarters',
  Math.abs(W.metresPerPixel(42.3676, 16) - 1.765) < 0.01);
// Latitude is in the formula because a pixel covers more ground near the equator.
ok('the equator gets more ground per pixel than Boston',
  W.metresPerPixel(0, 12) > W.metresPerPixel(42.3676, 12));
ok('and Boston is the cosine of its latitude of it',
  Math.abs(W.metresPerPixel(42.3676, 12) / W.metresPerPixel(0, 12)
    - Math.cos(42.3676 * Math.PI / 180)) < 1e-12);

head('and then clamped at both ends, because the map still has to be true');
eq('no zoom falls back to the fixed spread', W.spreadFor(42.3676), W.SPREAD_M);
eq('so do the values Leaflet never produces', W.spreadFor(42.3676, null), W.SPREAD_M);
eq('a far out map hits the honesty ceiling', W.spreadFor(42.3676, 12), W.MAX_M);
eq('a street level map hits the floor', W.spreadFor(42.3676, 19), W.MIN_M);
// Between the two clamps the fan should be tracking pixels rather than metres,
// which is the whole point: the same number of pixels at every zoom in the band.
[14, 15, 16].forEach(z => {
  const px = W.spreadFor(42.3676, z) / W.metresPerPixel(42.3676, z);
  ok('z' + z + ' asks for the pixel radius it was told to  [' + px.toFixed(1) + 'px]',
    Math.abs(px - W.FAN_PX) < 0.01);
});
ok('the spread only ever shrinks as you zoom in',
  W.spreadFor(42.3676, 13) >= W.spreadFor(42.3676, 14) &&
  W.spreadFor(42.3676, 14) >= W.spreadFor(42.3676, 15) &&
  W.spreadFor(42.3676, 15) >= W.spreadFor(42.3676, 16));

head('which pulls the rooftop three apart once the map is close enough');
// Two pins theta degrees apart on a circle of radius r are 2r sin(theta/2)
// from each other. The museum's southwest at 225 and west at 270 are only 45
// apart, which is 0.765r, and that pair is what the fan has to clear, not the
// easy 90 degree one. An 18px icon needs about 20px to read as two pins.
function pixelsApart(a, b, z) {
  const at = W.placed(z).filter(p => p.id === a)[0];
  const bt = W.placed(z).filter(p => p.id === b)[0];
  const mpp = W.metresPerPixel(at.lat, z);
  const dN = (at.lat - bt.lat) * 111320;
  const dE = (at.lon - bt.lon) * 111320 * Math.cos(at.lat * Math.PI / 180);
  return Math.hypot(dN, dE) / mpp;
}
const tight = pixelsApart('Jq-5u9NNZiM', 'oezcsH9ZZ24', 15);
ok('the 45 degree pair clears an icon at z15  [' + tight.toFixed(1) + 'px]', tight > 20);
ok('the easy pair clears it too at z15  [' + pixelsApart('p-pVYYH4ZCk', 'oezcsH9ZZ24', 15).toFixed(1) + 'px]',
  pixelsApart('p-pVYYH4ZCk', 'oezcsH9ZZ24', 15) > 20);
ok('and at z16', pixelsApart('Jq-5u9NNZiM', 'oezcsH9ZZ24', 16) > 20);
// The honest failure. At metro zoom the ceiling binds and the three read as one
// place, which at that scale is what they are. This is asserted rather than
// wished away, because it is the reason siblings() below exists.
ok('at z12 the ceiling binds and they are still one pin  ['
  + pixelsApart('Jq-5u9NNZiM', 'oezcsH9ZZ24', 12).toFixed(1) + 'px]',
  pixelsApart('Jq-5u9NNZiM', 'oezcsH9ZZ24', 12) < 20);

head('so a stacked pin can reach the cameras hiding under it');
const sib = W.siblings(W.get('p-pVYYH4ZCk'));
eq('the east camera knows about two others', sib.length, 2);
ok('and not about itself', sib.every(c => c.id !== 'p-pVYYH4ZCk'));
ok('they are the other two rooftop cameras',
  sib.map(c => c.id).sort().join(',') === ['Jq-5u9NNZiM', 'oezcsH9ZZ24'].sort().join(','));
ok('the relation goes both ways',
  W.siblings(W.get('oezcsH9ZZ24')).some(c => c.id === 'p-pVYYH4ZCk'));
eq('a camera standing alone has none', W.siblings(W.get('2lRbwu4TVtA')).length, 0);
eq('neither does a camera that is not one', W.siblings({ id: 'nope' }).length, 0);
eq('nor null', W.siblings(null).length, 0);
// Keyed on coordinates rather than the site string, same as stacks(), so two
// cameras that share a roof without sharing a site name still find each other.
ok('every camera with siblings is in a group of that size plus one',
  W.list().every(c => {
    const g = W.stacks().filter(s => s.some(x => x.id === c.id))[0];
    return g.length === W.siblings(c).length + 1;
  }));

head('the module does not need a browser');
ok('no window reference', typeof window === 'undefined');
ok('exports an object', typeof W === 'object');
ok('list is a copy-safe filter, not the raw array', W.list() !== W.CAMS);

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
