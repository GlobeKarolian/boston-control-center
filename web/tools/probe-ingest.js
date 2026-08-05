// tools/probe-ingest.js
//
// Reproduces the ingest 500 without needing an ingest token, by driving the
// two store calls that every POST goes through: loadStore and renderOutputs.
// Reads Upstash creds out of .env.local and never prints them.
//
//   node tools/probe-ingest.js

const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env.local');
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const i = line.indexOf('=');
  if (i < 1 || line.trim().startsWith('#')) continue;
  const k = line.slice(0, i).trim();
  let v = line.slice(i + 1).trim();
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  if (!process.env[k]) process.env[k] = v;
}
console.log('creds present:', !!process.env.KV_REST_API_URL, !!process.env.KV_REST_API_TOKEN);

const store_io = require('../lib/store-io');

const step = async (label, fn) => {
  const t = Date.now();
  try {
    const out = await fn();
    console.log('  ok   ' + label + '  (' + (Date.now() - t) + 'ms)');
    return out;
  } catch (e) {
    console.log('  FAIL ' + label + '  (' + (Date.now() - t) + 'ms)');
    console.log('       ' + (e && e.message));
    console.log((e && e.stack ? e.stack.split('\n').slice(1, 6).join('\n') : ''));
    throw e;
  }
};

(async () => {
  console.log('\nthe two calls every ingest POST makes');
  const store = await step('loadStore()', () => store_io.loadStore());
  console.log('       store keys: ' + Object.keys(store || {}).join(', ').slice(0, 200));

  const counts = await step('renderOutputs(store)',
    () => store_io.renderOutputs(store, { extractorLabel: 'idle' }));
  console.log('       ' + JSON.stringify(counts));

  console.log('\nthe health write');
  await step('putHealth()', () => store_io.putHealth('probe', [
    { id: 'probe-feed', state: 'live', up: true },
  ]));

  console.log('\nthe dedupe claim');
  const fresh = await step('claimNew() with no items', () => store_io.claimNew('probe', []));
  console.log('       fresh: ' + JSON.stringify(fresh));

  console.log('\nthe context read');
  const prior = await step('recentBySource()', () => store_io.recentBySource());
  console.log('       sources: ' + Object.keys(prior || {}).join(', ').slice(0, 200));

  console.log('\nall clear\n');
  process.exit(0);
})().catch(() => { console.log('\nstopped at the first failure above\n'); process.exit(1); });
