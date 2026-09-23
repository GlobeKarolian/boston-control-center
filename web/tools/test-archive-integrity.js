// tools/test-archive-integrity.js
// Synthetic archive regressions. No credentials, SDK calls or network access.
'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
// Authentication is tested by test/auth.js. This isolates the read handlers
// without granting a real session or letting an accidental fetch leave Node.
global.fetch = async () => { throw new Error('network forbidden in archive integrity tests'); };
Module._load = function (name, parent, main) {
  if (name === '../lib/http') return {
    requireRead: async () => true,
    harden: () => {},
    json: (res, body, opts) => { res.body = body; res.status = (opts && opts.status) || 200; },
  };
  return originalLoad.call(this, name, parent, main);
};
const browse = require('../api/vault-browse');
const audio = require('../api/vault-audio');
Module._load = originalLoad;
const blob = require('../lib/blob');
const vr = require('../lib/vault-read');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const AT = Date.parse('2026-08-17T14:00:00Z');
const iso = ms => new Date(ms).toISOString();
const row = (extra = {}) => ({ at: iso(AT), feed: 'synthetic-radio', text: 'Synthetic dispatch.', ...extra });
const pathFor = (suffix = '1') => vr.prefixFor(AT) + AT + '-' + suffix + '.json';
function store(objects, options = {}) {
  const entries = new Map(objects.map(o => [o.path, o]));
  blob._inject({
    list: async ({ prefix, mode, cursor, limit }) => {
      if (options.list) {
        const response = await options.list(prefix, { mode, cursor, limit });
        if (response) return response;
      }
      const all = [...entries.keys()].filter(p => p.startsWith(prefix) &&
        (mode !== 'folded' || !p.slice(prefix.length).includes('/'))).sort();
      const start = Number(cursor || 0);
      const page = all.slice(start, start + limit);
      const next = start + page.length;
      return { blobs: page.map(pathname => ({ pathname, url: 'https://archive.invalid/' + pathname })),
        hasMore: next < all.length, cursor: String(next) };
    },
  }, 'synthetic-not-a-credential');
  vr._setFetch(async url => {
    const o = entries.get(url.replace('https://archive.invalid/', ''));
    assert.ok(o, 'only fixture objects may be fetched');
    if (o.error) throw new Error(o.error);
    if (o.status) return { ok: false, status: o.status };
    return { ok: true, json: async () => {
      if (o.badJSON) throw new SyntaxError('synthetic invalid JSON');
      return o.body || { tx: o.rows || [] };
    } };
  });
}
const read = (opts = {}) => vr.readWindow(AT - 60000, AT + 60000, { slackMs: 0, ...opts });
async function endpoint(handler, query) {
  const res = {};
  await handler({ query }, res);
  return res;
}

test('row identity retains final characters, clips and source identity', async () => {
  const common = 'x'.repeat(120);
  const rows = [row({ text: common + 'A', clip: 'clip-a', seq: 0, machine: 'one' }),
    row({ text: common + 'B', clip: 'clip-a', seq: 0, machine: 'one' }),
    row({ text: common + 'A', clip: 'clip-b', seq: 0, machine: 'one' }),
    row({ text: common + 'A', clip: 'clip-a', seq: 1, machine: 'one' }),
    row({ text: common + 'A', clip: 'clip-a', seq: 0, machine: 'two' })];
  // Exact retries and a differently ordered JSON serialization are one row.
  store([{ path: pathFor(), rows: [...rows, rows[0], Object.fromEntries(Object.entries(rows[0]).reverse())] }]);
  const result = await read();
  assert.equal(result.rows.length, rows.length, 'distinct recordings must not disappear');
  assert.deepEqual(new Set(result.rows.map(vr.rowKey)), new Set(rows.map(vr.rowKey)));
  assert.notEqual(vr.rowKey(row({ feed: 'a|b', text: 'c' })), vr.rowKey(row({ feed: 'a', text: 'b|c' })),
    'a delimiter in content must not collide');
});

test('objects with the same basename in different paths are both read', async () => {
  store([{ path: pathFor(), rows: [row({ clip: 'bucketed' })] },
    { path: 'vault/2026-08-17/tx/' + AT + '-1.json', rows: [row({ clip: 'legacy' })] }]);
  const result = await read();
  assert.equal(result.listing.urls.length, 2);
  assert.deepEqual(result.rows.map(t => t.clip).sort(), ['bucketed', 'legacy']);
});

test('unreadable objects retain good rows but explicitly fail completeness', async () => {
  store([{ path: pathFor('good'), rows: [row()] },
    { path: pathFor('http'), status: 503 },
    { path: pathFor('network'), error: 'synthetic unavailable' },
    { path: pathFor('json'), badJSON: true },
    { path: pathFor('shape'), body: { tx: 'not-an-array' } }]);
  const result = await read();
  assert.equal(result.failed, 4, 'malformed JSON envelopes are failed reads too');
  assert.equal(result.rows.length, 1);
  assert.equal(result.ok, false);
  assert.equal(result.complete, false);
  assert.equal(result.incomplete, true);
  assert.deepEqual(result.errors.map(e => e.code).sort(), ['fetch_failed', 'http_error', 'invalid_json', 'invalid_object']);
  assert.ok(result.errors.every(e => e.url.startsWith('https://archive.invalid/')));
  assert.ok(result.why);
  store([{ path: pathFor(), rows: [row()] }]);
  const good = await read();
  assert.equal(good.ok, true);
  assert.equal(good.complete, true);
  assert.equal(good.incomplete, false);
  assert.deepEqual(good.errors, []);
});

test('piece and rollup listing failures are incomplete, not empty success', async () => {
  for (const failedPrefix of [vr.prefixFor(AT), vr.rollupPrefix('2026-08-17')]) {
    store([{ path: 'vault/2026-08-17/tx/' + AT + '-good.json', rows: [row()] }], {
      list: prefix => { if (prefix === failedPrefix) throw new Error('synthetic list failure'); },
    });
    const result = await read();
    assert.equal(result.ok, false, failedPrefix);
    assert.equal(result.rows.length, 1, 'readable listings survive another prefix failure');
    assert.equal(result.complete, false);
    assert.equal(result.incomplete, true);
    assert.equal(result.listing.ok, false);
    assert.ok(result.errors.some(e => e.stage === 'list' && e.prefix === failedPrefix));
  }
  blob._inject(null, '');
  const disabled = await read();
  assert.equal(disabled.ok, false);
  assert.equal(disabled.complete, false);
  assert.equal(disabled.incomplete, true);
  assert.ok(disabled.errors.length);
});

test('rollup selection pages beyond the first thousand revisions', async () => {
  const objects = Array.from({ length: 1001 }, (_, i) => ({
    path: vr.rollupPath('2026-08-17', '10', AT + i), rows: [row({ text: 'revision ' + i })],
  }));
  store(objects);
  const result = await read();
  assert.equal(result.rows[0].text, 'revision 1000');
  assert.equal(result.complete, true);
});

test('malformed rows and count mismatches cannot certify completeness', async () => {
  store([{ path: pathFor('invalid'), rows: [row(), null, {}, row({ at: null }), row({ at: 'not-a-time' })] },
    { path: pathFor('count'), body: { count: 2, tx: [row({ text: 'retained even when count is wrong' })] } }]);
  const result = await read();
  assert.equal(result.ok, false);
  assert.equal(result.incomplete, true);
  assert.equal(result.rows.length, 2);
  assert.equal(result.failed, 2, 'count failed objects, not invalid row count');
  assert.ok(result.errors.some(e => e.code === 'invalid_rows' && e.invalidRows === 4));
  assert.ok(result.errors.some(e => e.code === 'count_mismatch'));
});

test('chronology uses instants and deduped excludes out-of-window rows', async () => {
  const earlier = row({ at: '2026-08-17T09:59:30-04:00', text: 'first' });
  const later = row({ at: '2026-08-17T09:00:30-05:00', text: 'second' });
  store([{ path: pathFor(), rows: [later, earlier, earlier, row({ at: iso(AT - 120000) })] }]);
  const result = await read();
  assert.deepEqual(result.rows.map(t => t.text), ['first', 'second']);
  assert.equal(result.deduped, 1);
  assert.equal(result.outOfWindow, 1);
});

test('browse coverage describes delivered rows, not the discarded tail', async () => {
  const rows = Array.from({ length: 501 }, (_, i) => row({ at: iso(AT + i * 1000), text: 'row ' + i }));
  store([{ path: pathFor(), rows }]);
  const result = await endpoint(browse, { from: iso(AT), to: iso(AT + 600000) });
  assert.equal(result.status, 200);
  assert.equal(result.body.count, 501, 'existing count remains the matched count');
  assert.equal(result.body.tx.length, 500);
  assert.equal(result.body.clipped, true);
  assert.deepEqual(result.body.covered, { from: rows[0].at, to: rows[499].at });
  assert.deepEqual(result.body.matchedCovered, { from: rows[0].at, to: rows[500].at });
  assert.equal(result.body.returned, 500);
  assert.equal(result.body.incomplete, true);
  assert.equal(result.body.complete, false);
});

test('browse and audio propagate partial and total archive failures', async () => {
  for (const [handler, query, countField] of [
    [browse, { from: iso(AT - 60000), to: iso(AT + 60000) }, 'count'],
    [audio, { day: '2026-08-17' }, 'clips'],
  ]) {
    store([{ path: pathFor('good'), rows: [row({ clip: 'synthetic-clip' })] },
      { path: pathFor('bad'), status: 404 }]);
    const partial = await endpoint(handler, query);
    assert.equal(partial.body.ok, false);
    assert.equal(partial.body.complete, false);
    assert.equal(partial.body.incomplete, true);
    assert.equal(partial.body.failed, 1);
    assert.equal(partial.body[countField], 1, 'partial rows remain available');
    assert.ok(partial.body.errors.some(e => e.status === 404));
    assert.ok(partial.body.why);
    store([{ path: pathFor('bad'), status: 503 }]);
    const failed = await endpoint(handler, query);
    assert.equal(failed.status, 503);
    assert.equal(failed.body.ok, false);
    assert.equal(failed.body.incomplete, true);
    blob._inject(null, '');
    const disabled = await endpoint(handler, query);
    assert.equal(disabled.status, 503);
    assert.equal(disabled.body.complete, false);
    assert.equal(disabled.body.incomplete, true);
    assert.ok(disabled.body.errors.length);
    store([]);
    const empty = await endpoint(handler, query);
    assert.equal(empty.body.ok, true);
    assert.equal(empty.body.complete, true);
    assert.equal(empty.body.incomplete, false);
  }
});

test('audio days follow Eastern midnight, including 23 and 25 hour days', async () => {
  for (const [day, start, end] of [
    ['2026-01-17', '2026-01-17T05:00:00Z', '2026-01-18T05:00:00Z'],
    ['2026-03-08', '2026-03-08T05:00:00Z', '2026-03-09T04:00:00Z'],
    ['2026-11-01', '2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z'],
    ['2026-08-17', '2026-08-17T04:00:00Z', '2026-08-18T04:00:00Z'],
  ]) {
    const lo = Date.parse(start), hi = Date.parse(end);
    const stamps = [lo - 1, lo, hi - 1, hi];
    if (day === '2026-11-01') stamps.push(Date.parse('2026-11-01T05:30:00Z'), Date.parse('2026-11-01T06:30:00Z'));
    store(stamps.map((at, i) => ({ path: vr.prefixFor(at) + at + '-' + i + '.json',
      rows: [row({ at: iso(at), clip: 'clip-' + i })] })));
    const result = await endpoint(audio, { day });
    const clips = result.body.feeds.flatMap(f => f.clips);
    const expected = stamps.filter(at => at >= lo && at < hi).sort((a, b) => a - b).map(iso);
    assert.deepEqual(clips.map(c => c.at), expected, day);
    assert.equal(result.body.from, iso(lo));
    assert.equal(result.body.to, iso(hi));
    assert.equal(result.body.toExclusive, true);
    assert.equal(result.body.complete, true);
  }
});

test('audio rejects impossible calendar dates instead of normalizing them', async () => {
  store([]);
  for (const day of ['2026-02-29', '2026-02-30', '2026-04-31', '2026-13-01', '2026-01-00']) {
    const result = await endpoint(audio, { day });
    assert.equal(result.status, 400, day);
    assert.equal(result.body.ok, false);
  }
  const leap = await endpoint(audio, { day: '2024-02-29' });
  assert.equal(leap.status, 200);
});

test('audio preserves full transcript and absolute clip chronology', async () => {
  const text = 'x'.repeat(350) + ' final correction';
  store([{ path: pathFor(), rows: [
    row({ at: '2026-08-17T09:59:30-04:00', clip: 'first', text }),
    row({ at: '2026-08-17T09:00:30-05:00', clip: 'second' }),
  ] }]);
  const result = await endpoint(audio, { day: '2026-08-17' });
  assert.deepEqual(result.body.feeds[0].clips.map(c => c.clip), ['first', 'second']);
  assert.equal(result.body.feeds[0].clips[0].text, text);
});

test('hitting a cap exactly is complete; dropping objects is incomplete', async () => {
  store([{ path: pathFor('a'), rows: [row({ clip: 'a' })] },
    { path: pathFor('b'), rows: [row({ clip: 'b' })] }]);
  const exact = await read({ max: 2 });
  assert.equal(exact.complete, true);
  assert.equal(exact.truncated, false);
  const clipped = await read({ max: 1 });
  assert.equal(clipped.ok, true, 'a bounded read is not an upstream failure');
  assert.equal(clipped.rows.length, 1);
  assert.equal(clipped.truncated, true);
  assert.equal(clipped.complete, false);
  assert.equal(clipped.incomplete, true);
});

test('unexpected archive exceptions have explicit incomplete endpoint metadata', async () => {
  const saved = vr.readWindow;
  vr.readWindow = async () => { throw new Error('synthetic unexpected reader failure'); };
  try {
    for (const [handler, query] of [[browse, { from: iso(AT), to: iso(AT + 60000) }],
      [audio, { day: '2026-08-17' }]]) {
      const result = await endpoint(handler, query);
      assert.equal(result.status, 503);
      assert.equal(result.body.ok, false);
      assert.equal(result.body.complete, false);
      assert.equal(result.body.incomplete, true);
      assert.ok(result.body.errors.some(e => e.code === 'read_failed'));
    }
  } finally { vr.readWindow = saved; }
});

test('listing truncation propagates through audio metadata', async () => {
  store([{ path: pathFor(), rows: [row({ clip: 'synthetic' })] }]);
  const original = blob.listPrefix;
  blob.listPrefix = async (prefix, opts) => {
    const result = await original(prefix, opts);
    return prefix === vr.prefixFor(AT) ? { ...result, truncated: true } : result;
  };
  try {
    const result = await endpoint(audio, { day: '2026-08-17' });
    assert.equal(result.body.clips, 1);
    assert.equal(result.body.truncated, true);
    assert.equal(result.body.complete, false);
    assert.equal(result.body.incomplete, true);
    assert.ok(result.body.errors.some(e => e.code === 'listing_truncated'));
  } finally { blob.listPrefix = original; }
});

test('failed rollup bodies expose the missing hour rather than complete silence', async () => {
  store([{ path: vr.rollupPath('2026-08-17', '10', AT), status: 404 }]);
  const result = await read();
  assert.equal(result.rows.length, 0);
  assert.equal(result.listing.rollups, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.incomplete, true);
  assert.equal(result.ok, false);
  assert.ok(result.errors[0].url.includes('/hour/10-'));
});

test('browse rejects impossible ISO calendar dates without normalizing the request', async () => {
  store([]);
  const result = await endpoint(browse, { from: '2026-02-30T14:00:00Z', to: '2026-02-30T15:00:00Z' });
  assert.equal(result.status, 400);
  assert.equal(result.body.ok, false);
});

async function main() {
  let passed = 0, failed = 0;
  for (const t of tests) {
    try { await t.fn(); passed++; console.log('PASS ' + t.name); }
    catch (e) { failed++; console.error('FAIL ' + t.name + '\n' + e.stack); }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
