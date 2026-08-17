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
const trace = require('../lib/trace');
const et = require('../lib/etime');

/* How many transmissions the model is allowed to read. Enough to answer a
   question about a night, small enough to stay honest and cheap. */
const SHOW = 150;
/* How far back a bare question reaches when it names no time of its own.
   Two days, because that is the span a reporter means by "recently" and the
   span an editor is asked about at the start of a shift. It is also six
   thousand transmissions, which is the reason for everything below. */
const DEFAULT_HOURS = 48;

/* A question is allowed to read far more of the radio than the live listener,
   because it is a deliberate act by a person waiting for an answer rather than
   a loop running every few minutes. Roughly 2,500 batch objects covers two
   busy days; past that the reader samples evenly and says so. */
const ASK_ROWS = 9000;
const ASK_OBJECTS = 2600;

const SYSTEM = [
  'You are a Boston Globe desk editor who has been listening to police, fire,',
  'EMS and transit scanners. A reporter is asking you a question.',
  '',
  'Answer using ONLY the transmissions given to you. They are machine-made',
  'from poor radio and many are garbled. If the transcripts do not answer the',
  'question, say so plainly and say what you did hear instead. Never fill a',
  'gap with what is probably true.',
  '',
  'A dispatch IS news. When a channel sends units to a stabbing, a shooting or',
  'a fire, that is a reported incident and you say so plainly and first. The',
  'radio almost never says the words "confirmed", so "no confirmed stabbing"',
  'is technically true of nearly every real stabbing and it reads as nothing',
  'happened. Lead with what was dispatched and what units did, then qualify',
  'what was never confirmed. Never open an answer by denying the thing that',
  'was asked about when the transcripts contain it.',
  '',
  'Answer the most recent matching incident first. Somebody asking about a',
  'stabbing at 2am means the one on the air now, not one from yesterday',
  'morning, and a list in archive order buries it.',
  '',
  'Rules that matter more than being helpful:',
  '  - Do not resolve a garbled word into a plausible street, name or city.',
  '  - Do not call anything confirmed unless a transmission says it was.',
  '  - Do not describe an event as bigger than the traffic supports.',
  '  - When you cite something, give its clock time so it can be found.',
  '  - When nothing matches what was asked, say so in the first sentence, then',
  '    say what the window did contain. Do not stretch unrelated traffic into',
  '    an answer, and do not stop at "there is nothing" when there is context.',
  '  - Say what you READ, never what happened. "None of the transmissions I',
  '    read mention a fight" is something you know. "There were no fights" is',
  '    not, and it is not yours to say: you are reading a sample of a few',
  '    scanner channels, not a record of the city. A reporter told no, who',
  '    then finds out otherwise, stops asking. That costs more than a long',
  '    answer ever does.',
  '',
  'Write 2-5 sentences of plain English. No preamble, no bullet points unless',
  'the answer is genuinely a list.',
  '',
  'Every transmission below is stamped with the Eastern time it was said. Copy',
  'those times through unchanged. Do not convert, offset or relabel them.',
].join('\n');

/* Which transmissions could answer this. Pure arithmetic over fields the
   pipeline already produced, so it costs nothing and cannot hallucinate.

   Ranked by what a desk editor would look at first: the threat tier, then a
   real call type, then priority, then whether it belonged to a scene big
   enough to have its own incident. A question that named a type or a place
   also gets that filter applied, so "any fires in Dorchester" narrows before
   anything is ranked. */
/* Below this many matches, a filtered question also gets the night's most
   significant traffic, marked as context. Asked "any stabbings tonight" on a
   quiet night, the filter matches nothing and the honest answer is "no
   stabbings, here is what there was" rather than a shrug about an empty list.
   The first version returned zero rows and the model dutifully reported that
   it had been given nothing, which is true, useless, and reads to a reporter
   as though the archive had been searched properly. */
const MIN_MATCH = 15;

function rank(rows, incSize) {
  const scored = [];
  for (const t of rows) {
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
  return scored;
}

/* No single scene may take more than a slice of the list, because a
   forty-transmission structure fire would otherwise crowd out every other
   call of the night, which is the wrong answer to "what were the biggest
   calls". */
function spread(scored, cap, perScene) {
  const seen = {};
  const keep = [];
  for (const x of scored) {
    const k = x.t.incidentId || ('loose:' + x.t.feed);
    seen[k] = (seen[k] || 0) + 1;
    if (seen[k] > perScene) continue;
    keep.push(x.t);
    if (keep.length >= cap) break;
  }
  return keep;
}

function shortlist(rows, f) {
  const incSize = {};
  for (const t of rows) if (t.incidentId) incSize[t.incidentId] = (incSize[t.incidentId] || 0) + 1;

  const asked = !!(f.type || f.place || f.landmark || (f.words && f.words.length));
  const matches = [];
  for (const t of rows) {
    if (!asked) { matches.push(t); continue; }
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
    if (f.words && f.words.length && !f.type && !f.place && !f.landmark) {
      /* vq.wordIn, not hay.includes. A substring test misses the plural a
         reporter actually types and matches inside longer words at the same
         time: "fights" found nothing in a transmission that said "for a
         Fight", and "fire" would have matched "firefighter". */
      if (!f.words.some(w => vq.wordIn(hay, w))) continue;
    }
    matches.push(t);
  }

  const hit = spread(rank(matches, incSize), SHOW, 12);

  /* Too few, or none: add the night's most significant traffic so the answer
     can be "not that, but here is what happened" instead of silence. Marked,
     so the model knows which lines answer the question and which are only
     there for context. */
  let context = [];
  if (hit.length < MIN_MATCH) {
    const have = new Set(hit);
    const rest = rows.filter(t => !have.has(t));
    context = spread(rank(rest, incSize), SHOW - hit.length, 8);
  }

  /* Chronological, because a night has an order and a shuffled night reads as
     several unrelated ones. */
  const byTime = (a, b) => String(a.at).localeCompare(String(b.at));
  return { hit: hit.sort(byTime), context: context.sort(byTime), asked };
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
    /* evenly: when a window is too big to read whole, cover all of it thinly
       rather than the end of it thickly. Asked about two days, a reporter
       means both, and an answer built only from last night while claiming to
       cover two is worse than one that admits it sampled. */
    got = await stream.since(from.toISOString(), to.toISOString(),
                             { maxRows: ASK_ROWS, maxObjects: ASK_OBJECTS, evenly: true });
  } catch (e) {
    return json(res, { ok: false, why: 'could not read the archive: ' + String(e.message || e).slice(0, 160) }, { status: 503 });
  }

  const rows = got.rows || [];

  /* Fold in the live board for the minutes the vault has not caught up on.
     The vault lags on a busy night, so a question asked at 23:36 was answered
     from data that ended at 13:30 and missed the shots-fired call that was
     active on screen. The buffer is deduped against the vault by id and by
     timestamp+feed, so nothing is counted twice, and the freshest traffic is
     in the set the model actually reads. */
  try {
    const live = await stream.bufferSince(from.toISOString());
    if (live.length) {
      const seen = new Set(rows.map(r => r.id || (r.at + '|' + (r.feed || r.src))));
      for (const r of live) {
        const k = r.id || (r.at + '|' + (r.feed || r.src));
        if (!seen.has(k)) { seen.add(k); rows.push(r); }
      }
      rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    }
  } catch (e) { /* the buffer is a bonus, never a blocker */ }

  if (!rows.length) {
    return json(res, {
      ok: true,
      answer: 'Nothing is archived for that stretch, so there is nothing to answer from.',
      window: { from: from.toISOString(), to: to.toISOString() },
      considered: 0, shown: 0, tx: [], ms: Date.now() - t0,
    }, { priv: 0 });
  }

  const picked = shortlist(rows, f);
  const tx = picked.hit.concat(picked.context).map(stream.forListening);
  /* Eastern, because that is what the answer has to be written in and what an
     editor will check against the clock on the wall. Handing the model UTC
     under an instruction to answer in Eastern is how a 1:22am fire came back
     as a 5:22am one. */
  const fmt = (t) => {
    const clock = et.clock(t.at) + ' ET';
    return clock + ' [' + t.src + ']'
      + (t.where ? ' (' + String(t.where).slice(0, 60) + ')' : '')
      + ' ' + String(t.text || '').slice(0, 320);
  };
  const hitLines = picked.hit.map(stream.forListening).map(fmt).join('\n');
  const ctxLines = picked.context.map(stream.forListening).map(fmt).join('\n');

  let user = 'QUESTION: ' + q + '\n\n';
  if (picked.hit.length) {
    user += (picked.asked ? 'Transmissions matching what was asked about' : 'The most significant transmissions')
      + ' (' + picked.hit.length + ' of ' + rows.length + ' heard):\n\n' + hitLines + '\n';
  } else if (got.complete) {
    user += 'NOTHING in the ' + rows.length + ' transmissions heard matches what was asked about,'
      + ' and those are ALL of them for this window. Say that plainly first.\n';
  } else {
    /* THE SENTENCE THAT MUST NOT BE WRITTEN.
     *
     * On 17 August at 02:20 the desk answered "any fights?" with "There are no
     * fights dispatched in this window." It had read 150 of 3,121
     * transmissions. There had been a brawl outside Russell House Tavern.
     *
     * The sampling was broken and is fixed elsewhere, but the sentence was a
     * separate failure and the more dangerous one, because it would have been
     * wrong on any sampled window whatsoever. An absence is a claim about
     * everything, and a sample cannot support a claim about everything. A
     * newsroom that is told "no" and finds out otherwise stops asking, and a
     * tool nobody asks is worse than no tool.
     *
     * So the model is told what it actually read, in numbers, and told
     * plainly that "there were none" is not available to it. */
    user += 'NOTHING in the ' + rows.length + ' transmissions read matches what was asked about.\n'
      + 'IMPORTANT: those ' + rows.length + ' are a SAMPLE. The archive holds '
      + (got.objects ? 'far more' : 'more') + ' for this window and it was too large to read whole.\n'
      + 'You therefore DO NOT KNOW whether it happened. Do not write "there are no", "there were no",'
      + ' "nothing happened" or any other statement of absence. Say instead that you read '
      + rows.length + ' transmissions from across the window and none of them mention it, and that'
      + ' this does not rule it out. Then say what you did read.\n';
  }
  if (picked.context.length) {
    user += '\nFor context, the most significant OTHER traffic in the same window. '
      + 'These do not answer the question; use them only to say what did happen:\n\n' + ctxLines + '\n';
  }
  user += '\nWindow: ' + et.full(from) + ' to ' + et.full(to) + ', Eastern.'
    + ' Every clock time above is ALREADY Eastern. Quote them exactly as given.'
    + ' Do not shift them by any number of hours and do not append Z or UTC.';
  if (!got.complete) {
    /* Said to the model as well as to the reader, so a sampled window is not
       described as an exhaustive one. Not conditional: it used to end "say so
       if the answer depends on completeness", and a model answering a
       yes-or-no question does not reliably notice that its answer depends on
       completeness. Every negative answer does. */
    user += '\nNOTE: this is an even sample across the window, not every transmission in it.'
      + ' Never describe what you were given as everything that happened, and never state'
      + ' that something did not happen. You can only report what you read.';
  }

  try {
    const answer = await llm.chat({
      system: SYSTEM,
      user,
      maxTokens: 700,
      timeoutMs: 30000,
      role: 'desk-ask',
    });
    /* The transmissions the answer is actually about, computed from what it
       says rather than asked for. This is what makes the answer listenable:
       "a footchase down Geneva Street at 05:12" becomes a play-in-order
       control over the four transmissions that carry those words and that
       time. An answer that traces to nothing gets no control, which is also
       how a fabricated one announces itself. */
    const answerText = String(answer || '');
    const heard = trace.cited(answerText, picked.hit.concat(picked.context), { cap: 14 });

    return json(res, {
      ok: true,
      q,
      answer: answerText.slice(0, 1400),
      cited: { at: heard.at, clips: heard.clips, n: heard.n },
      window: { from: from.toISOString(), to: to.toISOString(), named: namedTime, label: namedTime ? f.when : 'the last ' + DEFAULT_HOURS + ' hours' },
      considered: rows.length,
      shown: tx.length,
      matched: picked.hit.length,
      complete: got.complete,
      sampled: !!got.sampled,
      objects: got.objects,
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
