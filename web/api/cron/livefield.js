// api/cron/livefield.js
// One live correction cycle: up to 120 BestTime probes at four concurrent,
// plus the bike dock deltas, rendered into anchors.
//
// The re-entrancy guard lives inside livefield.once() rather than here,
// because what it protects is BestTime's scraper and not this handler. See
// the note above once() in activity/livefield.js.

const { cronAuth, json } = require('../../lib/http');
const livefield = require('../../activity/livefield.js');

module.exports = async (req, res) => {
  if (!cronAuth(req)) return json(res, { error: 'unauthorized' }, { status: 401 });
  const t0 = Date.now();
  try {
    const d = await livefield.once();
    if (d && d.skipped) return json(res, { skipped: d.skipped, ms: Date.now() - t0 });
    return json(res, {
      ok: true,
      anchors: d.anchors.length,
      besttime: d.coverage.besttime,
      bikes: d.coverage.bikes,
      hourLocal: d.hourLocal,
      ms: Date.now() - t0,
    });
  } catch (e) {
    return json(res, { error: 'livefield cycle failed', detail: String(e.message || e).slice(0, 300), ms: Date.now() - t0 },
      { status: 500 });
  }
};
