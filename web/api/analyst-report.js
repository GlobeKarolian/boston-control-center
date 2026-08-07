// api/analyst-report.js
// The other half of the local analyst. The Mac POSTs back what its model
// said, and every guardrail the cloud path has runs HERE, identically:
// geocoding, feed verification, clip matching, reference discipline, human
// overrides, reconciliation, the write budget. The model proposed; this
// disposes. A local model that could write the board directly would be a
// trust hole, so it cannot.
//
// Body: { sig, situations } where sig is what analyst-work handed out.
// A report is accepted if its sig matches either the current transcript text
// or the signature most recently handed to a runner. Anything else is an
// answer to a question nobody is asking anymore, and is refused so a slow
// runner cannot overwrite fresh judgment with old.

const { ingestAuth, json, harden } = require('../lib/http');
const kv = require('../lib/kv');
const { K } = require('../lib/store-io');
const { reconcile } = require('../lib/threads');
const core = require('../lib/analyst-core');

const LOCK = 'bcc:lock:analyst';
const SIG = 'bcc:analyst:sig';
const WORK_SIG = 'bcc:analyst:work:sig';
const LINKS = 'bcc:sit:links';
const LOCAL_AT = 'bcc:analyst:local:at';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let n = 0;
    req.on('data', c => { n += c.length; if (n > 1000000) { reject(new Error('body too large')); req.destroy(); } else parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  harden(res);
  if (req.method !== 'POST') return json(res, { ok: false, why: 'POST only' }, { status: 405 });
  const auth = ingestAuth(req);
  if (!auth.ok) return json(res, { ok: false, why: auth.why }, { status: 401 });

  let body;
  try { body = JSON.parse((await readBody(req)).toString('utf8')); }
  catch (e) { return json(res, { ok: false, why: 'unreadable body' }, { status: 400 }); }
  const sits = body && Array.isArray(body.situations) ? body.situations : null;
  const sig = body && String(body.sig || '');
  if (!sits || !sig) return json(res, { ok: false, why: 'need sig and situations[]' }, { status: 400 });

  // Same lock as the cron, because they write the same key and a race would
  // double judgment for no benefit.
  const token = await kv.lock(LOCK, 90000, 0);
  if (!token) return json(res, { ok: false, why: 'another analyst run is in flight' }, { status: 409 });

  const t0 = Date.now();
  try {
    const [rawTr, rawSits, rawLinks, workSig] = await kv.raw([
      ['GET', K.outTranscripts],
      ['GET', K.outSituations],
      ['GET', LINKS],
      ['GET', WORK_SIG],
    ], 10000);

    const parse = (s, fb) => { try { return s ? JSON.parse(s) : fb; } catch (e) { return fb; } };
    const tr = parse(rawTr, []);
    const prev = parse(rawSits, []);
    const overrides = parse(rawLinks, {}) || {};

    const currentSig = core.sigOf(core.linesOf(tr));
    if (sig !== currentSig && sig !== workSig) {
      return json(res, { ok: false, why: 'stale: that transcript window has moved on', ms: Date.now() - t0 }, { status: 409 });
    }

    // The full dispose pipeline, shared verbatim with the cloud path.
    const batch = tr.slice(0, 70);
    const fresh = await core.disposeReported(sits, { batch, prev });

    const result = reconcile(prev, fresh, overrides);
    await kv.set(K.outSituations, core.fitToBudget(result.situations), 6 * 3600);
    // Recorded only after the write lands, so a failed run retries.
    try {
      await kv.raw([
        ['SET', SIG, sig, 'EX', 6 * 3600],
        ['SET', LOCAL_AT, new Date().toISOString(), 'EX', 3600],
      ], 8000);
    } catch (e) {}

    const out = result.situations;
    return json(res, {
      ok: true, by: 'local',
      situations: out.length,
      reported: fresh.length,
      opened: result.opened.length,
      threaded: fresh.length - result.opened.length,
      high: out.filter(s => s.priority === 'high').length,
      unclear: out.filter(s => s.confidence === 'unclear').length,
      located: out.filter(s => s.lat !== null && s.lat !== undefined).length,
      read: tr.length, ms: Date.now() - t0,
    });
  } catch (e) {
    // Leave the previous situations in place: stale beats empty, because an
    // empty board reads as a quiet city rather than a broken pipeline.
    return json(res, { error: 'analyst report failed', detail: String(e.message || e).slice(0, 300), ms: Date.now() - t0 }, { status: 500 });
  } finally {
    await kv.unlock(LOCK, token);
  }
};
