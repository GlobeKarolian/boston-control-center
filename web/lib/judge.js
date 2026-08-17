// lib/judge.js
//
// Everything that stands between a model's enthusiasm and a reporter's phone.
//
// WHY THIS IS ITS OWN FILE.
//
// There are two ways a situation reaches the board. api/cron/analyst.js runs
// in the cloud on a schedule; api/analyst-report.js accepts a report from a
// model running on the Mac mini, and when it does the cron stands down for ten
// minutes. The header of that second file says every guardrail the cloud path
// has runs there identically. It did not. The severity floor and the verifier
// were only ever written into the cron, so on the local path the raw model's
// word was the only judgment on the board, and the ten-minute stand-down meant
// nothing else was going to check it either.
//
// That is precisely the Walden Street failure the floor and the verifier were
// built to stop, resurrected on the second code path. The fix is not to copy
// the block; copying is what produced three vault readers with one bug in
// them. It is to have one block and two callers.
//
// WHAT IT DOES, IN ORDER, CHEAPEST FIRST.
//
// 1. THE FLOOR. lib/severity.js scores a situation on what was observed:
//    signals in the transcripts, agencies converged, units committed, minutes
//    elapsed, and how far above normal the radio is running for this hour of
//    this week. The model's own read is then capped at one notch above that,
//    so "Active Shooter" assembled from a single unit clearing an address
//    settles at a 1 rather than a 5.
//
// 2. THE SECOND OPINION. lib/verify.js shows the claim and the raw transcripts
//    to a model from a different lab, with the writer's confidence stripped
//    out, and asks whether the transcripts support it. Anything it cannot
//    stand up is held: the card keeps its transmissions and its audio and says
//    what failed. Only claims that already look like news are worth the call.
//
// 3. `major`, which is the only thing Situations Mode and the alarm read.

'use strict';

const severity = require('./severity');
const verify = require('./verify');
const baseline = require('./baseline');
const stream = require('./stream');

/* How busy each feed is against what this hour of this week normally sounds
   like, plus the same reading for the fleet as a whole.

   The fleet number was computed nowhere and passed nowhere, so the citywide
   surge clause in lib/severity.js was dead code: six feeds each running hot is
   an event no single feed would report, and that is the one signal that
   survives transcription failing completely. It is the South Station clause
   and it was never armed. */
async function anomalies(rows) {
  const byFeed = {};
  let fleet = { level: 'normal' };
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return { byFeed, fleet };
  try {
    const density = stream.densityByFeed(list) || {};
    const feeds = [...new Set(list.map(r => r.feed || r.source || r.src).filter(Boolean))];
    for (const f of feeds) {
      byFeed[f] = await baseline.score(f, new Date(), { n: density[f] || 0, mix: {} });
    }
    /* The fleet reading is the same question asked of every feed at once.
       Scoring the total against the total baseline is what "the whole city is
       busy" means; a single hot feed is already covered by byFeed. */
    const hot = Object.values(byFeed).filter(Boolean);
    const high = hot.filter(a => a.level === 'high').length;
    const watch = hot.filter(a => a.level === 'watch').length;
    if (high >= 3) fleet = { level: 'high', why: high + ' feeds well above normal at once' };
    else if (high + watch >= 4) fleet = { level: 'watch', why: (high + watch) + ' feeds above normal at once' };
  } catch (e) { /* no baseline yet is not a failure; normal is the safe read */ }
  return { byFeed, fleet };
}

/* A row's feed under any of the three names it might carry it under. The
   analyst filters situations by this, and reading only `feed` is what made
   every situation score over zero transmissions for an entire night. */
const feedOf = (r) => (r && (r.feed || r.source || r.src)) || null;

/* Judge a disposed situation list.
 *
 *   fresh   situations out of core.disposeReported()
 *   batch   the transmissions the model actually read this run. NOT the vault
 *           stream: on a Blob outage that is empty, and scoring every
 *           situation over zero transmissions floors them all at 1, puts
 *           nothing on the board, and reports success.
 *   rows    optional, the wider window used only for the baseline reading
 *
 * Returns the same list, each item carrying severity, severityLabel,
 * severityWhy, severityCapped, held/heldWhy, verified/verifiedBy and major.
 */
async function judge(fresh, opts) {
  const o = opts || {};
  const batch = Array.isArray(o.batch) ? o.batch : [];
  const { byFeed, fleet } = await anomalies(o.rows && o.rows.length ? o.rows : batch);

  return Promise.all((fresh || []).map(async (f0) => {
    let f = f0;
    const mine = batch.filter(r => (f.feeds || []).includes(feedOf(r)));
    const feeds = [...new Set(mine.map(feedOf).filter(Boolean))];
    const units = [...new Set(mine.flatMap(r => r.units || []))];
    const span = mine.length > 1
      ? (+new Date(mine[mine.length - 1].at) - +new Date(mine[0].at)) / 60000 : 0;
    const worst = feeds.map(x => byFeed[x]).filter(Boolean)
      .sort((a, b) => (b.z || 0) - (a.z || 0))[0] || { level: 'normal' };

    const fl = severity.floor({ tx: mine, feeds, units, spanMin: span, anomaly: worst, fleet });
    const modelScore = f.priority === 'high' ? 4 : 2;
    const settled = severity.settle(fl, { score: modelScore });
    f.severity = settled.score;
    f.severityLabel = severity.label(settled.score);
    f.severityWhy = fl.reasons;
    if (settled.capped) f.severityCapped = settled.why;
    if (settled.score < 3) f.priority = 'normal';

    if (!f.held && settled.score >= 3) {
      const v = await verify.check(f.headline + '. ' + f.summary, mine.length ? mine : batch);
      f = verify.apply(f, v);
    }
    /* The only field Situations Mode and the alarm read. */
    f.major = !f.held && f.verified === true && settled.score >= 3;
    return f;
  }));
}

module.exports = { judge, anomalies, feedOf };
