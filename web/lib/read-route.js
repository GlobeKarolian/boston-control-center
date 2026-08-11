// lib/read-route.js
// Every dashboard read endpoint is the same three lines: check the password,
// pull one pre-rendered string out of Redis, send it. This builds them.
//
// Cache policy is deliberately browser-only (priv), never s-maxage. See the
// note on json() in http.js: these routes are behind Basic auth and Vercel's
// CDN does not key its cache on the Authorization header.

const crypto = require('crypto');
const { requireRead, json, harden } = require('./http');
const store_io = require('./store-io');

/* One copy of each board payload per warm function instance, shared by every
   viewer that polls it within the window. This is the whole Redis bandwidth
   story: before it, ten open screens each paid the full transcript payload
   out of the store every few seconds, around the clock, which is how a
   250MB database moved 35GB in a month. The data itself only changes every
   few seconds, so within a three-second window every poll after the first
   is the same bytes. Serve them from memory and let the store answer once.

   The window trades at most `shareMs` of extra staleness on a board whose
   payload is already seconds old by the time anyone reads it. A cold or
   freshly recycled instance simply fetches once and is warm. */
const SHARED = new Map(); // key -> { at, body, etag }

/* shareMs deliberately sits ABOVE the page's poll interval. This board has
   one newsroom, not a crowd: the win is not ten viewers sharing a read, it
   is one always-on screen's consecutive polls reusing a read instead of
   paying the store every four seconds forever. Six seconds of worst-case
   staleness on words that took ten to transcribe is nothing; 2.7GB a day
   of repeat reads was the whole Upstash bill. */
function readRoute(key, fallback = '[]', { priv = 2, shareMs = 6000 } = {}) {
  return async (req, res) => {
    if (!(await requireRead(req, res))) return;
    try {
      const now = Date.now();
      let c = SHARED.get(key);
      if (!c || (now - c.at) > shareMs) {
        /* Ask what changed before asking for it.

           The board is polled around the clock and almost every poll finds
           the same data it saw a moment ago, so the expensive part was never
           the answer, it was re-fetching four hundred kilobytes to discover
           there was nothing new. The writer leaves a twelve character stamp
           beside each key; reading that costs nothing, and the payload only
           moves when it has actually changed. A missing stamp means an older
           deploy or an expired key, and falls back to the plain timed read
           so the board never depends on the optimisation being present. */
        const ver = await store_io.outVersion(key);
        if (c && ver && c.ver === ver) {
          c.at = now;                       // still current, nothing to fetch
        } else {
          const body = await store_io.readOut(key, fallback);
          c = {
            at: now, body, ver,
            etag: 'W/"' + crypto.createHash('sha1').update(body).digest('hex').slice(0, 16) + '"',
          };
          SHARED.set(key, c);
        }
      }
      res.setHeader('ETag', c.etag);
      /* The other half of the bandwidth: the wire to the browser. The board
         polls with the browser's HTTP cache in play, so when nothing changed
         the answer is a 304 and zero payload rather than the same JSON
         again. Weak ETag off the exact bytes; no writer had to learn
         anything for this to hold. */
      if (req.headers['if-none-match'] === c.etag) {
        harden(res);
        res.setHeader('Cache-Control', 'private, max-age=' + priv + ', stale-while-revalidate=' + (priv * 4));
        return res.status(304).end();
      }
      return json(res, c.body, { priv });
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
