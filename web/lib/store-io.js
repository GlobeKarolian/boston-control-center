// lib/store-io.js
// Everything that reads or writes the correlation store lives here.
//
// The store is one JSON blob in Redis. That is deliberate: the incidents,
// the unit->incident claims, the transcript ring and the event log all have
// to change together or the correlation logic sees a half-applied world.
// Splitting them across keys would buy nothing and would need a transaction
// to put back together.
//
// Concurrency: 2-3 Macs POST at once, and every POST is a read-modify-write.
// The mutex wraps ONLY load -> apply -> save, which is two Redis round trips.
// Extraction and geocoding, the two calls that actually take time, happen
// before withStore() is ever called. At a realistic 30-70 POSTs a minute that
// is single-digit-percent lock utilisation.

const kv = require('./kv');
const { createStore } = require('./incident-store');

const K = {
  store: 'bcc:store',
  lock: 'bcc:lock:store',
  health: 'bcc:health',            // hash: machine|src -> JSON health record
  outIncidents: 'bcc:out:incidents',
  outTranscripts: 'bcc:out:transcripts',
  outPipeline: 'bcc:out:pipeline',
  outSituations: 'bcc:out:situations',
  seen: m => 'bcc:seen:' + m,      // dedupe, one key per machine+seq
};

const OUT_TTL = 6 * 3600;          // outputs are regenerated constantly; this
                                   // is a floor so a dead fleet self-clears

// The store module is stateful per process, so build a fresh one for every
// load rather than reusing a module-level instance. A warm Vercel container
// serving two requests must not let them see each other's half-applied state.
function newStore() {
  // createStore(geocode, extractFn). Both are pre-computed and passed in on
  // each ingest() call, so these throw rather than silently making a network
  // call from inside the mutex, which is the one thing this design forbids.
  return createStore(
    async () => { throw new Error('store-io: geocode must be pre-computed'); },
    async () => { throw new Error('store-io: extract must be pre-computed'); },
  );
}

async function loadStore() {
  const store = newStore();
  try {
    const raw = await kv.getBig(K.store);
    if (raw) store.hydrate(JSON.parse(raw));
  } catch (e) {
    // A corrupt or half-written blob must not wedge ingestion forever. Start
    // clean and say so; the map repopulates within a minute of live traffic.
    console.error('[store] could not hydrate, starting empty:', String(e.message || e).slice(0, 200));
  }
  return store;
}

async function saveStore(store) {
  await kv.setBig(K.store, JSON.stringify(store.dump()), 24 * 3600);
}

// Run fn(store) under the store mutex. fn must be fast and must not make
// network calls other than to Redis.
async function withStore(fn, { ttlMs = 15000, waitMs = 8000 } = {}) {
  const token = await kv.lock(K.lock, ttlMs, waitMs);
  if (!token) {
    const e = new Error('store busy');
    e.status = 503;
    throw e;
  }
  try {
    const store = await loadStore();
    const result = await fn(store);
    store.sweep();
    await saveStore(store);
    return { store, result };
  } finally {
    await kv.unlock(K.lock, token);
  }
}

// ------------------------------------------------------------------ dedupe

// The Mac agent retries whole batches, so the same {machine, seq} can arrive
// twice. Claim each one with SET NX; anything already claimed is a retry of
// something already applied and is dropped.
async function claimNew(machine, items) {
  if (!items.length) return items;
  const withSeq = items.filter(i => i && i.seq !== undefined && i.seq !== null);
  if (!withSeq.length) return items;               // no seq, cannot dedupe, let it through
  const cmds = withSeq.map(i => ['SET', K.seen(machine) + ':' + i.seq, '1', 'NX', 'EX', 3600]);
  let res;
  try { res = await kv.raw(cmds, 10000); }
  catch (e) { return items; }                      // dedupe is an optimisation, never a gate
  const dropped = new Set();
  withSeq.forEach((it, i) => { if (res[i] !== 'OK') dropped.add(it); });
  return items.filter(i => !dropped.has(i));
}

// ------------------------------------------------------------------ health

async function putHealth(machine, records) {
  if (!Array.isArray(records) || !records.length) return;
  const at = new Date().toISOString();
  const pairs = {};
  for (const r of records) {
    if (!r || !r.id) continue;
    pairs[machine + '|' + r.id] = JSON.stringify({ ...r, machine, reportedAt: at });
  }
  if (Object.keys(pairs).length) await kv.hset(K.health, pairs);
}

// A Mac that goes to sleep stops POSTing. Its last health record still says
// "live", which would leave a dead feed looking healthy on the dashboard
// forever. Anything not heard from recently is relabelled here, at read time,
// so the truth does not depend on the dead machine writing one last update.
const OFFLINE_AFTER_MS = 120000;

async function getHealth() {
  let h = {};
  try { h = await kv.hgetall(K.health); } catch (e) { return []; }
  const now = Date.now();
  const out = [];
  for (const field in h) {
    let rec;
    try { rec = JSON.parse(h[field]); } catch (e) { continue; }
    const age = now - new Date(rec.reportedAt || 0).getTime();
    if (age > OFFLINE_AFTER_MS) {
      rec.status = 'offline';
      rec.staleSec = Math.round(age / 1000);
    }
    out.push(rec);
  }
  out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return out;
}

// ------------------------------------------------------------------ render

// Reads must never pull the whole store. The dashboard polls four endpoints
// on a few-second loop across a newsroom, and hydrating the full blob per
// poll would run into gigabytes of Redis egress a day. Instead each write
// leaves behind exactly what the browser asks for, and the CDN caches that.
async function renderOutputs(store, { extractorLabel } = {}) {
  const incs = store.snapshotIncidents();
  const transcripts = store.snapshotTranscripts().slice(0, 80);
  const health = await getHealth();
  const pipeline = {
    generatedAt: new Date().toISOString(),
    extractor: extractorLabel || 'cloud',
    feeds: health,
    stats: {
      ...store.snapshotStats(),
      incidents: incs.length,
      active: incs.filter(i => i.status === 'active').length,
      machines: [...new Set(health.map(f => f.machine).filter(Boolean))],
    },
    events: store.snapshotEvents(),
  };
  await kv.raw([
    ['SET', K.outIncidents, JSON.stringify(incs), 'EX', OUT_TTL],
    ['SET', K.outTranscripts, JSON.stringify(transcripts), 'EX', OUT_TTL],
    ['SET', K.outPipeline, JSON.stringify(pipeline), 'EX', OUT_TTL],
  ], 20000);
  return { incidents: incs.length, active: pipeline.stats.active };
}

// Read side. Returns the raw JSON string so a route can hand it straight to
// the response without a parse/stringify round trip.
// getBig, not get. Today every writer here uses a plain SET and the values are
// small, so the two are identical. getBig costs one string comparison and
// removes the trap: the day a writer outgrows the 400 KB chunk size and moves
// to setBig, a get() reader would silently serve the sentinel string to the
// browser as if it were the payload. The activity layer already writes that
// way, so the trap is not hypothetical.
async function readOut(key, fallback = '[]') {
  try {
    const v = await kv.getBig(key);
    return (v === null || v === undefined || v === '') ? fallback : v;
  } catch (e) { return fallback; }
}

module.exports = { K, withStore, loadStore, saveStore, claimNew, putHealth, getHealth, renderOutputs, readOut, OFFLINE_AFTER_MS };
