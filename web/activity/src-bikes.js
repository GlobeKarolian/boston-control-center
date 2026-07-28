/* ============================================================================
   Bluebikes dock flow - measured, directional, live.

   This is the connector that answers "the game just let out, where did they
   go". Every other source in this layer tells you how many people are somewhere.
   This one tells you which way they are moving, because a docked bikeshare
   system reports its inventory every 60 seconds and inventory only changes when
   a human takes a bike out or puts one back.

   A dock losing 9 bikes in 10 minutes means 9 people left from that corner. A
   dock gaining 9 means 9 arrived. Both are counts of real trips, not a model.

   REBALANCING is the one thing that lies here. Lyft moves bikes by van, usually
   in clumps of 10 or more within a couple of minutes, and that looks identical
   to a crowd. Anything above REBALANCE_SUSPECT in a single polling interval is
   flagged rather than silently reported as people.

   Coverage honesty: about 600 docks, concentrated in Boston, Cambridge,
   Somerville, Brookline, Everett and Chelsea. Bikeshare skews younger, fairer
   weather and shorter trips. It is a real sample of movement, not a census of
   it, and it goes quiet in the rain.

   Feed: GBFS 1.1 via Lyft. No key. station_status ttl is 60s.
   ========================================================================== */

const { activity } = require('./contract.js');
const hist = require('./bike-history.js');

const BASE = 'https://gbfs.lyft.com/gbfs/1.1/bos/en';


/* How far back to measure flow. Fifteen minutes is long enough to accumulate a
   readable signal and short enough that a stadium letout has not finished. */
const WINDOW_MS = 15 * 60 * 1000;
/* Keep a little more than the window so a restart mid-event still has history. */
const HIST_MS = 45 * 60 * 1000;
/* Below this a station is just normal churn and does not belong on the map. */
const MIN_FLOW = 3;
/* Above this in one poll interval, suspect a rebalancing van. */
const REBALANCE_SUSPECT = 8;

let stationInfo = null;      // id -> {name, lat, lon, capacity}
let stationInfoAt = 0;
const INFO_TTL = 6 * 60 * 60 * 1000;

async function getJSON(url, timeoutMs = 15000) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'BostonNewsroomControlCenter/1.0' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(url.split('/').pop() + ' -> HTTP ' + res.status);
  return res.json();
}

async function loadInfo(now) {
  if (stationInfo && now - stationInfoAt < INFO_TTL) return stationInfo;
  const j = await getJSON(BASE + '/station_information.json');
  const m = new Map();
  for (const s of (j.data?.stations || [])) {
    const lat = Number(s.lat), lon = Number(s.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    m.set(String(s.station_id), {
      name: s.name || 'Dock ' + s.station_id,
      lat, lon,
      capacity: Number(s.capacity) || null,
    });
  }
  stationInfo = m; stationInfoAt = now;
  return m;
}

/* ---- history ----
   Flow is a difference, so it needs a past. We keep a rolling file of dock
   inventories. Only bike counts are stored, keyed by station id, because that
   is the whole of what the delta needs and the file gets rewritten every poll. */

/* ---- history ----
   Same contract as the file version it replaces: an ordered set of past dock
   inventories to difference against. The storage moved to Redis, the shape did
   not. loadHistory returned every snapshot because reading the file was free;
   here the index is read and exactly one snapshot is fetched. */

/* Pick the snapshot to measure against. We want one about WINDOW_MS old, but
   we refuse anything younger than MIN_AGE_MS: over two minutes the deltas are
   single bikes and the map turns into static. Returns null on a cold start,
   which the caller reports honestly rather than papering over with zeros. */
const MIN_AGE_MS = 4 * 60 * 1000;

function pickBaseline(snaps, now) {
  const target = now - WINDOW_MS;
  let best = null, bestGap = Infinity;
  for (const s of snaps) {
    const age = now - s.t;
    if (age < MIN_AGE_MS || age > HIST_MS) continue;
    const gap = Math.abs(s.t - target);
    if (gap < bestGap) { bestGap = gap; best = s; }
  }
  return best;
}

/* Wording matters here. A dock LOSING bikes means people took them and rode
   away, so that corner is emptying. A dock GAINING bikes means people rode in
   and parked, so that corner is filling. Getting this backwards would put the
   Fenway crowd in exactly the wrong place, so it is stated once, in one spot,
   and every sign downstream follows from these two lines. */
function phaseFor(delta) { return delta > 0 ? 'building' : 'dispersing'; }

function basisFor(delta, name, mins) {
  const n = Math.abs(delta);
  return delta > 0
    ? n + ' bikes were returned to ' + name + ' in the last ' + mins + ' minutes. '
      + 'Every bike returned is one rider who arrived at this corner. Counted from '
      + 'dock inventory, not estimated.'
    : n + ' bikes were taken from ' + name + ' in the last ' + mins + ' minutes. '
      + 'Every bike taken is one rider who left this corner. Counted from '
      + 'dock inventory, not estimated.';
}

async function collect() {
  const now = Date.now();
  const errors = [];

  const info = await loadInfo(now);
  const st = await getJSON(BASE + '/station_status.json');
  const rows = st.data && Array.isArray(st.data.stations) ? st.data.stations : [];

  const cur = {};                 // id -> bikes available, this poll
  const live = new Map();         // id -> full row, this poll only
  let offline = 0, full = 0, empty = 0;

  for (const s of rows) {
    const id = String(s.station_id);
    const meta = info.get(id);
    if (!meta) continue;
    if (s.is_installed === 0 || (s.is_renting === 0 && s.is_returning === 0)) { offline++; continue; }
    const n = Number(s.num_bikes_available);
    if (!Number.isFinite(n)) { offline++; continue; }
    cur[id] = n;
    live.set(id, s);
    if (Number(s.num_docks_available) === 0) full++;
    if (n === 0) empty++;
  }

  const idx = await hist.index();
  const ref = pickBaseline(idx, now);
  const base = ref ? await hist.get(ref.t) : null;
  try {
    await hist.put(now, cur);
  } catch (e) {
    errors.push('bikes: could not persist history: ' + e.message);
  }

  const items = [];
  const flowPoints = [];
  let arrivals = 0, departures = 0, suspect = 0, compared = 0;
  const mins = base ? Math.max(1, Math.round((now - base.t) / 60000)) : 0;

  for (const id of Object.keys(cur)) {
    if (!base) break;
    const prev = base.b[id];
    if (typeof prev !== 'number') continue;   // station appeared since baseline
    compared++;
    const delta = cur[id] - prev;
    if (delta === 0) continue;

    const meta = info.get(id);
    const row = live.get(id);
    /* Rebalancing vans are the one thing in this feed that lies. They move
       bikes in clumps of ten or more with no rider involved. We do not delete
       those stations, we flag them and keep them out of the totals, because a
       van arriving is still worth seeing on the map. */
    const rebalance = Math.abs(delta) >= REBALANCE_SUSPECT;
    if (rebalance) suspect++;
    else if (delta > 0) arrivals += delta;
    else departures += -delta;

    flowPoints.push({
      lat: meta.lat, lon: meta.lon, net: delta,
      name: meta.name, suspect: rebalance,
    });

    if (Math.abs(delta) < MIN_FLOW) continue;   // below this it is normal churn

    items.push(activity({
      id: 'bike-' + id,
      source: 'bikes',
      label: meta.name,
      lat: meta.lat, lon: meta.lon,
      /* Deliberately null. These riders are in motion, not standing here, so
         adding them to peopleAccountedFor would double count against transit
         and against the venue models. The count lives in detail instead. */
      people: null,
      confidence: 'measured',
      basis: rebalance
        ? Math.abs(delta) + ' bikes moved at ' + meta.name + ' in ' + mins
          + ' minutes. That is a large enough jump that a Bluebikes rebalancing '
          + 'van is the likely cause rather than riders. Flagged, not counted.'
        : basisFor(delta, meta.name, mins),
      phase: phaseFor(delta),
      radiusM: 150,
      detail: {
        kind: 'bike-flow',
        net: delta,
        delta,                       // alias so the CLI summary renders it
        riders: Math.abs(delta),
        direction: delta > 0 ? 'in' : 'out',
        bikesNow: cur[id],
        docksFree: row ? Number(row.num_docks_available) : null,
        capacity: meta.capacity,
        windowMin: mins,
        suspectRebalance: rebalance,
      },
    }));
  }

  return {
    items,
    coverage: {
      stations: rows.length,
      reporting: Object.keys(cur).length,
      offline,
      compared,
      windowMin: mins,
      ridersOut: departures,
      ridersIn: arrivals,
      net: arrivals - departures,
      suspectRebalance: suspect,
      /* Every reporting station with any movement, for the heat layer. Items
         above are the threshold-filtered subset meant for the incident list. */
      flowPoints,
      warmingUp: !base,
      note: base
        ? 'Dock deltas over ' + mins + ' minutes. Each bike is one rider. '
          + 'Riders who did not use Bluebikes are invisible here.'
        : 'First poll. Flow needs a second reading at least '
          + Math.round(MIN_AGE_MS / 60000) + ' minutes from now before it can show anything.',
      /* Saturation is a real blind spot: a dock with no free slots cannot
         record an arrival and an empty dock cannot record a departure. */
      docksFull: full,
      docksEmpty: empty,
    },
    errors,
  };
}

module.exports = { collect, pickBaseline, phaseFor, BASE, WINDOW_MS };

if (require.main === module) {
  collect()
    .then(r => {
      console.log(JSON.stringify({ coverage: { ...r.coverage, flowPoints: r.coverage.flowPoints.length },
        top: r.items.slice(0, 10).map(i => i.label + '  ' + (i.detail.net > 0 ? '+' : '') + i.detail.net),
        errors: r.errors }, null, 2));
    })
    .catch(e => { console.error('bikes failed:', e.message); process.exit(1); });
}
