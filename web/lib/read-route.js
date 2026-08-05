// lib/read-route.js
// Every dashboard read endpoint is the same three lines: check the password,
// pull one pre-rendered string out of Redis, send it. This builds them.
//
// Cache policy is deliberately browser-only (priv), never s-maxage. See the
// note on json() in http.js: these routes are behind Basic auth and Vercel's
// CDN does not key its cache on the Authorization header.

const { requireRead, json } = require('./http');
const store_io = require('./store-io');

function readRoute(key, fallback = '[]', { priv = 2 } = {}) {
  return async (req, res) => {
    if (!(await requireRead(req, res))) return;
    try {
      const body = await store_io.readOut(key, fallback);
      return json(res, body, { priv });
    } catch (e) {
      // A Redis blip must not blank the map. Send the empty shape with a
      // header the console can see, so the page degrades instead of erroring.
      res.setHeader('X-BCC-Error', String(e.message || e).slice(0, 120));
      return json(res, fallback, { priv: 0 });
    }
  };
}

/* The activity endpoints differ from the incident ones in exactly one way, and
   it is the honesty argument the whole layer is built on.

   An empty incident list is a true statement: nothing is burning. An empty
   crowd map is not a statement at all, it is the absence of one, and drawing it
   as zeros tells an editor the city is empty when what we actually mean is that
   we have not looked. So when the key is missing these answer 503 instead of an
   empty shape.

   That is not a degraded path, it is the designed one. loadLiveField() returns
   silently on a non-ok response and leaves the forecast surface alone.
   loadActivity() keeps its last good render. loadPulse() prints the status code
   next to "The forecast worker may not be running." All three are better
   answers than a confident zero. */
function liveRoute(key, { priv = 2, hint = '' } = {}) {
  return async (req, res) => {
    if (!(await requireRead(req, res))) return;
    let body = null;
    try {
      body = await store_io.readOut(key, '');
    } catch (e) {
      return json(res, { error: 'storage unavailable', detail: String(e.message || e).slice(0, 120) },
        { status: 503 });
    }
    if (!body) return json(res, { error: 'no data yet', hint }, { status: 503 });
    return json(res, body, { priv });
  };
}

module.exports = { readRoute, liveRoute };
