/* ============================================================================
   lib/baseline.js - what normal sounds like, per feed, per hour, per weekday.

   The severity layer in threat.js reads one transmission at a time and asks
   whether the words in it are dangerous. That catches the loud thing. It is
   blind to the quiet thing, which in a newsroom is usually the more valuable
   of the two: Boston Police district traffic running at three times its
   Tuesday-evening norm, with no single transmission saying anything alarming,
   is a story before anybody says a word worth alerting on.

   So this file learns the shape of ordinary traffic and reports departures
   from it. Two quantities per bucket:

     volume  how many transmissions an hour usually carries
     mix     what fraction of them are medical, alarm, violent-crime and so on

   Both are kept as decayed running sums rather than a full history. A decayed
   sum costs one hash field per bucket forever, it never needs a backfill job,
   and it lets the baseline follow the city as the city changes. A feed that
   gets busier every summer should not spend August reporting an anomaly.

   COLD START is the design problem. A weekday-and-hour bucket only fills once
   a week, so the most specific baseline needs about a month before it means
   anything, and Matt needs value before that. The answer is three baselines
   at three resolutions, written on every seal and read as a cascade: the exact
   Tuesday-9pm bucket when it has enough weight, the pooled 9pm-any-day bucket
   when it does not, and the feed's overall hourly average when neither does.
   Every answer names which one it used, because "three sigma over the Tuesday
   norm" and "three sigma over the all-hours average" deserve different levels
   of trust and the analyst should be able to see which one they got.
   ========================================================================== */

const kv = require('./kv.js');
const { CATEGORIES } = require('./threat.js');

const NS       = 'bcc:base:v2';
const LIVE_TTL = 6 * 60 * 60;    // a live hour counter outlives any sane cron delay

/* One observation per bucket per week, so a half life of six weeks is a decay
   of 0.891 per observation. Effective sample size asymptotes near 9, which is
   enough to estimate a mean and a spread without pinning the baseline to how
   the city sounded last spring. */
const DECAY     = Math.pow(0.5, 1 / 6);
const MIN_N     = 3;             // below this the bucket abstains rather than guesses
const MIN_COUNT = 2;             // never call a mix anomaly on a single transmission

/* ---- Boston local time ----------------------------------------------------
   Vercel runs UTC and the question is always asked in local terms. Nobody in
   the newsroom wants to know about 02:00 Wednesday UTC, they want to know
   about Tuesday night. Intl does the whole job including daylight saving, with
   no dependency and no table to maintain.

   The one imperfection is the November hour that happens twice. Both copies
   fold into the same bucket, which is the bucket that already describes that
   hour, so the cost is one slightly heavier observation once a year. */

const FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour12: false,
  weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit',
});
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const DOW_NAME = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function localParts(ms) {
  const p = {};
  for (const x of FMT.formatToParts(new Date(ms || Date.now()))) p[x.type] = x.value;
  // hour12:false emits 24 for midnight on some ICU builds, which would put a
  // whole hour in a bucket that no reader ever looks at.
  const hour = Number(p.hour) % 24;
  return {
    dow: DOW[p.weekday] ?? 0,
    hour,
    minute: Number(p.minute) || 0,
    stamp: p.year + p.month + p.day + String(hour).padStart(2, '0'),
  };
}

/* Wall clock label for a bucket, the way a person would say it. */
function label(dow, hour) {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return DOW_NAME[dow] + ' ' + h + (hour < 12 ? 'am' : 'pm');
}

const liveKey    = (feed, stamp) => NS + ':live:' + feed + ':' + stamp;
const upKey      = stamp => NS + ':up:' + stamp;
const profileKey = feed => NS + ':prof:' + feed;
const FEEDS_KEY  = NS + ':feeds';

/* ---- liveness sampling ----------------------------------------------------
   The hardest number in this file is zero. A quiet hour on a police channel is
   a real and interesting fact, and a relay that fell over produces exactly the
   same reading. Record the second as if it were the first and the baseline
   teaches itself that Boston goes silent at 4am, which is roughly the moment
   the tool stops being worth having.

   So liveness is sampled rather than assumed. A cron ticks once a minute, asks
   which feeds report themselves live, and stamps them here. At the end of the
   hour a feed that logged 50-odd beats spread across 50-odd minutes was
   demonstrably listening, and its zero is a fact about the city. A feed with
   nine beats was not, and its hour is thrown away rather than averaged in.

   One hash per hour for the whole fleet, not one per feed, because the cron is
   the only writer and it can do the arithmetic for six feeds in a single read
   and a single write. Two Redis operations a minute is a rounding error next
   to what one ingest already costs. */
const MIN_BEATS = 40;            // of ~60, so a feed may miss ten minutes and still count
const MIN_SPAN  = 40 * 60;       // and those minutes must be spread, not clustered at :59
const MIN_COVER = 0.7;           // an hour less covered than this is not evidence of anything

async function beat(feeds, at) {
  const now = Number(at) || Date.parse(at) || Date.now();
  const { stamp } = localParts(now);
  const t = Math.floor(now / 1000);
  const list = [...new Set((feeds || []).map(f => String(f || '').trim()).filter(Boolean))];
  if (!list.length) return { marked: 0, stamp };

  // __all__ is the fleet-wide series, and the fleet is listening whenever any
  // one of its feeds is. Marked alongside the real feeds so the combined
  // profile gets the same honesty test as the individual ones.
  list.push('__all__');

  const k = upKey(stamp);
  const h = await kv.hgetall(k);
  const write = {};
  for (const f of list) {
    if (!h['f:' + f]) write['f:' + f] = String(t);
    write['l:' + f] = String(t);
    write['b:' + f] = String((Number(h['b:' + f]) || 0) + 1);
  }
  await kv.hset(k, write);
  if (!Object.keys(h).length) {
    await kv.raw([['EXPIRE', k, LIVE_TTL]]);
    // Registered here as well as on the transmission path, because a feed that
    // is up and quiet is exactly the feed this whole mechanism exists to
    // describe, and it would otherwise never appear in the roster at all.
    const reg = {};
    for (const f of list) reg[f] = String(now);
    await kv.hset(FEEDS_KEY, reg);
  }
  return { marked: list.length, stamp };
}

/* What the sampler saw for one feed in one hour, as a fraction of the hour.
   Returns cover:null rather than cover:0 when there is no record at all, so a
   caller can tell "the sampler says this feed was dead" from "the sampler was
   not running", which are very different claims. */
async function uptime(feed, at) {
  const { stamp } = localParts(at);
  const h = await kv.hgetall(upKey(stamp));
  if (!Object.keys(h).length) return { cover: null, beats: 0, span: 0, why: 'no liveness record' };
  const beats = Number(h['b:' + feed]) || 0;
  const first = Number(h['f:' + feed]) || 0;
  const last  = Number(h['l:' + feed]) || 0;
  const span  = first && last ? last - first : 0;
  const cover = Math.min(1, Math.min(beats / 60, span / 3600) || 0);
  return {
    cover: r3(cover), beats, span,
    up: beats >= MIN_BEATS && span >= MIN_SPAN,
    why: beats ? beats + ' beats over ' + Math.round(span / 60) + ' minutes' : 'never seen live this hour',
  };
}

/* Three resolutions, most specific first. The cascade walks this in order and
   takes the first one carrying enough weight to speak. */
const scopes = (dow, hour) => [
  { field: 'd' + dow + 'h' + hour, res: 'exact', says: label(dow, hour) },
  { field: 'h' + hour,             res: 'hour',  says: (hour % 12 === 0 ? 12 : hour % 12) + (hour < 12 ? 'am' : 'pm') + ' on any day' },
  { field: 'all',                  res: 'feed',  says: 'this feed at any hour' },
];

/* ---- accumulation ---------------------------------------------------------
   bump() runs on the ingest path, once per transmission. It is deliberately
   the cheapest thing in this file: one HSET into an hour-scoped hash, no read,
   no lock, no parse. Ingest latency is what the newsroom feels, and a counter
   that slows the map down would get switched off inside a week.

   Redis has HINCRBY, which would make this a single atomic op. The kv layer
   in front of it speaks a deliberately small subset of Redis and adding a
   command means adding it to the memory fallback too, so the read-modify-write
   below is the honest cost of keeping that surface small. The race it exposes
   is between two concurrent POSTs, which costs at most one transmission out of
   an hourly total, and the baseline is a distribution rather than a ledger.
   The far larger race, ten transmissions from one POST each counting
   themselves, is closed by grouping the batch before writing it. */

async function addTo(feed, stamp, counts) {
  const k = liveKey(feed, stamp);
  const h = await kv.hgetall(k);
  const write = {};
  let add = 0;
  for (const c in counts) {
    const d = Number(counts[c]) || 0;
    if (d <= 0) continue;
    const cat = CATEGORIES.includes(c) ? c : 'other';
    const f = 'c:' + cat;
    // Two source categories can fold into the same bucket, so the running
    // total has to come out of `write` once it is there rather than out of
    // the hash we read, or the second one silently replaces the first.
    write[f] = String((f in write ? Number(write[f]) : (Number(h[f]) || 0)) + d);
    add += d;
  }
  if (!add) return;
  write.n = String((Number(h.n) || 0) + add);
  await kv.hset(k, write);
  // The hash has to expire on its own. A cron that misses a seal should leak
  // one key for six hours rather than forever. Set on the first write of the
  // hour only, so this costs one extra round trip an hour, not one per batch.
  if (!h.n) {
    await kv.raw([['EXPIRE', k, LIVE_TTL]]);
    await kv.hset(FEEDS_KEY, feed, String(Date.now()));
  }
}

/* The entry point ingest actually calls. Takes a whole batch, groups it by
   feed and by hour, and writes one hash per group.

   Grouping is not a micro-optimisation, it is a correctness fix. Ten
   transmissions from the same feed counted in parallel would each read the
   same total and each write that total plus one, and the hour would record
   one transmission instead of ten. */
async function observe(rows) {
  const groups = new Map();
  for (const r of rows || []) {
    const feed = String((r && r.feed) || '').trim() || 'unknown';
    const cat  = (r && r.category) || 'other';
    const { stamp } = localParts(r && r.at);
    for (const f of [feed, '__all__']) {
      const key = f + ' ' + stamp;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { feed: f, stamp, counts: {} }));
      g.counts[cat] = (g.counts[cat] || 0) + 1;
    }
  }
  for (const g of groups.values()) await addTo(g.feed, g.stamp, g.counts);
  return groups.size;
}

const bump    = (feed, category, at) => observe([{ feed, category, at }]);
const bumpAll = bump;

/* Read an hour of live counters without disturbing them. */
async function liveHour(feed, at) {
  const { stamp } = localParts(at);
  const h = await kv.hgetall(liveKey(feed, stamp));
  const mix = {};
  for (const f in h) if (f.startsWith('c:')) mix[f.slice(2)] = Number(h[f]) || 0;
  return { n: Number(h.n) || 0, mix, stamp };
}

const blank = () => ({ n: 0, s: 0, ss: 0, tot: 0, c: {} });

function readBucket(raw) {
  if (!raw) return blank();
  try {
    const b = JSON.parse(raw);
    return { n: +b.n || 0, s: +b.s || 0, ss: +b.ss || 0, tot: +b.tot || 0, c: b.c || {} };
  } catch (e) { return blank(); }
}

const r3 = x => Math.round(x * 1000) / 1000;

/* seal() folds one completed hour into the three profiles. Runs from an hourly
   cron, pointed at the hour that just ended.
   
   The `up` flag matters more than it looks. A scanner feed that reports zero
   transmissions in an hour has almost never witnessed a silent city; it has a
   relay that fell over, a Mac that went to sleep, or a Broadcastify session
   that expired. Writing those zeros into the baseline would teach the system
   that quiet is normal and then suppress the alert on the night it matters.
   So a zero is only ever recorded when the caller can affirmatively say the
   feed was healthy for that hour. Unknown health means the hour is skipped,
   which loses a little data and protects the thing the file exists for.

   `cover` is the same argument applied to the hours that are not silent. A
   relay that ran for eleven minutes and heard four transmissions is not
   evidence that this hour normally carries four; it is evidence of eleven
   minutes. Passed as a 0..1 fraction from the liveness sampler, and a partial
   hour is discarded rather than scaled up, because scaling would be inventing
   the transmissions nobody recorded. A null cover means no sampler ran, and
   the old behaviour applies. */

async function seal(feed, at, { up = null, cover = null } = {}) {
  feed = String(feed || '').trim() || 'unknown';
  const { dow, hour, stamp } = localParts(at);
  const live = await liveHour(feed, at);

  if (live.n === 0 && up !== true) return { sealed: false, why: 'silent hour, health not confirmed' };
  if (cover !== null && cover < MIN_COVER) {
    return { sealed: false, why: 'partial hour, only ' + Math.round(cover * 100) + '% covered' };
  }

  // Idempotent, because a cron that fires twice for the same hour would
  // otherwise count it twice and quietly inflate the norm.
  const first = await kv.setIfAbsent(NS + ':seal:' + feed + ':' + stamp, '1', 8 * 24 * 3600);
  if (!first) return { sealed: false, why: 'already sealed' };

  const key = profileKey(feed);
  const h = await kv.hgetall(key);
  const write = {};

  for (const sc of scopes(dow, hour)) {
    const b = readBucket(h[sc.field]);
    const c = {};
    for (const k in b.c) { const v = (Number(b.c[k]) || 0) * DECAY; if (v > 0.02) c[k] = r3(v); }
    for (const k in live.mix) c[k] = r3((c[k] || 0) + live.mix[k]);
    write[sc.field] = JSON.stringify({
      n:   r3(b.n   * DECAY + 1),
      s:   r3(b.s   * DECAY + live.n),
      ss:  r3(b.ss  * DECAY + live.n * live.n),
      tot: r3(b.tot * DECAY + Object.values(live.mix).reduce((a, x) => a + x, 0)),
      c,
    });
  }

  await kv.hset(key, write);
  return { sealed: true, feed, n: live.n, bucket: label(dow, hour) };
}

/* ---- reading the baseline -------------------------------------------------
   Walk the cascade and answer from the finest resolution that carries weight.
   Returns ok:false rather than a guess when nothing does, because a fabricated
   norm produces a fabricated anomaly and there is no way to tell them apart
   downstream. */

async function expect(feed, at) {
  const { dow, hour } = localParts(at);
  const h = await kv.hgetall(profileKey(feed));

  for (const sc of scopes(dow, hour)) {
    const b = readBucket(h[sc.field]);
    if (b.n < MIN_N) continue;

    const mean = b.s / b.n;
    const varr = Math.max(0, b.ss / b.n - mean * mean);

    // Two floors on the spread, and both are load bearing. A bucket that has
    // seen 12, 12 and 12 has a measured spread of zero, and dividing by it
    // turns thirteen transmissions into an infinite z-score. The Poisson floor
    // says a count process that averages 12 will naturally wander by about
    // 3.5, and the absolute floor of 1 covers the quietest feeds.
    const sd  = Math.max(Math.sqrt(varr), Math.sqrt(Math.max(mean, 1)), 1);
    const tot = b.tot || Object.values(b.c).reduce((a, x) => a + Number(x || 0), 0);

    const p = {};
    if (tot > 0) for (const k in b.c) p[k] = Number(b.c[k]) / tot;

    return { ok: true, res: sc.res, says: sc.says, n: r3(b.n), mean: r3(mean), sd: r3(sd), p, weight: r3(tot) };
  }
  return { ok: false, res: 'none', says: 'no baseline yet', n: 0 };
}

const sigma = z => (Math.round(Math.abs(z) * 10) / 10) + ' sigma';

/* score() compares one observed hour against its baseline and says, in words,
   what is unusual about it. Two independent tests:

     volume  is this feed carrying more traffic than it usually does
     mix     is it carrying a different kind of traffic than it usually does

   The second is the more interesting one and the one nothing else in the
   system does. A district that runs its normal forty transmissions an hour but
   where nine of them are violent-crime instead of the usual one has not gotten
   louder, it has changed character, and that is the shift a reporter wants. */

async function score(feed, at, observed) {
  const exp = await expect(feed, at);
  const n = Math.max(0, Number(observed && observed.n) || 0);
  const mix = (observed && observed.mix) || {};
  if (!exp.ok) return { ok: false, feed, n, level: 'unknown', res: 'none', why: 'no baseline for this feed yet', categories: [] };

  const z = (n - exp.mean) / exp.sd;

  // Per-category, against the count the baseline mix predicts for an hour this
  // size. The +0.5 is a prior: without it, two transmissions of a category the
  // baseline has never seen scores a clean 2 sigma, and every feed produces one
  // of those most nights.
  const categories = [];
  if (exp.weight >= 30) {
    for (const k in mix) {
      const seen = Number(mix[k]) || 0;
      if (seen < MIN_COUNT) continue;
      if (k === 'chatter' || k === 'unintelligible' || k === 'unit-status') continue;  // volume of these tracks the feed, not the city
      const e  = (exp.p[k] || 0) * n + 0.5;
      const cz = (seen - e) / Math.sqrt(Math.max(e, 1));
      if (cz >= 2) categories.push({ category: k, seen, expected: r3(e), z: r3(cz) });
    }
    categories.sort((a, b) => b.z - a.z);
  }

  // A baseline pooled across every hour of the week is a weak instrument, so
  // it is allowed to raise a flag and not allowed to raise an alarm.
  let level = 'normal';
  if (z >= 2 || (categories[0] && categories[0].z >= 2.5)) level = 'watch';
  if (z >= 3 || (categories[0] && categories[0].z >= 3.5)) level = 'high';
  if (exp.res === 'feed' && level === 'high') level = 'watch';

  const bits = [];
  if (z >= 2)       bits.push(n + ' transmissions against a norm of ' + Math.round(exp.mean) + ' for ' + exp.says + ' (' + sigma(z) + ')');
  else if (z <= -2) bits.push('quiet, ' + n + ' transmissions against a norm of ' + Math.round(exp.mean) + ' for ' + exp.says);
  for (const c of categories.slice(0, 2)) bits.push(c.seen + ' ' + c.category + ' where ' + (c.expected < 1.2 ? 'under 1' : Math.round(c.expected)) + ' is usual');

  return {
    ok: true, feed, n, level,
    z: r3(z), res: exp.res, basis: exp.says, mean: exp.mean, sd: exp.sd, samples: exp.n,
    categories: categories.slice(0, 4),
    why: bits.join(', ') || 'within normal range',
  };
}

/* ---- fleet level ---------------------------------------------------------- */

/* The synthetic fleet total is stored like a feed and is not one, so it never
   appears in a list of feeds. */
const feeds = async () => Object.keys(await kv.hgetall(FEEDS_KEY)).filter(f => f !== '__all__');

/* Every feed, scored against the hour in progress. This is what the dashboard
   and the alerting cron both read. It also totals the fleet, because a night
   where six feeds each run 1.5 sigma hot is a citywide event that no single
   feed would ever report. */
async function report(at) {
  const when = at || Date.now();
  const list = await feeds();
  const rows = [];
  let n = 0;
  const mix = {};

  for (const f of list) {
    const live = await liveHour(f, when);
    n += live.n;
    for (const k in live.mix) mix[k] = (mix[k] || 0) + live.mix[k];
    rows.push(await score(f, when, live));
  }

  const city = await score('__all__', when, { n, mix });
  const { dow, hour } = localParts(when);

  rows.sort((a, b) => (Number(b.z) || 0) - (Number(a.z) || 0));
  return {
    at: when, bucket: label(dow, hour), n,
    city,
    feeds: rows,
    elevated: rows.filter(r => r.level === 'high' || r.level === 'watch').map(r => r.feed),
  };
}

/* What the profile currently believes, for a debug endpoint and for the
   verification pass. Small enough to return whole. */
async function snapshot(feed) {
  const h = await kv.hgetall(profileKey(feed));
  const out = {};
  for (const f in h) {
    const b = readBucket(h[f]);
    if (b.n < 0.5) continue;
    out[f] = { n: r3(b.n), mean: r3(b.s / b.n), weight: r3(b.tot) };
  }
  return out;
}

/* Seal the hour that just ended, for every feed the sampler saw plus the fleet
   total, using the sampler's own record of who was actually listening.

   Both halves of the honesty test live here rather than in the caller: an
   hour with no transmissions needs proof the relay was up, and an hour with
   transmissions needs proof the relay was up for most of it. A feed the
   sampler never saw at all gets neither, so it is skipped and says why. */
async function sealHour(at) {
  const when = at || Date.now();
  const list = await feeds();
  list.push('__all__');
  const out = [];
  for (const f of list) {
    const u = await uptime(f, when);
    // cover:null means the sampler left no record for this hour at all, which
    // is what a fresh deploy or an expired key looks like. Fall back to the
    // pre-sampler rule rather than refusing to learn anything.
    const r = await seal(f, when, {
      up: u.cover === null ? null : u.up,
      cover: u.cover,
    });
    out.push({ feed: f, ...r, cover: u.cover, liveness: u.why });
  }
  const { dow, hour } = localParts(when);
  return { bucket: label(dow, hour), sealed: out.filter(r => r.sealed).length, feeds: out };
}

module.exports = {
  observe, bump, bumpAll, beat, uptime, seal, sealHour, expect, score,
  report, snapshot, liveHour, feeds,
  localParts, label, scopes,
  DECAY, MIN_N, MIN_COVER, NS,
};
