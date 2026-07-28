// End-to-end test of the Vercel app with no Redis and no Anthropic key.
// Proves: auth, dedupe, extract (regex path), geocode cascade, the store
// mutex, the render keys, and every read route.
process.env.AUTH_USER = 'newsroom';
process.env.AUTH_PASS = 'test-pass-123';
process.env.INGEST_SECRET = 'test-ingest-abc';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.KV_REST_API_URL;
delete process.env.UPSTASH_REDIS_REST_URL;
// Deleted rather than assumed absent. livefield.js reads this once at module
// load, so a key sitting in the developer's shell would silently turn section 8
// into a live BestTime sweep that spends credits and fails on a plane.
delete process.env.BESTTIME_API_KEY_PRIVATE;

const path = require('path');
const ROOT = '/Users/mkarolian/Developer/bcc/web';

function mkres() {
  const r = { headers: {}, statusCode: 200, body: null };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.status = c => { r.statusCode = c; return r; };
  r.send = b => { r.body = b; return r; };
  r.end = () => r;
  return r;
}
const basic = 'Basic ' + Buffer.from('newsroom:test-pass-123').toString('base64');

async function call(mod, req) {
  const h = require(path.join(ROOT, mod));
  const res = mkres();
  req.headers = req.headers || {};
  req.method = req.method || 'GET';
  req.query = req.query || {};
  await h(req, res);
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch (e) {}
  return { status: res.statusCode, body: res.body, json: parsed, headers: res.headers };
}

let failures = 0;
const ok = (label, cond, extra) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (extra ? '   ' + extra : ''));
  if (!cond) failures++;
};

const TRAFFIC = [
  { src: 'bostonfire', city: 'Boston', text: 'Engine 7 Ladder 4 respond to 700 Boylston Street for a fire alarm activation', seq: 1 },
  { src: 'bostonfire', city: 'Boston', text: 'Engine 7 on scene 700 Boylston Street, investigating', seq: 2 },
  { src: 'bostonems',  city: 'Boston', text: 'A1 respond to 4 Yawkey Way for a cardiac, party is unresponsive, CPR in progress', seq: 3 },
  { src: 'bostonfire', city: 'Boston', text: 'Engine 7 clear, back in service, master box no fire', seq: 4 },
  { src: 'bostonpd',   city: 'Boston', text: 'Radio check, testing one two', seq: 5 },
];

(async () => {
  console.log('\n=== 1. auth ===');
  let r = await call('api/ingest.js', { method: 'POST', body: { machine: 'x', items: [] } });
  ok('ingest with no token is 401', r.status === 401, r.json && r.json.detail);
  r = await call('api/ingest.js', { method: 'POST', headers: { authorization: 'Bearer wrong' }, body: { machine: 'x', items: [] } });
  ok('ingest with wrong token is 401', r.status === 401);
  r = await call('api/incidents.js', {});
  ok('read with no password is 401', r.status === 401);
  ok('401 carries WWW-Authenticate', !!r.headers['www-authenticate']);
  r = await call('api/healthz.js', {});
  ok('healthz is open', r.status === 200 && r.json.ok === true);

  console.log('\n=== 2. ingest a shift of traffic ===');
  const H = { authorization: 'Bearer test-ingest-abc', 'x-bcc-machine': 'studio-mac' };
  const t0 = Date.now();
  r = await call('api/ingest.js', {
    method: 'POST', headers: H,
    body: { machine: 'studio-mac', at: new Date().toISOString(), items: TRAFFIC,
            health: [{ id: 'bostonfire', kind: 'broadcastify', city: 'Boston', feed: '46343', status: 'live', clips: 12, segs: 5, gated: 7, attempts: 1, peakMax: 0.31 },
                     { id: 'bostonems', kind: 'audiotap', city: 'Boston', app: 'Chrome', status: 'live', clips: 9, segs: 3, gated: 6, attempts: 1, peakMax: 0.02 }] },
  });
  console.log('    ->', JSON.stringify(r.json));
  ok('accepted all 5', r.status === 200 && r.json.accepted === 5, r.json && r.json.error);
  ok('regex extractor labelled honestly', /regex/.test(r.json.extractor || ''), r.json.extractor);
  ok('built at least one incident', r.json.incidents >= 1, 'incidents=' + r.json.incidents);
  console.log('    ingest took ' + (Date.now() - t0) + 'ms (real Census/OSM calls)');

  console.log('\n=== 3. dedupe ===');
  r = await call('api/ingest.js', { method: 'POST', headers: H, body: { machine: 'studio-mac', items: TRAFFIC } });
  ok('replay of the same seqs is fully deduped', r.json.accepted === 0 && r.json.duplicates === 5, JSON.stringify(r.json));

  console.log('\n=== 4. read routes ===');
  r = await call('api/incidents.js', { headers: { authorization: basic } });
  const incs = r.json;
  ok('incidents 200 with password', r.status === 200 && Array.isArray(incs));
  ok('cache header is private, never shared', /^private/.test(r.headers['cache-control'] || ''), r.headers['cache-control']);
  const fire = incs.find(i => (i.units || []).includes('E7'));
  ok('E7 correlated into ONE scene across 3 transmissions', !!fire && fire.timeline.length === 3,
     fire ? 'timeline=' + fire.timeline.length : 'no E7 incident');
  ok('scene geocoded to Boylston St', !!fire && fire.located && /Boylston/i.test(fire.location || ''), fire && fire.location);
  ok('scene went to cleared on the clear message', !!fire && fire.status === 'cleared', fire && fire.status);

  r = await call('api/transcripts.js', { headers: { authorization: basic } });
  ok('transcripts has all 5', Array.isArray(r.json) && r.json.length === 5, 'n=' + (r.json || []).length);

  r = await call('api/pipeline.js', { headers: { authorization: basic } });
  const pl = r.json;
  ok('pipeline reports both feeds', (pl.feeds || []).length === 2, 'feeds=' + (pl.feeds || []).length);
  ok('pipeline knows the machine', (pl.stats.machines || []).includes('studio-mac'), JSON.stringify(pl.stats.machines));
  ok('pipeline logged 5 transmissions', pl.stats.transmissions === 5, 'n=' + pl.stats.transmissions);
  ok('pipeline events trace every transmission', (pl.events || []).length === 5, 'n=' + (pl.events || []).length);

  r = await call('api/state.js', { headers: { authorization: basic } });
  ok('combined state has all four payloads', r.status === 200 && Array.isArray(r.json.incidents) &&
     Array.isArray(r.json.transcripts) && r.json.pipeline && Array.isArray(r.json.situations));

  console.log('\n=== 5. status page tells the truth about config ===');
  r = await call('api/status.js', { headers: { authorization: basic } });
  ok('status 200', r.status === 200);
  ok('knows there is no Redis', r.json.redis.configured === false);
  ok('knows ANTHROPIC_API_KEY is missing', r.json.config.ANTHROPIC_API_KEY === false);
  ok('knows AUTH_PASS is set', r.json.config.AUTH_PASS === true);
  ok('warns about the missing key', r.json.warnings.some(w => /ANTHROPIC_API_KEY/.test(w)));
  const dump = JSON.stringify(r.json);
  ok('leaks NO secret values', !dump.includes('test-pass-123') && !dump.includes('test-ingest-abc'));

  console.log('\n=== 6. heartbeat with no items ===');
  r = await call('api/ingest.js', { method: 'POST', headers: H, body: { machine: 'studio-mac', items: [],
    health: [{ id: 'bostonfire', status: 'connected', clips: 13, segs: 5, gated: 8 }] } });
  ok('heartbeat accepted, nothing applied', r.status === 200 && r.json.accepted === 0, JSON.stringify(r.json));

  console.log('\n=== 7. feed proxy allowlist ===');
  r = await call('api/feed.js', { query: { url: 'https://evil.example.com/x' } });
  ok('blocks a domain not on the list', r.status === 403, r.body);
  r = await call('api/feed.js', { query: { url: 'not a url' } });
  ok('rejects a malformed url', r.status === 400);

  console.log('\n=== 8. activity layer: routes ===');
  // Every one of these is behind the newsroom password and none of them exist
  // yet, which is the interesting case. An absent crowd map must read as "we
  // have not looked", never as a city with nobody in it.
  r = await call('api/activity.js', {});
  ok('activity needs the password', r.status === 401);
  r = await call('api/activity.js', { headers: { authorization: basic } });
  ok('activity with no data is 503, not an empty city', r.status === 503, JSON.stringify(r.json));
  ok('and it says why', /has not completed a run/.test((r.json || {}).hint || ''));
  r = await call('api/livefield.js', { headers: { authorization: basic } });
  ok('livefield with no data is 503', r.status === 503);
  r = await call('api/pulse.js', { headers: { authorization: basic } });
  ok('pulse with no data is 503', r.status === 503);

  const kv = require(path.join(ROOT, 'lib/kv.js'));
  const activity = require(path.join(ROOT, 'activity/index.js'));
  const livefield = require(path.join(ROOT, 'activity/livefield.js'));
  const pulseMod = require(path.join(ROOT, 'activity/pulse.js'));

  await kv.setBig(activity.K_OUT, JSON.stringify({ generatedAt: 'x', items: [], summary: { places: 3 } }), 600);
  r = await call('api/activity.js', { headers: { authorization: basic } });
  ok('activity serves what the cron stored', r.status === 200 && r.json.summary.places === 3);
  ok('activity is browser-cached, never CDN-cached', /^private,/.test(r.headers['cache-control'] || ''),
     r.headers['cache-control']);

  await kv.setBig(livefield.K_OUT, JSON.stringify({ anchors: [{ mult: 1.8 }], coverage: {} }), 600);
  r = await call('api/livefield.js', { headers: { authorization: basic } });
  ok('livefield serves its anchors', r.status === 200 && r.json.anchors.length === 1);

  console.log('\n=== 9. pulse assembles two keys into one document ===');
  const hours = new Array(24).fill(0); hours[22] = 60;
  const META = { generatedAt: '2026-07-26T12:00:00.000Z', hourLocal: 3, dayInt: 4,
                 kind: 'forecast', disclaimer: 'FORECAST, NOT LIVE.', coverage: { venues: 2 }, errors: [] };
  const VENUES = [{ name: 'Bleacher Bar', lat: 42.3467, lng: -71.0972, reviews: 900, hours },
                  { name: 'Cask n Flagon', lat: 42.3462, lng: -71.0975, reviews: 1200, hours }];
  await kv.set(pulseMod.K_META, JSON.stringify(META), 600);
  await kv.setBig(pulseMod.K_OUT, JSON.stringify(VENUES), 600);

  r = await call('api/pulse.js', { headers: { authorization: basic } });
  ok('pulse assembles into valid JSON', r.status === 200 && !!r.json, String(r.body).slice(0, 80));
  ok('venues arrive intact', r.json && r.json.venues.length === 2 && r.json.venues[1].name === 'Cask n Flagon');
  ok('the venue array is passed through byte for byte',
     String(r.body).includes(JSON.stringify(VENUES)));
  ok('header fields survive', r.json.disclaimer === 'FORECAST, NOT LIVE.' && r.json.coverage.venues === 2);
  // The asymmetry that matters: the clock is refreshed, the weekday label is not,
  // because every venue curve in this payload was fetched for that weekday.
  ok('dayInt is NOT refreshed at read time', r.json.dayInt === 4, 'dayInt=' + r.json.dayInt);
  ok('hourLocal IS refreshed at read time', r.json.hourLocal === pulseMod.bostonNow().hour,
     'served=' + r.json.hourLocal + ' now=' + pulseMod.bostonNow().hour);
  ok('and the swept hour is kept alongside it', r.json.sweptHourLocal === 3);

  await kv.setBig(pulseMod.K_OUT, 'this is not an array', 600);
  r = await call('api/pulse.js', { headers: { authorization: basic } });
  ok('a truncated venue payload is 503, never malformed JSON', r.status === 503, r.body);

  console.log('\n=== 10. the cadence table survives losing the process ===');
  // The whole reason activity.js was rewritten. On the Mac this was an object
  // in memory; here two invocations a minute apart must still honour a 15
  // minute cadence, or BestTime gets swept 60 times an hour instead of four.
  let calls = 0;
  const counted = async () => { calls++; return { items: [{ id: 'v' + calls }], errors: [], coverage: { run: calls } }; };
  let src = await activity.runSource('besttime', counted);
  ok('first call runs the source', calls === 1 && src.items[0].id === 'v1');
  src = await activity.runSource('besttime', counted);
  ok('second call inside the cadence does NOT run it again', calls === 1, 'calls=' + calls);
  ok('and still returns the cached items', src.items[0].id === 'v1');

  // A source that fails keeps its last good items, says so, and still burns its
  // cadence slot. Retrying a broken API at full cron rate is how an outage
  // becomes a rate limit.
  await kv.setBig('bcc:activity:src:mbta', JSON.stringify({ at: Date.now() - 60000,
    data: { items: [{ id: 'last-good' }], errors: [], coverage: { vehiclesSeen: 40 } } }), 600);
  src = await activity.runSource('mbta', async () => { throw new Error('upstream 503'); });
  ok('a failed source keeps its last good items', src.items.length === 1 && src.items[0].id === 'last-good');
  ok('a failed source is marked stale', src.coverage.stale === true);
  ok('a failed source keeps its old coverage too', src.coverage.vehiclesSeen === 40);
  ok('a failed source reports the error by name', /^mbta: /.test(src.errors[0] || ''), src.errors[0]);

  console.log('\n=== 11. livefield picks the right venues ===');
  const H0 = 22;
  const zeroAt22 = new Array(24).fill(0); zeroAt22[20] = 40;   // open near 22, forecast 0 AT 22
  const V = [
    { id: 'in-quiet',  name: 'in-quiet',  lat: 42.3467, lng: -71.0972, reviews: 500, hours: zeroAt22 },
    { id: 'in-shut',   name: 'in-shut',   lat: 42.3467, lng: -71.0972, reviews: 500, hours: new Array(24).fill(0) },
    { id: 'out-small', name: 'out-small', lat: 42.3600, lng: -71.0600, reviews: 500, hours: (() => { const h = new Array(24).fill(0); h[H0] = 5; return h; })() },
    { id: 'out-big',   name: 'out-big',   lat: 42.3600, lng: -71.0600, reviews: 500, hours: (() => { const h = new Array(24).fill(0); h[H0] = 80; return h; })() },
    { id: 'in-cached', name: 'in-cached', lat: 42.3467, lng: -71.0972, reviews: 500, hours: (() => { const h = new Array(24).fill(0); h[H0] = 90; return h; })() },
  ];
  const now = Date.now();
  const seen = new Map([['in-cached', { at: now - 60 * 1000, live: 50, fc: 40 }]]);
  const ids = livefield.priority(V, H0, now, seen).map(v => v.id);

  // The World Series case, and the single most important line in this file. A
  // bar the forecast calls dead at 10pm, two blocks from Fenway, is exactly the
  // venue that goes loud when the park lets out. MIN_FORECAST would throw it
  // away, which is why the zone does not apply it.
  ok('a zero-forecast venue INSIDE Fenway is probed', ids.includes('in-quiet'), ids.join(','));
  ok('a venue that is shut all day is not', !ids.includes('in-shut'));
  ok('a small venue outside the zone is skipped', !ids.includes('out-small'));
  ok('a busy venue outside the zone is probed', ids.includes('out-big'));
  ok('a venue probed one minute ago is not probed again', !ids.includes('in-cached'));

  const stale = new Map([['in-cached', { at: now - 60 * 60 * 1000, live: 50, fc: 40 }]]);
  const ids2 = livefield.priority(V, H0, now, stale).map(v => v.id);
  ok('but one probed an hour ago is', ids2.includes('in-cached'), ids2.join(','));

  const skipped = await livefield.once();
  ok('livefield with no API key skips cleanly instead of throwing',
     !!(skipped && /BESTTIME_API_KEY_PRIVATE/.test(skipped.skipped || '')), JSON.stringify(skipped));

  console.log('\n' + (failures ? '*** ' + failures + ' FAILURE(S) ***' : 'ALL CHECKS PASSED') + '\n');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
