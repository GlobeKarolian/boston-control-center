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
const blob = require('../../lib/blob');

/* Audio retention rides this cron rather than owning one, because a schedule
   in vercel.json is configuration in a second place and the sweep is already
   the tick that exists whether or not traffic does. Gated to one hour of the
   day: deleting week-old clips is daily work, and running it every five
   minutes would spend list operations discovering an empty window 287 times.
   Module state means a redeploy inside the hour can run it twice, and the
   second pass finds nothing, which is the cheap kind of wrong. */
let blobSweptDay = '';
function blobDue() {
  const now = new Date();
  if (now.getUTCHours() !== 8) return false;      // 4am ET, radio's quietest hour
  const day = now.toISOString().slice(0, 10);
  if (blobSweptDay === day) return false;
  blobSweptDay = day;
  return true;
}

module.exports = async (req, res) => {
  if (!cronAuth(req)) return json(res, { error: 'unauthorized' }, { status: 401 });
  const t0 = Date.now();
  try {
    let before = 0, after = 0;
    // withStore() sweeps and saves on its own. The callback just measures, so
    // the lock hold stays at the same two Redis round trips an ingest costs.
    const { store, archived } = await store_io.withStore(async (s) => {
      before = s.snapshotIncidents().length;
    }, { waitMs: 4000 });
    after = store.snapshotIncidents().length;

    /* withStore() archives what it retired, on every path that touches the
       store rather than only here. This used to be the only drain, and it was
       the wrong one: withStore sweeps on every ingest, at thirty to seventy a
       minute, and the store is rebuilt from Redis per request, so almost every
       retirement happened on an ingest and went out with the process. This
       route then found nothing and reported archiving zero, which read as "no
       scenes retired" rather than "the archive is not running". */

    const counts = await store_io.renderOutputs(store, { extractorLabel: 'sweep' });

    /* Fire and account, never block: the store sweep above is the work this
       route owes the board, and a slow Blob listing must not make it late.
       The result lands in the response for whoever reads cron logs, and a
       failure is a why string, not a thrown error, per blob.js's contract. */
    let clips;
    if (blob.enabled() && blobDue()) clips = await blob.sweep();

    /* `retired` is how many scenes left the board; `archived` is how many of
       them reached the vault. They were the same number under one name, which
       hid the case that matters: scenes retiring and none of them being
       written. */
    return json(res, {
      ok: true, before, after,
      retired: before - after,
      archived: (archived && archived.ok) || 0,
      archiveFails: (archived && archived.failed) || 0,
      ...counts, ...(clips ? { clips } : {}), ms: Date.now() - t0,
    });
  } catch (e) {
    // A busy store means ingests are flowing, which means sweep() is already
    // running on every one of them. Skipping this tick costs nothing.
    if (e && e.status === 503) return json(res, { skipped: 'store busy, ingest is sweeping anyway', ms: Date.now() - t0 });
    return json(res, { error: 'sweep failed', detail: String(e.message || e).slice(0, 300) }, { status: 500 });
  }
};
