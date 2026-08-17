// lib/compact.js
//
// Roll a settled Eastern hour of the vault into one object.
//
// WHY. The vault writes one or two transmissions per object, so an hour is
// several hundred objects and a two-day question is fifteen thousand fetches.
// On 17 August "Bar Fight in cambridge" took 14.6 seconds and, since no
// request can fetch that many, silently read only the newest sixteen hours of
// the two days it was asked about. Listing was already made cheap by hour
// bucketing; fetching is what this fixes. One object per hour, and the same
// question is fifty fetches.
//
// WHAT AN HOUR IS. Rows whose `at` falls inside the Eastern (day, hour)
// bucket, read through the same reader everything else uses, so hour pieces
// and the legacy flat day are both covered and nothing here re-invents
// "which objects hold this window". Deduped by row identity, oldest first.
//
// WHEN. An hour is rolled once it has SETTLED: ended at least SETTLE_MS ago,
// long enough for the last ingest of it to have landed. It is rolled AGAIN
// only if pieces for it turn up that were uploaded after the rollup was
// written, which is what a relay coming back from an outage looks like. The
// reader never has to check for that; the compactor owns freshness.
//
// NEVER OVERWRITTEN. A rollup's name ends in the millisecond it was written,
// so a re-roll is a new object and the reader takes the newest per hour. The
// old one is deleted after the new one is safely up. Objects are served from
// a cache that would otherwise hand back a stale one for a year, so writing
// in place was never an option.
//
// The pieces are left where they are. Deleting them would make this cron the
// one thing in the system that can destroy transmissions, and the cost of
// keeping them is a few megabytes of text.

'use strict';

const blob = require('./blob');
const vq = require('./vault-query');
const vr = require('./vault-read');

const SETTLE_MS = 25 * 60 * 1000;         // an hour is rolled this long after it ends
const RECHECK_HOURS = 24;                 // rolled hours this recent are checked for late pieces
const SLACK_MS = 10 * 60 * 1000;          // a piece named for its first row can carry rows a little later
const MAX_ROWS = 20000;                   // a sanity cap on one hour, not a real limit

/* Every Eastern (day, hour) bucket touched between two instants, newest first. */
function bucketsBetween(fromMs, toMs) {
  const seen = new Set();
  const out = [];
  for (let t = fromMs; t <= toMs; t += 15 * 60000) {
    const day = vq.dayString(new Date(t));
    const hh = vr.hourOf(t);
    const key = day + '/' + hh;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ day, hour: hh, key });
  }
  return out.reverse();
}

/* Roll one bucket. Returns { ok, key, rows, objects, bytes, url, why }. */
async function rollHour(day, hh, opts) {
  const o = opts || {};
  const w = vr.hourWindow(day, hh);
  if (!w) return { ok: false, key: day + '/' + hh, why: 'no such hour' };   // the missing 2am in March
  const key = day + '/' + hh;
  const cache = o.cache || new Map();

  /* The pieces, through the ordinary reader with rollups switched off, so a
     re-roll reads the source and not itself. `end - 1` because the bucket is
     half-open and the reader is inclusive. */
  const got = await vr.readWindow(w.start, w.end - 1, {
    slackMs: SLACK_MS, max: MAX_ROWS, rollups: false, cache, evenly: true, concurrency: 48,
  });
  if (!got.ok) return { ok: false, key, why: got.why || 'read failed' };
  if (got.listing && got.listing.truncated) return { ok: false, key, why: 'hour too large to roll whole' };
  if (got.failed) return { ok: false, key, why: got.failed + ' pieces unreadable; not rolling a partial hour' };
  const rows = got.rows;

  const written = o.now || Date.now();
  const path = vr.rollupPath(day, hh, written);
  const body = {
    v: 1, day, hour: hh,
    from: new Date(w.start).toISOString(), to: new Date(w.end).toISOString(),
    writtenAt: new Date(written).toISOString(),
    count: rows.length,
    pieces: (got.listing && got.listing.found) || 0,
    tx: rows,
  };
  const put = await blob.putJSON(path, body, { timeoutMs: 20000 });
  if (!put.ok) return { ok: false, key, why: put.why || 'put failed' };

  /* Retire what this supersedes, only now that the new one is up. */
  let retired = 0;
  if (o.supersedes && o.supersedes.length) {
    const d = await blob.del(o.supersedes);
    retired = d.deleted || 0;
  }
  return { ok: true, key, rows: rows.length, objects: (got.listing && got.listing.found) || 0,
           bytes: put.bytes || 0, url: put.url, retired };
}

/* One run: roll what is due, newest first, until the budget is spent.
 *
 *   opts.now         the clock, for tests
 *   opts.lookbackMs  how far back to look for un-rolled hours (default 8 days)
 *   opts.budgetMs    wall time to spend (default 80s)
 *   opts.maxHours    hard cap on hours rolled per run
 */
async function run(opts) {
  const o = opts || {};
  const now = o.now || Date.now();
  const t0 = Date.now();
  const budget = o.budgetMs || 80000;
  const lookback = o.lookbackMs || 8 * 86400000;
  const maxHours = o.maxHours || 40;
  const cache = new Map();

  if (!blob.enabled()) return { ok: false, why: blob.reason(), rolled: [] };

  const settledBefore = now - SETTLE_MS;
  const all = bucketsBetween(now - lookback, now);
  const days = [...new Set(all.map(b => b.day))];
  const have = await vr.rollupsFor(days, cache);

  /* Due: settled and not yet rolled. Newest first, so the hours a shift
     briefing or a two-day search is about to ask for are done before the
     archaeology. */
  const due = [];
  for (const b of all) {
    const w = vr.hourWindow(b.day, b.hour);
    if (!w) continue;
    if (w.end > settledBefore) continue;
    if (have.has(b.key)) continue;
    due.push({ ...b, w, supersedes: [] });
  }

  /* Re-roll: a recent rolled hour whose folder holds a piece uploaded after
     the rollup was written. Only the hour folders are checked, never a legacy
     flat day: nothing writes flat any more, so those cannot grow. */
  const rechecked = [];
  for (const b of all) {
    const ru = have.get(b.key);
    if (!ru) continue;
    const w = vr.hourWindow(b.day, b.hour);
    if (!w || w.end < now - RECHECK_HOURS * 3600000) continue;
    const r = await vr.cachedList(cache, vr.prefixFor(w.start), { max: 8000, keepNewest: true });
    let late = 0;
    for (const p of ((r && r.blobs) || [])) {
      const up = p.uploadedAt ? +new Date(p.uploadedAt) : 0;
      if (up && up > ru.written + 1000) late++;
    }
    rechecked.push(b.key);
    if (late) due.unshift({ ...b, w, supersedes: [ru.url], late });
    if (Date.now() - t0 > budget * 0.25) break;     // the recheck must not eat the run
  }

  const rolled = [], failed = [];
  for (const b of due) {
    if (rolled.length >= maxHours) break;
    if (Date.now() - t0 > budget) break;
    const r = await rollHour(b.day, b.hour, { cache, now, supersedes: b.supersedes });
    if (r.ok) rolled.push({ key: r.key, rows: r.rows, objects: r.objects, bytes: r.bytes, retired: r.retired, late: b.late || 0 });
    else failed.push({ key: r.key, why: r.why });
  }
  return {
    ok: true, now: new Date(now).toISOString(),
    due: due.length, rolled, failed, rechecked: rechecked.length,
    remaining: Math.max(0, due.length - rolled.length - failed.length),
    ms: Date.now() - t0,
  };
}

module.exports = { run, rollHour, bucketsBetween, SETTLE_MS, RECHECK_HOURS, SLACK_MS };
