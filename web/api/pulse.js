/* ============================================================================
   api/pulse.js  -  the forecast surface.

   This is the biggest thing the page pulls and the only route that does not
   simply hand a stored string to the response, so both departures are worth
   explaining.

   WHY TWO KEYS. The sweep stores the browser's copy of the venue array under
   one key and the small header under another. Measured: the full document is
   1,469,983 bytes across 3,390 venues. Dropping the fields index.html never
   reads takes it to 561 KB raw, 113 KB gzip, 87 KB brotli. The venue ids alone
   are 56 high entropy characters each and would roughly double the compressed
   wire size to carry a field the page does not use, so they stay in the
   internal key that livefield reads and never reach the browser.

   WHY STRING CONCATENATION. The venue array is served verbatim, never parsed.
   Parsing 561 KB into 3,390 objects and stringifying them back is pure waste
   on every single request, and it is waste inside the request path rather than
   inside the cron. The header is small, so it is parsed, edited and
   re-stringified, then its closing brace is replaced by the venue array. The
   result is byte for byte the document the old file server produced.

   WHY hourLocal IS REFRESHED BUT dayInt IS NOT. They look symmetrical and are
   not. hourLocal is just a clock reading and stating a stale one helps nobody.
   dayInt names which weekday's curves are in the payload, and every venue's
   24 numbers were fetched for that specific day. Refreshing it at read time
   would relabel Thursday's data as Friday, which is not a rounding error, it
   is a false claim about what you are looking at. The sweep runs every three
   hours precisely so this window stays short; until it runs, the page says
   "a typical Thursday" and means it.
   ========================================================================== */

const { requireRead, json } = require('../lib/http');
const kv = require('../lib/kv');
const pulse = require('../activity/pulse.js');

module.exports = async (req, res) => {
  if (!requireRead(req, res)) return;

  let metaStr, venuesStr;
  try {
    [metaStr, venuesStr] = await Promise.all([
      kv.get(pulse.K_META),
      kv.getBig(pulse.K_OUT),
    ]);
  } catch (e) {
    return json(res, { error: 'storage unavailable', detail: String(e.message || e).slice(0, 120) },
      { status: 503 });
  }

  if (!metaStr || !venuesStr) {
    return json(res, { error: 'no data yet', hint: 'the pulse sweep has not completed a run yet' },
      { status: 503 });
  }

  let meta;
  try { meta = JSON.parse(metaStr); } catch (e) { meta = null; }
  if (!meta || typeof meta !== 'object') {
    return json(res, { error: 'pulse header unreadable' }, { status: 503 });
  }

  /* Cheap structural check before we splice two strings together. Without it a
     truncated or expired chunk becomes malformed JSON in the browser, which
     surfaces as "Unexpected end of JSON input" and sends whoever debugs it
     looking at the wrong layer. */
  if (venuesStr[0] !== '[') {
    return json(res, { error: 'pulse venue payload is incomplete', hint: 'a storage chunk expired mid-read; the next sweep rewrites it' },
      { status: 503 });
  }

  meta.sweptHourLocal = meta.hourLocal;
  meta.hourLocal = pulse.bostonNow().hour;

  const head = JSON.stringify(meta);
  json(res, head.slice(0, -1) + ',"venues":' + venuesStr + '}', { priv: 60 });
};
