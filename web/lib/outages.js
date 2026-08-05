// Massachusetts power outages, by municipality.
//
// SOURCE PROVENANCE, READ THIS BEFORE DEBUGGING A BAD PARSE.
//
// The endpoint and the property names below are SECONDARY evidence. They
// come from the public repository jhaddadin/massoutagemap, specifically
// mass_outage_map_cartoframes.py, which reads:
//
//     "http://mema.mapsonline.net/power_outage_public.geojson"
//
// and pulls the properties town, total_cust, no_power, pct_nopow, county,
// last_update, utility and notes off each feature. MEMA aggregates that from
// National Grid, Unitil and Eversource and refreshes it about every fifteen
// minutes.
//
// I could not observe the response myself. mema.mapsonline.net is
// robots-disallowed to the fetching tools available here, and working around
// a robots block with curl is not something I will do. So: the shape is
// documented, not measured, and that repo is old enough that MEMA may have
// renamed a column or moved the file since.
//
// Everything below is written on the assumption that the shape is wrong
// until proven right:
//
//   * pick() matches property names case-insensitively and accepts a list of
//     aliases, so no_power / noPower / NO_POWER / customers_out all land in
//     the same slot.
//   * A feature that yields no usable outage number is counted in `skipped`
//     and reported, never silently dropped. If the first real run comes back
//     "towns: 0, skipped: 351" the cause is obvious in one glance.
//   * A run that produces less data than the run before it does not
//     overwrite the run before it. A reshaped or truncated response leaves
//     the last good numbers on the board rather than blanking the layer
//     during the exact storm the layer exists for.
//
// WHY CENTROIDS AND NOT POLYGONS.
//
// The upstream file carries a polygon per municipality, all 351 of them,
// which is megabytes of coastline. The question a newsroom asks this layer
// is "which towns are dark and how badly", and a dot answers that as well as
// an outline of Barnstable's shore does. So the cron reduces each affected
// town to one area-weighted centroid and ships only the towns that actually
// have customers out. On a calm day that payload is a few hundred bytes.

const kv = require('./kv');

const KEY = 'bcc:outages';
const ENDPOINT = 'http://mema.mapsonline.net/power_outage_public.geojson';

// Twelve hours, against a source that refreshes every fifteen minutes. The
// TTL is not a freshness policy, it is a floor: it decides how long stale
// numbers stay visible after the feed has gone away entirely. Twelve hours
// means an overnight outage of the source still leaves the evening's outage
// map on the wall in the morning, clearly stamped with its age, instead of
// an empty layer. The UI is responsible for showing `at` so nobody mistakes
// old numbers for current ones.
const TTL = 12 * 3600;

// The feed is small but this is an http (not https) government host with no
// SLA, so it gets a hard timeout rather than being allowed to hang the cron.
const TIMEOUT_MS = 20000;

// Property aliases. First match wins, case and underscores ignored. The
// canonical names on the left of each list are the ones the massoutagemap
// repo uses; the rest are the names the same data carries in other state
// feeds, included because renaming a column is the single most likely way
// this breaks.
const FIELDS = {
  town: ['town', 'municipality', 'city', 'name', 'community'],
  county: ['county'],
  total: ['total_cust', 'totalcustomers', 'total_customers', 'customers', 'cust_total'],
  out: ['no_power', 'nopower', 'customers_out', 'cust_out', 'out', 'outages', 'customersaffected'],
  pct: ['pct_nopow', 'pctnopower', 'percent_out', 'pct_out'],
  utility: ['utility', 'company', 'provider'],
  updated: ['last_update', 'lastupdate', 'updated', 'last_updated', 'timestamp'],
  notes: ['notes', 'note', 'comment'],
};

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Build a lowercase-stripped index of a properties bag once, then answer
// every field lookup off it. Doing this per feature rather than per lookup
// matters at 351 features times eight fields.
function indexProps(props) {
  const ix = {};
  for (const k of Object.keys(props || {})) ix[norm(k)] = props[k];
  return ix;
}

function pick(ix, aliases) {
  for (const a of aliases) {
    const v = ix[norm(a)];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

// Numbers arrive as numbers, as strings, and as strings with thousands
// separators. "1,204" parses to 1 under parseFloat, which would understate
// an outage by three orders of magnitude and is exactly the kind of quiet
// wrongness a newsroom cannot afford, so strip separators first.
function num(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(/[, ]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Area-weighted centroid of a ring, by the standard shoelace formula.
// Returns null for a degenerate ring (zero area), which happens on
// malformed geometry and on the odd single-point "polygon"; the caller
// falls back to the bounding box in that case, which is always defined.
function ringCentroid(ring) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[i + 1];
    const f = x0 * y1 - x1 * y0;
    a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
  }
  if (!a) return null;
  a *= 0.5;
  return { lon: cx / (6 * a), lat: cy / (6 * a), area: Math.abs(a) };
}

function bboxCenter(coords) {
  let n = Infinity, s = -Infinity, e = -Infinity, w = Infinity, seen = 0;
  const walk = c => {
    if (typeof c[0] === 'number' && typeof c[1] === 'number') {
      seen++;
      if (c[1] < n) n = c[1];
      if (c[1] > s) s = c[1];
      if (c[0] < w) w = c[0];
      if (c[0] > e) e = c[0];
      return;
    }
    for (const x of c) if (Array.isArray(x)) walk(x);
  };
  if (Array.isArray(coords)) walk(coords);
  if (!seen) return null;
  return { lat: (n + s) / 2, lon: (w + e) / 2 };
}

// One point per municipality. A Massachusetts town is often several polygons
// (islands, harbour parcels), so MultiPolygon gets the area-weighted mean of
// its parts rather than the centroid of whichever ring happened to be first.
// Barnstable and Gloucester both look wrong under the naive version.
function centroid(geom) {
  if (!geom || !geom.coordinates) return null;
  const t = geom.type;

  if (t === 'Point') {
    const c = geom.coordinates;
    return Number.isFinite(c[0]) && Number.isFinite(c[1]) ? { lat: c[1], lon: c[0] } : null;
  }

  const polys = t === 'Polygon' ? [geom.coordinates]
    : t === 'MultiPolygon' ? geom.coordinates
      : null;

  if (polys) {
    let A = 0, X = 0, Y = 0;
    for (const poly of polys) {
      const outer = poly && poly[0];
      if (!Array.isArray(outer) || outer.length < 4) continue;
      const c = ringCentroid(outer);
      if (!c) continue;
      A += c.area; X += c.lon * c.area; Y += c.lat * c.area;
    }
    if (A > 0) return { lat: Y / A, lon: X / A };
  }

  return bboxCenter(geom.coordinates);
}

// Massachusetts, generously bounded. A centroid outside this box means the
// geometry is in a projection this code did not expect (state plane feet,
// most likely, which would put the coordinates in the hundreds of thousands)
// and dropping it is better than pinning a town off the coast of Africa.
const BOX = { north: 43.10, south: 41.10, east: -69.80, west: -73.60 };
const inBox = p => p && p.lat >= BOX.south && p.lat <= BOX.north && p.lon >= BOX.west && p.lon <= BOX.east;

function normalize(geojson) {
  const feats = (geojson && Array.isArray(geojson.features)) ? geojson.features : [];
  const towns = [];
  let skipped = 0, offMap = 0, totalOut = 0, totalCust = 0, updated = '';

  for (const f of feats) {
    const ix = indexProps(f && f.properties);
    const town = String(pick(ix, FIELDS.town) || '').trim();
    const out = num(pick(ix, FIELDS.out));
    const total = num(pick(ix, FIELDS.total));

    // No name or no outage number means the feature told us nothing usable.
    // Count it. A parse that quietly discards two thirds of the state should
    // be visible in the cron's own output, not discovered by a reporter
    // wondering why Worcester is missing during a storm.
    if (!town || out === null) { skipped++; continue; }

    if (total !== null) totalCust += total;

    // Towns with power are the overwhelming majority and carry no news.
    // They are dropped after being counted into the statewide totals, which
    // is what keeps the payload small enough to be free.
    if (out <= 0) continue;

    const c = centroid(f.geometry);
    if (!inBox(c)) { offMap++; continue; }

    const pctRaw = num(pick(ix, FIELDS.pct));
    const pct = pctRaw !== null ? pctRaw
      : (total && total > 0) ? (out / total) * 100
        : null;

    const u = pick(ix, FIELDS.updated);
    if (u && !updated) updated = String(u);

    totalOut += out;
    towns.push({
      town,
      county: String(pick(ix, FIELDS.county) || '').trim() || undefined,
      lat: Math.round(c.lat * 1e5) / 1e5,
      lon: Math.round(c.lon * 1e5) / 1e5,
      out,
      total: total !== null ? total : undefined,
      pct: pct !== null ? Math.round(pct * 10) / 10 : undefined,
      utility: String(pick(ix, FIELDS.utility) || '').trim() || undefined,
      notes: String(pick(ix, FIELDS.notes) || '').trim() || undefined,
    });
  }

  // Sorted by customers out, descending. Position in this array is rank, and
  // the UI is allowed to rely on that: the first entry is the worst-hit town
  // in Massachusetts right now, which is the lede.
  towns.sort((a, b) => b.out - a.out || a.town.localeCompare(b.town));

  return { towns, skipped, offMap, totalOut, totalCust, seen: feats.length, updated };
}

async function query() {
  const r = await fetch(ENDPOINT, {
    headers: {
      // Identify honestly. This is a public emergency-management file being
      // read by a newsroom dashboard, and if MEMA ever wants to ask us to
      // back off they should be able to tell who we are.
      'User-Agent': 'BostonControlCenter/1.0 (newsroom dashboard; contact via site)',
      Accept: 'application/geo+json, application/json;q=0.9, */*;q=0.5',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error('outage feed HTTP ' + r.status);
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    // A JS shell or an error page instead of geojson. Say so with a sample,
    // because "Unexpected token <" tells the next person nothing about which
    // of the several possible failures happened.
    throw new Error('outage feed did not return JSON: ' + text.slice(0, 120).replace(/\s+/g, ' '));
  }
}

async function once() {
  const t0 = Date.now();
  const gj = await query();
  const n = normalize(gj);

  const prev = await kv.getJSON(KEY, null);

  // The keep-previous guard, and the reason it is not simply "keep the run
  // with more towns": on a calm day the correct answer really is zero towns,
  // and a guard that refused to write zero would leave a storm on the map
  // for a week after it cleared. So the guard triggers on evidence that the
  // FEED is broken, not on evidence that the state is fine:
  //
  //   * we saw no features at all, or
  //   * we saw features but could not parse a single one, when a previous
  //     run could.
  //
  // Either of those means the shape changed or the file is truncated. A
  // genuine calm day still has ~351 parseable features with out === 0.
  const feedLooksBroken = n.seen === 0 || (n.seen > 0 && n.skipped === n.seen);

  if (feedLooksBroken && prev && Array.isArray(prev.towns)) {
    return {
      ok: false,
      note: 'feed unparseable, kept previous outage map',
      kept: prev.towns.length,
      seen: n.seen,
      skipped: n.skipped,
      ms: Date.now() - t0,
    };
  }

  const doc = {
    at: Date.now(),
    source: 'mema',
    sourceUpdated: n.updated || undefined,
    totalOut: n.totalOut,
    totalCust: n.totalCust || undefined,
    towns: n.towns,
  };
  await kv.setJSON(KEY, doc, TTL);

  return {
    ok: true,
    towns: n.towns.length,
    totalOut: n.totalOut,
    seen: n.seen,
    skipped: n.skipped,
    offMap: n.offMap,
    ms: Date.now() - t0,
  };
}

module.exports = { once, normalize, centroid, ringCentroid, query, KEY, TTL, ENDPOINT, FIELDS, BOX };
