// lib/vault-read.js
//
// One way to find the vault objects covering a window of time.
//
// WHY THIS FILE EXISTS AT ALL.
//
// There were two readers of the archive, lib/stream.js for the desk and
// api/vault-search.js for the Archive tab, and each had grown its own copy of
// "list the day folders, filter by the stamp in the filename, fetch what is
// left". On 16 August both of them had the identical bug: a cap on how many
// objects the listing would take, applied to a listing that Blob returns
// OLDEST FIRST. So both silently answered from midnight to about 6pm and
// declared the evening empty. Fixing one did not fix the other, and the
// second fix had to be discovered by a person noticing the archive still
// stopped at 6:27pm. Two implementations of one idea is two places for the
// same bug, and this is the merge.
//
// WHY THE HOUR BUCKET.
//
// The vault writes one or two records per object, so a busy day is roughly
// thirty thousand tiny objects in a single flat folder. Reading any window,
// even twenty minutes of it, meant paging that entire folder a thousand
// objects at a time: thirty round trips before a single byte of content was
// fetched. That cost caused, in one night, an archive that stopped at 6pm, a
// Shift Change page that timed out, and a briefing that took eighteen
// seconds.
//
// Objects now live under the hour they belong to:
//
//     vault/2026-08-17/tx/03/1755400000000-2.json
//
// so a twenty-minute read lists one hour instead of a whole day, and a
// twelve-hour shift lists twelve small folders instead of one enormous one.
// The filename still carries the epoch stamp, so nothing downstream that
// parses it has to change.
//
// LEGACY. Everything written before this lived flat at vault/DAY/tx/. That
// prefix is still read, so yesterday keeps working. It is a set that stops
// growing the moment this ships, and the fallback can be deleted once the
// oldest interesting data is past it.
//
// ROLLUPS, WHICH IS THE ACTUAL CURE.
//
// Hour bucketing made the LISTING cheap. The FETCHING was still one round
// trip per object, and a two-day question is fifteen thousand objects: on 17
// August "Bar Fight in cambridge" took 14.6 seconds and, because no request
// can fetch that many, quietly read only the newest sixteen hours of the two
// days it was asked about.
//
// So a cron (api/cron/compact.js) rolls every settled Eastern hour into ONE
// object:
//
//     vault/2026-08-17/hour/03-1755410000000.json     { tx: [ ...the hour... ] }
//
// and this reader fetches that instead of the hour's several hundred pieces.
// A two-day question is then about fifty fetches. The trailing stamp is when
// the rollup was written; if an hour has to be rolled again because late
// objects arrived, a newer stamp wins and nothing is ever overwritten in
// place, which matters because objects are served from a cache that would
// otherwise hand back the stale one for a year.
//
// The pieces are still there. An hour with no rollup yet, the current one and
// the one before it, is read piece by piece exactly as before. Rows can
// therefore arrive twice at a boundary, once in a rollup and once in a piece,
// and readWindow() dedupes them; nothing above this file has to know which
// shape an hour came in.

'use strict';

const blob = require('./blob');
const vq = require('./vault-query');

const TZ = 'America/New_York';

/* The Eastern hour an instant falls in, as "00".."23". The vault is filed by
   Eastern day, so its hours have to be Eastern too or the buckets straddle
   the wrong midnight. */
const HOUR_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hour: '2-digit', hour12: false });
function hourOf(ms) {
  const p = {};
  HOUR_FMT.formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; });
  const h = (+p.hour) % 24;
  return String(h).padStart(2, '0');
}

/* The prefix an object written at this instant belongs under. */
function prefixFor(ms) {
  return 'vault/' + vq.dayString(new Date(ms)) + '/tx/' + hourOf(ms) + '/';
}

/* Every hour prefix touching [fromMs, toMs], plus a slack hour on each side
   because a batch is named for its FIRST row and may carry rows that spill
   over an hour boundary. Newest first. */
function prefixesFor(fromMs, toMs, slackMs) {
  const out = [];
  for (const g of planFor(fromMs, toMs, slackMs)) {
    for (const e of g.entries) if (!e.folded) out.push(e.prefix);
  }
  return out;
}

/* The legacy flat day folders for the same span. */
function legacyPrefixesFor(fromMs, toMs, slackMs) {
  return planFor(fromMs, toMs, slackMs).map(g => 'vault/' + g.day + '/tx/');
}

/* THE READ PLAN.
 *
 * Grouped by Eastern day, newest day first, and within a day the hours newest
 * first. The grouping is not cosmetic; two things hang off it.
 *
 * CONCURRENCY. A day's hour folders are independent, so they are listed at the
 * same time. The old flat layout could not do this: one folder, one cursor,
 * thirty strictly sequential round trips. That is what timed out Shift Change
 * and made the briefing take eighteen seconds.
 *
 * EARLY EXIT. Because days are walked newest first, once enough objects are in
 * hand every prefix still unread covers strictly older time, and the caller's
 * cap was going to discard all of it. So the walk stops at the day boundary
 * and says it stopped. A question about last week that can only afford six
 * thousand objects reads last night and stops, instead of paging seven days to
 * throw six of them away.
 */
function planFor(fromMs, toMs, slackMs, opts) {
  const slack = typeof slackMs === 'number' ? slackMs : 60 * 60 * 1000;
  const legacy = !(opts && opts.legacy === false);
  const lo = fromMs - slack;
  const hi = toMs + slack;

  const byDay = new Map();
  const mark = (t) => {
    const d = vq.dayString(new Date(t));
    if (!d) return;
    if (!byDay.has(d)) byDay.set(d, new Set());
    byDay.get(d).add(hourOf(t));
  };
  /* Half-hour steps cannot skip an hour folder, and are cheap: a week is 336
     iterations of an Intl format, all of it before any network. */
  for (let t = lo; t <= hi; t += 30 * 60 * 1000) mark(t);
  mark(hi);

  const days = [...byDay.keys()].sort().reverse();
  return days.map(day => {
    const hours = [...byDay.get(day)].sort().reverse();
    const entries = [];
    /* Folded, so this returns only what sits loose in vault/DAY/tx/ from
       before hour bucketing. Blob matches a prefix as a plain string, so an
       expanded listing here would walk every hour folder underneath and hand
       back the entire cost the bucketing removed. */
    if (legacy) entries.push({ prefix: 'vault/' + day + '/tx/', folded: true });
    for (const h of hours) entries.push({ prefix: 'vault/' + day + '/tx/' + h + '/', folded: false });
    return { day, hours, entries };
  });
}

/* The epoch stamp a vault filename starts with, or null. */
function stampOf(path) {
  const base = String(path || '').split('/').pop() || '';
  const m = base.match(/^(\d{10,16})-/);
  if (!m) return null;
  const n = +m[1];
  return Number.isFinite(n) ? n : null;
}

/* ROLLUPS.

   One object per settled Eastern hour, under vault/DAY/hour/. The basename is
   HH-<written>.json where <written> is the epoch millisecond the rollup was
   written, so a re-roll of the same hour is a new object with a later stamp
   and the reader takes the newest per hour. */
function rollupPrefix(day) { return 'vault/' + day + '/hour/'; }
function rollupPath(day, hh, writtenMs) {
  return rollupPrefix(day) + hh + '-' + String(writtenMs || Date.now()) + '.json';
}
/* { day, hour, written } out of a rollup pathname, or null. */
function rollupOf(path) {
  const parts = String(path || '').split('/');
  const base = parts.pop() || '';
  const m = /^(\d\d)-(\d{10,16})\.json$/.exec(base);
  if (!m || parts.pop() !== 'hour') return null;
  const day = parts.pop();
  if (!/^\d{4}-\d\d-\d\d$/.test(day || '')) return null;
  return { day, hour: m[1], written: +m[2] };
}

/* The newest rollup per hour for these days: Map "DAY/HH" -> { url, written,
   pathname, uploadedAt }. One small listing per day. */
async function rollupsFor(days, cache) {
  const out = new Map();
  const results = await pool(days, (day) => cachedList(cache, rollupPrefix(day), { max: 500 }), LIST_CONCURRENCY);
  for (const r of results) {
    for (const b of ((r && r.blobs) || [])) {
      const info = rollupOf(b.pathname || b.url);
      if (!info) continue;
      const key = info.day + '/' + info.hour;
      const have = out.get(key);
      if (!have || info.written > have.written) {
        out.set(key, { url: b.url, written: info.written, pathname: b.pathname, uploadedAt: b.uploadedAt || null });
      }
    }
  }
  return out;
}

/* A listing, once per run when the caller hands over a cache. The compactor
   rolls many hours of one day in a single run, and a legacy day's flat folder
   is thirty pages; listing it once per hour would be thirty pages times
   twenty-four. */
async function cachedList(cache, prefix, opts) {
  const o = opts || {};
  if (!cache) return blob.listPrefix(prefix, o);
  /* What is cached is the WHOLE listing, unfiltered and uncapped. The first
     version cached whatever the first caller asked for, and the first caller
     was rolling hour 08 with ten minutes of slack, so hour 07's folder went
     into the cache holding only its last ten minutes; rolling hour 07 then
     read six rows and wrote them down as the hour. A cache entry has to be
     the folder, not one caller's view of it. */
  const key = prefix + '|' + (o.folded ? 'f' : 'e');
  let full = cache.get(key);
  if (!full) {
    full = await blob.listPrefix(prefix, { folded: o.folded, max: 400000, keepNewest: false, maxPages: 400 });
    cache.set(key, full);
  }
  let blobs = full.blobs || [];
  if (typeof o.keep === 'function') blobs = blobs.filter(o.keep);
  let truncated = !!full.truncated;
  if (o.max && blobs.length > o.max) {
    blobs = o.keepNewest ? blobs.slice(-o.max) : blobs.slice(0, o.max);
    truncated = true;
  }
  return { ok: full.ok !== false, why: full.why, blobs, pages: full.pages || 0, seen: (full.blobs || []).length, truncated };
}

/* The instant range of an Eastern (day, hour) bucket: [start, end).

   Eastern is UTC minus four or minus five, so the bucket starts at one of two
   instants; each is checked against the same clock the writer uses, so this
   cannot disagree with where an object was filed. The doubled 1am on the
   November change comes back as one two-hour range, which is what its single
   bucket holds; the missing 2am in March comes back null. Memoised, because
   the reader asks for the same few dozen buckets over and over. */
const HW_MEMO = new Map();
function hourWindow(day, hh) {
  const key = day + '/' + hh;
  if (HW_MEMO.has(key)) return HW_MEMO.get(key);
  let out = null;
  const base = Date.parse(day + 'T00:00:00Z');
  if (Number.isFinite(base) && /^\d\d$/.test(hh)) {
    const H = 3600000;
    let start = null;
    for (const off of [4, 5]) {
      const t = base + (+hh) * H + off * H;
      if (vq.dayString(new Date(t)) === day && hourOf(t) === hh) { start = start === null ? t : Math.min(start, t); }
    }
    if (start !== null) {
      let end = start + H;
      /* The doubled hour: the instant an hour later still reads as this hour. */
      if (vq.dayString(new Date(end)) === day && hourOf(end) === hh) end += H;
      out = { start, end };
    }
  }
  if (HW_MEMO.size > 5000) HW_MEMO.clear();
  HW_MEMO.set(key, out);
  return out;
}

/* One row's identity, for deduping a row that arrived both in a rollup and in
   a piece at an hour boundary, or twice from a relay retry. */
function rowKey(t) {
  return String(t.at || '') + '|' + String(t.feed || t.src || '') + '|' + String(t.text || '').slice(0, 96);
}

/* How many listings run at once. Enough to collapse a shift's worth of hour
   folders into a few waves, low enough not to look like an attack on the
   store. */
const LIST_CONCURRENCY = 6;

async function pool(items, worker, width) {
  const out = new Array(items.length);
  let i = 0;
  const runners = new Array(Math.min(width, items.length || 1)).fill(0).map(async () => {
    for (;;) {
      const n = i++;
      if (n >= items.length) return;
      out[n] = await worker(items[n], n);
    }
  });
  await Promise.all(runners);
  return out;
}

/* How much of an even sample is reserved for the newest end of the window.
 *
 * Even coverage of two days quietly throws away right now, because right now
 * is a handful of objects at the end of a list of thousands and a stride of
 * one-in-twenty does not care which end it is dropping. On 14 August somebody
 * typed "stabbing" at 02:32 and got seven knife references from the previous
 * afternoon and not the stabbing dispatched eight minutes earlier. So the
 * newest share is taken whole and the stride covers everything older.
 *
 * lib/stream.js reserves the same share again on the rows it fetches. The two
 * compose: this one guarantees the SPAN is represented, that one guarantees
 * the last few minutes survive the second cut. */
const TAIL_SHARE = 1 / 3;

/* Thin a newest-first list to `cap`, keeping the span. Returns newest-first. */
function thin(found, cap) {
  if (found.length <= cap) return found.slice();
  const tailN = Math.max(1, Math.min(cap - 1, Math.floor(cap * TAIL_SHARE)));
  const tail = found.slice(0, tailN);                 // newest, kept whole
  const rest = found.slice(tailN);                    // older, sampled
  const headCap = cap - tailN;
  const out = tail.slice();
  if (headCap > 0 && rest.length) {
    const step = rest.length / headCap;
    for (let i = 0; i < headCap; i++) out.push(rest[Math.floor(i * step)]);
  }
  return out;
}

/* Object URLs covering a window, newest first.
 *
 * Returns { ok, urls, listed, pages, truncated, why }. `urls` is newest-first
 * so a caller that can only afford N of them keeps the N that matter; a
 * caller wanting chronology sorts what it kept.
 *
 * `max` bounds the number of URLs returned, not the number listed: the
 * listing is metadata and cheap, the fetching is what costs.
 */
async function listWindow(fromMs, toMs, opts) {
  const o = opts || {};
  const slack = typeof o.slackMs === 'number' ? o.slackMs : 60 * 60 * 1000;
  const max = o.max || 12000;
  const lo = fromMs - slack;
  const hi = toMs + slack;
  const cache = o.cache || null;

  if (!blob.enabled()) return { ok: false, why: blob.reason(), urls: [], listed: 0, truncated: false };

  const seen = new Set();
  const found = [];       // raw pieces
  const rolled = [];      // rollups, always kept whole
  let listed = 0, scanned = 0, pages = 0, truncated = false, why = null;

  const take = (r) => {
    pages += (r && r.pages) || 0;
    scanned += (r && r.seen) || 0;
    if (r && r.truncated) truncated = true;
    if (r && r.ok === false && r.why && !why) why = r.why;
    for (const b of ((r && r.blobs) || [])) {
      listed++;
      const key = String(b.pathname || b.url).split('/').pop();
      if (!key || seen.has(key)) continue;
      const at = stampOf(b.pathname || b.url);
      /* An object whose name we cannot read is kept rather than dropped:
         losing a transmission is worse than fetching one we did not need. */
      if (at !== null && (at < lo || at > hi)) continue;
      seen.add(key);
      found.push({ url: b.url, at: at == null ? 0 : at });
    }
  };

  /* EVENLY, WHICH IS A DIFFERENT QUESTION.
   *
   * A listener wants the end of the window. Somebody who typed a QUESTION into
   * the desk wants the window, all of it, thinly. Those need different answers
   * and the difference has to be made HERE, where the whole set is known.
   *
   * Getting that wrong is what put "there are no fights" on the screen at 2am
   * on 17 August, over a window that contained a brawl outside Russell House
   * Tavern. The desk asked for even coverage of 3,121 transmissions and got a
   * contiguous newest-first block of 150, so its sampler was spreading evenly
   * across the last few minutes and calling it two days. The fight was never
   * fetched, and the answer said the city was quiet.
   *
   * So when a caller asks for the whole window: do not stop early, and thin
   * the result across the span instead of taking the newest slice of it. */
  const evenly = !!o.evenly;
  const plan = planFor(fromMs, toMs, slack, { legacy: o.legacy !== false });

  /* Which hours already exist as one object. */
  const rollups = (o.rollups === false) ? new Map() : await rollupsFor(plan.map(g => g.day), cache);

  let stoppedEarly = false;
  for (const group of plan) {
    /* The window filter runs inside the listing, per page, rather than after
       it. A legacy flat day holds tens of thousands of objects and the
       newest-first trim used to throw away everything but the last few
       thousand BEFORE anyone checked which of them were in the window, so a
       morning question came back empty while the archive held six hundred
       objects for it. */
    const inWindow = (b) => {
      const at = stampOf(b.pathname || b.url);
      return at === null || (at >= lo && at <= hi);
    };
    /* Hours with a rollup are one fetch and no listing. Hours without are
       listed piece by piece. The legacy flat folder is only listed when some
       hour of the day still needs pieces, since a rolled hour has already
       absorbed its flat objects. */
    const entries = [];
    let needsPieces = false;
    for (const e of group.entries) {
      if (e.folded) continue;                            // decided below
      const hh = e.prefix.slice(-3, -1);
      const ru = rollups.get(group.day + '/' + hh);
      if (ru) {
        const w = hourWindow(group.day, hh);
        rolled.push({ url: ru.url, at: w ? w.start : 0, rollup: true, hour: group.day + '/' + hh });
      } else {
        entries.push(e);
        needsPieces = true;
      }
    }
    if (needsPieces) for (const e of group.entries) if (e.folded) entries.push(e);
    const results = await pool(entries,
      (e) => cachedList(cache, e.prefix, { max: 8000, keepNewest: true, folded: e.folded, keep: inWindow }),
      LIST_CONCURRENCY);
    for (const r of results) take(r);
    /* Every prefix left is an older day, and the cap below would drop all of
       it. Stopping here is the difference between answering last night and
       paging last week to discard it. Never when the caller asked for even
       coverage: for them the older days ARE the answer. */
    if (!evenly && found.length >= max) { stoppedEarly = true; truncated = true; break; }
  }

  found.sort((a, b) => b.at - a.at);           // newest first
  let kept;
  let sampled = false;
  if (found.length > max) {
    truncated = true;
    if (evenly) { kept = thin(found, max); sampled = true; }
    else kept = found.slice(0, max);
  } else {
    kept = found;
  }
  /* Rollups are never capped or thinned: each one IS an hour, and dropping
     one drops the hour. They ride along whole, newest first with the rest. */
  const all = kept.concat(rolled).sort((a, b) => b.at - a.at);
  const urls = all.map(x => x.url);
  return { ok: true, urls, objects: all, listed, scanned, pages, truncated, sampled, stoppedEarly,
           found: found.length, rollups: rolled.length, why };
}

/* Fetch what a listing found. Every object is { tx: [...] }, rollup or piece,
   so the shape is one shape. One unreadable object is not a failed read. */
let FETCH = (u) => fetch(u);
async function fetchAll(urls, width) {
  const out = [];
  let i = 0, failed = 0;
  const w = Math.min(width || 48, urls.length || 1);
  const worker = async () => {
    for (;;) {
      const n = i++;
      if (n >= urls.length) return;
      try {
        const r = await FETCH(urls[n]);
        if (!r || !r.ok) { failed++; continue; }
        const j = await r.json();
        if (j && Array.isArray(j.tx)) for (const t of j.tx) out.push(t);
      } catch (e) { failed++; }
    }
  };
  await Promise.all(Array.from({ length: w }, worker));
  return { rows: out, failed };
}

/* THE ROWS IN A WINDOW. The one read everything above this file should use.
 *
 * Lists (rollups first, pieces for the hours that have none), fetches, dedupes
 * a row that arrived both ways, keeps only rows inside [fromMs, toMs], and
 * returns them oldest first. Every option of listWindow applies. */
async function readWindow(fromMs, toMs, opts) {
  const o = opts || {};
  const got = await listWindow(fromMs, toMs, o);
  if (!got.ok) return { ok: false, why: got.why, rows: [], listing: got, failed: 0 };
  const fetched = await fetchAll(got.urls, o.concurrency);
  const seen = new Set();
  const rows = [];
  for (const t of fetched.rows) {
    if (!t) continue;
    const at = +new Date(t.at);
    if (!Number.isFinite(at) || at < fromMs || at > toMs) continue;
    const k = rowKey(t);
    if (seen.has(k)) continue;
    seen.add(k);
    rows.push(t);
  }
  rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return { ok: true, rows, listing: got, failed: fetched.failed, deduped: fetched.rows.length - rows.length };
}

module.exports = {
  listWindow, readWindow, fetchAll, thin, planFor, prefixFor, prefixesFor, legacyPrefixesFor,
  stampOf, hourOf, hourWindow, rowKey, rollupPrefix, rollupPath, rollupOf, rollupsFor, cachedList,
  TZ, LIST_CONCURRENCY,
  /* Test seam: the fetch used for object bodies. */
  _setFetch(fn) { FETCH = fn || ((u) => fetch(u)); },
};
