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

'use strict';

const blob = require('./blob');
const vq = require('./vault-query');

const TZ = 'America/New_York';

/* The Eastern hour an instant falls in, as "00".."23". The vault is filed by
   Eastern day, so its hours have to be Eastern too or the buckets straddle
   the wrong midnight. */
function hourOf(ms) {
  const p = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hour: '2-digit', hour12: false })
    .formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; });
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

  if (!blob.enabled()) return { ok: false, why: blob.reason(), urls: [], listed: 0, truncated: false };

  const seen = new Set();
  const found = [];
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
    const results = await pool(group.entries,
      (e) => blob.listPrefix(e.prefix, { max: 8000, keepNewest: true, folded: e.folded, keep: inWindow }),
      LIST_CONCURRENCY);
    for (const r of results) take(r);
    /* Every prefix left is an older day, and the cap below would drop all of
       it. Stopping here is the difference between answering last night and
       paging last week to discard it. Never when the caller asked for even
       coverage: for them the older days ARE the answer. */
    if (!evenly && found.length >= max) { stoppedEarly = true; truncated = true; break; }
  }

  found.sort((a, b) => b.at - a.at);           // newest first
  let urls;
  let sampled = false;
  if (found.length > max) {
    truncated = true;
    if (evenly) { urls = thin(found, max).map(x => x.url); sampled = true; }
    else urls = found.slice(0, max).map(x => x.url);
  } else {
    urls = found.map(x => x.url);
  }
  return { ok: true, urls, listed, scanned, pages, truncated, sampled, stoppedEarly, found: found.length, why };
}

module.exports = { listWindow, thin, planFor, prefixFor, prefixesFor, legacyPrefixesFor, stampOf, hourOf, TZ, LIST_CONCURRENCY };
