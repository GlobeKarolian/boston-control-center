// lib/verify.js
//
// A second model, from a different lab, trying to knock the claim down.
//
// On the night this was written the board carried "Active Shooter at 81
// Walden Street, Cambridge - Confirmed by Police", grown entirely from:
//
//   "I am good to go. All right, Jake 201. Sorry. 81 Walden Street."
//
// The model that wrote it also reviewed it, found its own earlier headline
// sitting in the open-stories list, and counted that as corroboration. One
// author, one editor, same mind. That is not a review.
//
// So the writer no longer gets the last word. A different model, from a
// different lab, is shown the raw transcripts and the bare claim, and asked
// one question: is there anything here that supports this. It never sees the
// headline's confidence, the severity, the summary's certainty, or the fact
// that another model already believed it, because all of those are things to
// agree with rather than evidence to weigh.
//
// Different lab is the point. Two models trained by the same people on
// similar data fail in similar ways, and a rubber stamp is worse than no
// review because it launders the claim. Ling and DeepSeek fabricating the
// same shooter out of "Jake 201" is far less likely than either doing it
// alone, and that asymmetry is the entire mechanism.
//
// A verifier that cannot be reached does not approve anything. Silence is not
// consent: an unreachable second opinion leaves the claim unverified, and the
// caller decides what an unverified claim is allowed to do.

'use strict';

const llm = require('./llm');

/* Deliberately not the writer's family. The writer is Sonnet-tier; the
   skeptic is DeepSeek's flash, which is cheap, fast, and wrong in different
   ways. Swap either with an env var, but keep them from the same lab only on
   purpose and never by accident. */
const MODEL = process.env.VERIFY_MODEL || 'deepseek/deepseek-v4-flash-0731';
const MODEL2 = process.env.VERIFY_MODEL2 || 'qwen/qwen3.7-flash';

const SYSTEM = [
  'You are a Boston Globe fact-checker reading raw scanner transcripts.',
  'The transcripts are machine-made from poor radio and contain errors.',
  '',
  'You are given a CLAIM and the transcripts it was supposedly built from.',
  'Your only job is to decide whether the transcripts support the claim.',
  '',
  'Default to refuted. A claim is supported ONLY if a transcript actually',
  'contains the thing claimed. Not something that could imply it, not',
  'something a reasonable person might assume, not background knowledge about',
  'Boston. If the claim says shooting, a transcript must mention a shooting,',
  'shots, or a gun. If the claim names a city, a transcript must name it or',
  'name an address that is obviously in it.',
  '',
  'Watch specifically for: a claim naming a place nobody said, a claim',
  'asserting police confirmed something when no one on the radio confirmed',
  'anything, and evidence that appears only inside a negation ("they are NOT',
  'pursuing" does not support a pursuit).',
  '',
  'Reply as JSON with exactly these keys:',
  '  supported : true only if the transcripts plainly contain the claim',
  '  quote     : the exact substring from a transcript that supports it, or ""',
  '  refutes   : one short sentence on what is missing, or "" if supported',
  '  worst     : the single most unsupported element of the claim, or ""',
].join('\n');

function transcriptBlock(batch) {
  return (batch || []).slice(0, 80).map((t) => {
    const at = String((t && (t.at || t.time)) || '');
    const clock = at.length >= 16 ? at.slice(11, 16) + 'Z ' : '';
    return clock + '[' + String((t && (t.src || t.source || t.feed)) || '?') + '] '
      + String((t && t.text) || '').slice(0, 400);
  }).join('\n');
}

/* One verification. Returns:
     { ran, supported, quote, refutes, worst, model, why }
   `ran` false means no second opinion was obtained, which is NOT approval. */
async function check(claim, batch, opts = {}) {
  const text = String(claim || '').trim();
  if (!text) return { ran: false, supported: false, why: 'no claim given' };
  if (!llm.enabled()) return { ran: false, supported: false, why: 'no model configured' };
  const lines = transcriptBlock(batch);
  if (!lines) return { ran: true, supported: false, refutes: 'there are no transcripts behind this claim', worst: text };

  const user = 'CLAIM:\n' + text.slice(0, 600)
    + '\n\nTRANSCRIPTS, verbatim and in order:\n\n' + lines;

  for (const model of [opts.model || MODEL, MODEL2]) {
    try {
      const out = await llm.chatJSON({
        system: SYSTEM,
        user,
        maxTokens: 500,
        timeoutMs: opts.timeoutMs || 20000,
        model,
      });
      return {
        ran: true,
        supported: out.supported === true,
        quote: String(out.quote || '').slice(0, 300),
        refutes: String(out.refutes || '').slice(0, 300),
        worst: String(out.worst || '').slice(0, 200),
        model,
      };
    } catch (e) {
      /* Try the other skeptic before giving up, then fail closed. */
      if (model === MODEL2) {
        return { ran: false, supported: false, why: String(e.message || e).slice(0, 200) };
      }
    }
  }
  return { ran: false, supported: false, why: 'no verifier answered' };
}

/* The verdict applied to a situation, and the reason it is applied this way:
   an unverified claim is not a rejected claim. It is held, keeps every one of
   its transmissions and its audio, and says plainly what could not be stood
   up, so a person can look at it in ten seconds and decide. Deleting it would
   hide a real story on the night the verifier was having a bad time. */
function apply(sit, verdict) {
  const f = { ...sit };
  f.verified = !!(verdict && verdict.ran && verdict.supported);
  if (verdict && verdict.ran) {
    f.verifiedBy = verdict.model || null;
    if (verdict.quote) f.verifiedQuote = verdict.quote;
  }
  if (f.verified) return f;

  f.held = true;
  f.heldWhy = (verdict && verdict.ran)
    ? ('a second model could not stand this up: ' + (verdict.refutes || 'no supporting transcript'))
    : ('unverified: ' + ((verdict && verdict.why) || 'no second opinion available'));
  if (verdict && verdict.worst) f.heldWorst = verdict.worst;
  /* A held card cannot page anybody and cannot claim confidence it did not
     earn, but it keeps its priority visible so the desk can see what the
     writer thought it was. */
  f.confidence = 'unclear';
  return f;
}

module.exports = { check, apply, MODEL, MODEL2, SYSTEM };
