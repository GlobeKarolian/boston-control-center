// Serve the cached municipal outage map.
//
// swr is 60. Unlike the camera catalog, which changes twice a year, this
// payload changes every fifteen minutes and is the thing a reporter refreshes
// during a storm. A minute of edge cache still absorbs a newsroom's worth of
// open tabs while keeping the worst case one minute behind the cron.

const { requireRead, json } = require('../lib/http');
const kv = require('../lib/kv');
const { KEY } = require('../lib/outages');

module.exports = async function handler(req, res) {
  if (!(await requireRead(req, res))) return;

  const doc = await kv.getJSON(KEY, null);

  // Note the asymmetry with api/cameras.js, which 503s on an empty array.
  // Here an empty towns array is a legitimate and common answer: it means
  // the power is on everywhere in Massachusetts. Only the total absence of a
  // document means the cron has never run. Confusing those two would put a
  // scary error on the map on every ordinary sunny afternoon.
  if (!doc || !Array.isArray(doc.towns)) {
    return json(res, {
      error: 'no outage data yet',
      hint: 'run /api/cron/outages once, or wait for the scheduled run',
    }, { status: 503 });
  }

  return json(res, doc, { swr: 60 });
};
