// api/vault-search.js
//
// The newsroom's question, answered out of the archive.
//
//   GET /api/vault-search?q=big fire last night in Back Bay
//
// Reads the vault day folders the question covers, scores every archived
// transmission against it, and returns them grouped into the scenes they
// belonged to, each with its audio. Behind the same password as the board.
//
// The grouping is the part that makes this useful rather than a grep. The
// pipeline already decided which transmissions were the same call, and that
// decision is archived on every record as incidentId. So "the fire" comes
// back as one thing with a beginning and an end, not forty loose lines a
// reporter has to reassemble at 1am.

const { requireRead, json, harden } = require('../lib/http');
const blob = require('../lib/blob');
const vq = require('../lib/vault-query');

/* Enough to answer a night without reading a month. A day of traffic is about
   1,500 objects, so this covers roughly two full days and says so when it
   stops rather than quietly returning half an answer. */
const MAX_OBJECTS = 3500;
const CONCURRENCY = 64;

function daysBetween(from, to) {
  const out = [];
  const step = 86400000;
  for (let t = +from - step; t <= +to + step; t += step) {
    const d = vq.dayString(new Date(t));
    if (d && !out.includes(d)) out.push(d);
  }
  return out;
}

/* Object storage has no query language, so the fetch is the search. Run wide
   rather than deep: these are a few hundred bytes each and the round trip,
   not the payload, is the cost. */
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
      } catch (e) { /* one unreadable object is not a failed search */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));
  return out;
}

/* Loose transmissions back into the calls they belonged to.

   Anything the pipeline could not tie to a scene still comes back, gathered
   under its feed, because "we heard this and never worked out what it was"
   is a real answer and hiding it would make the archive look tidier than the
   night actually was. */
function group(hits) {
  const byInc = new Map();
  for (const { tx, s } of hits) {
    const key = tx.incidentId || ('loose:' + (tx.feed || 'unknown'));
    let g = byInc.get(key);
    if (!g) {
      g = { id: key, loose: !tx.incidentId, feed: tx.feed, town: tx.town || tx.city || null,
            type: tx.callType || null, place: tx.matched || tx.address || tx.street || null,
            from: tx.at, to: tx.at, score: 0, units: new Set(), tx: [] };
      byInc.set(key, g);
    }
    g.tx.push(tx);
    g.score += s;
    if (tx.at < g.from) g.from = tx.at;
    if (tx.at > g.to) g.to = tx.at;
    if (!g.type && tx.callType) g.type = tx.callType;
    if (!g.place && (tx.matched || tx.address)) g.place = tx.matched || tx.address;
    for (const u of (tx.units || [])) g.units.add(u);
  }
  return [...byInc.values()].map(g => ({
    ...g,
    units: [...g.units].slice(0, 12),
    tx: g.tx.sort((a, b) => String(a.at).localeCompare(String(b.at))),
    clips: g.tx.filter(t => t.clip).map(t => ({ u: t.clip, at: t.at })).slice(0, 40),
  })).sort((a, b) => b.score - a.score);
}

module.exports = async (req, res) => {
  harden(res);
  if (!(await requireRead(req, res))) return;

  const t0 = Date.now();
  const q = String((req.query && req.query.q) || '').slice(0, 300);
  if (!q.trim()) return json(res, { ok: false, why: 'ask a question' }, { status: 400 });
  if (!blob.enabled()) return json(res, { ok: false, why: blob.reason() }, { status: 503 });

  const f = vq.parse(q);

  /* Only the days the question touches. This is the whole reason the vault is
     filed by Eastern day: "last night" reads two folders, never the archive. */
  const days = daysBetween(f.from, f.to);
  const urls = [];
  let truncated = false;
  for (const d of days) {
    const r = await blob.listPrefix('vault/' + d + '/tx/', { max: MAX_OBJECTS });
    for (const b of (r.blobs || [])) {
      if (urls.length >= MAX_OBJECTS) { truncated = true; break; }
      urls.push(b.url);
    }
    if (truncated) break;
  }

  const tx = await fetchAll(urls);
  const hits = [];
  for (const t of tx) {
    const s = vq.score(t, f);
    if (s > 0) hits.push({ tx: t, s });
  }
  const groups = group(hits).slice(0, 40);

  return json(res, {
    ok: true,
    q,
    understood: {
      when: f.when,
      from: f.from.toISOString(),
      to: f.to.toISOString(),
      type: f.type, place: f.place, big: f.big, words: f.words,
    },
    scanned: tx.length,
    matched: hits.length,
    calls: groups.length,
    /* Said out loud rather than hidden, because a search that quietly stopped
       reading is a search that lies about what is not there. */
    truncated,
    results: groups,
    ms: Date.now() - t0,
  }, { priv: 0 });
};
