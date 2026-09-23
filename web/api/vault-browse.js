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

  /* Date parses February 30 as March 2. Check the written ISO calendar date
     before accepting that normalization; keep other valid legacy timestamp
     forms working rather than changing the endpoint's input contract. */
  const badCalendar = value => {
    const m = /^(\d{4}-\d{2}-\d{2})(?:T|\s|$)/.exec(String(value || ''));
    if (!m) return false;
    const day = new Date(m[1] + 'T00:00:00Z');
    return !Number.isFinite(+day) || day.toISOString().slice(0, 10) !== m[1];
  };
  if (isNaN(+from) || isNaN(+to) || badCalendar(qq.from) || badCalendar(qq.to)) {
    return json(res, { ok: false, why: 'from and to must be timestamps with valid calendar dates' }, { status: 400 });
  }
  if (+to <= +from) {
    return json(res, { ok: false, why: 'that window ends before it starts' }, { status: 400 });
  }
  if (+to - +from > MAX_WINDOW_MS) {
    return json(res, { ok: false, why: 'browse covers up to six hours at a time; for more, search' }, { status: 400 });
  }

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
  let read;
  try {
    read = await vaultRead.readWindow(+from, +to, { slackMs: BATCH_SLACK_MS, max: MAX_OBJECTS, concurrency: CONCURRENCY });
  } catch (e) {
    return json(res, { ok: false, complete: false, incomplete: true, why: 'could not read the archive',
      errors: [{ stage: 'read', code: 'read_failed', why: 'could not read the archive' }] }, { status: 503 });
  }
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

  /* The object cap keeps the newest end; the response cap then keeps the first
     500 of those rows. Report each span separately so a discarded tail is not
     advertised as playable. Neither span proves there are no interior gaps. */
  const matchedCovered = rows.length
    ? { from: String(rows[0].at), to: String(rows[rows.length - 1].at) }
    : null;
  const tx = rows.slice(0, 500);
  const clipped = rows.length > tx.length;
  const covered = tx.length ? { from: String(tx[0].at), to: String(tx[tx.length - 1].at) } : null;
  const incomplete = !read.ok || !!read.incomplete || truncated || clipped;

  return json(res, {
    ok: read.ok,
    why: read.why || null,
    failed: read.failed || 0,
    errors: read.errors || [],
    feed: feed || null,
    from: from.toISOString(),
    to: to.toISOString(),
    count: rows.length,
    heard,
    truncated,
    covered,
    matchedCovered,
    returned: tx.length,
    tx,
    clipped,
    complete: !incomplete,
    incomplete,
    ms: Date.now() - t0,
  }, { priv: 0, status: !read.ok && !rows.length ? 503 : 200 });
};
