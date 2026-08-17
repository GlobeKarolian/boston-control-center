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
const vaultRead = require('../lib/vault-read');
const places = require('../lib/places');

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
  /* A card is named by its strongest transmission, not its earliest. The
     Lancaster card called itself MEDICAL in Boston, because the EMS dispatch
     that anchored it carried no call type and the first ambient line that did
     got to speak for a double stabbing. */
  for (const g of byInc.values()) {
    let best = null;
    for (const h of hits) {
      if (h.key !== g.id) continue;
      if (!best || h.s > best.s) best = h;
    }
    if (best && best.s > 0.01) {
      if (best.tx.callType) g.type = best.tx.callType;
      const place = best.tx.matched || best.tx.address || best.tx.street;
      if (place) g.place = place;
      if (best.tx.town || best.tx.city) g.town = best.tx.town || best.tx.city;
    }
  }

  return [...byInc.values()].map(g => ({
    ...g,
    /* Ranked on its best transmission, nudged by how many others agreed.

       Summing every transmission's score, which is what this did first, ranks
       by how talkative a call was. A forty-line structure fire then buries the
       three lines that are the actual answer to the question, which is the
       opposite of what a reporter at 1am needs. */
    /* The corroboration bonus is CAPPED. It was log2(1+n) uncapped, so a
       ten-transmission call earned +3.5 and a precise one-line match earned
       +1, and a chatty Needham incident that merely contained the word
       "Harvard" outranked the Harvard Square brawl the reporter was actually
       looking for. Agreement among transmissions is a tiebreak, not a reason
       to outrank a better answer. */
    score: g.best + Math.min(1.5, Math.log2(1 + g.tx.length)),
    units: [...g.units].slice(0, 12),
    tx: g.tx.sort((a, b) => String(a.at).localeCompare(String(b.at))),
    clips: g.tx.filter(t => t.clip).map(t => ({ u: t.clip, at: t.at })).slice(0, 40),
  /* Ties go to the newest. This sort was stable and the groups were built in
     time order, so equal scores came back OLDEST first: on 17 August ten
     Cambridge disturbances tied and the one from 5:34 pm led the one the
     reporter was asking about. Somebody asking at 2am means the one on the
     air now, and the desk already says so; the archive has to agree. */
  })).sort((a, b) => b.score - a.score || String(b.to || '').localeCompare(String(a.to || '')));
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
const SCENE_CAP = 30;

/* Words that name WHERE an anchor was, for linking context to it.

   Read from the address, the street and the landmark, never from `matched`
   whole: `matched` is the geocoder's formatted answer and it ends in the
   town, the state and a zip code, so on 17 August every Cambridge
   transmission's "street words" contained "cambridge", every other Cambridge
   transmission's haystack contained "cambridge", and a knife call at 1426
   Mass Ave collected thirty-three lines of unrelated chatter, "Thank you very
   much" and "Wilco 6 is going off" among them, as its scene. The town is not a
   thread. Neither is a number: 1426 is a house, a unit, or a time. */
const NOT_A_THREAD = new Set(['street', 'st', 'road', 'rd', 'avenue', 'ave', 'drive', 'dr', 'place', 'pl',
  'court', 'ct', 'lane', 'ln', 'way', 'terrace', 'ter', 'boulevard', 'blvd', 'parkway', 'pkwy',
  'highway', 'hwy', 'route', 'rte', 'square', 'sq', 'circle', 'park', 'north', 'south', 'east', 'west',
  'the', 'and', 'house', 'building', 'apartment', 'apt', 'floor', 'unit', 'suite', 'rear', 'front',
  'usa']);
function streetWords(tx) {
  const src = [tx.address, tx.street, tx.landmark,
    /* the street part of a geocoded answer only, before the first comma */
    String(tx.matched || '').split(',')[0]].filter(Boolean).join(' ').toLowerCase();
  const out = new Set();
  for (const w of src.split(/[^a-z0-9]+/)) {
    if (w.length < 3) continue;
    if (/^\d+$/.test(w)) continue;
    if (NOT_A_THREAD.has(w)) continue;
    if (places.isKnownTown(w)) continue;
    out.add(w);
  }
  return [...out];
}

/* How far a line can be from the anchor and still join by SAYING the type.

   It depends on how common the type is. Two stabbings in the same city
   inside forty-five minutes are almost always the same stabbing, and the
   Lancaster Street scene was knitted exactly that way: the EMS dispatch said
   the address, the officers eighteen and thirty minutes later said stab and
   knife and never the street. That reach is kept for the rare types.

   Two disturbances inside forty-five minutes on a citywide police channel are
   almost always two different calls. On 17 August Cambridge worked "P&P for a
   disturbance", "Newtown Court for disturbance" and "no disturbance right
   yet" inside twenty minutes, three calls, and a reach that long makes them
   one card. So the common types, the ones a channel says several times an
   hour, only reach a few minutes: far enough for the follow-up on the same
   call, not far enough for the next call. */
const RARE_TYPE = new Set(['death', 'shooting', 'stabbing', 'hazmat', 'pursuit', 'robbery', 'search']);
const TYPE_LINK_MS = 12 * 60 * 1000;
const typeReach = (type) => (RARE_TYPE.has(type) ? SCENE_MS : TYPE_LINK_MS);

function sceneExpand(hits, pool, f) {
  if (!hits.length) return hits;
  const strong = hits.filter(h => h.s >= (hits[0] ? Math.max(...hits.map(x => x.s)) : 0) * 0.6);
  if (!strong.length) return hits;
  const have = new Set(hits.map(h => h.tx));
  /* Context has to be LINKED, not merely nearby and vaguely related.

     The first cut let kinship alone qualify, and on a citywide police channel
     forty-five minutes of kin is most of the channel: a strangulation from
     three that morning, a Canal Street follow-up, the fire department's chest
     pains, all riding into a stabbing's card. So a transmission joins the
     scene only by a real thread: the pipeline already tied it to the same
     incident, it names the anchor's street or landmark, or it plainly says
     the thing the question asked about within a few minutes of the anchor.

     That last one is what carries cross-agency knitting, and it is why this
     still works: the officers at Lancaster never said the address, but they
     said stab, knife, and stabbing, and the EMS dispatch said the address, so
     the two halves of the scene arrive by different threads and land in the
     same card.

     A unit number is not a thread. A8 works all night across a dozen calls,
     and "shares a unit with the anchor" pulled a Charlestown cardiac and a
     bomb squad dismissal into a Back Bay shooting card on 15 August 2026. */
  const linked = (tx, hay, dtMs, inc, anchorStreet) => {
    if (inc && tx.incidentId && tx.incidentId === inc) return true;
    if (anchorStreet.length && anchorStreet.some(w => hay.includes(w))) return true;
    if (f.type && dtMs <= typeReach(f.type)) {
      if (vq.ownType(tx, f.type)) return true;
      if (vq.TYPES[f.type] && vq.TYPES[f.type].test(hay)) return true;
    }
    return false;
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
    const anchorStreet = streetWords(a.tx);
    /* Nearest first, so the cap keeps the lines closest to the anchor rather
       than whichever happened to be fetched first. */
    const near = [];
    for (const tx of pool) {
      if (have.has(tx)) continue;
      const dt = Math.abs(+new Date(tx.at) - at);
      if (dt > SCENE_MS) continue;
      const c2 = String(tx.city || tx.town || '').toLowerCase();
      if (city && c2 && c2 !== city) continue;
      near.push({ tx, dt });
    }
    near.sort((x, y) => x.dt - y.dt);
    let added = 0;
    for (const { tx, dt } of near) {
      if (added >= SCENE_CAP) break;
      const hay = ((tx.text || '') + ' ' + (tx.address || '') + ' ' + (tx.landmark || '') + ' ' + (tx.matched || '')).toLowerCase();
      if (!linked(tx, hay, dt, inc, anchorStreet)) continue;
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

  /* WHICH OBJECTS COULD HOLD THE ANSWER.

     Shared with the desk's reader. This file used to carry its own copy of
     "list the day folders and filter by the stamp in the filename", and it
     carried the same bug: a cap applied to a listing Vercel Blob returns
     OLDEST FIRST. So the archive answered from midnight to about 6:27pm and
     called the evening empty, and a reporter searching for the bar fight at
     11pm got nothing. Fixing lib/stream.js did not fix this file, and a
     person had to notice the archive was still truncated.

     lib/vault-read.js is now the one implementation. It lists the hour
     folders the window touches, returns them NEWEST FIRST, and only then
     applies the cap, so a window too wide to fetch whole loses its oldest
     edge rather than the night being asked about. */
  const got = await vaultRead.listWindow(+f.from, +f.to, { slackMs: BATCH_SLACK_MS, max: MAX_OBJECTS });
  const urls = got.urls;                          // newest first
  const truncated = !!got.truncated;
  /* A COUNT, not the result object. This was `listed` before the shared reader
     landed and it went on being spread into the response afterwards, which
     shipped every blob URL a second time: two thirds of a megabyte of JSON on
     a wide search, for a field nothing reads. */
  const listed = got.listed || 0;

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
