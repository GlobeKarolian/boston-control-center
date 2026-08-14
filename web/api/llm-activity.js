// api/llm-activity.js
//
//   GET /api/llm-activity?limit=60
//   -> { ok, configured, summary{...}, calls[...] }
//
// What the models have actually been doing, for the Under The Hood tab.
//
// The `configured` block is here because the most common failure is not a
// model behaving badly, it is a key that is missing or dead, and that is
// invisible from a list of call results alone: a system with no key logs
// nothing, and a list of zero failures looks identical to a system that is
// working perfectly. Saying which keys exist turns "quiet" into either
// "quiet because nothing needed doing" or "quiet because nothing can run".

const { requireRead, json, harden } = require('../lib/http');
const llmlog = require('../lib/llmlog');

module.exports = async (req, res) => {
  harden(res);
  if (!(await requireRead(req, res))) return;

  const limit = Math.max(5, Math.min(120, parseInt((req.query && req.query.limit) || '60', 10) || 60));
  const log = await llmlog.recent(limit);

  const configured = {
    openrouter: !!(process.env.OPENROUTER_API_KEY || '').trim(),
    anthropic: !!(process.env.ANTHROPIC_API_KEY || '').trim(),
    extractModel: process.env.EXTRACT_MODEL_OR || 'inclusionai/ling-2.6-flash',
    verifyModel: process.env.VERIFY_MODEL || 'deepseek/deepseek-v4-flash-0731',
    dailyCap: parseInt(process.env.EXTRACT_DAILY_CAP || '500', 10) || 500,
  };

  return json(res, {
    ok: true,
    configured,
    summary: log.summary,
    calls: log.calls || [],
    why: log.ok ? null : log.why,
  }, { priv: 0 });
};
