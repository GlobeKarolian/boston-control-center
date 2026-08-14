// lib/llm.js
//
// One door to the models, through OpenRouter.
//
// Extraction grew its own copy of this inside lib/extractor.js while the
// pipeline was being repaired live, and the moment a second caller wanted a
// model, the reasoning-budget bug and the timeout-skips-the-fallback bug
// would have been copied along with it. So the hard-won parts live here now:
// reasoning explicitly off, a token budget big enough to survive a provider
// that reasons anyway, timeouts treated as failures rather than as exceptions
// that fly past the fallback, latency-sorted routing, and a fallback in a
// different model family so one provider's bad night is not the whole
// system's bad night.
//
// The V2 event resolver and severity judge are the next tenants.

'use strict';

const KEY = () => (process.env.OPENROUTER_API_KEY || '').trim();
const PRIMARY = process.env.LLM_MODEL || 'inclusionai/ling-2.6-flash';
const FALLBACK = process.env.LLM_MODEL2 || 'deepseek/deepseek-v4-flash-0731';

function enabled() { return !!KEY(); }

/* One chat turn. Returns the assistant's text, or throws with both models'
   stories attached so a failure names what actually happened rather than
   whichever half was noticed last. */
async function chat({ system, user, maxTokens = 700, json = false, timeoutMs = 20000 }, modelId, priorErr) {
  if (!KEY()) throw new Error('OPENROUTER_API_KEY not set');
  const model = modelId || PRIMARY;
  const fail = (why) => {
    const msg = 'openrouter ' + model + ': ' + why;
    if (!modelId) return chat({ system, user, maxTokens, json, timeoutMs }, FALLBACK, msg);
    throw new Error((priorErr ? priorErr + ' ; then ' : '') + msg);
  };

  let r;
  try {
    r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + KEY(),
        'http-referer': 'https://www.scan.boston',
        'x-title': 'Boston Newsroom Control Center',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature: 0,
        reasoning: { enabled: false, exclude: true },
        provider: { sort: 'latency' },
        ...(json ? { response_format: { type: 'json_object' } } : {}),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return fail(e && e.name === 'TimeoutError' ? 'timeout after ' + timeoutMs + 'ms' : String((e && e.message) || e));
  }
  if (!r.ok) return fail('http ' + r.status + ' ' + (await r.text()).slice(0, 200));

  const j = await r.json();
  const msg = (((j.choices || [])[0] || {}).message || {});
  let out = msg.content;
  if (Array.isArray(out)) out = out.map(p => (p && (p.text || p.content)) || '').join('');
  out = String(out || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (!out) return fail('empty content (finish: ' + ((j.choices || [])[0] || {}).finish_reason + ')');
  return out;
}

async function chatJSON(opts) {
  const raw = await chat({ ...opts, json: true });
  try { return JSON.parse(raw); } catch (e) {
    throw new Error('model returned unparseable JSON: ' + raw.slice(0, 160));
  }
}

module.exports = { chat, chatJSON, enabled, PRIMARY, FALLBACK };
