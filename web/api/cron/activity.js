// api/cron/activity.js
// Refreshes the composite activity snapshot.
//
// This fires every minute, but it does not poll every source every minute.
// Each source carries its own cadence (see CADENCE_MS in activity/index.js)
// enforced against a shared Redis record, so a tick usually refreshes bikes
// and MBTA and leaves events and BestTime alone. The cron is the heartbeat;
// the cadence table decides what actually costs anything.

const { cronAuth, json } = require('../../lib/http');
const kv = require('../../lib/kv');
const activity = require('../../activity/index.js');

const LOCK = 'bcc:lock:activity';

module.exports = async (req, res) => {
  if (!cronAuth(req)) return json(res, { error: 'unauthorized' }, { status: 401 });

  // Zero wait. If the previous tick is still in flight, this one has nothing
  // useful to add and would only double the outbound polling.
  const token = await kv.lock(LOCK, 50000, 0);
  if (!token) return json(res, { skipped: 'previous tick still running' });

  const t0 = Date.now();
  try {
    const s = await activity.once();
    return json(res, {
      ok: true,
      places: s.summary.places,
      people: s.summary.peopleAccountedFor,
      bySource: s.summary.bySource,
      flow: s.summary.flow,
      errors: s.errors,
      ms: Date.now() - t0,
    });
  } catch (e) {
    return json(res, { error: 'activity refresh failed', detail: String(e.message || e).slice(0, 300), ms: Date.now() - t0 },
      { status: 500 });
  } finally {
    await kv.unlock(LOCK, token);
  }
};
