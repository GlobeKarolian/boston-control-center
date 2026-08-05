// Serve the cached MassDOT camera catalog to the map.
//
// Read half of the pair. api/cron/cameras.js writes bcc:cams; this reads it.
// Nothing here talks to Mass511, which is the whole point: a room full of
// open dashboards hits this route, and this route hits Redis.
//
// swr is 300 rather than the 60 used by api/pulse.js because the payload is
// a catalog of camera positions, not a live feed. It changes when MassDOT
// installs a camera. Five minutes of edge cache on something that turns over
// twice a year is still conservative.

const { requireRead, json } = require('../lib/http');
const kv = require('../lib/kv');
const { KEY } = require('../lib/cameras');

module.exports = async function handler(req, res) {
  if (!(await requireRead(req, res))) return;

  const doc = await kv.getJSON(KEY, null);

  // 503 and not 200-with-empty-array. An empty array is indistinguishable
  // from "Massachusetts has no traffic cameras", and the map would happily
  // draw nothing and look correct. A 503 with a hint tells whoever is
  // looking at the network tab exactly which lever to pull.
  if (!doc || !Array.isArray(doc.cams) || !doc.cams.length) {
    return json(res, {
      error: 'no camera catalog yet',
      hint: 'run /api/cron/cameras once, or wait for the scheduled run',
    }, { status: 503 });
  }

  return json(res, doc, { swr: 300 });
};
