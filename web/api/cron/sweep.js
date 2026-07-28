// api/cron/sweep.js
// Time-based housekeeping for the correlation store.
//
// On the Mac, sweep() ran every two seconds inside the worker's flush loop,
// so it happened whether or not traffic was arriving. Here nothing runs
// unless a Mac POSTs, which is exactly backwards: the moment the fleet goes
// quiet is the moment stale incidents most need clearing. A 3am scene that
// nobody transmits about again would otherwise sit on the map as "active"
// until someone happened to speak.
//
// This also re-renders the output keys, so feed health decays to "offline"
// on the dashboard when a Mac sleeps, instead of freezing on its last word.

const { cronAuth, json } = require('../../lib/http');
const store_io = require('../../lib/store-io');

module.exports = async (req, res) => {
  if (!cronAuth(req)) return json(res, { error: 'unauthorized' }, { status: 401 });
  const t0 = Date.now();
  try {
    let before = 0, after = 0;
    // withStore() sweeps and saves on its own. The callback just measures, so
    // the lock hold stays at the same two Redis round trips an ingest costs.
    const { store } = await store_io.withStore(async (s) => {
      before = s.snapshotIncidents().length;
    }, { waitMs: 4000 });
    after = store.snapshotIncidents().length;
    const counts = await store_io.renderOutputs(store, { extractorLabel: 'sweep' });
    return json(res, { ok: true, before, after, archived: before - after, ...counts, ms: Date.now() - t0 });
  } catch (e) {
    // A busy store means ingests are flowing, which means sweep() is already
    // running on every one of them. Skipping this tick costs nothing.
    if (e && e.status === 503) return json(res, { skipped: 'store busy, ingest is sweeping anyway', ms: Date.now() - t0 });
    return json(res, { error: 'sweep failed', detail: String(e.message || e).slice(0, 300) }, { status: 500 });
  }
};
