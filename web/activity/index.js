/* ============================================================================
   Composite activity layer.

   Merges every source into one snapshot of where people are in Boston right
   now, with per-source attribution and an explicit statement of what the layer
   cannot see.

   Design rule: this file never invents a number. It sums what the connectors
   report and it reports what they could not report. A source being down and a
   source reporting zero are different facts and are kept apart.

   ---------------------------------------------------------------------------
   WHAT CHANGED IN THE MOVE OFF THE MAC.

   This was a long-lived process with two module-scope objects, `cache` and
   `lastRun`, and the cadence table below was enforced against them. A
   serverless invocation gets a fresh module every time, so with no other change
   every source would be polled on every cron tick. That is 60 BestTime sweeps
   an hour against a table that asks for four, and BestTime is the one source
   that costs money per call.

   So the cadence table is now enforced against a shared Redis record per
   source, which has the useful side effect of making the throttle hold across
   every caller rather than per process. The failure semantics are unchanged and
   deliberately so: a failed source keeps its last good items, gains an error
   line, is marked stale, and still consumes its cadence slot. Retrying a broken
   source at full cron rate is how a transient outage turns into a rate limit.
   ========================================================================== */

const kv = require('../lib/kv.js');
const cache = require('./src-cache.js');

const events = require('./src-events.js');
const mbta = require('./src-mbta.js');
const besttime = require('./src-besttime.js');
const bikes = require('./src-bikes.js');

const K_OUT = 'bcc:out:activity';
/* Longer than any cadence below, so a source between polls is never treated as
   missing, but short enough that a cron that stopped firing goes visibly blank
   instead of serving a half hour old map with a confident looking timestamp. */
const OUT_TTL_SEC = 15 * 60;

/* Poll cadences. Events change slowly, transit changes constantly, BestTime
   costs money per call. Bikes match the GBFS ttl of 60 seconds: polling faster
   returns the same file, polling slower loses the shape of a letout. */
const CADENCE_MS = {
  events: 5 * 60 * 1000,
  mbta: 30 * 1000,
  besttime: 15 * 60 * 1000,
  bikes: 60 * 1000,
};

const norm = r => ({ items: r.items || [], errors: r.errors || [], coverage: r.coverage || {} });

async function runSource(name, fn) {
  const prev = await cache.read(name, CADENCE_MS[name]);
  if (prev && !prev.stale && prev.data) return norm(prev.data);

  const last = prev && prev.data ? norm(prev.data) : { items: [], errors: [], coverage: {} };
  let rec;
  try {
    rec = norm(await fn());
  } catch (e) {
    // Keep the last good data rather than blanking the map, but say so.
    rec = {
      items: last.items,
      errors: [name + ': ' + e.message],
      coverage: { stale: true, ...last.coverage },
    };
  }
  /* Written even on failure, on purpose. The write is what advances the cadence
     clock, and a source that is failing should be retried on its own schedule
     rather than on every invocation. */
  try { await cache.write(name, rec); } catch (e) { /* a cold cache costs a poll, not a wrong answer */ }
  return rec;
}

async function snapshot() {
  const at = new Date();

  const [ev, mb, bt, bk] = await Promise.all([
    runSource('events', () => events.collect(at)),
    runSource('mbta', () => mbta.collect()),
    runSource('besttime', () => besttime.collect()),
    runSource('bikes', () => bikes.collect()),
  ]);

  const items = [...ev.items, ...mb.items, ...bt.items, ...bk.items];
  const errors = [...ev.errors, ...mb.errors, ...bt.errors, ...bk.errors];

  // Only count people from sources that actually claim headcounts. Relative
  // signals are excluded by construction: they have no people value.
  const counted = items.filter(i => i.people != null);
  const totalPeople = counted.reduce((s, i) => s + i.people, 0);

  const byConfidence = { measured: 0, modelled: 0, relative: 0 };
  for (const i of items) if (byConfidence[i.confidence] != null) byConfidence[i.confidence]++;

  const bySource = {};
  for (const i of items) {
    bySource[i.source] = bySource[i.source] || { count: 0, people: 0 };
    bySource[i.source].count++;
    bySource[i.source].people += i.people || 0;
  }

  return {
    generatedAt: at.toISOString(),
    items: items.sort((a, b) => (b.people || 0) - (a.people || 0)),
    summary: {
      places: items.length,
      peopleAccountedFor: totalPeople,
      bySource,
      byConfidence,
      /* Directional movement, kept separate from peopleAccountedFor on purpose.
         These are trips over a window, not bodies standing somewhere, and the
         two must never be added together. */
      flow: {
        windowMin: bk.coverage.windowMin || 0,
        ridersOut: bk.coverage.ridersOut || 0,
        ridersIn: bk.coverage.ridersIn || 0,
        stationsMoving: (bk.coverage.flowPoints || []).length,
        warmingUp: !!bk.coverage.warmingUp,
      },
    },
    /* What this layer cannot see. Rendered in the UI so a quiet map is never
       mistaken for a quiet city. See DEFINITION.md section 10 on coverage. */
    coverage: {
      events: ev.coverage,
      mbta: mb.coverage,
      besttime: bt.coverage,
      bikes: bk.coverage,
      blindSpots: [
        'People on foot outside venues and off transit are not counted at all.',
        'Buses do not report occupancy, so surface transit is invisible.',
        'Bike flow only sees people who chose Bluebikes, and it goes quiet in the rain.',
        'Venue coverage is limited to major ticketed events with published capacities.',
        besttime.collect && !process.env.BESTTIME_API_KEY_PRIVATE
          ? 'BestTime is not configured, so commercial venue busyness is absent.'
          : 'BestTime live coverage requires high venue volume and is sparse outside commercial districts.',
      ],
    },
    errors,
  };
}

async function once() {
  const s = await snapshot();
  await kv.setBig(K_OUT, JSON.stringify(s), OUT_TTL_SEC);
  return s;
}

function summarize(s) {
  const L = [];
  L.push('Boston activity layer  ' + s.generatedAt);
  L.push('');
  L.push('  ' + s.summary.peopleAccountedFor.toLocaleString() + ' people accounted for across '
    + s.summary.places + ' places');
  L.push('  confidence: ' + s.summary.byConfidence.measured + ' measured, '
    + s.summary.byConfidence.modelled + ' modelled, ' + s.summary.byConfidence.relative + ' relative');
  L.push('');
  for (const [src, v] of Object.entries(s.summary.bySource)) {
    L.push('  ' + src.padEnd(10) + String(v.count).padStart(4) + ' places'
      + (v.people ? '   ~' + v.people.toLocaleString() + ' people' : ''));
  }
  L.push('');
  L.push('  top:');
  for (const i of s.items.slice(0, 8)) {
    const n = i.people != null ? '~' + i.people.toLocaleString() : i.detail.delta > 0
      ? '+' + i.detail.delta + ' vs normal' : String(i.detail.delta) + ' vs normal';
    L.push('    ' + n.padStart(16) + '  ' + i.label + '  (' + i.confidence + ', ' + i.phase + ')');
  }
  if (s.coverage.mbta && s.coverage.mbta.vehiclesSeen != null) {
    L.push('');
    L.push('  mbta coverage: ' + s.coverage.mbta.vehiclesReporting + '/'
      + s.coverage.mbta.vehiclesSeen + ' vehicles reporting ('
      + s.coverage.mbta.reportingPct + '%)');
  }
  if (s.errors.length) {
    L.push('');
    L.push('  errors:');
    s.errors.forEach(e => L.push('    ' + e));
  }
  return L.join('\n');
}

module.exports = { snapshot, once, summarize, runSource, CADENCE_MS, K_OUT };
