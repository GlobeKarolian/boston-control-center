// api/cron/analyst.js
// The desk-editor pass. A stronger model reads the recent transcript stream
// and groups it into real SITUATIONS worth a reporter's attention, correcting
// the garble that comes out of noisy radio.
//
// On the Mac this ran every 25 seconds inside the worker process. Here it is
// a cron, so the floor is 60 seconds (Pro). That is fine: situations are a
// minute-scale editorial view, not a live pin.
//
// It never touches the correlation store, so it can never contend with an
// ingest. It reads the rendered transcript key and writes the situations key.
//
// ----------------------------------------------------------------- threading
//
// This pass used to be stateless. Every run replaced the situations key with
// whatever the model had just said, and asked the model to supply "a stable
// short id slug" for each situation. Nothing about that was stable. The same
// fire came back as `back-bay-fire` on one run and `fire-boylston-st` on the
// next, so the board carried it twice and the alert banner fired again on a
// story the desk had already read and dismissed.
//
// The model is no longer asked for an id. It is shown the stories already
// open, by id, and asked which of them each thing it heard belongs to.
// Identity is minted and kept in lib/threads.js, which also decides whether to
// believe the answer. The model proposes; this file disposes.

const { cronAuth, json } = require('../../lib/http');
const kv = require('../../lib/kv');
const { K } = require('../../lib/store-io');
const { reconcile } = require('../../lib/threads');
/* The prompt, the schema, the signature, and the whole dispose pipeline live
   in lib/analyst-core.js now, shared with the local-analyst endpoints
   (api/analyst-work.js and api/analyst-report.js), so a model on one of the
   Macs and this cloud path can never drift apart on what a situation is. */
const core = require('../../lib/analyst-core');
const stream = require('../../lib/stream');
const severity = require('../../lib/severity');
const verify = require('../../lib/verify');
const baseline = require('../../lib/baseline');
const llm = require('../../lib/llm');

/* The last thing this cron did, where a person can see it. Never throws: a
   broken note must not break the run it is describing. */
const LAST_RUN = 'bcc:analyst:last';
async function noteRun(o) {
  try {
    await kv.set(LAST_RUN, JSON.stringify(Object.assign({ at: new Date().toISOString() }, o)), 26 * 3600);
  } catch (e) {}
}

const ANALYST_MODEL = process.env.ANALYST_MODEL || 'claude-sonnet-5';
/* The same judgment, reachable with the key this project actually has.
   Sonnet through OpenRouter rather than through api.anthropic.com, because
   the analyst was the last thing in the system needing a second credential
   and that is the entire reason the Situations board has been empty. */
const ANALYST_MODEL_OR = process.env.ANALYST_MODEL_OR || 'anthropic/claude-sonnet-5';

// One analyst run at a time. Two crons overlapping would double the model
// spend and race on the situations key for no benefit.
const LOCK = 'bcc:lock:analyst';

// Fingerprint of the exact text last sent to the model.
const CURSOR = 'bcc:analyst:cursor';
const SIG = 'bcc:analyst:sig';

// Stamped by api/analyst-report.js each time a Mac's model judges the board.
// While this is fresh the cloud stands down completely.
const LOCAL_AT = 'bcc:analyst:local:at';

/* Human corrections, shaped {merge:{key:parentId}, split:{key:parentId|true}}.
   Written by /api/sitlink when somebody on the desk folds one card into
   another or pulls one out. Read every run and applied ahead of anything the
   model says, because a person in the newsroom has information the radio does
   not carry, and because a correction that does not survive the next sixty
   seconds is not a correction. */
const LINKS = 'bcc:sit:links';

module.exports = async (req, res) => {
  if (!cronAuth(req)) return json(res, { error: 'unauthorized' }, { status: 401 });

  const token = await kv.lock(LOCK, 90000, 0);
  if (!token) return json(res, { skipped: 'another analyst run is in flight' });

  const t0 = Date.now();
  try {
    /* One round trip for everything this run needs in order to decide
       anything. Four GETs pipelined costs the same four commands against the
       Upstash quota as four calls would, but it is one HTTP request instead of
       four, and this cron fires every minute of every day forever. */
    const [rawTr, prevSig, rawSits, rawLinks, rawLocalAt] = await kv.raw([
      ['GET', K.outTranscripts],
      ['GET', SIG],
      ['GET', K.outSituations],
      ['GET', LINKS],
      ['GET', LOCAL_AT],
    ], 10000);

    const parse = (s, fallback) => {
      try { return s ? JSON.parse(s) : fallback; } catch (e) { return fallback; }
    };
    const tr = parse(rawTr, []);
    /* let, not const: the model call below takes seconds, and the desk can
       move the board underneath us inside that window. Both get re-read
       immediately before the write. */
    let prev = parse(rawSits, []);
    let overrides = parse(rawLinks, {}) || {};

    const writeBoard = async (sits) => {
      const body = core.fitToBudget(sits);
      await kv.set(K.outSituations, body, 6 * 3600);
      return body;
    };

    /* Ageing has to happen on the runs that do NOT call the model, and most
       runs do not call the model. Without this, a board that goes quiet at 2am
       still reads "developing" at 4am, because closing a story is something
       reconcile does and reconcile only used to run when there was new traffic
       to reconcile. A wall screen that cannot go quiet is one the room stops
       believing during the hours it matters most.

       It writes only when the result actually differs from what is stored, so
       a genuinely idle night costs the four GETs above and nothing else. */
    const ageOnly = async (why, extra) => {
      const r = reconcile(prev, [], overrides);
      const body = JSON.stringify(r.situations);
      let aged = false;
      if (body !== JSON.stringify(prev)) { await writeBoard(r.situations); aged = true; }
      /* On the record, because an empty Situations rail and a rail that is
         empty for a reason look identical from the outside, and this endpoint
         has been telling nobody but the cron log for its whole life. Three of
         these skips are configuration, not weather: no ANTHROPIC_API_KEY, a
         local analyst holding the lease, and ANALYST_CLOUD unset. Any one of
         them means nothing is being judged at all, and the board says
         'Nothing major right now' the entire time. */
      await noteRun({ ran: false, why: why, situations: r.situations.length });
      return json(res, Object.assign({
        skipped: why, situations: r.situations.length,
        closed: r.situations.filter(s => s.status === 'closed').length,
        aged, ms: Date.now() - t0,
      }, extra || {}));
    };

    /* The analyst is the one judgment in this system that never moved to
       OpenRouter: it still calls api.anthropic.com directly. So Situations
       depends on a completely different credential from extraction, the desk
       read, the ask box and the verifier, and a project with a perfectly
       healthy OpenRouter key can still have an empty board. */
    /* Either door. OpenRouter is preferred because it is the key that is set,
       monitored and already carrying extraction, the desk read and the
       verifier. Anthropic direct stays as the fallback for anyone who has that
       key set instead. Only the case of neither is a stop. */
    const key = (process.env.ANTHROPIC_API_KEY || '').trim();
    if (!key && !llm.enabled()) {
      return await ageOnly('no OPENROUTER_API_KEY and no ANTHROPIC_API_KEY, so nothing can judge the radio and Situations cannot fill');
    }
    if (tr.length < 3) return await ageOnly('not enough traffic', { transcripts: tr.length });

    /* THE LISTENER'S INPUT.

       This used to be tr.slice(0, 70) off bcc:out:transcripts, a buffer that
       holds eighty. At rush hour more than eighty transmissions arrive between
       two runs and the oldest fall off unseen, so the thing meant to be
       listening to the city was blind in exactly the minutes it existed for.

       lib/stream.js reads the vault from a cursor instead: append-only,
       complete, and off Redis entirely. The buffer stays as the fallback for
       the case where Blob is unreachable, because a degraded listener beats a
       stopped one. */
    let batch = tr.slice(0, 70);
    let streamed = null;
    try {
      const cursor = (await kv.get(CURSOR)) || new Date(Date.now() - 10 * 60000).toISOString();
      const got = await stream.since(cursor);
      if (got.rows.length) {
        streamed = got;
        batch = got.rows.map(stream.forListening);
      }
    } catch (e) {
      /* Vault unreachable: fall back to the buffer and say so in the response
         rather than pretending the listener heard everything. */
      streamed = { why: String(e.message || e).slice(0, 160) };
    }
    const lines = core.linesOf(batch.length ? batch : tr);



    /* A cron fires whether or not anything happened. At 4am the transcript key
       still holds the last six hours of traffic, so without this guard the
       same 70 lines would go to a frontier model 1,440 times a day and come
       back with the same answer. Identical input, no call.

       The signature covers the transcript text only, never the open-stories
       block. That block changes every run as timestamps and statuses move,
       so folding it in would defeat the guard completely. */
    const sig = core.sigOf(lines);
    if (prevSig === sig) return await ageOnly('no new traffic since last run', { transcripts: tr.length });

    /* The local analyst. When a Mac beside the radio has judged recently,
       the cloud stands down entirely: same board, zero spend. Ten minutes of
       runner silence reopens this path so a sleeping Mac degrades to cloud
       (when enabled) rather than to a board that quietly stops updating. */
    const localAt = Date.parse(rawLocalAt || '') || 0;
    if (Date.now() - localAt < 10 * 60000) {
      return await ageOnly('local analyst is live, cloud stands down', {
        transcripts: tr.length, localAt: rawLocalAt,
      });
    }
    /* This used to require ANALYST_CLOUD=1 to run at all, which made an unset
       variable indistinguishable from a deliberate choice and left the board
       empty by default. The local analyst was an Ollama model on the Mac and
       it is not the plan any more. The gate above already stands down for a
       local analyst that has actually reported in the last ten minutes, so
       this one only has to honour somebody explicitly switching cloud off. */
    if (process.env.ANALYST_CLOUD === '0') {
      return await ageOnly('cloud analyst switched off by ANALYST_CLOUD=0 and no local analyst has reported in 10 minutes, so nothing is judging the radio', {
        transcripts: tr.length,
      });
    }

    /* The budget rung, same shape as the extractor's. Sonnet is the single
       most expensive call in this system and the account has already been
       run dry once. Over the daily allowance the board keeps aging on the
       ageOnly path, situations close on schedule, and nothing new is judged
       until midnight UTC. The response says so in words, because a budget
       that silences a system without saying why is how tonight happened. */
    /* The backstop, not the budget. This exists to stop a runaway, a cron that
       misfires in a loop or a broken signature guard that calls the model on
       every fire, from draining the account. It is NOT meant to be reached in
       normal operation.

       At the every-5-minute cadence in vercel.json the theoretical ceiling is
       288 fires a day, and most of those are skipped by the signature guard
       when nothing new was said. The old default of 40 was spent in about
       three hours and then produced nothing for the next twenty, which is how
       a newsroom tool showed an empty board through a whole news cycle. The
       default is now set above the daily ceiling so ordinary days never touch
       it, while a genuine loop firing thousands of times still trips it.

       And the window is Eastern, not UTC. A budget that reset at midnight UTC
       reset at 8pm Eastern, right as the evening cycle started, which is the
       worst possible time to zero a counter. The key is the Eastern date so
       the day the budget covers is the newsroom's day. */
    const CAP = Math.max(0, parseInt(process.env.ANALYST_DAILY_CAP || '400', 10) || 400);
    try {
      const etDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
        .format(new Date()).replace(/-/g, '');
      const dk = 'bcc:spend:analyst:' + etDay;
      const [used] = await kv.raw([['INCR', dk], ['EXPIRE', dk, 172800]], 5000);
      if (Number(used) > CAP) {
        return await ageOnly('analyst backstop tripped at ' + CAP + ' runs today, which should not happen in normal use; check for a cron loop. Aging only until midnight Eastern',
          { transcripts: tr.length });
      }
    } catch (e) { /* a broken meter must not silence a working radio */ }

    const userBlock = core.openStoriesBlock(prev)
      + '\n\n---\n\nRecent scanner traffic (oldest first):\n\n' + lines;

    let sits = [];
    let usedModel = null;
    if (llm.enabled()) {
      /* JSON mode rather than Anthropic tool-use, because this now goes
         through the one gateway every other model call uses: reasoning off,
         a real token budget, timeouts that fall back instead of escaping,
         and a line in the activity log. The analyst has been the only
         judgment in this system nobody could watch. */
      usedModel = ANALYST_MODEL_OR;
      const out = await llm.chatJSON({
        system: core.ANALYST_SYSTEM
          + '\n\nReply with a single JSON object and nothing else. It must have'
          + ' one key, "situations", whose value is an array matching this schema'
          + ' exactly:\n' + JSON.stringify(core.SIT_SCHEMA)
          + '\n\nAn empty array is a correct and expected answer. Report nothing'
          + ' you did not hear.',
        user: userBlock,
        maxTokens: 3000,
        timeoutMs: 60000,
        role: 'analyst',
        model: ANALYST_MODEL_OR,
      });
      sits = (out && (Array.isArray(out) ? out : out.situations)) || [];
      if (!Array.isArray(sits)) sits = [];
    } else {
      usedModel = ANALYST_MODEL;
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: ANALYST_MODEL, max_tokens: 2000, system: core.ANALYST_SYSTEM,
          tools: [{ name: 'report_situations', description: 'Report the active situations.', input_schema: core.SIT_SCHEMA }],
          tool_choice: { type: 'tool', name: 'report_situations' },
          messages: [{ role: 'user', content: userBlock }],
        }),
        signal: AbortSignal.timeout(60000),
      });
      if (!r.ok) throw new Error('anthropic ' + r.status + ' ' + (await r.text()).slice(0, 200));
      const j = await r.json();
      const tu = (j.content || []).find(c => c.type === 'tool_use');
      sits = (tu && tu.input && tu.input.situations) || [];
    }

    /* The dispose pipeline, shared verbatim with the local path
       (lib/analyst-core.js): geocoding, feed verification, clip
       matching, reference discipline, the works. */
    let fresh = await core.disposeReported(sits, { batch, prev });

    /* THE FLOOR, AND THE SECOND OPINION.

       Two layers between a model's enthusiasm and a reporter's phone, run in
       this order because the cheap one should reject before the expensive one
       is asked.

       lib/severity.js scores each situation on things that were observed:
       signals in the transcripts, agencies converged, units, duration, and
       how far above normal the radio is running. The model's own read is
       capped at one notch above that, so "Active Shooter" built from one unit
       clearing an address settles at a 1 rather than a 5.

       lib/verify.js then shows the claim and the raw transcripts to a model
       from a different lab, with the writer's confidence stripped out, and
       asks whether the transcripts support it. Anything it cannot stand up is
       held: it keeps its transmissions and its audio and says what failed. */
    const anomalyByFeed = {};
    try {
      for (const f of [...new Set((streamed && streamed.rows ? streamed.rows : []).map(r => r.feed))]) {
        if (!f) continue;
        const d = stream.densityByFeed(streamed.rows)[f] || 0;
        anomalyByFeed[f] = await baseline.score(f, new Date(), { n: d, mix: {} });
      }
    } catch (e) { /* no baseline yet is not a failure */ }

    /* The rows the model actually read this run, whichever source won: the
       vault stream when Blob is up, the buffer when it is not. Reading
       streamed.rows instead meant that on any Blob outage `mine` was empty for
       every situation, the floor scored them all 0 -> settled 1 -> none major,
       and the board went dark while status still reported the analyst ran ok.
       The pool is `batch` and the feed is read through every name a row might
       carry it under, so scoring survives the fallback. */
    const feedOf = (r) => r.feed || r.source || r.src || null;
    fresh = await Promise.all(fresh.map(async (f) => {
      const mine = (batch || []).filter(r => (f.feeds || []).includes(feedOf(r)));
      const feeds = [...new Set(mine.map(feedOf).filter(Boolean))];
      const units = [...new Set(mine.flatMap(r => r.units || []))];
      const span = mine.length > 1
        ? (+new Date(mine[mine.length - 1].at) - +new Date(mine[0].at)) / 60000 : 0;
      const worst = feeds.map(x => anomalyByFeed[x]).filter(Boolean)
        .sort((a, b) => (b.z || 0) - (a.z || 0))[0] || { level: 'normal' };

      const fl = severity.floor({ tx: mine, feeds, units, spanMin: span, anomaly: worst });
      const modelScore = f.priority === 'high' ? 4 : 2;
      const settled = severity.settle(fl, { score: modelScore });
      f.severity = settled.score;
      f.severityLabel = severity.label(settled.score);
      f.severityWhy = fl.reasons;
      if (settled.capped) f.severityCapped = settled.why;
      if (settled.score < 3) f.priority = 'normal';

      /* Only claims that still look like news are worth a verifier call. */
      if (!f.held && settled.score >= 3) {
        const v = await verify.check(f.headline + '. ' + f.summary, mine.length ? mine : batch);
        f = verify.apply(f, v);
      }
      /* What Situation Mode is allowed to show. */
      f.major = !f.held && f.verified === true && settled.score >= 3;
      return f;
    }));

    /* The desk can drag a card while the model is thinking, and this handler has
       been holding a copy of the board from before that call. Writing it back
       would erase the correction. A merge would heal itself next tick because the
       rule persists, but a split mints a card that exists nowhere else, so a
       stale write ends it permanently. Two commands, slow path only: the ageOnly
       returns above reconcile against a copy that is still seconds old, so they
       do not pay for this. */
    try {
      const [nowLinks, nowSits] = await kv.raw([
        ['GET', LINKS],
        ['GET', K.outSituations],
      ], 8000);
      if (nowSits) { try { const p = JSON.parse(nowSits); if (Array.isArray(p)) prev = p; } catch (e) {} }
      if (nowLinks) { try { const o = JSON.parse(nowLinks); if (o && typeof o === 'object') overrides = o; } catch (e) {} }
    } catch (e) {
      /* Reading failed, so go with what we have. A stale board beats no board,
         and the desk can drag again. */
    }

    const result = reconcile(prev, fresh, overrides);
    await writeBoard(result.situations);
    // Recorded only after the write lands, so a failed run retries next minute.
    try { await kv.set(SIG, sig, 6 * 3600); } catch (e) {}
    /* Only after the board is written. A failed run leaves the cursor where it
       was, so the next one re-reads the gap instead of stepping over it. */
    if (streamed && streamed.cursor) { try { await kv.set(CURSOR, streamed.cursor, 24 * 3600); } catch (e) {} }

    const out = result.situations;
    await noteRun({ ran: true, why: null, situations: out.length, model: usedModel });
    return json(res, {
      ok: true, model: usedModel,
      situations: out.length,
      reported: fresh.length,
      opened: result.opened.length,
      threaded: fresh.length - result.opened.length,
      high: out.filter(s => s.priority === 'high').length,
      unclear: out.filter(s => s.confidence === 'unclear').length,
      closed: out.filter(s => s.status === 'closed').length,
      located: out.filter(s => s.lat !== null && s.lat !== undefined).length,
      read: tr.length, ms: Date.now() - t0,
    });
  } catch (e) {
    /* Leave the previous situations in place. A failed analyst run must not
       blank the editorial layer: stale beats empty here, because an empty
       board reads as a quiet city rather than as a broken cron. */
    return json(res, {
      error: 'analyst failed',
      detail: String(e.message || e).slice(0, 300),
      ms: Date.now() - t0,
    }, { status: 500 });
  } finally {
    await kv.unlock(LOCK, token);
  }
};
