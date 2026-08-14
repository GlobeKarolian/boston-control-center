// tools/test-stream.js
//
//   node tools/test-stream.js
//
// The listener's contract: nothing between two reads is skipped, no row is
// read twice, and when the radio outruns the reader it says so out loud
// instead of quietly dropping the middle of a busy hour.

const blob = require('../lib/blob.js');

/* A fake vault: one day folder, batches named the way vault.js names them. */
function fakeStore(rows) {
  const batches = [];
  for (let i = 0; i < rows.length; i += 5) {
    const chunk = rows.slice(i, i + 5);
    batches.push({ stamp: +new Date(chunk[0].at), tx: chunk });
  }
  return {
    async list({ prefix }) {
      if (!/^vault\//.test(prefix || '')) return { blobs: [], hasMore: false };
      return {
        blobs: batches.map((b, i) => ({
          url: 'https://fake.test/' + prefix + b.stamp + '-' + b.tx.length + '-x' + i + '.json',
          pathname: prefix + b.stamp + '-' + b.tx.length + '-x' + i + '.json',
        })),
        hasMore: false,
      };
    },
    _batches: batches,
  };
}

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '   ' + detail : '')); }
};

const T0 = Date.UTC(2026, 7, 14, 17, 0, 0);
const ROWS = Array.from({ length: 250 }, (_, i) => ({
  at: new Date(T0 + i * 10000).toISOString(),
  feed: i % 3 === 0 ? 'boston-police' : (i % 3 === 1 ? 'boston-ems' : 'mbta-transit-police'),
  text: 'transmission ' + i,
  clip: 'https://fake.test/clips/c' + i + '.m4a',
}));

const store = fakeStore(ROWS);
blob._inject(store, 'test-token');

/* fetch is stubbed to serve the fake batches by the stamp in the URL. */
global.fetch = async (url) => {
  const m = String(url).match(/\/(\d{10,16})-\d+-x(\d+)\.json$/);
  if (!m) return { ok: false };
  const b = store._batches[+m[2]];
  return { ok: true, json: async () => ({ tx: b.tx }) };
};

const stream = require('../lib/stream.js');

(async () => {
  const wholeWindow = new Date(T0 - 1000).toISOString();
  const first = await stream.since(wholeWindow, new Date(T0 + 100 * 10000).toISOString());
  ok('a read returns the window in order', first.rows.length === 101,
     'got ' + first.rows.length);
  ok('and it is sorted', first.rows.every((r, i, a) => i === 0 || a[i - 1].at <= r.at));
  ok('the cursor is the last row it returned', first.cursor === first.rows[first.rows.length - 1].at);

  /* The whole point: a second read starting at the cursor must not repeat the
     row that set it, and must not skip the one after it. */
  const second = await stream.since(first.cursor, new Date(T0 + 200 * 10000).toISOString());
  ok('no row is read twice', second.rows.every(r => r.at > first.cursor));
  ok('and none is skipped between reads',
     second.rows[0].text === 'transmission 101', second.rows[0] && second.rows[0].text);

  /* Busy hour: more traffic than one read can carry. */
  const flood = await stream.since(new Date(T0 - 1000).toISOString(),
                                   new Date(T0 + 250 * 10000).toISOString());
  const capped = flood.rows.length === stream.MAX_ROWS || flood.complete;
  ok('a normal-sized window is complete', flood.complete === true, 'skipped=' + flood.skipped);

  /* The listener's view is smaller than the vault record, on purpose. */
  const v = stream.forListening({
    at: ROWS[0].at, feed: 'boston-ems', text: 'person stabbed 30 Lancaster Street',
    clip: 'https://fake.test/c.m4a', lat: 42.3, lon: -71.0, by: 'cloud', machine: 'mini',
    signals: [{ id: 'stabbing', tier: 3 }], callType: 'stabbing', matched: '30 LANCASTER ST',
  });
  ok('the listener sees the words, the radio and the audio',
     v.text && v.src && v.clip && v.where === '30 LANCASTER ST');
  ok('and not the provenance it could hallucinate about',
     v.lat === undefined && v.by === undefined && v.machine === undefined);
  /* Signals used to be flattened to id strings here. That looked tidy and it
     cost the severity floor everything: lib/severity.js reads g.id and g.tier
     off each signal, and off a string both are undefined, so GRAVE and HEAVY
     never matched and a mass-casualty signal weighed the same as a noise
     complaint. Objects out, with a flat list alongside for callers that only
     want labels. The model never sees either field. */
  ok('signals keep their id and tier so the floor can read them',
     Array.isArray(v.signals) && v.signals[0].id === 'stabbing' && v.signals[0].tier === 3,
     JSON.stringify(v.signals));
  ok('and a flat id list is still available', Array.isArray(v.signalIds) && v.signalIds[0] === 'stabbing');
  /* The feed goes out under every name its three readers use. analyst-core
     reads t.source, the analyst filters on r.feed, the UI prints t.src. One
     missing alias emptied every situation's transmission list all night. */
  ok('the feed answers to src, source and feed',
     v.src === 'boston-ems' && v.source === 'boston-ems' && v.feed === 'boston-ems');

  const d = stream.densityByFeed(first.rows);
  ok('density is counted per feed for the severity floor',
     d['boston-police'] > 0 && d['boston-ems'] > 0 && d['mbta-transit-police'] > 0,
     JSON.stringify(d));

  /* --- the sampler must never drop right now -------------------------------
 *
 * 14 August, 02:32. Somebody typed "stabbing" into the desk. The answer came
 * back listing seven knife references from the previous morning and
 * afternoon, opened with "there is no explicit confirmation of a stabbing",
 * and did not contain the stabbing dispatched to a Dunkin' Donuts at 02:24,
 * eight minutes earlier, with both an EMS and a BPD unit on it.
 *
 * It was not filtered out and it was not scored down. It was never fetched.
 * A 48 hour window holds more objects than one read may take, so the even
 * sampler strided across the whole list, and right now is a handful of
 * objects at the very end of thousands. A stride does not care which end it
 * drops.
 */
{
  const urls = Array.from({ length: 4000 }, (_, i) => 'o' + String(i).padStart(4, '0'));
  const newest = urls.slice(-40);
  const r = stream.spread(urls, 2600);
  const got = new Set(r.picked);

  ok('the sampler still respects the cap', r.picked.length <= 2600, 'picked=' + r.picked.length);
  ok('and still says it sampled', r.sampled === true);
  ok('every one of the newest 40 objects survives',
     newest.every(u => got.has(u)), 'missing ' + newest.filter(u => !got.has(u)).length);
  ok('while the old half of the window is still covered',
     r.picked.some(u => u < 'o0500') && r.picked.some(u => u > 'o1500' && u < 'o2500'));

  /* The old behaviour, kept here so the regression is legible rather than
     described. It dropped fourteen of the last forty. */
  const strided = new Set((function (u, c) {
    const st = u.length / c, p = [];
    for (let i = 0; i < c; i++) p.push(u[Math.floor(i * st)]);
    return p;
  })(urls, 2600));
  ok('a plain stride would have dropped some of them, which is the bug',
     !newest.every(u => strided.has(u)));

  /* Nothing changes when everything fits. */
  const small = stream.spread(['a', 'b', 'c'], 10);
  ok('an uncapped window is untouched and unflagged',
     small.picked.length === 3 && small.sampled === false);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
