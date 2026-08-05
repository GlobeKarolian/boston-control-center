// Refresh the MassDOT camera catalog.
//
// Why this runs on a schedule instead of in the browser:
//
//   1. The upstream call is a POST to https://mass511.com/api/graphql, and
//      api/feed.js is a GET-only allowlist proxy. There is no path from a
//      browser to that endpoint without widening the proxy, and widening a
//      proxy to allow POST so a map layer can load is a bad trade.
//   2. A newsroom leaves this dashboard open on a wall. Every open screen
//      hitting an undocumented state endpoint on a timer is exactly the
//      behaviour the s-maxage comments elsewhere in this codebase exist to
//      prevent. One call every six hours from one server is polite.
//   3. A cached catalog degrades well. If Mass511 is down at the moment a
//      reporter opens the map, the cameras from the last good run are still
//      on the board.
//
// Note what this job does NOT cache: the pictures. Every camera carries a
// plain public https JPEG on public.carsprogram.org, which an <img> tag loads
// directly without CORS and without touching this deployment. Measured on a
// live camera: 6178 bytes, last-modified 52 seconds before the request. So
// the images refresh about once a minute at the source and cost us nothing
// no matter how many screens are open. This job only refreshes the list of
// where the cameras are.
//
// The catalog is near-static. MassDOT adds or moves a camera occasionally,
// not hourly, so six hours is generous. The TTL in lib/cameras.js is set to
// match, which means a run that fails for a day still leaves usable data.

const { cronAuth, json } = require('../../lib/http');
const kv = require('../../lib/kv');
const cameras = require('../../lib/cameras');

// Ten minutes is far longer than a run needs (measured: under two seconds),
// but a lease that expires mid-run is worse than one held too long, and
// waitMs of 0 means a second invocation gives up instantly rather than
// queueing behind the first. Vercel can double-fire a cron; this is the
// guard against two of them writing the same key.
const LOCK = 'bcc:lock:cams';
const LEASE_MS = 10 * 60 * 1000;

module.exports = async function handler(req, res) {
  if (!cronAuth(req)) return json(res, { error: 'unauthorized' }, { status: 401 });

  const token = await kv.lock(LOCK, LEASE_MS, 0);
  if (!token) return json(res, { skipped: 'locked' });

  try {
    return json(res, await cameras.once());
  } catch (e) {
    // Deliberately a 200 with an error body rather than a 500. A 500 makes
    // Vercel's cron dashboard light up red for a transient upstream blip,
    // and the previous catalog is still in KV either way, so nothing on the
    // map is broken. The message is what a human needs to see.
    return json(res, { ok: false, error: String((e && e.message) || e) });
  } finally {
    await kv.unlock(LOCK, token);
  }
};
