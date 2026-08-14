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
const MAX_OBJECTS = 6000;
const CONCURRENCY = 64;

/* A batch is named for the first transmission in it, so the last one can sit a
   little after that stamp. The window is widened before filtering by filename
   and every transmission is still checked exactly by score(), so this only
   ever skips objects that could not have contained an answer. */
const BATCH_SLACK_MS = 30 * 60 * 1000;

function daysBetween(from, to) {
  const out = [];
  const step = 86400000;
  for (let t = +from - step; t <= +to + step; t += step) {
    const d = vq.dayString(new Date(t));
    if (d && !out.includes(d)) out.push(d);
  }
  return out;
}

/* The epoch the archive wrote into a batch's filename: vault/DAY/tx/<ms>-<n>.json,
   possibly with a random suffix before the extension. Anything unparseable is
   kept rather than dropped, because a filename this code does not recognise is
   not evidence that the night is not in there. */
function stampOf(path) {
  const base = String(path || '').split('/').pop() || '';
  const m = base.match(/^(\d{10,16})-/);
  if (!m) return null;
  const n = +m[1];
  return Number.isFinite(n) ? n : null;
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
/* A quarter hour of quiet ends a burst. Loose matches used to pile into one
   card per feed, which put a 6am domestic and a 1pm homicide scene in the
   same "call" and buried the homicide in the middle where nobody scrolls.
   Now a loose match joins the previous one only if it is the same feed
   within fifteen minutes, which is roughly the shape of one scene's radio. */
const BURST_MS = 15 * 60 * 1000;

function group(hits) {
  hits = [...hits].sort((a, b) => String(a.tx.at).localeCompare(String(b.tx.at)));
  const lastLoose = new Map();
  for (const h of hits) {
    if (h.key) continue;                       // scene context: stays with its anchor
    if (h.tx.incidentId) { h.key = h.tx.incidentId; continue; }
    const feed = h.tx.feed || 'unknown';
    const at = +new Date(h.tx.at);
    const prev = lastLoose.get(feed);
    if (prev && at - prev.at <= BURST_MS) { h.key = prev.key; }
    else { h.key = 'loose:' + feed + ':' + h.tx.at; }
    lastLoose.set(feed, { at, key: h.key });
  }
  const byInc = new Map();
  for (const { tx, s, key } of hits) {
    let g = byInc.get(key);
    if (!g) {
      g = { id: key, loose: !tx.incidentId, feed: tx.feed, town: tx.town || tx.city || null,
            type: tx.callType || null, place: tx.matched || tx.address || tx.street || null,
            from: tx.at, to: tx.at, score: 0, best: 0, units: new Set(), tx: [] };
      byInc.set(key, g);
    }
    g.tx.push(tx);
    if (s > g.best) g.best = s;
    if (tx.at < g.from) g.from = tx.at;
    if (tx.at > g.to) g.to = tx.at;
    if (!g.type && tx.callType) g.type = tx.callType;
    if (!g.place && (tx.matched || tx.address)) g.place = tx.matched || tx.address;
    for (const u of (tx.units || [])) g.units.add(u);
  }
  return [...byInc.values()].map(g => ({
    ...g,
    /* Ranked on its best transmission, nudged by how many others agreed.

       Summing every transmission's score, which is what this did first, ranks
       by how talkative a call was. A forty-line structure fire then buries the
       three lines that are the actual answer to the question, which is the
       opposite of what a reporter at 1am needs. */
    score: g.best + Math.log2(1 + g.tx.length),
    units: [...g.units].slice(0, 12),
    tx: g.tx.sort((a, b) => String(a.at).localeCompare(String(b.at))),
    clips: g.tx.filter(t => t.clip).map(t => ({ u: t.clip, at: t.at })).slice(0, 40),
  })).sort((a, b) => b.score - a.score);
}

/* The scene around a strong hit.

   A reporter who searches "stabbing lancaster street" is asking about an
   EVENT, and the archive answers with the transmissions that contain those
   words, which for Lancaster was exactly one: the EMS dispatch. The officers
   confirming two victims, calling for tape, making notifications, none of
   them ever said the street's name, because people at a scene don't address
   their own location. Strict matching returned the one line and hid the
   story around it.

   So strong hits expand: every transmission from the same incident, plus
   everything in the same city within forty-five minutes that speaks to the
   same kind of call, rides along as context in the same card, chronological,
   with its audio. Context is marked, adds no score, and only strong anchors
   expand, so the weak tail cannot drag a whole evening in with it.

   The city gate matters: a knife mentioned in Lowell twenty minutes after a
   Boston stabbing is a different night in a different place, and without
   that gate the expansion would rebuild the flood this search just stopped
   returning. */
const SCENE_MS = 45 * 60 * 1000;
const SCENE_CAP = 40;

function sceneExpand(hits, pool, f) {
  if (!hits.length) return hits;
  const strong = hits.filter(h => h.s >= (hits[0] ? Math.max(...hits.map(x => x.s)) : 0) * 0.6);
  if (!strong.length) return hits;
  const have = new Set(hits.map(h => h.tx));
  const typed = (tx, hay) => {
    if (!f.type) return true;
    if (tx.callType === f.type) return true;
    if (vq.TYPES[f.type] && vq.TYPES[f.type].test(hay)) return true;
    return (vq.KIN[f.type] || []).includes(tx.callType);
  };
  const out = hits.slice();
  for (const a of strong) {
    const at = +new Date(a.tx.at);
    const inc = a.tx.incidentId || null;
    const city = String(a.tx.city || a.tx.town || '').toLowerCase();
    /* The anchor names its card now, so the scene and the anchor cannot end
       up grouped apart, which is exactly what happened on the first run of
       the test below this feature was built against. */
    a.key = a.key || inc || ('scene:' + (a.tx.feed || '') + ':' + a.tx.at);
    let added = 0;
    for (const tx of pool) {
      if (added >= SCENE_CAP) break;
      if (have.has(tx)) continue;
      const t = +new Date(tx.at);
      const sameInc = inc && tx.incidentId === inc;
      if (!sameInc) {
        if (Math.abs(t - at) > SCENE_MS) continue;
        const c2 = String(tx.city || tx.town || '').toLowerCase();
        if (city && c2 && c2 !== city) continue;
        const hay = ((tx.text || '') + ' ' + (tx.address || '') + ' ' + (tx.matched || '')).toLowerCase();
        if (!typed(tx, hay)) continue;
      }
      have.add(tx);
      out.push({ tx: { ...tx, ctx: true }, s: 0.01, key: a.key });
      added++;
    }
  }
  return out;
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
     filed by Eastern day: "last night" reads two folders, never the archive.

     Newest day first, so that a question wide enough to hit the object cap
     loses its oldest edge rather than the night the reporter is asking about. */
  const days = daysBetween(f.from, f.to).sort().reverse();
  const lo = +f.from - BATCH_SLACK_MS;
  const hi = +f.to + BATCH_SLACK_MS;
  const urls = [];
  let truncated = false;
  let listed = 0;
  for (const d of days) {
    const r = await blob.listPrefix('vault/' + d + '/tx/', { max: MAX_OBJECTS });
    for (const b of (r.blobs || [])) {
      listed++;
      /* The day folders on either edge are read for the hours that spill over
         a midnight, not for their whole contents. */
      const at = stampOf(b.pathname || b.url);
      if (at !== null && (at < lo || at > hi)) continue;
      if (urls.length >= MAX_OBJECTS) { truncated = true; break; }
      urls.push(b.url);
    }
    if (truncated) break;
  }

  const tx = await fetchAll(urls);
  let hits = [];
  for (const t of tx) {
    const s = vq.score(t, f);
    if (s > 0) hits.push({ tx: t, s });
  }
  hits = sceneExpand(hits, tx, f);
  const groups = group(hits).slice(0, 40);

  /* What the archive actually holds for the window that was read.

     A search that finds nothing has two very different meanings and the
     reporter cannot tell them apart: the thing did not happen on the radio, or
     the archive was not running yet. Saying the span that was searched turns
     "nothing found" into something a person can act on. */
  let seenFrom = null, seenTo = null;
  for (const t of tx) {
    const at = String(t.at || '');
    if (!at) continue;
    if (!seenFrom || at < seenFrom) seenFrom = at;
    if (!seenTo || at > seenTo) seenTo = at;
  }

  return json(res, {
    ok: true,
    q,
    understood: {
      when: f.when,
      from: f.from.toISOString(),
      to: f.to.toISOString(),
      type: f.type, place: f.place, landmark: f.landmark, big: f.big, words: f.words,
      phrases: (f.phrases || []).map(set => set[0]),
    },
    scanned: tx.length,
    matched: hits.length,
    calls: groups.length,
    coverage: { from: seenFrom, to: seenTo, objects: urls.length, listed },
    /* Said out loud rather than hidden, because a search that quietly stopped
       reading is a search that lies about what is not there. */
    truncated,
    results: groups,
    ms: Date.now() - t0,
  }, { priv: 0 });
};

module.exports._sceneExpand = sceneExpand;
module.exports._group = group;
