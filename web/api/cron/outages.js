// Refresh the municipal power outage map.
//
// Every fifteen minutes, because that is how often MEMA's aggregation of
// National Grid, Unitil and Eversource updates. Polling faster would return
// the same numbers; polling slower would mean a reporter watching a storm
// roll through sees a town go dark up to half an hour after it did.
//
// The interesting design decision is in lib/outages.js, not here: a run that
// comes back unparseable does not overwrite the previous run. During a storm
// this layer matters most at exactly the moment the state's own web
// infrastructure is under the most load, so "blank the map on a bad
// response" is the wrong failure mode.

const { cronAuth, json } = require('../../lib/http');
const kv = require('../../lib/kv');
const outages = require('../../lib/outages');

// Four minutes. Comfortably longer than a run (one small file, parsed once)
// and comfortably shorter than the fifteen minute cadence, so a lease that
// somehow leaks can only ever cost one cycle. waitMs 0: a double-fired cron
// gives up rather than queueing.
const LOCK = 'bcc:lock:outages';
const LEASE_MS = 4 * 60 * 1000;

module.exports = async function handler(req, res) {
  if (!cronAuth(req)) return json(res, { error: 'unauthorized' }, { status: 401 });

  const token = await kv.lock(LOCK, LEASE_MS, 0);
  if (!token) return json(res, { skipped: 'locked' });

  try {
    return json(res, await outages.once());
  } catch (e) {
    // 200 with an error body, same reasoning as the cameras cron: the
    // previous outage map is still in KV, so nothing a viewer sees is
    // broken, and a red cron dashboard for a transient blip on an http
    // government host trains people to ignore the dashboard.
    return json(res, { ok: false, error: String((e && e.message) || e) });
  } finally {
    await kv.unlock(LOCK, token);
  }
};
