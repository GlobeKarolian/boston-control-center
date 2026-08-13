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
const vq = require('../lib/vault-query');

const MAX_WINDOW_MS = 6 * 3600000;
const MAX_OBJECTS = 3000;
const CONCURRENCY = 64;
const BATCH_SLACK_MS = 30 * 60 * 1000;

function stampOf(path) {
  const base = String(path || '').split('/').pop() || '';
  const m = base.match(/^(\d{10,16})-/);
  if (!m) return null;
  const n = +m[1];
  return Number.isFinite(n) ? n : null;
}

async function fetchAll(urls) {
  const out = [];
  let i = 0;
  async function worker() {
    for (;;) {
      const n = i++;
      if (n >= urls.length) return;
      try {
        const r = await fetch(urls[n]);
        if (!r.ok) continue;
        const j = await r.json();
        if (j && Array.isArray(j.tx)) out.push(...j.tx);
      } catch (e) { /* one unreadable object is not a failed browse */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));
  return out;
}

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

  /* The Eastern day folders the window touches, edges included. */
  const days = [];
  for (let t = +from - 86400000; t <= +to + 86400000; t += 86400000) {
    const d = vq.dayString(new Date(t));
    if (d && !days.includes(d)) days.push(d);
  }

  const lo = +from - BATCH_SLACK_MS;
  const hi = +to + BATCH_SLACK_MS;
  const urls = [];
  let truncated = false;
  for (const d of days) {
    const r = await blob.listPrefix('vault/' + d + '/tx/', { max: MAX_OBJECTS });
    for (const b of (r.blobs || [])) {
      const at = stampOf(b.pathname || b.url);
      if (at !== null && (at < lo || at > hi)) continue;
      if (urls.length >= MAX_OBJECTS) { truncated = true; break; }
      urls.push(b.url);
    }
    if (truncated) break;
  }

  const all = await fetchAll(urls);
  const rows = all
    .filter(t => {
      const at = +new Date(t.at);
      if (!(at >= +from && at <= +to)) return false;
      if (feed && String(t.feed || '').toLowerCase() !== feed) return false;
      return true;
    })
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));

  /* What the archive holds for the window, feed by feed, whether or not it
     was the feed asked for. "Transit had nothing but EMS had nineteen" is the
     answer that redirects a reporter instead of stopping one. */
  const heard = {};
  for (const t of all) {
    const at = +new Date(t.at);
    if (!(at >= +from && at <= +to)) continue;
    heard[t.feed || 'unknown'] = (heard[t.feed || 'unknown'] || 0) + 1;
  }

  return json(res, {
    ok: true,
    feed: feed || null,
    from: from.toISOString(),
    to: to.toISOString(),
    count: rows.length,
    heard,
    truncated,
    tx: rows.slice(0, 500),
    clipped: rows.length > 500,
    ms: Date.now() - t0,
  }, { priv: 0 });
};
