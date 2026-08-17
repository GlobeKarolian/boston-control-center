// api/vault-browse.js
//
// A feed and a stretch of time, played back in order. No words involved.
//
//   GET /api/vault-browse?feed=mbta-transit-police&from=2026-08-12T21:15:00Z&to=2026-08-12T21:45:00Z
//   GET /api/vault-browse?from=...&to=...          every feed, interleaved
//
// This exists because search depends on transcription, and transcription of
// vocoded trunked radio misses proper nouns exactly when they matter. The
// South Station stabbing was in the archive the whole time, transcribed as a
// disorderly party, and the only door in was a text search that no honest
// spelling of the question could get through. A reporter who knows roughly
// when and roughly which agency should not need the radio to have said the
// words. "Transit police, Wednesday, quarter past five to quarter to six" is
// a complete question and the archive can answer it exactly.
//
// The window is capped at six hours because this reads objects, not an index,
// and a reporter asking for more than six hours is asking a search question
// wearing browse clothes. The error says so rather than half-answering.

const { requireRead, json, harden } = require('../lib/http');
const blob = require('../lib/blob');
const vaultRead = require('../lib/vault-read');

const MAX_WINDOW_MS = 6 * 3600000;
/* Six hours of a busy night. Raised from 3,000 when this file stopped
   building its own object list: the old loop capped the LISTING at 3,000,
   and because Vercel Blob returns a folder oldest-first that cap was spent
   somewhere around 2am, so browsing any evening window on a busy day came
   back empty. */
const MAX_OBJECTS = 9000;
const CONCURRENCY = 64;
const BATCH_SLACK_MS = 30 * 60 * 1000;

module.exports = async (req, res) => {
  harden(res);
  if (!(await requireRead(req, res))) return;

  const t0 = Date.now();
  const qq = req.query || {};
  const feed = String(qq.feed || '').trim().toLowerCase();
  const from = new Date(String(qq.from || ''));
  const to = new Date(String(qq.to || ''));

  if (isNaN(+from) || isNaN(+to)) {
    return json(res, { ok: false, why: 'from and to must be timestamps' }, { status: 400 });
  }
  if (+to <= +from) {
    return json(res, { ok: false, why: 'that window ends before it starts' }, { status: 400 });
  }
  if (+to - +from > MAX_WINDOW_MS) {
    return json(res, { ok: false, why: 'browse covers up to six hours at a time; for more, search' }, { status: 400 });
  }
  if (!blob.enabled()) return json(res, { ok: false, why: blob.reason() }, { status: 503 });

  /* WHICH OBJECTS COVER THE WINDOW.

     This file used to carry its own copy of "list the day folder and filter by
     the stamp in the filename", which made three copies of that idea in the
     repo, all with the same defect: a cap applied to a listing Vercel Blob
     returns OLDEST FIRST. Here the cap was 3,000 objects against a day that
     holds tens of thousands, so the listing was spent around 2am and browsing
     any evening window came back empty while reporting success.

     lib/vault-read.js is the one implementation. It lists the hour folders the
     window touches rather than the whole day, runs them concurrently, and
     returns newest first so the cap drops the oldest edge instead of the
     newest. */
  const read = await vaultRead.readWindow(+from, +to, { slackMs: BATCH_SLACK_MS, max: MAX_OBJECTS, concurrency: CONCURRENCY });
  const got = read.listing || {};
  const truncated = !!got.truncated;

  const all = read.rows;                          // in window, deduped, oldest first
  const rows = feed ? all.filter(t => String(t.feed || '').toLowerCase() === feed) : all;

  /* What the archive holds for the window, feed by feed, whether or not it
     was the feed asked for. "Transit had nothing but EMS had nineteen" is the
     answer that redirects a reporter instead of stopping one. */
  const heard = {};
  for (const t of all) {
    const at = +new Date(t.at);
    if (!(at >= +from && at <= +to)) continue;
    heard[t.feed || 'unknown'] = (heard[t.feed || 'unknown'] || 0) + 1;
  }

  /* What was actually read, which is not always what was asked for. A window
     too busy to fetch whole keeps its newest end, so saying the span that came
     back turns a short playback into something a reporter can reason about
     instead of a silent hole. */
  const covered = rows.length
    ? { from: String(rows[0].at), to: String(rows[rows.length - 1].at) }
    : null;

  return json(res, {
    ok: true,
    feed: feed || null,
    from: from.toISOString(),
    to: to.toISOString(),
    count: rows.length,
    heard,
    truncated,
    covered,
    tx: rows.slice(0, 500),
    clipped: rows.length > 500,
    ms: Date.now() - t0,
  }, { priv: 0 });
};
