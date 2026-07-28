/* ============================================================================
   Activity layer: the connector contract.

   Every source of "where are people right now" produces the same record shape,
   regardless of whether the number came from a stadium capacity, a train's
   occupancy sensor, or a foot traffic vendor.

   The point of this file is honesty about provenance. A crowd estimate derived
   from a published capacity and a schedule is a fundamentally different claim
   than one read off a live sensor, and the UI has to be able to tell them
   apart. So every record carries how it was derived and how much to trust it.
   ========================================================================== */

/**
 * Confidence tiers, strongest to weakest. These are claims about the NUMBER,
 * not about whether the event is happening.
 *
 *   measured   a sensor or official count reported this. MBTA occupancy,
 *              post-game announced attendance.
 *   modelled   a known quantity (venue capacity, typical fill) run through a
 *              documented curve. We know a sellout crowd is at Fenway; we are
 *              modelling how many are inside at 6:42pm specifically.
 *   relative   we know something is unusually busy but have no headcount.
 *              BestTime deltas live here. Never render these as people.
 */
const CONFIDENCE = ['measured', 'modelled', 'relative'];

/**
 * Lifecycle of a crowd. Matters more than the raw number for a newsroom: a
 * venue that is about to release 37,000 people onto Lansdowne Street is a
 * traffic story, a transit story, and sometimes a public safety story.
 */
const PHASE = ['pending', 'building', 'peak', 'dispersing', 'ended'];

/**
 * Build a normalized activity record.
 *
 * @param {object} o
 * @param {string} o.id           stable across polls, so the UI can animate
 * @param {string} o.source       connector id, e.g. 'mlb', 'mbta'
 * @param {string} o.label        human name, e.g. 'Fenway Park'
 * @param {number} o.lat
 * @param {number} o.lon
 * @param {number|null} o.people  estimated headcount, or null for 'relative'
 * @param {string} o.confidence   one of CONFIDENCE
 * @param {string} o.basis        plain-language derivation, shown in the UI.
 *                                If you cannot write this sentence, you do not
 *                                understand your own number well enough to ship it.
 * @param {string} o.phase        one of PHASE
 * @param {object} [o.detail]     source-specific extras
 * @param {number} [o.radiusM]    rough spatial extent, metres
 * @param {string} [o.startsAt]   ISO
 * @param {string} [o.endsAt]     ISO
 */
function activity(o) {
  if (!CONFIDENCE.includes(o.confidence)) {
    throw new Error('activity: bad confidence "' + o.confidence + '"');
  }
  if (!PHASE.includes(o.phase)) {
    throw new Error('activity: bad phase "' + o.phase + '"');
  }
  if (o.confidence === 'relative' && o.people != null) {
    // Guard rail. A relative signal rendered as a headcount is exactly the
    // kind of quiet lie that gets a number into print.
    throw new Error('activity: "relative" records must not carry a people count');
  }
  if (!o.basis || o.basis.length < 10) {
    throw new Error('activity: every record needs a basis sentence');
  }
  return {
    id: String(o.id),
    source: o.source,
    label: o.label,
    lat: o.lat, lon: o.lon,
    people: o.people == null ? null : Math.round(o.people),
    confidence: o.confidence,
    basis: o.basis,
    phase: o.phase,
    radiusM: o.radiusM || 150,
    startsAt: o.startsAt || null,
    endsAt: o.endsAt || null,
    detail: o.detail || {},
    observedAt: new Date().toISOString(),
  };
}

/* ---------------------------------------------------------------------------
   Crowd curve.

   A stadium is not N people at an instant. It fills, holds, and empties. For
   "how many people are near this incident right now" the curve matters more
   than the headline capacity.

   Shape, as a fraction of peak attendance:

     gates open        0.00 -> 0.85   (linear over `doorsMin` before start)
     start -> end      0.85 -> 1.00   (rises through the first fifth, then holds)
     end -> +exitMin   1.00 -> 0.00   (linear dispersal)

   These are assumptions, not measurements. They are deliberately conservative
   and they are stated in every record's `basis` so nobody mistakes them for
   observed data.
   --------------------------------------------------------------------------- */
function crowdCurve(now, startsAt, endsAt, opts = {}) {
  const doorsMin = opts.doorsMin ?? 90;
  const exitMin = opts.exitMin ?? 45;

  const t = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const t0 = new Date(startsAt).getTime();
  const t1 = new Date(endsAt).getTime();
  const doorsAt = t0 - doorsMin * 60000;
  const emptyAt = t1 + exitMin * 60000;

  if (t < doorsAt) return { fraction: 0, phase: 'pending' };
  if (t < t0) {
    return { fraction: 0.85 * ((t - doorsAt) / (t0 - doorsAt)), phase: 'building' };
  }
  if (t <= t1) {
    const through = (t - t0) / Math.max(1, t1 - t0);
    // reach full house about a fifth of the way in, then hold
    const f = through < 0.2 ? 0.85 + 0.15 * (through / 0.2) : 1.0;
    return { fraction: f, phase: 'peak' };
  }
  if (t < emptyAt) {
    return { fraction: 1 - (t - t1) / (emptyAt - t1), phase: 'dispersing' };
  }
  return { fraction: 0, phase: 'ended' };
}

module.exports = { activity, crowdCurve, CONFIDENCE, PHASE };
