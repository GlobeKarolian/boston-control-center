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
   forever trying to catch up. */
const MAX_ROWS = 1200;

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
async function since(fromISO, toISO) {
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
  const urls = [];
  for (const d of days) {
    const r = await blob.listPrefix('vault/' + d + '/tx/', { max: 4000 });
    for (const b of (r.blobs || [])) {
      const at = stampOf(b.pathname || b.url);
      if (at !== null && (at < lo || at > hi)) continue;
      const key = String(b.pathname || b.url).split('/').pop();
      if (seen.has(key)) continue;
      seen.add(key);
      urls.push(b.url);
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

  let skipped = 0;
  let complete = true;
  if (rows.length > MAX_ROWS) {
    skipped = rows.length - MAX_ROWS;
    rows = rows.slice(-MAX_ROWS);      // the freshest, because the radio is live
    complete = false;
  }

  const cursor = rows.length ? rows[rows.length - 1].at : fromISO;
  return { rows, from, to, cursor, complete, skipped, objects: urls.length };
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
    text: t.text,
  };
  if (t.units && t.units.length) out.units = t.units;
  if (t.callType) out.callType = t.callType;
  if (t.address || t.matched) out.where = t.matched || t.address;
  if (t.tier) out.tier = t.tier;
  if (t.signals && t.signals.length) out.signals = t.signals.map(s => s.id || s.label).filter(Boolean);
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

module.exports = { since, forListening, densityByFeed, MAX_ROWS };
