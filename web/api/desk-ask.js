// api/desk-ask.js
//
//   POST /api/desk-ask   { q: "what were the biggest calls tonight" }
//   -> { ok, answer, window, considered, shown, tx[], ms }
//
// Ask the desk a question in English and get an answer built only out of
// transmissions, with those transmissions returned alongside it.
//
// THE SCALE PROBLEM, which is the whole design. "Tonight" is twelve hours and
// several thousand transmissions, and no model should be handed all of them:
// it costs a fortune, it blows past any sane context, and a model swimming in
// four thousand lines of "received, thank you" will confidently summarise the
// noise. So the work is split. Plain code decides WHICH transmissions could
// possibly answer the question, using the threat tiers, call types and
// priorities the pipeline already computed. The model only reads the shortlist
// and writes the sentence.
//
// That split is also what makes the answer checkable. The shortlist comes back
// with the answer, so "the biggest calls tonight" is a claim a reporter can
// audit in ten seconds by reading the same lines the model read.
//
// The grounding rule is the same one the rest of the system now runs on: an
// answer may only contain what a transmission says. On 14 August this project
// put "Active Shooter, Confirmed by Police" on a newsroom board out of one
// unit clearing an address, and every prompt written since has been written
// against that.

const { requireRead, json, harden } = require('../lib/http');
const stream = require('../lib/stream');
const vq = require('../lib/vault-query');
const llm = require('../lib/llm');

/* How many transmissions the model is allowed to read. Enough to answer a
   question about a night, small enough to stay honest and cheap. */
const SHOW = 150;
/* How far back a bare question reaches when it names no time of its own. */
const DEFAULT_HOURS = 8;

const SYSTEM = [
  'You are a Boston Globe desk editor who has been listening to police, fire,',
  'EMS and transit scanners. A reporter is asking you a question.',
  '',
  'Answer using ONLY the transmissions given to you. They are machine-made',
  'from poor radio and many are garbled. If the transcripts do not answer the',
  'question, say so plainly and say what you did hear instead. Never fill a',
  'gap with what is probably true.',
  '',
  'Rules that matter more than being helpful:',
  '  - Do not resolve a garbled word into a plausible street, name or city.',
  '  - Do not call anything confirmed unless a transmission says it was.',
  '  - Do not describe an event as bigger than the traffic supports.',
  '  - When you cite something, give its clock time so it can be found.',
  '',
  'Write 2-5 sentences of plain English. No preamble, no bullet points unless',
  'the answer is genuinely a list. Times are Eastern.',
].join('\n');

/* Which transmissions could answer this. Pure arithmetic over fields the
   pipeline already produced, so it costs nothing and cannot hallucinate.

   Ranked by what a desk editor would look at first: the threat tier, then a
   real call type, then priority, then whether it belonged to a scene big
   enough to have its own incident. A question that named a type or a place
   also gets that filter applied, so "any fires in Dorchester" narrows before
   anything is ranked. */
function shortlist(rows, f) {
  const incSize = {};
  for (const t of rows) if (t.incidentId) incSize[t.incidentId] = (incSize[t.incidentId] || 0) + 1;

  const scored = [];
  for (const t of rows) {
    const hay = ((t.text || '') + ' ' + (t.matched || '') + ' ' + (t.address || '') + ' ' + (t.town || '')).toLowerCase();
    if (f.type) {
      const own = t.callType === f.type;
      const said = vq.TYPES[f.type] && vq.TYPES[f.type].test(hay);
      if (!own && !said) continue;
    }
    if (f.place && !hay.includes(f.place)) continue;
    if (f.landmark) {
      const aliases = vq.LANDMARKS[f.landmark] || [f.landmark];
      if (!aliases.some(a => hay.includes(a))) continue;
    }

    let s = 0;
    s += (Number(t.tier) || 0) * 10;
    if (t.signals && t.signals.length) s += 6;
    if (t.callType) s += 4;
    if (t.priority === 'high') s += 5;
    if (t.incidentId && incSize[t.incidentId] >= 3) s += 3;
    if (t.address || t.matched) s += 2;
    /* Length is a weak proxy for content: "Yeah." answers nothing. */
    s += Math.min(3, Math.floor(String(t.text || '').length / 60));
    if (/^(chatter|unintelligible|unit-status)$/.test(String(t.category || ''))) s -= 4;
    scored.push({ t, s });
  }

  scored.sort((a, b) => b.s - a.s || String(a.t.at).localeCompare(String(b.t.at)));

  /* No single scene may eat the shortlist. A forty-transmission structure fire
     would otherwise crowd out every other call of the night, which is exactly
     the wrong answer to "what were the biggest calls". */
  const perInc = {};
  const keep = [];
  for (const x of scored) {
    const k = x.t.incidentId || ('loose:' + x.t.feed);
    perInc[k] = (perInc[k] || 0) + 1;
    if (perInc[k] > 12) continue;
    keep.push(x.t);
    if (keep.length >= SHOW) break;
  }
  /* Chronological for the model, because a night has an order and a shuffled
     night reads as several unrelated ones. */
  return keep.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

module.exports = async (req, res) => {
  harden(res);
  if (!(await requireRead(req, res))) return;
  if (req.method !== 'POST') return json(res, { ok: false, why: 'POST only' }, { status: 405 });

  const t0 = Date.now();
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  const q = String((body && body.q) || '').trim().slice(0, 300);
  if (!q) return json(res, { ok: false, why: 'ask something' }, { status: 400 });
  if (!llm.enabled()) return json(res, { ok: false, why: 'no model configured' }, { status: 503 });

  /* The question's own sense of time, using the same parser the Archive uses,
     so "tonight" means the same thing in both places. A question that names no
     time gets a shift rather than the parser's two-day default, because
     somebody at the desk means recently. */
  const f = vq.parse(q);
  const namedTime = /\b(tonight|last night|yesterday|today|this morning|this evening|last (hour|week|month)|\d{4}-\d{2}-\d{2})\b/i.test(q);
  const from = namedTime ? f.from : new Date(Date.now() - DEFAULT_HOURS * 3600000);
  const to = namedTime ? f.to : new Date();

  let got;
  try {
    got = await stream.since(from.toISOString(), to.toISOString());
  } catch (e) {
    return json(res, { ok: false, why: 'could not read the archive: ' + String(e.message || e).slice(0, 160) }, { status: 503 });
  }

  const rows = got.rows || [];
  if (!rows.length) {
    return json(res, {
      ok: true,
      answer: 'Nothing is archived for that stretch, so there is nothing to answer from.',
      window: { from: from.toISOString(), to: to.toISOString() },
      considered: 0, shown: 0, tx: [], ms: Date.now() - t0,
    }, { priv: 0 });
  }

  const picked = shortlist(rows, f);
  const tx = picked.map(stream.forListening);
  const lines = tx.map(t => {
    const clock = String(t.at || '').slice(11, 16) + 'Z';
    return clock + ' [' + t.src + ']'
      + (t.where ? ' (' + String(t.where).slice(0, 60) + ')' : '')
      + ' ' + String(t.text || '').slice(0, 320);
  }).join('\n');

  try {
    const answer = await llm.chat({
      system: SYSTEM,
      user: 'QUESTION: ' + q
        + '\n\nThese are the ' + tx.length + ' most significant transmissions out of '
        + rows.length + ' heard between ' + from.toISOString().slice(11, 16) + 'Z and '
        + to.toISOString().slice(11, 16) + 'Z, in order:\n\n' + lines,
      maxTokens: 700,
      timeoutMs: 30000,
      role: 'desk-ask',
    });
    return json(res, {
      ok: true,
      q,
      answer: String(answer || '').slice(0, 1400),
      window: { from: from.toISOString(), to: to.toISOString(), named: namedTime, label: namedTime ? f.when : 'the last ' + DEFAULT_HOURS + ' hours' },
      considered: rows.length,
      shown: tx.length,
      complete: got.complete,
      tx,
      ms: Date.now() - t0,
    }, { priv: 0 });
  } catch (e) {
    /* The shortlist still goes back. A failed sentence should not cost the
       reporter the transmissions that would have answered them anyway. */
    return json(res, {
      ok: true, q, answer: null,
      why: String(e.message || e).slice(0, 200),
      window: { from: from.toISOString(), to: to.toISOString() },
      considered: rows.length, shown: tx.length, tx, ms: Date.now() - t0,
    }, { priv: 0 });
  }
};
