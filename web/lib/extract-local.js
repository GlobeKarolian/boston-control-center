// The same extraction, run against a model on one of the Macs instead of the
// Anthropic API.
//
// Why this exists: 95% of every token sent to the API is the system prompt and
// the tool schema, which are byte identical on every call and are re-sent for
// every three second transmission. Prompt caching is the obvious answer and it
// is closed off here, because Haiku 4.5 will not cache a prefix under 4,096
// tokens and this one is about 2,440. The API returns no error when that
// happens, it simply bills the full rate, which is why this went unnoticed.
//
// A model on the Mac has no per token cost at all, and the Macs are already
// doing the harder job of running Whisper on four live audio streams. The
// extraction is a much smaller task than the transcription that feeds it.
//
// This file deliberately shares SYSTEM, SCHEMA and mapFields with the cloud
// extractor rather than restating them. Two copies of a prompt drift, and the
// day they drift is the day the local and cloud paths start disagreeing about
// what "clear" means. Sharing mapFields also means the local model inherits
// every guardrail already paid for: the landmark hallucination check, the
// records-answer guard on is_clear, the literal "null" filter, and the noise
// rescue.

const { SYSTEM, SCHEMA, mapFields, regexExtract, isNoise } = require('./extractor.js');

const HOST = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const MODEL = process.env.LOCAL_EXTRACT_MODEL || 'qwen2.5:7b-instruct';

// Ollama constrains decoding to a JSON schema, so the model cannot return
// prose or a half closed object. The schema is the same one the API tool uses.
// required is dropped on purpose: a forced field on a small model invites a
// fabricated value where an omission would have been honest, and mapFields
// already treats a missing field and a null one the same way.
const FORMAT = { type: 'object', properties: SCHEMA.properties };

function contextBlock(prior) {
  if (!prior || !prior.length) return '';
  return 'Earlier on this channel (background only, oldest first):\n' +
    prior.slice(-3).map(p => '- ' + String(p).slice(0, 220)).join('\n') + '\n\n';
}

async function callLocal(text, timeoutMs, prior) {
  const r = await fetch(HOST + '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      format: FORMAT,
      // Zero temperature because this is a reading task with a right answer,
      // and because a reproducible extractor is one you can actually regress.
      options: { temperature: 0, num_ctx: 4096, num_predict: 400 },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: contextBlock(prior) + 'Current transmission transcript:\n\n' + String(text).slice(0, 4000) },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error('ollama ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  const raw = j && j.message && j.message.content;
  if (!raw) throw new Error('ollama: empty response');
  let o;
  try { o = JSON.parse(raw); } catch (e) { throw new Error('ollama: unparseable JSON'); }
  return mapFields(o, 'local', text);
}

// Same shape and same contract as extractBatch in extractor.js, so api/ingest
// can swap one for the other without knowing which it has.
//
// Concurrency defaults to 2. The API can absorb six at once; a single Mac
// serves one request at a time per loaded model and queues the rest, so a
// higher number buys nothing and only lengthens the tail. It also leaves the
// machine room for the Whisper work that is the reason it is running at all.
async function extractBatchLocal(items, { concurrency = 2, timeoutMs = 45000, priorBySrc = {} } = {}) {
  const rows = items.map(it => (typeof it === 'string' ? { text: it, src: '' } : { text: it.text, src: it.src || '' }));
  const out = new Array(rows.length);

  const ctx = {};
  for (const k in priorBySrc) ctx[k] = (priorBySrc[k] || []).slice(-3);
  const priorFor = src => (ctx[src] || []).slice();
  const remember = (src, t) => { (ctx[src] = ctx[src] || []).push(String(t).slice(0, 220)); if (ctx[src].length > 3) ctx[src].shift(); };

  let skipped = 0;
  for (let i = 0; i < rows.length; i++) {
    if (isNoise(rows[i].text)) { out[i] = { ...regexExtract(rows[i].text), noise: true, _by: 'noise' }; skipped++; }
  }

  // The breaker is per batch for the same reason it is in the cloud path: a
  // Mac that is asleep, rebuilding, or simply not running Ollama should cost
  // one timeout for the whole batch rather than one per transmission.
  let down = false;
  const errors = [];
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= rows.length) return;
      if (out[i]) continue;
      const { text, src } = rows[i];
      if (down) { out[i] = regexExtract(text); continue; }
      try {
        out[i] = await callLocal(text, timeoutMs, priorFor(src));
      } catch (e) {
        down = true;
        if (errors.length < 3) errors.push(String(e.message || e).slice(0, 200));
        out[i] = regexExtract(text);
      }
      remember(src, text);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));

  const local = out.filter(o => o && o._by === 'local').length;
  const scored = out.length - skipped;
  return {
    results: out,
    by: scored === 0 ? 'noise' : (local === scored ? 'local' : (local ? 'mixed' : 'regex')),
    errors, skipped,
    hallucinated: out.filter(o => o && o._hallucinated).length,
  };
}

async function ping(timeoutMs = 4000) {
  try {
    const r = await fetch(HOST + '/api/tags', { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return { up: false, why: 'http ' + r.status };
    const j = await r.json();
    const names = (j.models || []).map(m => m.name);
    return { up: true, models: names, has: names.some(n => n === MODEL || n.startsWith(MODEL.split(':')[0])) };
  } catch (e) { return { up: false, why: String(e.message || e).slice(0, 120) }; }
}

module.exports = { extractBatchLocal, ping, MODEL, HOST };
