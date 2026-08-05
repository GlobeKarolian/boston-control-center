/* ============================================================================
   lib/blob.js - the only place this app stores audio.

   Every other lib here is dependency free, and the banner on lib/kv.js says
   why: a Vercel deploy that needs a healthy npm install is a deploy that can
   break for reasons having nothing to do with Boston. This file is the one
   exception, and the exception is argued rather than assumed.

   Blob has no published HTTP contract. There is an SDK, and the endpoints it
   calls are whatever the SDK currently calls. Hand rolling that means shipping
   a guess about somebody else's internals into a newsroom tool, and the day it
   drifts the audio stops with no error anyone would think to look for. The SDK
   is written by the people who change the API. So it goes in.

   What does not go in is the risk the zero-dependency rule was protecting
   against. The require below is guarded, and a missing or broken module leaves
   this file answering "clips are off" instead of throwing. In that state the
   relay still ships transcripts, the board still renders, the crons still run,
   and the only thing the newsroom loses is the play button. That is the whole
   point of the guard: npm can fail without Boston going dark.

   Storage sits outside Redis on purpose and permanently. The store is on a
   500,000 command a month tier that has already been hit once, and audio is
   the single biggest thing that could ever be asked to hold. Nothing in this
   file touches kv.
   ========================================================================== */

const clips = require('../app/clips.js');

/* The guarded require. Wrapped rather than declared, so that a module missing
   from node_modules is a feature that is off rather than a function that
   crashes on first call. */
let sdk = null;
let sdkWhy = '';
try {
  sdk = require('@vercel/blob');
  if (!sdk || typeof sdk.put !== 'function') { sdk = null; sdkWhy = 'the module loaded but has no put()'; }
} catch (e) {
  sdkWhy = 'the module is not installed (' + ((e && e.message) || 'no detail') + ')';
}

/* Vercel injects this when a Blob store is attached to the project. Absent, the
   feature is off in exactly the same way as a missing module, and for the same
   reason: better a quiet no than a 500 on the ingest path.

   Declared with let rather than const only so the test seam at the bottom can
   stand up a fake store without a real one existing. Nothing in normal
   operation reassigns it, and the value is never logged or returned. */
let TOKEN = String(process.env.BLOB_READ_WRITE_TOKEN || '').trim();

/* One month is the SDK default and it is far longer than anything here lives.
   A clip is immutable once written, so the only thing a long cache costs is
   nothing, and what it buys is that the second reporter to play a clip gets it
   off the CDN rather than off the store, which is the difference between a
   cache HIT and a billed Simple Operation. */
const CACHE_SECONDS = 60 * 60 * 24 * 30;

/* Bigger than any real transmission and small enough to be obviously wrong.
   Whisper is fed segments, and at 24 kbps a two minute segment is 360 KB, so a
   megabyte is a generous ceiling on a thing that should average forty-four
   kilobytes. */
const MAX_BYTES = 1024 * 1024;

/* ---- the meter ------------------------------------------------------------
   Same idea as the one in lib/kv.js, and written after the same lesson.
   Nothing told anyone how close the Redis quota was until writes started
   failing, so this counts from the first request a container serves.

   Blob bills puts as Advanced Operations at five dollars a million. At the
   measured rate of 223 transmissions an hour that is about 160,000 a month and
   about seventy-five cents, which is not a number worth worrying about. It is
   still a number worth being able to see, because the way this gets expensive
   is a retry loop nobody noticed, and a retry loop shows up here as a rate
   rather than as a bill four weeks later. */
const METER = { puts: 0, bytes: 0, fails: 0, deletes: 0, lists: 0, since: Date.now() };

function meter() {
  const mins = Math.max(1, (Date.now() - METER.since) / 60000);
  return {
    on: enabled(),
    why: enabled() ? '' : reason(),
    puts: METER.puts,
    fails: METER.fails,
    deletes: METER.deletes,
    lists: METER.lists,
    megabytes: Math.round(METER.bytes / 10485.76) / 100,
    upMin: Math.round(mins),
    perMin: Math.round((METER.puts / mins) * 10) / 10,
    /* Advanced Operations only. Reads are Simple Operations and are billed
       against a separate, far larger allowance that nothing here can exhaust. */
    projectedMonthlyPuts: Math.round((METER.puts / mins) * 60 * 24 * 30),
    projectedMonthlyUSD: Math.round(((METER.puts / mins) * 60 * 24 * 30 / 1e6) * 5 * 100) / 100,
  };
}

function enabled() { return !!(sdk && TOKEN); }

function reason() {
  if (!sdk) return 'clip storage is off: ' + (sdkWhy || 'the blob module is unavailable');
  if (!TOKEN) return 'clip storage is off: no BLOB_READ_WRITE_TOKEN, so no store is attached';
  return '';
}

/* ---- writing --------------------------------------------------------------

   Returns a URL, or null. Never throws, and that is deliberate rather than
   lazy. The only caller is the endpoint the relay posts audio to, and the
   transcript that clip belongs to has already been accepted by then. A clip
   that fails to store must cost the newsroom a play button, not a
   transmission. */
async function putClip(bytes, row, opts) {
  if (!enabled()) return { ok: false, why: reason() };
  const buf = Buffer.isBuffer(bytes) ? bytes : null;
  if (!buf || !buf.length) return { ok: false, why: 'no audio in the request body' };
  if (buf.length > MAX_BYTES) {
    return { ok: false, why: 'audio is ' + buf.length + ' bytes, over the ' + MAX_BYTES + ' cap' };
  }

  const path = clips.pathFor(row);
  if (!path) return { ok: false, why: 'could not name the clip: no usable feed or timestamp' };

  const ms = (opts && opts.timeoutMs) || 8000;
  const started = Date.now();
  try {
    const out = await withTimeout(sdk.put(path, buf, {
      access: 'public',
      token: TOKEN,
      contentType: (opts && opts.contentType) || 'audio/mp4',
      /* On, because two transmissions can land on the same channel in the same
         second and the alternative is an overwrite that silently loses one.
         The URL the store keeps is whatever comes back, so an unpredictable
         name costs nothing. */
      addRandomSuffix: true,
      cacheControlMaxAge: CACHE_SECONDS,
    }), ms);
    const url = out && out.url;
    if (!clips.ok(url)) {
      METER.fails++;
      return { ok: false, why: 'the store answered with a URL this app will not serve' };
    }
    METER.puts++;
    METER.bytes += buf.length;
    return { ok: true, url: url, pathname: (out && out.pathname) || path, bytes: buf.length,
      ms: Date.now() - started };
  } catch (e) {
    METER.fails++;
    return { ok: false, why: 'clip upload failed: ' + ((e && e.message) || 'no detail') };
  }
}

/* ---- retention ------------------------------------------------------------

   Audio is the one thing here that grows without a ceiling, and the ceiling it
   would otherwise find is a bill. At the measured rate a day of every channel
   is about 230 megabytes, so a week is a gigabyte and a half and a year is
   eighty. A week is the window, because a week is longer than any story a
   reporter is still chasing off a scanner clip and short enough that the
   number never becomes a conversation.

   Deletes are free. Listing is not, but it is one Advanced Operation per
   thousand blobs, so a day is six and a sweep is under a hundred. The sweep
   walks a window of days rather than only the cutoff day, so a stretch of
   missed crons cleans itself up instead of leaving a bill nobody can explain. */
async function sweep(opts) {
  if (!enabled()) return { ok: false, why: reason(), deleted: 0 };
  const days = (opts && typeof opts.days === 'number') ? opts.days : 7;
  const back = (opts && typeof opts.back === 'number') ? opts.back : 14;
  const now = (opts && opts.now) || new Date().toISOString();
  const budget = (opts && typeof opts.maxDeletes === 'number') ? opts.maxDeletes : 20000;

  const folders = clips.sweepDays(days, now, back);
  let deleted = 0, scanned = 0;
  const touched = [];

  for (const day of folders) {
    if (!day || deleted >= budget) break;
    const before = deleted;
    let cursor = undefined, safety = 0;
    for (;;) {
      if (safety++ > 200) break;
      let page;
      try {
        METER.lists++;
        page = await withTimeout(sdk.list({
          token: TOKEN, prefix: 'clips/' + day + '/', limit: 1000, cursor: cursor,
        }), 15000);
      } catch (e) { break; }
      const blobs = (page && page.blobs) || [];
      if (!blobs.length) break;
      scanned += blobs.length;
      /* Checked one at a time against expired() rather than trusted because
         the prefix was built from the same rule. Belt and braces on the one
         operation here that destroys something. A listing that came back with
         an unexpected prefix deletes nothing instead of deleting everything. */
      const doomed = blobs
        .filter((b) => b && clips.expired(b.pathname, days, now))
        .map((b) => b.url)
        .filter((u) => clips.ok(u))
        .slice(0, Math.max(0, budget - deleted));
      if (doomed.length) {
        try {
          await withTimeout(sdk.del(doomed, { token: TOKEN }), 20000);
          deleted += doomed.length;
          METER.deletes += doomed.length;
        } catch (e) { /* next page; a failed delete costs storage, not audio */ }
      }
      /* Stop paging the moment the budget is gone. Without this the sweep keeps
         listing pages it has already decided not to act on, which is a real
         Advanced Operation each time and buys nothing. */
      if (deleted >= budget) break;
      cursor = page && page.hasMore ? page.cursor : null;
      if (!cursor) break;
    }
    /* Compared against the count this day started on, not against zero. The
       running total is non-zero for every day after the first one that found
       something, and a cron log that lists forty days as cleared when three
       were is a log nobody reads twice. */
    if (deleted > before) touched.push(day);
  }
  return { ok: true, deleted: deleted, scanned: scanned, days: folders, cleared: touched };
}

/* ---- plumbing ------------------------------------------------------------- */

/* The SDK does its own retrying, which is the right default for a page that is
   uploading somebody's photo and the wrong one for a request sitting in front
   of a scanner relay that has forty more transmissions queued behind it. This
   caps the wait so a slow store slows the audio and never the transcripts. */
function withTimeout(p, ms) {
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error('the store did not answer within ' + ms + 'ms'));
    }, ms);
    Promise.resolve(p).then(
      (v) => { if (done) return; done = true; clearTimeout(t); resolve(v); },
      (e) => { if (done) return; done = true; clearTimeout(t); reject(e); },
    );
  });
}

module.exports = {
  enabled,
  reason,
  putClip,
  sweep,
  meter,
  MAX_BYTES,
  /* Test seam. tools/test-blob.js swaps in a fake store so the sweep's paging,
     its budget and its refusal to delete anything outside the window are all
     testable without a network or a bill.

     The second argument is a stand-in for the token, and it exists because
     enabled() checks for one. It is a fixed string in the test file and never
     a real credential: the fake store does not look at it, and no request
     leaves the machine. */
  _inject(fake, token) {
    sdk = fake;
    sdkWhy = fake ? '' : 'injected null';
    if (typeof token === 'string') TOKEN = token;
  },
  _sdk() { return sdk; },
};
