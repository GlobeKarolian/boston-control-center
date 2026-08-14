// tools/test-kv-compress.js
//
//   node tools/test-kv-compress.js
//
// The store blob is the largest thing this app moves across a metered wire,
// and compression is being added under a live database. These are the checks
// that make that safe: values written before the change must still read back,
// and values written after must survive the chunking path unharmed.

const kv = require('../lib/kv.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '   ' + detail : '')); }
};

const incident = (i) => ({
  id: 'inc-' + i, status: 'active', callType: 'medical', town: 'Boston',
  address: (100 + i) + ' Boylston Street',
  timeline: Array.from({ length: 12 }, (_, j) => ({
    at: '2026-08-14T0' + (j % 10) + ':00:00Z',
    text: 'Engine 7 responding to ' + (100 + i) + ' Boylston Street for a medical, priority one, segment ' + j,
  })),
});

(async () => {
  const small = JSON.stringify({ hello: 'world' });
  const big = JSON.stringify({ incidents: Array.from({ length: 300 }, (_, i) => incident(i)) });
  const huge = JSON.stringify({ incidents: Array.from({ length: 4000 }, (_, i) => incident(i)) });

  await kv.setBig('t:small', small, 60);
  ok('a short value round-trips', await kv.getBig('t:small') === small);

  await kv.setBig('t:big', big, 60);
  ok('a store-sized value round-trips', await kv.getBig('t:big') === big);

  await kv.setBig('t:huge', huge, 60);
  ok('a value past the chunk boundary round-trips', await kv.getBig('t:huge') === huge,
     'len=' + huge.length);

  /* The compatibility case, and the reason this is deployable into a live
     store: a value written by the old code has no prefix and must read back
     unchanged rather than being mistaken for a corrupt compressed value. */
  await kv.set('t:legacy', big, 60);
  ok('a value written before compression still reads', await kv.getBig('t:legacy') === big);

  ok('absent keys are still absent', await kv.getBig('t:nothing:here') === null);

  const zlib = require('zlib');
  const packed = 'gz64:' + zlib.gzipSync(Buffer.from(big), { level: 6 }).toString('base64');
  console.log('\n  store-sized blob: ' + big.length + ' bytes -> ' + packed.length
    + ' (' + (100 - 100 * packed.length / big.length).toFixed(1) + '% off the wire)');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
