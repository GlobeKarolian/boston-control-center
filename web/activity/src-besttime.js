/* ============================================================================
   BestTime live busyness.

   Inert without BESTTIME_API_KEY_PRIVATE. The rest of the layer works today;
   this lights up when a key exists.

   What this emits and what it does not:

   BestTime returns busyness as 0-100 RELATIVE TO EACH VENUE'S OWN WEEKLY PEAK.
   A packed coffee shop reads 100. A packed TD Garden reads 100. That makes the
   raw value useless as a density measure, so this connector never emits a
   people count. Every record here is confidence 'relative' and the contract
   enforces that a relative record carries no headcount.

   What it emits instead is the DELTA: live busyness minus the forecast for this
   hour. A venue 30 points above its own normal Tuesday afternoon is anomalous,
   and anomalies are the newsworthy part. Level is noise, delta is signal.

   Cost note: live data is Pro tier at 1 credit per venue per call. Polling the
   full watchlist every 15 minutes is roughly 10 venues x 96 calls a day, about
   960 credits a day. Keep POLL_MINUTES honest about that.
   ========================================================================== */

const { activity } = require('./contract.js');
const { BESTTIME_WATCHLIST } = require('./venues.js');

const API = 'https://besttime.app/api/v1';
const KEY = process.env.BESTTIME_API_KEY_PRIVATE || '';

/** Only surface venues that deviate meaningfully. Below this, it is just a
 *  normal day and putting it on the map is noise. */
const DELTA_THRESHOLD = 20;

async function liveFor(venue, timeoutMs = 12000) {
  const url = API + '/forecasts/live?api_key_private=' + encodeURIComponent(KEY)
    + '&venue_name=' + encodeURIComponent(venue.name)
    + '&venue_address=' + encodeURIComponent(venue.address);

  const res = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(venue.name + ' -> HTTP ' + res.status);
  return res.json();
}

async function collect(opts = {}) {
  if (!KEY) {
    return {
      items: [],
      errors: [],
      coverage: { enabled: false, reason: 'BESTTIME_API_KEY_PRIVATE not set' },
    };
  }

  const watchlist = opts.watchlist || BESTTIME_WATCHLIST;
  const items = [];
  const errors = [];
  let available = 0;

  // Sequential on purpose. Each call costs a credit and the vendor rate limits.
  for (const v of watchlist) {
    try {
      const j = await liveFor(v);
      const a = j.analysis || {};
      if (!a.venue_live_busyness_available) continue;
      available++;

      const delta = Number(a.venue_live_forecasted_delta);
      if (!Number.isFinite(delta) || Math.abs(delta) < DELTA_THRESHOLD) continue;

      const info = j.venue_info || {};
      const lat = Number(info.venue_lat), lon = Number(info.venue_lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      items.push(activity({
        id: 'bt-' + (info.venue_id || v.name.replace(/\W+/g, '-').toLowerCase()),
        source: 'besttime',
        label: info.venue_name || v.name,
        lat, lon,
        people: null,                 // never a headcount. See header.
        confidence: 'relative',
        basis: 'BestTime live busyness ' + a.venue_live_busyness + ' against a forecast of '
          + a.venue_forecasted_busyness + ' for this hour, a delta of '
          + (delta > 0 ? '+' : '') + delta + ' points. Relative to this venue only, not a headcount.',
        phase: 'peak',
        radiusM: 150,
        detail: {
          kind: 'venue-anomaly',
          delta,
          live: a.venue_live_busyness,
          forecast: a.venue_forecasted_busyness,
          direction: delta > 0 ? 'busier than normal' : 'quieter than normal',
        },
      }));
    } catch (e) {
      errors.push(e.message);
    }
  }

  return {
    items,
    errors,
    coverage: {
      enabled: true,
      watched: watchlist.length,
      liveAvailable: available,
      // Matters editorially: BestTime live needs high foot traffic volume, so
      // absence clusters in lower-income neighbourhoods. Absence is not calm.
      note: 'Venues without live data are omitted, not zero.',
    },
  };
}

module.exports = { collect, DELTA_THRESHOLD };
