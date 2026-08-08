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
  outStops: 'bcc:out:stops',       // stops and field contacts, own surface
  outStopsN: 'bcc:out:stopsn',     // just the two counts, for the tab badge
  seen: m => 'bcc:seen:' + m,      // dedupe, one key per machine+seq
};

const OUT_TTL = 6 * 3600;          // outputs are regenerated constantly; this
                                   // is a floor so a dead fleet self-clears

/* How far back the stops log reads. Twelve hours so someone coming in at six
   in the morning still sees the whole overnight, which is the shift where the
   stops actually happen. Retention in the tracker is separate and longer. */
const STOPS_WINDOW_MS = 12 * 3600 * 1000;

/* The street index, if it has been deployed. The stop tracker uses it to
   settle one specific ambiguity: surnames and street names are the same words
   in a city this old, so "out with a vehicle on Bowdoin" has to read as a
   place and "operator is Michael Delgado" has to read as a person, and
   Delgado, Sullivan and Warren are all roads here too.

   Loaded in a try because web/lib/streets.js lands in a later deploy than this
   file. Without it the tracker falls back to keeping any name a transmission
   introduced with a name cue, which is the same answer nine times in ten and
   the wrong one on a spelled street name. Better than refusing to boot. */
let isStreet = () => false;
let STREET_COUNT = 0;
try {
  const S = require('./streets');
  if (S && typeof S.correct === 'function') {
    STREET_COUNT = Number(S.count) || 0;
    /* correct(), not knows(). knows() is documented in streets.js as a cheap
       permissive gate to run before spending a network call on a street that
       may not exist in this town, so it is built to say yes on a maybe: one
       wasted lookup is the whole cost of a false positive there. Used as a
       veto it deletes people. Measured against twenty names of the kind a
       records return really reads back, knows() called eleven of them streets,
       including Delgado, Warren, Russo, Walsh, Mendez and Santos, all of which
       are roads here as well as surnames. correct() has to actually resolve a
       street before it answers, and it called none of them streets while still
       catching all sixteen roads tested.

       An exact core match always vetoes. A fuzzy one only vetoes a single
       token, because a one word run is how a spelled street arrives, JETTE off
       the air, and a two word run at this point is nearly always a person. */
    isStreet = t => {
      const v = String(t || '').trim();
      if (!v) return false;
      const oneWord = !/\s/.test(v);
      for (const town of ['Boston', 'Cambridge']) {
        try {
          const c = S.correct(v, town);
          if (c && (c.exact || oneWord)) return true;
        } catch (e) { /* index unhappy about this town, try the other */ }
      }
      return false;
    };
  }
} catch (e) { /* not deployed yet */ }

/* How long a stop record lives, in days, or 0 for forever.

   Scanner traffic is public and the Globe has recorded what it carries for a
   century, so the default is to keep it and let the standards desk and the
   lawyers decide otherwise. This exists so that decision is one number in one
   file rather than a rewrite. */
const RETENTION_DAYS = Number(process.env.BCC_RETENTION_DAYS || 0) || 0;

// The store module is stateful per process, so build a fresh one for every
// load rather than reusing a module-level instance. A warm Vercel container
// serving two requests must not let them see each other's half-applied state.
function newStore() {
  // createStore(geocode, extractFn, opt). The first two are pre-computed and
  // passed in on each ingest() call, so these throw rather than silently
  // making a network call from inside the mutex, which is the one thing this
  // design forbids.
  return createStore(
    async () => { throw new Error('store-io: geocode must be pre-computed'); },
    async () => { throw new Error('store-io: extract must be pre-computed'); },
    { isStreet, retentionDays: RETENTION_DAYS },
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

// A machine that is decommissioned never writes again, so its last record sits
// in the hash forever. The retired node agent left eight of them, and every one
// rendered as a feed chip on the dashboard. Anything silent for a day is gone,
// not merely offline, and is deleted on the way past.
const FORGET_AFTER_MS = 24 * 3600 * 1000;

/* Scanner Relay and the retired node agent name the same things differently:
   label vs src, lastTextAt vs lastSegAt. The dashboard was written against the
   agent's names, so every Scanner Relay chip rendered as "#undefined ... last
   null". Rather than teach each client both vocabularies, every record leaves
   here speaking both. */
function normalizeHealth(rec) {
  const name = rec.label || rec.src || rec.id || 'feed';
  rec.label = name;
  rec.src = rec.src || rec.id || name;
  rec.id = rec.id || rec.src;
  rec.lastSegAt = rec.lastSegAt || rec.lastTextAt || null;
  rec.lastTextAt = rec.lastTextAt || rec.lastSegAt || null;
  // feed is a Broadcastify feed number and is genuinely absent for an app-audio
  // or direct-URL source. Null, so a client can tell "none" from "undefined".
  const n = Number(rec.feed);
  rec.feed = Number.isFinite(n) && n > 0 ? n : null;
  if (rec.clips === undefined && rec.transmissions !== undefined) rec.clips = rec.transmissions;
  if (typeof rec.coverage === 'string') rec.coverage = rec.coverage.split(',').map(s => s.trim()).filter(Boolean);
  if (!Array.isArray(rec.coverage)) {
    const sc = typeof rec.scope === 'string' ? rec.scope : '';
    rec.coverage = sc.split(',').map(s => s.trim()).filter(Boolean);
  }
  return rec;
}

async function getHealth() {
  let h = {};
  try { h = await kv.hgetall(K.health); } catch (e) { return []; }
  const now = Date.now();
  const out = [];
  const forget = [];
  for (const field in h) {
    let rec;
    try { rec = JSON.parse(h[field]); } catch (e) { forget.push(field); continue; }
    const age = now - new Date(rec.reportedAt || 0).getTime();
    if (age > FORGET_AFTER_MS) { forget.push(field); continue; }
    if (age > OFFLINE_AFTER_MS) {
      rec.status = 'offline';
      rec.staleSec = Math.round(age / 1000);
    }
    out.push(normalizeHealth(rec));
  }
  if (forget.length) {
    // Fire and forget. A failed prune costs one stale chip, never a request.
    kv.raw([['HDEL', K.health, ...forget]], 5000).catch(() => {});
  }
  out.sort((a, b) => String(a.label).localeCompare(String(b.label)));
  return out;
}

/* The last few transmissions per channel, oldest first, for the extractor.
   A 3-second clip carries no context of its own: "we're on scene" means
   nothing alone and everything after "Engine 7, 40 Boylston". This reads the
   rendered transcript key rather than the store, so it costs one GET and never
   touches the write lock. */
/* Cached per warm instance for a few seconds, because this runs on EVERY
   relay ingest, which is every few seconds forever, and each call was a
   full read of the transcript key out of the store. Context that is five
   seconds stale reads identically to the extractor; the repeat reads were
   a measurable slice of the monthly bandwidth for a store that never had
   a storage problem in its life. */
let RECENT_CACHE = { at: 0, out: null };
async function recentBySource(n = 3) {
  if (RECENT_CACHE.out && (Date.now() - RECENT_CACHE.at) < 5000) return RECENT_CACHE.out;
  const out = {};
  try {
    const raw = await readOut(K.outTranscripts, '[]');
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return out;
    for (const t of list) {                     // newest first
      const s = t && t.source;
      if (!s || !t.text) continue;
      if (!out[s]) out[s] = [];
      if (out[s].length < n) out[s].unshift(String(t.text).slice(0, 220));
    }
  } catch (e) { /* no context is worse extraction, never a failed ingest */ }
  RECENT_CACHE = { at: Date.now(), out };
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

  /* Stops go out on their own key rather than onto the map.

     Boston works hundreds of car stops a night. A pin for each one buries the
     fire and the shooting under a field of routine plate checks, which is the
     opposite of what a situational map is for. The ones that turn into news
     already promote themselves into incidents and arrive on the map that way.
     This key is the log underneath: who is out with whom, where, for how long,
     and how it ended.

     Guarded because the store module that knows how to answer this ships in
     its own deploy. An older incident-store.js next to a newer store-io.js is
     a normal few seconds of a rolling deploy, and it must degrade to an empty
     stops tab rather than to a failed ingest. */
  let stopsOut = { open: [], closed: [], summary: null };
  try {
    if (typeof store.snapshotStops === 'function') stopsOut = store.snapshotStops(Date.now(), STOPS_WINDOW_MS);
  } catch (e) {
    console.error('[store] stops snapshot failed:', String(e.message || e).slice(0, 200));
  }
  stopsOut.generatedAt = new Date().toISOString();
  stopsOut.windowHours = STOPS_WINDOW_MS / 3600000;

  /* The two counts, on their own key, because the number in the Stops tab has
     to stay live while somebody is looking at the map.

     The log itself is a few hundred kilobytes once a night's transmissions are
     attached to it, and these read routes sit behind Basic auth, which Vercel's
     CDN will not cache. So every viewer polling the full log all evening just
     to keep a badge current would pull that down from the origin each time,
     per person, all night. This key is sixty bytes. */
  const stopsN = {
    open: stopsOut.open.length,
    total: (stopsOut.summary && stopsOut.summary.total) || stopsOut.closed.length,
  };

  const pipeline = {
    generatedAt: new Date().toISOString(),
    extractor: extractorLabel || 'cloud',
    feeds: health,
    stats: {
      ...store.snapshotStats(),
      incidents: incs.length,
      active: incs.filter(i => i.status === 'active').length,
      machines: [...new Set(health.map(f => f.machine).filter(Boolean))],
      // Same two integers the badge key carries, so the backend tab can show
      // the tracker working without a second fetch.
      stops: stopsN,
      /* How many streets the geocoder can place without a network call, and 0
         when the gazetteer did not ship. Worth a line here because the failure
         it catches is silent: everything keeps working, corners just quietly
         go back to being an Overpass call that times out, and nothing else on
         this page would say so. healthz stays boring on purpose, so the
         readout lives behind the auth with the rest of the operational state. */
      streetIndex: STREET_COUNT,
    },
    events: store.snapshotEvents(),
  };

  await kv.raw([
    ['SET', K.outIncidents, JSON.stringify(incs), 'EX', OUT_TTL],
    ['SET', K.outTranscripts, JSON.stringify(transcripts), 'EX', OUT_TTL],
    ['SET', K.outPipeline, JSON.stringify(pipeline), 'EX', OUT_TTL],
    ['SET', K.outStops, JSON.stringify(stopsOut), 'EX', OUT_TTL],
    ['SET', K.outStopsN, JSON.stringify(stopsN), 'EX', OUT_TTL],
  ], 20000);
  return { incidents: incs.length, active: pipeline.stats.active, stops: stopsOut.open.length };
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

module.exports = { K, withStore, loadStore, saveStore, claimNew, putHealth, getHealth, recentBySource, renderOutputs, readOut, OFFLINE_AFTER_MS };
