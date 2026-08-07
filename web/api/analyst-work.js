// api/analyst-work.js
// One half of the local analyst. A Mac beside the radio asks this endpoint
// "is there judging to do?", and the answer is either a reason to sit quiet
// or the complete job: the system prompt, the schema, and the exact text to
// judge. The server composes everything, because the prompt is editorial
// policy and policy lives in one place (lib/analyst-core.js), not on
// whichever machine happens to run the model tonight.
//
// Auth is the relay's ingest token. This endpoint changes nothing; the only
// state it touches is remembering which signature it handed out, so the
// report endpoint can tell a slow answer from a stale one.

const { ingestAuth, json, harden } = require('../lib/http');
const kv = require('../lib/kv');
const { K } = require('../lib/store-io');
const core = require('../lib/analyst-core');

const SIG = 'bcc:analyst:sig';           // last signature actually judged
const WORK_SIG = 'bcc:analyst:work:sig'; // last signature handed out to a runner

module.exports = async (req, res) => {
  harden(res);
  if (req.method !== 'GET') return json(res, { ok: false, why: 'GET only' }, { status: 405 });
  const auth = ingestAuth(req);
  if (!auth.ok) return json(res, { ok: false, why: auth.why }, { status: 401 });

  const [rawTr, judgedSig, rawSits] = await kv.raw([
    ['GET', K.outTranscripts],
    ['GET', SIG],
    ['GET', K.outSituations],
  ], 10000);

  const parse = (s, fb) => { try { return s ? JSON.parse(s) : fb; } catch (e) { return fb; } };
  const tr = parse(rawTr, []);
  const prev = parse(rawSits, []);

  if (tr.length < 3) return json(res, { ok: true, skip: 'not enough traffic', transcripts: tr.length });

  const lines = core.linesOf(tr);
  const sig = core.sigOf(lines);
  if (judgedSig === sig) return json(res, { ok: true, skip: 'no new traffic since last judgment' });

  // Remembered so the report endpoint can accept an answer to THIS text even
  // if the transcripts have moved on while the model was thinking. Ten
  // minutes is far longer than any sane model run and far shorter than a
  // stale answer being worth anything.
  try { await kv.set(WORK_SIG, sig, 600); } catch (e) {}

  return json(res, {
    ok: true,
    sig: sig,
    system: core.ANALYST_SYSTEM,
    user: core.openStoriesBlock(prev) +
      '\n\n---\n\nRecent scanner traffic (oldest first):\n\n' + lines,
    format: core.SIT_FORMAT_LOCAL,
    transcripts: tr.length,
    openStories: (prev || []).filter(s => s && s.status !== 'closed').length,
  });
};
