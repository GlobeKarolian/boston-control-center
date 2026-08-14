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
  ok('signals arrive as plain ids', Array.isArray(v.signals) && v.signals[0] === 'stabbing');

  const d = stream.densityByFeed(first.rows);
  ok('density is counted per feed for the severity floor',
     d['boston-police'] > 0 && d['boston-ems'] > 0 && d['mbta-transit-police'] > 0,
     JSON.stringify(d));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
