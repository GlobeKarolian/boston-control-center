// lib/stream.js
//
// Every transmission, in order, with nothing skipped.
//
// WHY THIS EXISTS. The analyst was reading `bcc:out:transcripts`, a rolling
// buffer of the 80 most recent transmissions, and taking 70 of them once
// every five minutes. On a quiet night that happens to be everything. At
// rush hour, when eleven feeds are talking and a scene is developing, more
// than eighty transmissions can arrive between two runs, and the older ones
// fall off the buffer before anything ever looks at them. The listener was
// blind in exactly the minutes it existed for, and it had no way to know:
// a buffer that has dropped something looks identical to a quiet channel.
//
// So the stream is read from the vault instead, which is append-only, holds
// a year, and is filed by Eastern day. A cursor says where the last read
// stopped, the next read starts there, and nothing between the two is
// skipped no matter how busy the radio got. If a run fails, the cursor does
// not move, and the next run picks up the gap rather than stepping over it.
//
// It also takes the analyst off Redis. On the night this was written Upstash
// hit its plan ceiling and answered 403 to every command, which took the
// board down and would have taken the listener with it. Blob stayed up the
// whole time. The thing that watches the city should not stop watching
// because a cache is over its quota.

'use strict';

const blob = require('./blob');
const vq = require('./vault-query');

const CONCURRENCY = 48;

/* A window wider than the request, because a vault batch is named for the
   first transmission in it and its last can land a little after that stamp.
   Every row is still filtered exactly on its own timestamp. */
const BATCH_SLACK_MS = 30 * 60 * 1000;

/* A ceiling on one read. Passing this means the listener fell far behind, a
   long outage or a cold start, and the honest move is to take the most recent
   slice and say how much was skipped rather than silently truncate or stall
   forever trying to catch up.

   Callers asking a QUESTION rather than tailing the radio pass their own,
   much larger, because "what were the biggest calls in the last two days" is
   six thousand transmissions and answering it off the freshest twelve hundred
   would silently drop the first day, which is the half most likely to hold
   the thing being asked about. */
const MAX_ROWS = 1200;

/* Objects fetched in one read. Each is a batch of a few transmissions and a
   round trip, so this is the real cost of a long window: a 48-hour question
   is roughly twelve hundred of them. */
const MAX_OBJECTS = 2400;

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
      } catch (e) { /* one unreadable object is not a failed read */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));
  return out;
}

/* Everything the radio carried between two instants.
 *
 * Returns { rows, from, to, cursor, complete, skipped, objects }. `cursor` is
 * what to pass as `from` next time: the timestamp of the last row returned,
 * so a row is never read twice and never jumped over. `complete` is false when
 * the window held more than MAX_ROWS, and `skipped` says how many were left
 * behind, because a listener that silently drops the middle of a busy hour is
 * the bug this file was written to end.
 */
/* When a window holds more objects than one read may fetch, take them EVENLY
   across the window rather than from the end.

   Taking the tail is right for a listener catching up, because the newest
   traffic is the traffic still developing. It is wrong for a question: asked
   about two days, a reporter means both of them, and an answer built only
   from last night while claiming to cover two is worse than an answer that
   admits it sampled. */
/* Fraction of the object budget held back for the newest traffic, whatever
   else the sampler does with the rest. */
const TAIL_SHARE = 0.35;

function spread(urls, cap) {
  if (urls.length <= cap) return { picked: urls, sampled: false };

  /* THE TAIL IS NEVER SAMPLED.
   *
   * Even sampling gives fair coverage of two days and quietly throws away
   * right now, because right now is a handful of objects at the end of a list
   * of thousands and a stride of 1-in-8 does not care which end it is
   * dropping.
   *
   * On 14 August somebody typed "stabbing" at 02:32. The answer listed seven
   * knife references from the previous morning and afternoon and did not
   * contain the stabbing dispatched at 02:24, eight minutes earlier, which
   * was the only one anybody was going to ask about. It was not filtered out
   * or scored down. It was never fetched.
   *
   * So the newest third of the budget is reserved for the newest objects, and
   * the sampler spreads over everything older. A question about a window
   * still gets the window, and the thing happening while it is being asked is
   * never the part that gets dropped. */
  const tailN = Math.max(1, Math.min(cap - 1, Math.floor(cap * TAIL_SHARE)));
  const tail = urls.slice(-tailN);
  const head = urls.slice(0, urls.length - tailN);
  const headCap = cap - tailN;

  const picked = [];
  if (headCap > 0 && head.length) {
    const step = head.length / headCap;
    for (let i = 0; i < headCap; i++) picked.push(head[Math.floor(i * step)]);
  }
  for (const u of tail) picked.push(u);
  return { picked, sampled: true, tailKept: tail.length };
}

async function since(fromISO, toISO, opts) {
  const maxRows = Math.max(50, (opts && opts.maxRows) || MAX_ROWS);
  const maxObjects = Math.max(50, (opts && opts.maxObjects) || MAX_OBJECTS);
  /* A question wants coverage of the whole window; a listener wants the end
     of it. The caller says which, and the default stays the listener's. */
  const evenly = !!(opts && opts.evenly);
  const from = new Date(fromISO);
  const to = toISO ? new Date(toISO) : new Date();
  if (isNaN(+from) || isNaN(+to)) return { rows: [], from: null, to: null, cursor: fromISO, complete: true, skipped: 0, objects: 0, why: 'bad window' };
  if (!blob.enabled()) return { rows: [], from, to, cursor: fromISO, complete: false, skipped: 0, objects: 0, why: blob.reason() };

  const days = [];
  for (let t = +from - 86400000; t <= +to + 86400000; t += 86400000) {
    const d = vq.dayString(new Date(t));
    if (d && !days.includes(d)) days.push(d);
  }

  const lo = +from - BATCH_SLACK_MS;
  const hi = +to + BATCH_SLACK_MS;
  /* A Set, because the day folders on either edge are read to catch the hours
     that spill over midnight, and a listener that counts the same batch twice
     reports a busy hour that never happened. The severity floor reads these
     counts, so a duplicate is not a cosmetic error. */
  const seen = new Set();
  let urls = [];
  for (const d of days) {
    /* List the WHOLE day, not the first 4000 objects of it.
       The vault writes 1-2 records per object, so a busy day is tens of
       thousands of tiny objects, and Vercel Blob returns them oldest-first
       (they are named by epoch stamp, which sorts chronologically). A cap of
       4000 therefore returned midnight through roughly 6pm and stopped, so the
       archive looked like it ended in the afternoon while writes kept flowing
       all evening. Listing is cheap metadata; the fetch below is what stays
       capped and sampled, so this restores coverage without fetching more.
       The real fix is to write fewer, larger objects: see the note in
       api/ingest.js. Until then, list it all. */
    const r = await blob.listPrefix('vault/' + d + '/tx/', { max: 12000, keepNewest: true });
    for (const b of (r.blobs || [])) {
      const at = stampOf(b.pathname || b.url);
      if (at !== null && (at < lo || at > hi)) continue;
      const key = String(b.pathname || b.url).split('/').pop();
      if (seen.has(key)) continue;
      seen.add(key);
      urls.push(b.url);
    }
  }

  /* Newest-first when taking a tail, so the cap keeps the freshest. */
  urls.sort();
  let sampled = false;
  let dropped = 0;
  if (urls.length > maxObjects) {
    if (evenly) {
      const r = spread(urls, maxObjects);
      dropped = urls.length - r.picked.length;
      urls = r.picked;
      sampled = true;
    } else {
      dropped = urls.length - maxObjects;
      urls = urls.slice(-maxObjects);
    }
  }

  const all = await fetchAll(urls);
  let rows = all
    .filter(t => {
      const at = +new Date(t.at);
      /* Strictly after `from`, so the row that set the cursor is not read a
         second time and counted as new traffic. */
      return at > +from && at <= +to;
    })
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));

  let skipped = dropped;
  let complete = !sampled && !dropped;
  if (rows.length > maxRows) {
    skipped += rows.length - maxRows;
    if (evenly) {
      const r = spread(rows, maxRows);
      rows = r.picked;
    } else {
      rows = rows.slice(-maxRows);     // the freshest, because the radio is live
    }
    complete = false;
  }

  const cursor = rows.length ? rows[rows.length - 1].at : fromISO;
  return { rows, from, to, cursor, complete, skipped, sampled, objects: urls.length };
}

/* The listener's view of a transmission: what was said, when, on which radio,
   plus the structured reading the pipeline already produced. Deliberately not
   the whole vault record, because the model does not need lat/lon precision
   or provenance to decide whether a scene is developing, and every field
   handed over is a field it can hallucinate about. */
function forListening(t) {
  const out = {
    at: t.at,
    src: t.feed,
    /* THREE NAMES FOR ONE THING, AND ALL THREE ARE LOAD-BEARING.
     *
     * This shape is read by the UI, by lib/analyst-core.js and by
     * lib/severity.js, and each of them learned a different name for the feed
     * before they were ever used together. On 14 August that cost the whole
     * editorial layer, silently:
     *
     *   analyst-core.linesOf() writes '[' + t.source + '] ' in front of every
     *   line the analyst reads. With only `src` set, every line the model saw
     *   was tagged "[undefined]". It copied that into `feeds`, exactly as it
     *   was told to. feedsHeard() looked "undefined" up, found nothing, and
     *   dropped it, so every situation came back with feeds: [].
     *
     *   The analyst then selects a situation's own transmissions with
     *   rows.filter(r => f.feeds.includes(r.feed)), which with an empty feeds
     *   list matches nothing. So the severity floor was scoring every
     *   situation over ZERO transmissions, every situation settled below 3,
     *   and f.major was false for all of them, forever. Situations Mode could
     *   not have shown a card if the city had burned down.
     *
     *   It also cost verification: with no transmissions of its own, each
     *   claim was checked against the whole eighty-line batch, which is how
     *   an unambiguous stabbing dispatch came back unsupported.
     *
     * So the feed goes out under every name its readers use. Cheap, and the
     * alternative is this failure again the next time two files meet. */
    source: t.feed,
    feed: t.feed,
    text: t.text,
  };
  if (t.units && t.units.length) out.units = t.units;
  if (t.callType) out.callType = t.callType;
  if (t.address || t.matched) out.where = t.matched || t.address;
  if (t.tier) out.tier = t.tier;
  /* Signals stay as objects. Flattening them to id strings here meant
     lib/severity.js read g.id and g.tier off a string and got undefined for
     both, so GRAVE and HEAVY never matched and a mass-casualty signal scored
     the same as a noise complaint. The string list is kept alongside for
     anything that just wants labels. */
  if (t.signals && t.signals.length) {
    out.signals = t.signals;
    out.signalIds = t.signals.map(x => (x && (x.id || x.label)) || x).filter(Boolean);
  }
  if (t.clip) out.clip = t.clip;
  return out;
}

/* Density per feed for the window, which is what the severity floor reads to
   notice a scene it cannot understand a word of. */
function densityByFeed(rows) {
  const n = {};
  for (const t of (rows || [])) n[t.feed || 'unknown'] = (n[t.feed || 'unknown'] || 0) + 1;
  return n;
}

/* THE LIVE BOARD, FOR THE MINUTES THE VAULT HAS NOT CAUGHT UP ON.
 *
 * The vault is the archive and it lags: on a busy night its newest object can
 * be hours behind the radio, because writes are batched and Blob is eventually
 * consistent. The desk reads the vault, so a running read of "the last 20
 * minutes" comes back empty while the console one panel below shows traffic
 * from a minute ago, and an ask reaches 48 hours back and answers with old
 * calls while missing the one that is happening now.
 *
 * bcc:out:transcripts is the same buffer the live board renders: current,
 * small (the last few hundred), authoritative for right now. This reads it and
 * normalises to the listener shape, so the desk can fold the live minutes in
 * front of the lagging archive. The field names are the buffer's actual ones,
 * time/text/source, not the vault's at/text/feed. Reading the wrong name is
 * how an earlier version of this dropped every row it fetched.
 */
async function bufferSince(fromISO) {
  try {
    const store = require('./store-io');
    const raw = await store.readOut(store.K.outTranscripts, '[]');
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    const cutoff = String(fromISO || '');
    const out = [];
    for (const r of list) {
      const at = r && (r.time || r.at || r.t);
      if (!at || (cutoff && at <= cutoff)) continue;
      out.push({
        at,
        src: r.source || r.feed || r.src || 'unknown',
        feed: r.source || r.feed || r.src || 'unknown',
        source: r.source || r.feed || r.src || 'unknown',
        text: r.text || r.transcript || '',
        clip: r.clip,
        incidentId: r.incidentId || null,
        id: r.id,
      });
    }
    out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    return out;
  } catch (e) { return []; }
}

module.exports = { spread, since, bufferSince, forListening, densityByFeed, MAX_ROWS, MAX_OBJECTS };
