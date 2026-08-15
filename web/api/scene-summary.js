// api/scene-summary.js
//
//   POST /api/scene-summary   { tx: [{ at, feed, text }, ...] }
//   -> { ok, headline, summary, confidence, unclear }
//
// What a desk editor would say after listening to the scene once.
//
// This runs as a SECOND request after the search returns, never inside it. A
// reporter at 1am gets their transmissions in the time the archive takes to
// read them, and the summary arrives a beat later into a card that is already
// on screen. Blocking the search on a model call would trade the thing that
// works for the thing that is nice.
//
// The prompt's hardest instruction is about doubt. These transcripts are
// machine-made from vocoded radio and are frequently wrong in ways that read
// as confident: "one stab in the abdomen" was clear, "Rob Square" was not a
// place. A summary that laundered garbled audio into clean prose would be the
// most dangerous feature in this building, so the model is told to name what
// it cannot tell, and the banner above every card already says none of this
// is publishable until the desk checks it.

const { requireRead, json, harden } = require('../lib/http');
const llm = require('../lib/llm');
const et = require('../lib/etime');

const MAX_TX = 60;

const SYSTEM = [
  'You are a Boston Globe desk editor reading raw police, fire and EMS scanner',
  'transcripts. The transcripts are machine-generated from poor-quality radio',
  'and contain errors: mangled street names, wrong unit numbers, invented words.',
  '',
  'Say what the radio traffic appears to describe. Be concrete about what is',
  'clearly stated and explicitly uncertain about what is not. Never invent a',
  'detail that is not in the transcripts. Never resolve a garbled word into a',
  'plausible name. If the traffic is too broken to describe, say so plainly.',
  '',
  'Reply as JSON with exactly these keys:',
  '  headline   : under 60 characters, what this appears to be, no clickbait',
  '  summary    : 2-3 sentences a reporter can act on. What happened, where,',
  '               who responded, current status. Hedge where the audio hedges.',
  '  confidence : "clear" | "likely" | "murky"',
  '  unclear    : array of up to 3 short strings naming what a reporter would',
  '               need to confirm before writing. Empty array if nothing.',
].join('\n');

module.exports = async (req, res) => {
  harden(res);
  if (!(await requireRead(req, res))) return;
  if (req.method !== 'POST') return json(res, { ok: false, why: 'POST only' }, { status: 405 });
  if (!llm.enabled()) return json(res, { ok: false, why: 'no model configured' }, { status: 503 });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  const rows = (body && Array.isArray(body.tx)) ? body.tx : null;
  if (!rows || !rows.length) return json(res, { ok: false, why: 'no transmissions' }, { status: 400 });

  const lines = rows.slice(0, MAX_TX).map(t => {
    const at = String(t.at || '');
    const clock = at ? et.clock(at) + ' ET' : '';
    return clock + ' [' + String(t.feed || '?').slice(0, 40) + '] ' + String(t.text || '').slice(0, 400);
  }).join('\n');

  try {
    const out = await llm.chatJSON({
      system: SYSTEM,
      user: 'Scanner traffic, in order:\n\n' + lines,
      maxTokens: 1200,
      timeoutMs: 25000,
      role: 'scene-summary',
      model: llm.SCENE_MODEL,
      fallback: llm.SCENE_FALLBACK,
    });
    return json(res, {
      ok: true,
      headline: String(out.headline || '').slice(0, 120),
      summary: String(out.summary || '').slice(0, 900),
      confidence: ['clear', 'likely', 'murky'].includes(out.confidence) ? out.confidence : 'murky',
      unclear: Array.isArray(out.unclear) ? out.unclear.slice(0, 3).map(x => String(x).slice(0, 120)) : [],
      model: llm.PRIMARY,
    }, { priv: 0 });
  } catch (e) {
    /* A failed summary must never look like a summary that found nothing
       worth saying. The card keeps its transmissions either way. */
    return json(res, { ok: false, why: String(e.message || e).slice(0, 200) }, { status: 502 });
  }
};
