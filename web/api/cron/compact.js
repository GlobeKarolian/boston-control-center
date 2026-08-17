// api/cron/compact.js
//
// Roll settled hours of the vault into one object each. See lib/compact.js
// for why: a two-day archive question was fifteen thousand fetches and
// fourteen seconds, and could only ever read the newest sixteen hours of it.
//
// Every five minutes. Most runs find one hour due and are done in a couple
// of seconds; the first runs after this ships work backwards through the
// existing archive, newest first, a few dozen hours at a time.

const { cronAuth, json } = require('../../lib/http');
const kv = require('../../lib/kv');
const compact = require('../../lib/compact');

const LOCK = 'bcc:lock:compact';
const LAST = 'bcc:compact:last';

module.exports = async (req, res) => {
  if (!cronAuth(req)) return json(res, { error: 'unauthorized' }, { status: 401 });
  const t0 = Date.now();
  const token = await kv.lock(LOCK, 110000, 0);
  if (!token) return json(res, { skipped: 'a compaction is already running', ms: Date.now() - t0 });
  try {
    const r = await compact.run({ budgetMs: 85000 });
    try {
      await kv.set(LAST, {
        at: new Date().toISOString(), ok: r.ok, why: r.why || null,
        rolled: (r.rolled || []).length, failed: (r.failed || []).length, remaining: r.remaining || 0,
        ms: r.ms,
      }, 24 * 3600);
    } catch (e) {}
    return json(res, r);
  } catch (e) {
    return json(res, { error: 'compact failed', detail: String(e.message || e).slice(0, 300), ms: Date.now() - t0 }, { status: 500 });
  } finally {
    await kv.unlock(LOCK, token);
  }
};
