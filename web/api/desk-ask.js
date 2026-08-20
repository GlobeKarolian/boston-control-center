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
const sceneLib = require('../lib/scenes');
const severity = require('../lib/severity');

/* How many transmissions the model is allowed to read. Enough to answer a
   question about a night, small enough to stay honest and cheap. */
const SHOW = 150;
/* How many scenes the model is shown, and how many lines any one of them may
   take. A forty-line structure fire is one scene; it gets one block, not the
   whole page. */
const SCENES = 18;
const LINES_PER_SCENE = 10;
/* The model. The rest of the pipeline runs on the cheapest thing that can
   label a line, because it runs every minute. A question is a person waiting
   for an answer, a few times an hour at most, and the answer is read as
   prose: it gets the model the scene summaries get, with the everyday model
   behind it so a bad night for one provider is not a dead ask box. ASK_MODEL
   overrides. */
const ASK_MODEL = process.env.ASK_MODEL || llm.SCENE_MODEL;
const ASK_FALLBACK = process.env.ASK_MODEL2 || llm.PRIMARY;
/* How far back a bare question reaches when it names no time of its own.
   Two hours, because that is what "recently" means at a desk and because the
   vault can answer it in milliseconds. Forty-eight was the cause of "why did
   it take ten seconds to say nothing happened", which is the wrong shape for
   the question. */
const DEFAULT_HOURS = 2;

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
  'The transmissions come grouped into SCENES: the calls they belonged to,',
  'each with its time span, the radios that carried it, where it was, which',
  'units were on it and how many transmissions it ran to. Write about scenes,',
  'not lines: what the call was, when it started, who went, what they found,',
  'how it ended if the radio said. A scene with many transmissions and several',
  'agencies is a bigger event than one line on one channel, and your answer',
  'should say so. Not every line in a scene repeats the thing that was asked',
  'about; the scene is there because one of them did.',
  '',
  'A dispatch IS news. When a channel sends units to a stabbing, a shooting or',
  'a fire, that is a reported incident and you say so plainly and first. The',
  'radio almost never says the words "confirmed", so "no confirmed stabbing"',
  'is technically true of nearly every real stabbing and it reads as nothing',
  'happened. Lead with what was dispatched and what units did, then qualify',
  'what was never confirmed. Never open an answer by denying the thing that',
  'was asked about when the transcripts contain it.',
  '',
  'Answer the most recent matching scene first. Somebody asking about a',
  'stabbing at 2am means the one on the air now, not one from yesterday',
  'morning, and a list in archive order buries it. When the question is about',
  'the biggest or most serious calls, lead with the scene that ranks first',
  'and work down; the order the scenes are given in is already that ranking.',
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

   SCENES, NOT LINES. The first version ranked single transmissions by tier,
   call type and priority and handed the model a hundred and fifty of them,
   spread a dozen to a scene, in time order. That is a hundred and fifty
   fragments of forty different calls, and the model was left to work out
   which fragments were one event before it could say a word about any of
   them. It did that badly, as anyone would: a question about "the biggest
   calls tonight" came back as a tour of loose lines, and a question about a
   stabbing got the one line that said "stabbing" without the six that said
   what happened next, because those never said the word.

   So the window is grouped back into scenes first (lib/scenes.js, the same
   grouping the Archive and Shift Change use), and it is SCENES that are
   chosen and ranked. A scene is in because one of its lines answered the
   question, and once it is in, its best lines come with it, whether or not
   each one repeats the word that was asked. The model reads events, with a
   beginning and an end and the agencies on them, and writes about events.

   Two rankings, because two kinds of question. A question that names a
   thing (a type, a place, a word) wants the scenes that match it, best match
   first and newest first among equals, because somebody asking about a
   stabbing at 2am means the one on the air now. A question that names
   nothing ("what's the biggest thing tonight", "anything going on") wants
   the scenes that mattered, ranked by the same severity floor Shift Change
   uses, so the ask box and the briefing agree about what a big night was. */
/* Below this many matching scenes, a filtered question also gets the window's
   most significant traffic, marked as context. Asked "any stabbings tonight"
   on a quiet night, the filter matches nothing and the honest answer is "no
   stabbings, here is what there was" rather than a shrug about an empty
   list. */
const MIN_MATCH = 3;

/* How much a scene matters, independent of the question: the floor's score,
   the peak tier anybody reached on it, and a nudge for priority. Used to rank
   bare questions and to pick context for narrow ones. */
function weight(scene) {
  const tx = scene.tx;
  const span = tx.length > 1 ? (+new Date(tx[tx.length - 1].at) - +new Date(tx[0].at)) / 60000 : 0;
  let fl = { score: 0, reasons: [] };
  try { fl = severity.floor({ tx, feeds: scene.feeds, units: scene.units, spanMin: span, anomaly: { level: 'normal' } }); } catch (e) { /* a bad row is not a reason to drop a scene */ }
  let tier = 0, high = false;
  for (const t of tx) { tier = Math.max(tier, Number(t.tier) || 0); if (t.priority === 'high') high = true; }
  /* A loose burst is twenty minutes of a channel, not a call, and the floor's
     volume terms read a busy channel as a big scene: on the first real slice
     a chunk of boston-police ranked third for "the biggest calls tonight"
     because it held fifty-six lines and one tier-3 sentence. A burst ranks by
     what was SAID in it, nothing else; a real shots-fired line that never
     made a scene still surfaces, and ordinary busyness does not. */
  const score = scene.loose
    ? tier * 10 + (high ? 4 : 0)
    : fl.score * 10 + tier * 3 + (high ? 4 : 0) + Math.min(3, scene.units.length / 3);
  return { floor: fl.score, reasons: fl.reasons, tier, high, score };
}

/* The lines of a scene worth showing: the ones that answered the question
   first, then the ones that carry a signal, then the rest in time order, up
   to the cap, and the result back in time order so it reads as a call. The
   first and last lines are always kept when there is room, because how a
   call opened and how it ended are the two things a reporter asks. */
function linesOf(scene, matchedSet, cap) {
  const tx = scene.tx;
  if (tx.length <= cap) return tx.slice();
  const picked = new Set();
  const take = (t) => { if (picked.size < cap) picked.add(t); };
  take(tx[0]);
  for (const t of tx) if (matchedSet.has(t)) take(t);
  take(tx[tx.length - 1]);
  const rest = tx.filter(t => !picked.has(t))
    .map(t => ({ t, s: (Number(t.tier) || 0) * 10 + ((t.signals || []).length ? 6 : 0) + (t.callType ? 4 : 0) + (t.priority === 'high' ? 5 : 0) + Math.min(3, Math.floor(String(t.text || '').length / 60)) - (/^(chatter|unintelligible|unit-status)$/.test(String(t.category || '')) ? 4 : 0) }))
    .sort((a, b) => b.s - a.s);
  for (const r of rest) take(r.t);
  return tx.filter(t => picked.has(t));
}

function shortlist(rows, f) {
  const scenes = sceneLib.assemble(rows);
  const asked = !!(f.type || f.place || f.landmark || (f.words && f.words.length) || (f.phrases && f.phrases.length));

  const scored = scenes.map(scene => {
    const w = weight(scene);
    let best = 0, matched = new Set();
    if (asked) {
      for (const t of scene.tx) {
        /* The archive's own scorer: type, place, landmark, phrases and words,
           with the same plural folding and the same "asked for a fire, this
           is not one" gate, so a question means the same thing on the desk
           and in the Archive. */
        const sc = vq.score(t, f);
        if (sc > 0) { matched.add(t); if (sc > best) best = sc; }
      }
    }
    return { scene, w, best, matched, last: +new Date(scene.to) };
  });

  let hits, context = [];
  if (asked) {
    /* Best match first, and among the scenes that match about as well, the
       most recent first, so the list the model reads is already in the order
       it is told to answer in: somebody asking about a stabbing at 2am means
       the one on the air now. */
    const m = scored.filter(x => x.best > 0).sort((a, b) => b.best - a.best || b.last - a.last);
    const top = m.length ? m[0].best : 0;
    const close = m.filter(x => x.best >= top * 0.7).sort((a, b) => b.last - a.last);
    const rest = m.filter(x => x.best < top * 0.7);
    hits = close.concat(rest).slice(0, SCENES);
  } else {
    /* The scenes that were more than routine, biggest first. On a quiet
       night nothing clears that bar, and the honest answer still names the
       biggest things there were, so the top few come anyway and the model
       can say "quiet; the largest thing was a car stop". */
    const ranked = scored.slice().sort((a, b) => b.w.score - a.w.score || b.last - a.last);
    const clear = ranked.filter(x => x.w.floor >= 2 || x.w.tier >= 2 || x.w.high);
    hits = clear.slice(0, SCENES);
    if (hits.length < 3) for (const x of ranked) { if (hits.length >= 3) break; if (!hits.includes(x)) hits.push(x); }
  }
  if (asked && hits.length < MIN_MATCH) {
    const have = new Set(hits.map(h => h.scene));
    context = scored.filter(x => !have.has(x.scene) && x.w.floor >= 2)
      .sort((a, b) => b.w.score - a.w.score || b.last - a.last)
      .slice(0, Math.max(0, 8 - hits.length));
  }

  /* Lines, capped overall, matched scenes first. */
  let budget = SHOW;
  const pack = (list, perScene) => list.map(x => {
    const lines = linesOf(x.scene, x.matched, Math.min(perScene, Math.max(2, budget)));
    budget -= lines.length;
    return {
      id: x.scene.id, from: x.scene.from, to: x.scene.to, feeds: x.scene.feeds, units: x.scene.units.slice(0, 10),
      place: x.scene.place, type: x.scene.type, n: x.scene.n, shown: lines.length,
      severity: x.w.floor, tier: x.w.tier, why: x.w.reasons, matched: x.matched.size,
      lines,
    };
  }).filter(b => b.lines.length);
  const hitBlocks = pack(hits, LINES_PER_SCENE);
  const ctxBlocks = pack(context, 6);
  return { hits: hitBlocks, context: ctxBlocks, asked, scenes: scenes.length };
}

/* The prompt, from the shortlist. A function of its own so tools/ask-replay.js
   can show exactly what the model was handed for a question against a slice
   of the real archive, with no model and no network. */
function composePrompt(q, rows, got, picked, from, to) {
  /* Eastern, because that is what the answer has to be written in and what an
     editor will check against the clock on the wall. Handing the model UTC
     under an instruction to answer in Eastern is how a 1:22am fire came back
     as a 5:22am one. */
  const fmt = (t0) => {
    const t = stream.forListening(t0);
    const clock = et.clock(t.at) + ' ET';
    return '    ' + clock + ' [' + t.src + ']'
      + (t.where ? ' (' + String(t.where).slice(0, 60) + ')' : '')
      + ' ' + String(t.text || '').slice(0, 320);
  };
  /* One block per scene: when, which radios, where, which units, how much of
     it is shown, then the lines. The model is told what a scene is so it
     writes about events and not about fragments. */
  const block = (b, i, label) => {
    const span = et.clock(b.from) + (b.to !== b.from ? ' to ' + et.clock(b.to) : '') + ' ET';
    return label + ' ' + (i + 1) + ' — ' + span + ' — ' + b.feeds.join(', ')
      + (b.place ? ' — at ' + String(b.place).slice(0, 70) : '')
      + (b.type ? ' — ' + b.type : '')
      + (b.units.length ? ' — units ' + b.units.slice(0, 8).join(' ') : '')
      + ' — ' + b.n + ' transmission' + (b.n === 1 ? '' : 's') + (b.shown < b.n ? ', ' + b.shown + ' shown' : '')
      + '\n' + b.lines.map(fmt).join('\n');
  };
  const hitText = picked.hits.map((b, i) => block(b, i, 'SCENE')).join('\n\n');
  const ctxText = picked.context.map((b, i) => block(b, i, 'CONTEXT')).join('\n\n');

  let user = 'QUESTION: ' + q + '\n\n';
  if (picked.hits.length) {
    user += (picked.asked
      ? 'Scenes with at least one transmission matching what was asked about, best match first'
      : 'The most significant scenes in the window, biggest first')
      + ' (' + picked.hits.length + ' of ' + picked.scenes + ' scenes, out of ' + rows.length + ' transmissions heard):\n\n' + hitText + '\n';
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
    user += '\nFor context, the most significant OTHER scenes in the same window. '
      + 'These do not answer the question; use them only to say what did happen:\n\n' + ctxText + '\n';
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
  return user;
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
  /* The parser says whether a time was named; this file used to keep its own
     list of time words and it lacked "overnight", "this afternoon" and "last
     6 hours", so those were answered from the two-hour default while the
     parser had already worked the window out. One list. */
  const namedTime = !!f.named;
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
  const flat = (blocks) => blocks.flatMap(b => b.lines);
  const tx = flat(picked.hits).concat(flat(picked.context)).map(stream.forListening);
  const user = composePrompt(q, rows, got, picked, from, to);

  try {
    const answer = await llm.chat({
      system: SYSTEM,
      user,
      maxTokens: 700,
      timeoutMs: 40000,
      role: 'desk-ask',
      model: ASK_MODEL,
      fallback: ASK_FALLBACK,
    });
    /* The transmissions the answer is actually about, computed from what it
       says rather than asked for. This is what makes the answer listenable:
       "a footchase down Geneva Street at 05:12" becomes a play-in-order
       control over the four transmissions that carry those words and that
       time. An answer that traces to nothing gets no control, which is also
       how a fabricated one announces itself. */
    const answerText = String(answer || '');
    const heard = trace.cited(answerText, flat(picked.hits).concat(flat(picked.context)), { cap: 14 });

    return json(res, {
      ok: true,
      q,
      answer: answerText.slice(0, 1400),
      cited: { at: heard.at, clips: heard.clips, n: heard.n },
      window: { from: from.toISOString(), to: to.toISOString(), named: namedTime, label: namedTime ? f.when : 'the last ' + DEFAULT_HOURS + ' hours' },
      considered: rows.length,
      shown: tx.length,
      matched: flat(picked.hits).length,
      scenes: picked.hits.map(b => ({ id: b.id, from: b.from, to: b.to, feeds: b.feeds, units: b.units, place: b.place, type: b.type, n: b.n, severity: b.severity, matched: b.matched })),
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

module.exports._shortlist = shortlist;
module.exports._composePrompt = composePrompt;
module.exports._SYSTEM = SYSTEM;
module.exports._model = { model: ASK_MODEL, fallback: ASK_FALLBACK };
