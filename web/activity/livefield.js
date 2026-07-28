/* ============================================================================
   THE LIVE CORRECTION FIELD.

   The crowd heatmap is drawn from BestTime's weekly forecast, which is why the
   app has to admit in its own footer that a game night and a quiet night look
   identical. This file is the fix, and it is built around what the data can
   actually support rather than what we wish it supported.

   WHAT WE MEASURED, 26 July, and why the design looks like this:

   1. There is no bulk live endpoint. /venues/filter rejects foot_traffic=live
      outright: "Must be one of: limited, day, both." Live busyness is one HTTP
      call per venue, full stop.

   2. Their live endpoint is a scrape and it punishes parallelism. Twelve
      concurrent calls timed out 23 of 48 requests. Four concurrent completed
      40 of 40 clean, and finished faster in wall time. Hence CONC = 4.

   3. Live coverage is thin. Of venues open at midnight, 8% reported live
      busyness. Around Fenway it was 3 of the top 34 venues; the Seaport,
      Harvard Square and Back Bay returned zero. Live busyness therefore CANNOT
      be the surface. There are not enough of them to draw one.

   So it is not the surface. It is a set of ANCHORS that bend the surface.

   Every anchor is a point where we have measured, right now, that reality
   differs from the forecast, expressed as a multiplier. Beantown Pub reading
   100 against a forecast of 55 is an anchor of x1.8 at that corner. A Bluebikes
   dock that has lost nine bikes in fifteen minutes is an anchor saying people
   left this corner. Between anchors the field decays back to 1.0, which means
   "we have nothing live here, so the forecast stands".

   THE HONESTY REQUIREMENT. The field also emits its own coverage geometry, so
   the map can shade where we are actually measuring versus where we are still
   guessing. A newsroom tool that quietly presents a forecast as a live reading
   is worse than one that shows nothing, and this layer will not do it.

   ---------------------------------------------------------------------------
   WHAT CHANGED IN THE MOVE OFF THE MAC.

   The Mac ran this as one long-lived process with a setInterval, so the venue
   cache was a Map in memory and the re-entrancy guard was a boolean. Neither
   survives a serverless invocation, and the cache is the expensive one: the
   architecture note is blunt about it, losing the cache re-probes all 120
   venues cold every cycle, which is precisely the condition measured to make
   BestTime start timing out. So the Map moved to a Redis hash and the boolean
   moved to a Redis lock. Everything above this line is unchanged.
   ========================================================================== */

const kv = require('../lib/kv.js');
const pulse = require('./pulse.js');
const cache = require('./src-cache.js');

const API = 'https://besttime.app/api/v1';

const KEY = String(process.env.BESTTIME_API_KEY_PRIVATE || '').trim();
const redact = s => (KEY ? String(s).split(KEY).join('<KEY>') : String(s));

/* Four concurrent, measured not guessed. See header note 2. */
const CONC = 4;
/* BestTime live only moves on the clock hour, so asking the same venue twice in
   one hour spends a credit to receive the identical number. */
const VENUE_TTL_MS = 55 * 60 * 1000;
/* How many venues we are willing to have in flight per cycle. At roughly 70
   venues a minute this is a two minute sweep, comfortably inside the cycle. */
const BATCH = 120;
const CYCLE_MS = 5 * 60 * 1000;
/* An anchor stops mattering once you are this far from it. 500m is about a six
   minute walk, which is roughly how far a crowd signal at one bar tells you
   anything about the next block. */
const ANCHOR_RADIUS_M = 500;
/* Below this the venue is a rounding error and its multiplier is noise: a venue
   forecast at 3 that reads 6 is not a story, it is two extra people. */
const MIN_FORECAST = 15;

/* THE FENWAY FOCUS ZONE.
   When the ballpark lets out, the ballpark itself is the least interesting
   thing on the map. The story is the six blocks around it: Lansdowne filling,
   Kenmore Square filling, then both draining toward the Green Line and Boylston
   while somewhere unplanned starts to fill instead. 1800m from home plate covers
   Lansdowne, Kenmore, Brookline Ave down to the Longwood edge, the Boylston
   Street bars, and the Symphony side of Mass Ave. */
const FOCUS = { lat: 42.3467, lng: -71.0972, radiusM: 1800, name: 'Fenway' };
/* Share of the probe budget reserved for the zone. Whatever the zone cannot
   fill flows back to the rest of the metro, so this never shrinks the sweep. */
const FOCUS_SHARE = 0.6;
/* Inside the zone we probe venues the forecast calls dead, and this is the
   whole point. A bar that is normally empty at 11pm and is suddenly packed is
   exactly the World Series signal, and MIN_FORECAST is precisely the filter
   that throws it away. We can afford that here because the zone is small.
   Outside it we cannot, because most dead venues are just dead. */
const FOCUS_MIN_FORECAST = 0;

const M_PER_DEG = 111320;
const dist = (a, b, c, d) => Math.hypot((c - a) * M_PER_DEG,
  (d - b) * M_PER_DEG * Math.cos(a * Math.PI / 180));

/* ---- the venue cache, formerly a Map ------------------------------------- */

const K_SEEN = 'bcc:livefield:seen';
const K_OUT  = 'bcc:out:livefield';
const LOCK   = 'bcc:lock:livefield';
/* Every entry is stale after VENUE_TTL_MS and gets pruned on the next cycle
   anyway. The key TTL exists only so an abandoned deploy does not leave a hash
   sitting in Redis forever. */
const SEEN_KEY_TTL_SEC = 2 * 3600;

/* Stored as "epochSeconds:live:fc" rather than JSON. The hash holds up to
   eleven cycles of 120 venues and the ids are 56 high entropy characters, so
   the field names already cost more than the values; there is no reason to pay
   JSON punctuation on top of that for three numbers. An empty slot means the
   venue answered but had no live coverage, which is a different fact from
   never having been asked, and the cache has to keep them apart or the zone
   will re-probe the same dead venues every cycle forever. */
const encSeen = o => Math.round(o.at / 1000) + ':'
  + (o.live === null || o.live === undefined ? '' : o.live) + ':'
  + (o.fc === null || o.fc === undefined ? '' : o.fc);

const decSeen = s => {
  const p = String(s).split(':');
  const at = Number(p[0]) * 1000;
  if (!Number.isFinite(at) || at <= 0) return null;
  return { at, live: p[1] === '' ? null : Number(p[1]), fc: p[2] === '' ? null : Number(p[2]) };
};

/* Read the cache and drop everything past its TTL in the same pass. Pruning the
   stale entries is safe by construction: an entry past VENUE_TTL_MS is exactly
   an entry priority() has already decided is eligible to re-probe. The Mac
   version never pruned, so its reported cache size grew all night and meant
   nothing; this one reports the number of venues actually still cached. */
async function loadSeen(now) {
  let h = {};
  try { h = await kv.hgetall(K_SEEN) || {}; } catch (e) { return { seen: new Map(), expired: [] }; }
  const seen = new Map();
  const expired = [];
  for (const id in h) {
    const rec = decSeen(h[id]);
    if (!rec || now - rec.at > VENUE_TTL_MS) { expired.push(id); continue; }
    seen.set(id, rec);
  }
  return { seen, expired };
}

/* One write per cycle, not one per probe. 120 probes would otherwise be 120
   Redis round trips interleaved with the BestTime calls they are pacing. The
   cost of batching is that a function killed mid sweep loses that cycle's cache
   updates and re-probes those venues five minutes later. That is a credit,
   bounded to a single cycle, and it buys back the sweep's whole latency budget. */
async function saveSeen(fresh, expired) {
  const pairs = {};
  for (const [id, rec] of fresh) pairs[id] = encSeen(rec);
  try {
    if (expired.length) for (const id of expired) await kv.hdel(K_SEEN, id);
    if (Object.keys(pairs).length) await kv.hset(K_SEEN, pairs);
    await kv.raw([['EXPIRE', K_SEEN, SEEN_KEY_TTL_SEC]]);
  } catch (e) { /* the cache is an optimisation; losing it costs credits, not correctness */ }
}

/* ---- probing -------------------------------------------------------------- */

/* Dropping MIN_FORECAST inside the zone opens a hole: a venue reading zero at
   this hour is either quiet or shut, and the forecast curve does not say which.
   A venue that is flat zero across the whole surrounding window is shut, and a
   shut museum will never surprise us. Without this the zone spends a third of
   its budget probing the MFA and the Prudential Center at one in the morning. */
const openNear = (v, hour) => {
  for (let d = -2; d <= 2; d++) {
    if ((v.hours[((hour + d) % 24 + 24) % 24] || 0) > 0) return true;
  }
  return false;
};

async function probe(v) {
  const qs = new URLSearchParams({ api_key_private: KEY, venue_id: v.id });
  try {
    const r = await fetch(API + '/forecasts/live?' + qs,
      { method: 'POST', signal: AbortSignal.timeout(25000) });
    if (r.status !== 200) return { fail: 'HTTP ' + r.status };
    const a = (await r.json()).analysis || {};
    if (a.venue_live_busyness_available !== true) return { unavailable: true };
    return { ok: true, live: Number(a.venue_live_busyness),
             fc: Number(a.venue_forecasted_busyness),
             delta: Number(a.venue_live_forecasted_delta) };
  } catch (e) { return { fail: redact(e.message).slice(0, 40) }; }
}

/* Which venues are worth a credit this cycle. Two lists, ranked on different
   rules, because the zone and the rest of the metro are asking different
   questions.

   Across the metro the question is "where is a surprise worth spending on",
   and the answer is somewhere the forecast already expects to be humming,
   weighted by how well known it is. A venue the forecast calls empty cannot
   produce a surprise big enough to matter at that distance.

   Inside Fenway the question is "what is happening right here", and the empty
   ones are the whole point. So the zone ranks by prominence with the forecast
   demoted to a tiebreak. Ranking the zone by forecast would quietly reinstate
   the filter we just removed, since every quiet-tonight venue scores zero and
   would sit at the bottom of the list forever. */
function priority(venues, hour, now, seen) {
  const fresh = venues
    .filter(v => Array.isArray(v.hours) && v.hours.length === 24)
    .filter(v => {
      const s = seen.get(v.id);
      return !s || now - s.at > VENUE_TTL_MS;
    });

  const inZone = v => Number.isFinite(v.lat) && Number.isFinite(v.lng)
    && dist(FOCUS.lat, FOCUS.lng, v.lat, v.lng) <= FOCUS.radiusM;

  const near = fresh.filter(inZone)
    .filter(v => (v.hours[hour] || 0) >= FOCUS_MIN_FORECAST)
    .filter(v => openNear(v, hour))
    .map(v => ({ v, score: Math.log10(10 + (v.reviews || 0)) * (1 + (v.hours[hour] || 0) / 100) }));

  const wide = fresh.filter(v => !inZone(v))
    .filter(v => (v.hours[hour] || 0) >= MIN_FORECAST)
    .map(v => ({ v, score: (v.hours[hour] || 0) * Math.log10(10 + (v.reviews || 0)) }));

  const byScore = (a, b) => b.score - a.score;
  const picked = near.sort(byScore).slice(0, Math.round(BATCH * FOCUS_SHARE)).map(x => x.v);
  return picked.concat(wide.sort(byScore).slice(0, BATCH - picked.length).map(x => x.v));
}

async function sweepVenues(venues, hour, seen) {
  const now = Date.now();
  const batch = priority(venues, hour, now, seen);
  const anchors = [];
  const fresh = new Map();
  let probed = 0, avail = 0, fail = 0;
  const queue = batch.slice();

  await Promise.all(Array.from({ length: CONC }, async () => {
    while (queue.length) {
      const v = queue.shift();
      const r = await probe(v);
      probed++;
      if (r.fail) { fail++; continue; }
      fresh.set(v.id, { at: Date.now(), live: r.ok ? r.live : null, fc: r.ok ? r.fc : null });
      if (!r.ok) continue;
      avail++;
      /* The multiplier, and the one line where the whole idea lives. A venue at
         its forecast is 1.0 and changes nothing. Double its forecast is 2.0.
         Dead when it should be packed is near 0. The +8 floor keeps a venue
         forecast at 2 from producing a x50 anchor on a single quiet reading. */
      const mult = (r.live + 8) / (Math.max(r.fc, 0) + 8);
      anchors.push({
        lat: v.lat, lng: v.lng, mult: Math.round(mult * 100) / 100,
        weight: 1, src: 'besttime', label: v.name,
        live: r.live, forecast: r.fc, delta: r.delta,
        basis: v.name + ' is reading ' + r.live + ' against a forecast of ' + r.fc
          + ' for this hour, ' + (r.delta > 0 ? '+' : '') + r.delta + ' points. '
          + 'Relative to this venue\'s own weekly peak, not a headcount.',
      });
    }
  }));
  return { anchors, probed, avail, fail, eligible: batch.length, fresh };
}

/* Bikes are the other half, and the denser half: about 564 docks inside the map
   box with a median spacing of 272m, all reporting inside 60 seconds. One dock
   delta is a weak signal on its own, so these anchors carry less weight than a
   venue reading, but there are far more of them and they cover the places
   BestTime cannot see at all.

   The activity cron polls bikes every 60 seconds, so by the time this cycle
   runs there is nearly always a reading under three minutes old sitting in the
   shared cache. Reading it instead of collecting again is not only cheaper, it
   is required: see the header of src-cache.js for what two writers do to the
   dock history index. */
const BIKE_MAX_AGE_MS = 3 * 60 * 1000;

async function sweepBikes() {
  try {
    let r = null;
    let source = 'cache';
    const rec = await cache.read('bikes', BIKE_MAX_AGE_MS);
    if (rec && !rec.stale) r = rec.data;
    if (!r) {
      source = 'collected';
      const bikes = require('./src-bikes.js');
      r = await bikes.collect();
      await cache.write('bikes', r);
    }
    const pts = (r.coverage && r.coverage.flowPoints) || [];
    const win = (r.coverage && r.coverage.windowMin) || 0;
    const anchors = pts.filter(p => !p.suspect && Math.abs(p.net) >= 2).map(p => ({
      lat: p.lat, lng: p.lon,
      /* Deliberately gentle. Nine riders is not nine hundred people, but the
         DIRECTION is measured fact, so it earns a nudge and not a verdict. */
      mult: 1 + Math.max(-0.5, Math.min(0.5, p.net / 20)),
      weight: 0.45, src: 'bikes', label: p.name, net: p.net,
      basis: Math.abs(p.net) + ' bikes ' + (p.net > 0 ? 'returned to ' : 'taken from ')
        + p.name + ' in ' + win + ' minutes. Counted from dock inventory.',
    }));
    return { anchors, source, stations: (r.coverage || {}).reporting || 0, warmingUp: !!(r.coverage || {}).warmingUp };
  } catch (e) { return { anchors: [], err: redact(e.message) }; }
}

/* ---- the cycle ------------------------------------------------------------ */

async function build() {
  if (!KEY) return { skipped: 'no BESTTIME_API_KEY_PRIVATE' };

  const venues = await pulse.loadVenues();
  if (!venues.length) return { skipped: 'no pulse venues yet, run the pulse sweep first' };

  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York',
    hour: 'numeric', hour12: false }).format(new Date())) % 24;

  const { seen, expired } = await loadSeen(Date.now());

  const [vs, bikes] = await Promise.all([sweepVenues(venues, hour, seen), sweepBikes()]);
  const anchors = vs.anchors.concat(bikes.anchors);

  /* Reported after the sweep, so it counts what the NEXT cycle will find
     cached rather than what this one started with. The two sets cannot overlap:
     loadSeen already dropped everything past its TTL, and priority() only picks
     venues that are absent from what remains. */
  const cached = seen.size + vs.fresh.size;

  const doc = {
    generatedAt: new Date().toISOString(),
    hourLocal: hour,
    radiusM: ANCHOR_RADIUS_M,
    anchors,
    coverage: {
      besttime: { eligible: vs.eligible, probed: vs.probed,
                  liveAvailable: vs.avail, failed: vs.fail,
                  cachedThisHour: cached },
      bikes: { stations: bikes.stations || 0, anchors: bikes.anchors.length,
               warmingUp: !!bikes.warmingUp, source: bikes.source || 'none' },
    },
    /* Said plainly and carried in the payload so the UI cannot forget it.
       Anywhere outside an anchor's reach, what you are looking at is still the
       forecast, and the map has an obligation to say which is which. */
    honesty: 'Live corrections apply only within ' + ANCHOR_RADIUS_M + 'm of an anchor. '
      + 'Everywhere else the surface is still the historical forecast. Venues without '
      + 'live coverage are unknown, not empty.',
  };

  await saveSeen(vs.fresh, expired);
  /* TTL is four cycles. A field older than that is not worth drawing, and the
     read route would rather serve nothing than serve a twenty minute old
     "live" correction with a fresh looking timestamp next to it. */
  await kv.setBig(K_OUT, JSON.stringify(doc), Math.round((CYCLE_MS * 4) / 1000));
  return doc;
}

/* The re-entrancy guard, formerly `let running = false`.

   A cold start has an empty venue cache, so the first cycle probes all 120
   venues from scratch and can run longer than CYCLE_MS. Without this, the next
   cron tick starts a second cycle on top of the first and we double our
   concurrency against BestTime, which is the exact condition measured to make
   them time out. Skipping a beat is cheaper than stampeding them.

   It lives here rather than in the cron route because what it protects is
   BestTime, not the HTTP handler. Anything that calls this function deserves
   the guard, whether or not a cron is what called it. Zero wait: if another
   cycle holds the lease, this tick has nothing useful to do but leave. */
async function once() {
  const token = await kv.lock(LOCK, 4 * 60 * 1000, 0);
  if (!token) return { skipped: 'previous cycle still running' };
  try {
    return await build();
  } finally {
    await kv.unlock(LOCK, token);
  }
}

module.exports = {
  build, once, priority, openNear,
  ANCHOR_RADIUS_M, CYCLE_MS, VENUE_TTL_MS, FOCUS, BATCH,
  K_OUT, K_SEEN, LOCK,
};
