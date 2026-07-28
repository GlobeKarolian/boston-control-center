// api/cron/pulse.js
// The forecast sweep. 16 map tiles, ~20 API calls, 3,390 venues, measured at
// about 166 seconds from cold.
//
// Runs every three hours, and the interval is chosen by two constraints
// pulling in opposite directions. The dashboard prints "Forecast pulled Nh
// ago" in warning colour once N reaches 6, so a six-hourly sweep would spend
// half its life apologising for itself. And the payload is labelled with the
// weekday whose curves it contains, which cannot be relabelled at read time,
// so the gap after midnight where the page still says "a typical Thursday" is
// exactly this interval long. Three hours keeps both small. The sweep is
// cheap on an unlimited plan and the venue set barely moves between runs.

const { cronAuth, json } = require('../../lib/http');
const kv = require('../../lib/kv');
const pulse = require('../../activity/pulse.js');

const LOCK = 'bcc:lock:pulse';

module.exports = async (req, res) => {
  if (!cronAuth(req)) return json(res, { error: 'unauthorized' }, { status: 401 });
  if (!String(process.env.BESTTIME_API_KEY_PRIVATE || '').trim()) {
    return json(res, { skipped: 'no BESTTIME_API_KEY_PRIVATE' });
  }

  // A sweep is minutes long, so the lease is generous and the wait is zero.
  // Two overlapping sweeps would double the tile requests for one result.
  const token = await kv.lock(LOCK, 15 * 60 * 1000, 0);
  if (!token) return json(res, { skipped: 'a sweep is already in flight' });

  const t0 = Date.now();
  try {
    const r = await pulse.once();
    return json(res, { ok: true, ...r, ms: Date.now() - t0 });
  } catch (e) {
    return json(res, { error: 'pulse sweep failed', detail: String(e.message || e).slice(0, 300), ms: Date.now() - t0 },
      { status: 500 });
  } finally {
    await kv.unlock(LOCK, token);
  }
};
