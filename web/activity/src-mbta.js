/* ============================================================================
   MBTA live occupancy.

   This is the only genuinely real-time headcount source in the layer that costs
   nothing. The V3 API reports per-carriage `occupancy_percentage` on heavy rail,
   so a six-car Red Line train reports six numbers, and those are sensor
   readings rather than a model.

   Two honest caveats, both surfaced in `basis`:

   1. `occupancy_percentage` semantics are not precisely documented. It is
      treated here as percent of total (seated plus standing) capacity. If that
      reading is wrong the absolute numbers scale, though the relative picture
      holds.
   2. Coverage is partial. Many vehicles report NO_DATA_AVAILABLE, and buses
      largely do not report at all. A quiet map does not mean an empty train.
      The composer reports coverage explicitly for this reason.
   ========================================================================== */

const { activity } = require('./contract.js');

const UA = 'BostonNewsroomActivityLayer/0.1';
const API = 'https://api-v3.mbta.com';

/* Per-carriage capacity, seated plus standing, by route type.
   MBTA heavy rail cars run roughly 150-180 at full load depending on series.
   Conservative mid figures used; these are approximations, stated as such. */
const CAR_CAPACITY = {
  0: 110,   // light rail (Green Line)
  1: 160,   // heavy rail (Red, Orange, Blue)
  2: 180,   // commuter rail coach
};

const ROUTE_TYPE_NAME = { 0: 'Green Line', 1: 'subway', 2: 'commuter rail' };

async function getJSON(url, timeoutMs = 12000) {
  const headers = { 'User-Agent': UA, Accept: 'application/vnd.api+json' };
  // An API key raises rate limits considerably. Works without one.
  if (process.env.MBTA_API_KEY) headers['x-api-key'] = process.env.MBTA_API_KEY;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error('mbta -> HTTP ' + res.status);
  return res.json();
}

/**
 * Estimate people aboard a vehicle from its carriage occupancy readings.
 * Returns null when the vehicle reports nothing usable, so unknown stays
 * unknown rather than silently becoming zero.
 */
function peopleAboard(attrs, routeType) {
  const cap = CAR_CAPACITY[routeType] ?? 150;
  const cars = Array.isArray(attrs.carriages) ? attrs.carriages : [];

  const withData = cars.filter(c => typeof c.occupancy_percentage === 'number');
  if (withData.length) {
    const people = withData.reduce((sum, c) => sum + (c.occupancy_percentage / 100) * cap, 0);
    return { people, cars: cars.length, reporting: withData.length, method: 'carriage' };
  }

  // Fall back to the vehicle-level status enum when per-car numbers are absent.
  const MIDPOINT = {
    EMPTY: 0.02,
    MANY_SEATS_AVAILABLE: 0.15,
    FEW_SEATS_AVAILABLE: 0.40,
    STANDING_ROOM_ONLY: 0.70,
    CRUSHED_STANDING_ROOM_ONLY: 0.90,
    FULL: 0.95,
  };
  const f = MIDPOINT[attrs.occupancy_status];
  if (f == null) return null;
  const n = Math.max(1, cars.length || 1);
  return { people: f * cap * n, cars: n, reporting: 0, method: 'status' };
}

/**
 * Collect live vehicle occupancy.
 * @param {object} opts
 * @param {number[]} [opts.routeTypes] defaults to subway + Green Line
 * @param {number}   [opts.minPeople]  suppress near-empty vehicles from the map
 */
async function collect(opts = {}) {
  const routeTypes = opts.routeTypes || [0, 1];
  const minPeople = opts.minPeople ?? 20;

  const url = API + '/vehicles?filter%5Broute_type%5D=' + routeTypes.join(',')
    + '&page%5Blimit%5D=400';
  const j = await getJSON(url);

  const items = [];
  let total = 0, reporting = 0, skipped = 0;

  for (const v of j.data || []) {
    const a = v.attributes || {};
    if (typeof a.latitude !== 'number' || typeof a.longitude !== 'number') continue;
    total++;

    // route_type is not on the vehicle; infer from the route relationship id.
    const routeId = v.relationships?.route?.data?.id || '';
    const routeType = /^Green/.test(routeId) ? 0 : 1;

    const est = peopleAboard(a, routeType);
    if (!est) { skipped++; continue; }
    reporting++;
    if (est.people < minPeople) continue;

    items.push(activity({
      id: 'mbta-' + v.id,
      source: 'mbta',
      label: routeId || ROUTE_TYPE_NAME[routeType] || 'MBTA',
      lat: a.latitude, lon: a.longitude,
      people: est.people,
      confidence: 'measured',
      basis: est.method === 'carriage'
        ? 'MBTA reported occupancy on ' + est.reporting + ' of ' + est.cars
          + ' carriages, multiplied by an assumed ' + (CAR_CAPACITY[routeType]) + ' per car.'
        : 'MBTA vehicle occupancy status "' + a.occupancy_status
          + '" mapped to a band midpoint, multiplied by an assumed ' + (CAR_CAPACITY[routeType]) + ' per car.',
      phase: 'peak',
      radiusM: 120,
      detail: {
        kind: 'transit',
        route: routeId,
        status: a.current_status,
        carriages: est.cars,
        carriagesReporting: est.reporting,
        method: est.method,
      },
    }));
  }

  return {
    items,
    coverage: {
      vehiclesSeen: total,
      vehiclesReporting: reporting,
      vehiclesNoData: skipped,
      // The honest headline: what fraction of the network we can actually see.
      reportingPct: total ? Math.round((reporting / total) * 100) : 0,
    },
    errors: [],
  };
}

module.exports = { collect, peopleAboard, CAR_CAPACITY };
