/* ============================================================================
   City pulse - BestTime Radar sweep over Boston.

   This is the "Discover the pulse of the city" behaviour: instead of polling a
   hand-picked watchlist one venue at a time, sweep bounding boxes across the
   metro with GET /venues/filter and take back every venue in the box along with
   its 24-hour foot-traffic curve. The curve is what makes the hour scrubber in
   the UI free: once a venue's day_raw_whole is on the client, moving the slider
   from 6AM to 2AM costs zero API calls.

   HONESTY, because this one is easy to get wrong.
   BestTime busyness is 0-100 RELATIVE TO EACH VENUE'S OWN WEEKLY PEAK. A packed
   coffee shop reads 100 and so does a packed arena. Rendering these as a heat
   surface therefore shows WHERE COMMERCIAL VENUES ARE NEAR THEIR OWN NORMAL
   PEAK, which is not the same thing as where people are. It is also not a
   headcount and must never be summed into one. The UI legend says so and
   pulse.json carries the disclaimer in-band so it travels with the data.

   Coverage bias worth stating out loud: BestTime derives from venues that have
   enough Google foot-traffic volume to model. That means dense commercial
   strips are well covered and residential and lower-income areas are thin. A
   cold patch on this map means "few modelled venues here", not "nobody here".

   Env:
     BESTTIME_API_KEY_PRIVATE   required, else this module is inert
     PULSE_LIVE                 "0" to skip the live pass (default on)
     PULSE_TILES                grid size per side, default 4 (so 16 tiles)
   ========================================================================== */

const kv = require('../lib/kv.js');

const API = 'https://besttime.app/api/v1';
const KEY = process.env.BESTTIME_API_KEY_PRIVATE || '';

/* The metro box. Wider than the city line on purpose: Cambridge, Somerville,
   Brookline, Chelsea and Everett are all part of the same nightly rhythm and a
   map that stops at the Boston boundary looks broken to anyone who lives here. */
const BOX = { latMin: 42.2270, latMax: 42.4160, lngMin: -71.1930, lngMax: -70.9860 };

const TILES = Math.max(1, parseInt(process.env.PULSE_TILES || '4', 10));
const LIVE_PASS = process.env.PULSE_LIVE !== '0';

/* /venues/filter is capped at 30 requests a minute, separately from the 300/min
   account limit. 2.2s between calls keeps us under it with room to spare. */
const PACE_MS = 2200;
const PAGE_LIMIT = 250;      // venues per request
const MAX_PAGES = 2;         // per tile, so at most 500 venues from any one box
const LIVE_BUSY_MIN = 45;    // only spend live lookups where something is happening

const sleep = ms => new Promise(r => setTimeout(r, ms));

function tiles() {
  const out = [];
  const dLat = (BOX.latMax - BOX.latMin) / TILES;
  const dLng = (BOX.lngMax - BOX.lngMin) / TILES;
  for (let i = 0; i < TILES; i++) {
    for (let j = 0; j < TILES; j++) {
      out.push({
        latMin: BOX.latMin + i * dLat, latMax: BOX.latMin + (i + 1) * dLat,
        lngMin: BOX.lngMin + j * dLng, lngMax: BOX.lngMin + (j + 1) * dLng,
      });
    }
  }
  return out;
}

/** Never let the key reach a log line, a stack trace or an error message. */
const redact = s => String(s).replace(/api_key_private=[^&\s"]*/g, 'api_key_private=REDACTED');

async function filterCall(params, timeoutMs) {
  const qs = new URLSearchParams({ api_key_private: KEY, ...params }).toString();
  const url = API + '/venues/filter?' + qs;
  let res;
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new Error(redact('venues/filter request failed: ' + e.message));
  }
  if (!res.ok) {
    let body = '';
    try { body = (await res.text()).slice(0, 200); } catch { /* ignore */ }
    throw new Error(redact('venues/filter -> HTTP ' + res.status + ' ' + body));
  }
  return res.json();
}

/* BestTime's filter response has documented forecast fields but the live fields
   are not in the published example, so read them by any plausible name rather
   than assuming one. Anything we cannot find stays null, which the UI renders as
   "no live data" instead of as zero. */
function pickNum(obj, names) {
  for (const n of names) {
    const v = obj == null ? undefined : obj[n];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

function normalizeVenue(v, windowStart) {
  const lat = Number(v.venue_lat), lng = Number(v.venue_lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  /* 24 hourly values. day_raw_whole is the full day; day_raw is only the hours
     that survived the filter, so prefer the whole.

     CRITICAL: index 0 is NOT midnight. BestTime's day runs 6AM to 5AM the next
     morning, so index 0 is 6AM by default. Their docs: "the foot traffic data
     time window ranges from 6 AM until 5 AM next day. Not from midnight to
     midnight." Verified against the MFA, which reports open 10 to 17 and has
     its curve sitting at indexes 4 through 10. Left uncorrected, every venue on
     the map would peak six hours off. We rotate to real hour-of-day here, once,
     so nothing downstream has to think about it. */
  const raw = Array.isArray(v.day_raw_whole) ? v.day_raw_whole
            : Array.isArray(v.day_raw) ? v.day_raw : null;
  let hours = null;
  if (raw && raw.length === 24) {
    const off = Number.isFinite(+windowStart) ? ((+windowStart % 24) + 24) % 24 : 6;
    hours = new Array(24);
    for (let i = 0; i < 24; i++) {
      const n = +raw[i];
      hours[(i + off) % 24] = Number.isFinite(n) ? n : 0;
    }
  }

  const live = pickNum(v, ['venue_live_busyness', 'live_busyness', 'venue_live'])
            ?? pickNum(v.venue_live_data, ['venue_live_busyness', 'busyness']);
  const liveDelta = pickNum(v, ['venue_live_forecasted_delta', 'live_forecasted_delta'])
            ?? pickNum(v.venue_live_data, ['venue_live_forecasted_delta', 'delta']);

  const info = v.day_info || {};
  return {
    id: v.venue_id || (v.venue_name + '|' + lat.toFixed(5) + ',' + lng.toFixed(5)),
    name: v.venue_name || 'Unnamed venue',
    type: v.venue_type || null,
    address: v.venue_address || null,
    lat, lng,
    rating: Number.isFinite(+v.rating) ? +v.rating : null,
    reviews: Number.isFinite(+v.reviews) ? +v.reviews : null,
    priceLevel: Number.isFinite(+v.price_level) ? +v.price_level : null,
    dwellMin: Number.isFinite(+v.venue_dwell_time_min) ? +v.venue_dwell_time_min : null,
    dwellMax: Number.isFinite(+v.venue_dwell_time_max) ? +v.venue_dwell_time_max : null,
    openHour: Number.isFinite(+info.venue_open) ? +info.venue_open : null,
    closeHour: Number.isFinite(+info.venue_closed) ? +info.venue_closed : null,
    dayMax: Number.isFinite(+info.day_max) ? +info.day_max : null,
    dayMean: Number.isFinite(+info.day_mean) ? +info.day_mean : null,
    hours,
    live, liveDelta,
  };
}

/** Boston local hour and weekday, independent of the machine's timezone. */
function bostonNow(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', hour12: false, weekday: 'short',
  }).formatToParts(d);
  const hour = Number(p.find(x => x.type === 'hour').value) % 24;
  const wd = p.find(x => x.type === 'weekday').value;
  const dayInt = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[wd];
  return { hour, dayInt };
}

/** One sweep. Forecast pass over every tile, then an optional live pass. */
async function sweep(opts = {}) {
  if (!KEY) {
    return { venues: [], errors: [], coverage: { enabled: false, reason: 'BESTTIME_API_KEY_PRIVATE not set' } };
  }

  const { hour, dayInt } = bostonNow();
  const grid = tiles();
  const byId = new Map();
  const errors = [];
  let calls = 0, sampled = false;

  /* ---- pass A: forecast. Cheap, broad, gives every venue its 24h curve. ---- */
  for (const t of grid) {
    for (let page = 0; page < MAX_PAGES; page++) {
      let j;
      try {
        j = await filterCall({
          lat_min: t.latMin, lat_max: t.latMax, lng_min: t.lngMin, lng_max: t.lngMax,
          day_int: dayInt, foot_traffic: 'both',
          limit: PAGE_LIMIT, page, order_by: 'reviews', order: 'desc',
        }, 45000);
      } catch (e) { errors.push(e.message); break; }
      calls++;

      /* The API states its own window per response. Trust that over our
         default of 6, because BestTime can shift it per query. */
      const wStart = j.window && Number.isFinite(+j.window.time_window_start)
        ? +j.window.time_window_start : 6;

      const list = Array.isArray(j.venues) ? j.venues : [];
      for (const raw of list) {
        const v = normalizeVenue(raw, wStart);
        if (v && !byId.has(v.id)) byId.set(v.id, v);
      }
      await sleep(PACE_MS);
      if (list.length < PAGE_LIMIT) break;   // last page for this tile
    }
  }

  /* ---- there is no pass B. ----
     This originally ran a second sweep with foot_traffic:'live' to layer real
     time busyness over the forecast. The API rejects it: foot_traffic accepts
     only limited, day, or both, and none of them return a live field. Live
     busyness is a separate per-venue endpoint, and it only refreshes on the
     clock hour anyway.

     So this file is honestly a FORECAST layer: what a normal Saturday at 10PM
     looks like across the city, scrubs through the whole day for free because
     each venue ships its own 24h curve, and costs nothing per scrub. It is the
     backdrop. The things that actually move in real time are Bluebikes dock
     flow at 60 second resolution and MBTA occupancy at 30, both in the activity
     layer. Do not let this file pretend otherwise in the UI. */

  const venues = [...byId.values()];
  return {
    venues,
    errors,
    coverage: {
      enabled: true,
      tiles: grid.length,
      calls,
      venues: venues.length,
      withCurve: venues.filter(v => v.hours).length,
      kind: 'forecast',
      live: false,
      hourLocal: hour,
      dayInt,
      note: 'Typical busyness for this weekday, not a live reading. Values are '
          + 'relative to each venue\'s own weekly peak, never a headcount. Thin '
          + 'coverage means few modelled venues, not few people.',
    },
  };
}

/* ---- persistence ----------------------------------------------------------

   Two keys, on purpose.

   The internal one carries the venue id, which livefield needs to ask BestTime
   about a specific venue. Ids are 56 random-looking characters and they do not
   compress, so shipping 3,390 of them to every browser in the newsroom would
   roughly double the wire size of the largest payload on the page to serve a
   field the page never reads.

   The browser one carries what the map actually draws. Measured on a real
   sweep: 1.47 MB down to 0.56 MB raw, 280 KB down to 113 KB gzipped, 87 KB
   brotli. Same venues, same curves, nothing dropped that anything reads.
*/
const K_VENUES = 'bcc:pulse:venues';   // internal, livefield reads this
const K_META   = 'bcc:out:pulse:meta'; // small header, read route rebuilds around it
const K_OUT    = 'bcc:out:pulse:venues';
const TTL = 36 * 3600;                 // survives a missed sweep, dies before it lies about the weekday

const DISCLAIMER = 'FORECAST, NOT LIVE. This is the typical pattern for this weekday, '
  + 'built from historical foot traffic. It will show a busy Fenway at 7PM on a '
  + 'game night and an equally busy one on a night with no game. Busyness is 0-100 '
  + 'relative to each venue\'s own weekly peak, so it is not a headcount and values '
  + 'from different venues are not comparable as volumes. Absence of a venue means '
  + 'it is not modelled, not that it is empty. For what is actually happening right '
  + 'now, read the bike flow and transit occupancy in the activity layer.';

const r5 = n => Math.round(Number(n) * 1e5) / 1e5;   // 1.1m, finer than any venue is a point

async function once() {
  const r = await sweep();
  const { hour, dayInt } = bostonNow();

  const internal = r.venues.map(v => ({
    id: v.id, name: v.name, lat: r5(v.lat), lng: r5(v.lng),
    reviews: v.reviews || 0, hours: v.hours,
  }));
  const browser = r.venues.map(v => ({
    name: v.name, type: v.type, lat: r5(v.lat), lng: r5(v.lng),
    reviews: v.reviews || 0, hours: v.hours,
  }));

  const meta = {
    generatedAt: new Date().toISOString(),
    hourLocal: hour,
    dayInt,
    kind: 'forecast',
    disclaimer: DISCLAIMER,
    coverage: r.coverage,
    errors: r.errors,
  };

  await kv.setBig(K_VENUES, JSON.stringify(internal), TTL);
  await kv.setBig(K_OUT, JSON.stringify(browser), TTL);
  await kv.set(K_META, JSON.stringify(meta), TTL);

  return { venues: r.venues.length, calls: r.coverage.calls || 0, errors: r.errors, dayInt, hourLocal: hour };
}

/* What livefield needs: the curve, the coordinates, and the id to probe with. */
async function loadVenues() {
  const s = await kv.getBig(K_VENUES);
  if (!s) return [];
  try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}

module.exports = { sweep, once, loadVenues, bostonNow, BOX, K_VENUES, K_META, K_OUT };
