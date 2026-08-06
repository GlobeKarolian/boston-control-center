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

const crypto = require('crypto');
const { cronAuth, json } = require('../../lib/http');
const kv = require('../../lib/kv');
const { K } = require('../../lib/store-io');
const { geocode, nominatim } = require('../../lib/geo');
const { reconcile, alertKey, normWords } = require('../../lib/threads');

const ANALYST_MODEL = process.env.ANALYST_MODEL || 'claude-sonnet-5';

// One analyst run at a time. Two crons overlapping would double the model
// spend and race on the situations key for no benefit.
const LOCK = 'bcc:lock:analyst';

// Fingerprint of the exact text last sent to the model.
const SIG = 'bcc:analyst:sig';

/* Human corrections, shaped {merge:{key:parentId}, split:{key:parentId|true}}.
   Written by /api/sitlink when somebody on the desk folds one card into
   another or pulls one out. Read every run and applied ahead of anything the
   model says, because a person in the newsroom has information the radio does
   not carry, and because a correction that does not survive the next sixty
   seconds is not a correction. */
const LINKS = 'bcc:sit:links';

// The situations key is written with a plain SET, like every other output key,
// so the pipelined GET below can read it in the same round trip as the rest.
// That holds only while the payload stays under the 400 KB chunk threshold in
// kv.js, which is what fitToBudget() at the bottom of this file is for.
const WRITE_BUDGET = 350000;

/* No `id` field, which is the whole point: the model reports what it heard and
   which open story it thinks that belongs to, and identity is assigned here.

   `updates` means "this IS that story, later". `relatedTo` means "this belongs
   with that story but is its own thing", which is the bag on the walkway. */
const SIT_SCHEMA = {
  type: 'object',
  properties: {
    situations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          headline: { type: 'string' },
          summary: { type: 'string' },
          type: { type: 'string' },
          priority: { type: ['string', 'null'] },
          location: { type: ['string', 'null'] },
          status: { type: ['string', 'null'] },
          confidence: {
            type: ['string', 'null'],
            description: "'confirmed' when units on scene are describing what they can see, 'reported' for a call taken or a dispatch sent, 'unclear' when the radio is too broken to be sure it happened.",
          },
          updates: {
            type: ['string', 'null'],
            description: 'The id of a story from the OPEN STORIES list that this is a later development OF. The same event, further along.',
          },
          relatedTo: {
            type: ['string', 'null'],
            description: 'The id of a story from the OPEN STORIES list that this belongs WITH but is not the same event as. A bag found near where somebody went into the water is relatedTo the search, not a new suspicious package.',
          },
          feeds: {
            type: ['array', 'null'],
            items: { type: 'string' },
            description: 'The feed tags in square brackets that this situation was actually heard on, copied exactly as written. Usually one. Two when the same scene ran on a police and a fire channel.',
          },
        },
        required: ['headline', 'summary', 'type', 'location'],
      },
    },
  },
  required: ['situations'],
};

/* Kept as an array of sentences because it is edited far more often than it is
   read, and a 2,000-character string literal on one line is a diff nobody can
   review. Joined with spaces, so it reaches the model as one paragraph. */
const ANALYST_SYSTEM = [
  'You are a veteran newsroom desk editor and former public-safety dispatcher monitoring Boston-area police/fire/EMS scanner traffic.',
  'Transcripts are auto-generated from noisy radio and often garbled; use radio knowledge to interpret them.',
  "Notes: a 'patch' is a radio patch to talk to another agency; 'primary' is the lead unit; a vehicle that 'failed to stop' (often mis-heard as 'failed to start') did not pull over; phonetic letters (Sierra, Juliet) spell plate letters; 'northbound 93/95/128/3/24' are highways.",
  'Group related transmissions into distinct ACTIVE situations worth a reporter\'s attention (pursuit, working fire, serious crash, shooting, stabbing, search, barricade, major medical, hazmat).',
  'Ignore routine chatter, tests, and radio checks.',
  "For each situation give a punchy headline, a 1-2 sentence plain-English summary correcting obvious garbles, the type (lowercase, e.g. 'pursuit'), priority ('high' for anything violent, fire, pursuit, or life-threatening, else 'normal'), a best-guess LOCATION a map can find (address, intersection, highway plus town, or town/neighborhood), and status ('developing', 'active', 'winding down').",
  'Do NOT invent an id. Identity is assigned downstream and yours would be ignored.',
  'Every transcript line is prefixed with the feed it came off, in square brackets. Copy the tags a situation was actually heard on into `feeds`, exactly as written, and copy no others.',
  'Which radio carried a scene is the only evidence there is about which agency is working it, because the transcript has no agency field, and it is lost for good if you leave `feeds` empty.',

  'THREADING.',
  'You are shown the stories already open on the newsroom board, each with an id.',
  'A story on that list is one a reporter is already watching, so adding a development to it is worth more than reporting that development on its own.',
  "Set `updates` to an open story's id when what you just heard IS that story, further along: the same fire an hour in, the same pursuit two towns later.",
  "Set `relatedTo` to an open story's id when what you just heard belongs WITH that story but is a different thing.",
  'A bag found on the walkway near where somebody went into the water is a development of that search, NOT a suspicious package, and it is `relatedTo` the search.',
  'A second vehicle struck at the scene of a crash is `relatedTo` the crash.',
  'A road closure around a working fire is `relatedTo` the fire.',
  'Set neither when the thing is genuinely new.',
  'When in doubt between `relatedTo` and a brand new situation, choose `relatedTo`: a wrongly linked beat is a small editing problem, and a wrongly separate one puts a false emergency on a newsroom wall.',

  'CONFIDENCE.',
  "Mark `confidence` 'confirmed' only when units on scene are describing what they can see.",
  "Use 'reported' for a call taken or a dispatch sent, which is most traffic.",
  "Use 'unclear' when the radio is too broken to be sure the event happened at all, and be willing to use it: an unclear situation sits on the board quietly and never raises an alarm, so honesty is free.",
  'Return an empty list if it is all noise.',
].join(' ');

function hhmm(iso) {
  const d = new Date(iso || 0);
  if (!(d.getTime() > 0)) return '??:??';
  return d.toLocaleTimeString('en-US', {
    hour12: false, hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York',
  });
}

/* What the model is shown of the current board. Enough to recognise a story
   and nothing more: 25 lines of ids, types, places and headlines costs a few
   hundred tokens, where sending the situations array with its events would
   cost thousands to tell the model things it cannot act on.

   Closed stories are left out. A story nobody has said a word about in
   forty-five minutes is one the model would only ever reopen by coincidence of
   wording, and a coincidence is exactly what threading must not run on. */
function openStoriesBlock(sits) {
  const open = (sits || []).filter(s => s && s.status !== 'closed').slice(0, 25);
  if (!open.length) return 'OPEN STORIES: none. Everything you find is new.';
  const rows = open.map(s =>
    '[' + s.id + '] ' + (s.type || 'situation') +
    ' | ' + (s.location || 'location unknown') +
    ' | opened ' + hhmm(s.firstSeen) + ', last heard ' + hhmm(s.updated) +
    '\n    ' + String(s.headline || '').slice(0, 160));
  return 'OPEN STORIES on the board right now. Use these ids in `updates` and `relatedTo`:\n' + rows.join('\n');
}

/* Which radios carried a scene, kept only where the tag was really in the
   batch the model was shown. The scanner has no agency field, so this is the
   whole basis on which a card can be called State Police business rather than
   guessed at from a road name, and a tag the model made up would put a Boston
   Police call under the wrong agency with nothing on the card to give it away.
   Unmatched tags are dropped in silence. An empty list is an honest answer. */
function feedsHeard(raw, heard) {
  var out = [], seen = {}, list = Array.isArray(raw) ? raw : [], i, k, real;
  for (i = 0; i < list.length && out.length < 6; i++) {
    k = String(list[i] == null ? '' : list[i]).trim().toLowerCase();
    real = k && heard.get(k);
    if (!real || seen[real]) continue;
    seen[real] = 1;
    out.push(real);
  }
  return out;
}

/* Geocoding is per-situation and every situation is approximate by definition,
   so a miss is a situation with no pin rather than a situation dropped. */
async function locate(s) {
  if (!s.location) return null;
  try { const g = await geocode(s.location, 'Boston'); if (g) return g; } catch (e) {}
  try { return await nominatim(s.location + ', Massachusetts'); } catch (e) {}
  return null;
}

/* Keeps the written payload under the chunk threshold in kv.js, by dropping
   the oldest beats off the longest threads until it fits. Beats are the only
   thing here that grows without bound, and the oldest beat of the longest
   story is the least valuable byte on the board.

   In practice this never fires. It exists because the alternative to never
   firing is a silent switch to chunked writes that the pipelined read at the
   top of this handler would serve to the browser as a sentinel string. */
function fitToBudget(sits) {
  let s = JSON.stringify(sits);
  if (s.length <= WRITE_BUDGET) return s;
  for (let pass = 0; pass < 40 && s.length > WRITE_BUDGET; pass++) {
    let longest = null;
    for (const x of sits) {
      if (!Array.isArray(x.events) || x.events.length < 2) continue;
      if (!longest || x.events.length > longest.events.length) longest = x;
    }
    if (!longest) break;
    longest.events = longest.events.slice(Math.ceil(longest.events.length / 2));
    longest.trimmed = true;
    s = JSON.stringify(sits);
  }
  return s;
}

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
    const [rawTr, prevSig, rawSits, rawLinks] = await kv.raw([
      ['GET', K.outTranscripts],
      ['GET', SIG],
      ['GET', K.outSituations],
      ['GET', LINKS],
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
      const body = fitToBudget(sits);
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
      return json(res, Object.assign({
        skipped: why, situations: r.situations.length,
        closed: r.situations.filter(s => s.status === 'closed').length,
        aged, ms: Date.now() - t0,
      }, extra || {}));
    };

    const key = (process.env.ANTHROPIC_API_KEY || '').trim();
    if (!key) return await ageOnly('no ANTHROPIC_API_KEY');
    if (tr.length < 3) return await ageOnly('not enough traffic', { transcripts: tr.length });

    const batch = tr.slice(0, 70);
    const lines = batch.reverse().map(t => '[' + t.source + '] ' + t.text).join('\n');

    /* The evidence, kept so a situation can be heard and not only read. Each
       transcript row already carries the clip URL the relay uploaded; the
       model never sees the URLs (they are noise to it and a place to
       hallucinate), so the clip for a situation is recovered afterwards by
       matching the model's summary and beats back to the transmissions that
       produced them. A situation that quotes "20 teams physically fighting"
       finds the row that said it and inherits its audio. Text-similarity, not
       exact, because the model paraphrases; good enough to attach a play
       button to the right thirty seconds. */
    const clipRows = batch
      .filter(t => t && t.clip && t.text)
      .map(t => ({ clip: t.clip, at: t.time || t.at || null, words: normWords(t.text) }));
    const clipsForText = (s) => {
      const want = normWords(s);
      if (want.length < 3 || !clipRows.length) return [];
      const scored = clipRows.map(r => {
        const set = new Set(r.words);
        let hit = 0; for (const w of want) if (set.has(w)) hit++;
        return { clip: r.clip, at: r.at, score: hit / Math.max(6, want.length) };
      }).filter(x => x.score >= 0.34).sort((a, b) => b.score - a.score).slice(0, 4);
      // Oldest first, so a chain plays in the order it was said.
      return scored.sort((a, b) => String(a.at).localeCompare(String(b.at)))
        .map(x => ({ u: x.clip, at: x.at }));
    };

    /* The same tags the model is about to be shown, as a lookup. Anything it
       hands back that is not in here was invented, and an invented feed name
       is worse than an empty list: the state police column reads this field to
       decide whose scene a card is, so a made-up tag would file a Boston
       Police call under the State Police with nothing on the card to show for
       it. Matched case-insensitively and returned in the store's spelling. */
    const heard = new Map();
    batch.forEach(t => { if (t && t.source) heard.set(String(t.source).toLowerCase(), String(t.source)); });

    /* A cron fires whether or not anything happened. At 4am the transcript key
       still holds the last six hours of traffic, so without this guard the
       same 70 lines would go to a frontier model 1,440 times a day and come
       back with the same answer. Identical input, no call.

       The signature covers the transcript text only, never the open-stories
       block. That block changes every run as timestamps and statuses move,
       so folding it in would defeat the guard completely. */
    const sig = crypto.createHash('sha1').update(lines).digest('hex').slice(0, 20);
    if (prevSig === sig) return await ageOnly('no new traffic since last run', { transcripts: tr.length });

    /* The budget rung, same shape as the extractor's. Sonnet is the single
       most expensive call in this system and the account has already been
       run dry once. Over the daily allowance the board keeps aging on the
       ageOnly path, situations close on schedule, and nothing new is judged
       until midnight UTC. The response says so in words, because a budget
       that silences a system without saying why is how tonight happened. */
    const CAP = Math.max(0, parseInt(process.env.ANALYST_DAILY_CAP || '40', 10) || 40);
    try {
      const dk = 'bcc:spend:analyst:' + new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const [used] = await kv.raw([['INCR', dk], ['EXPIRE', dk, 172800]], 5000);
      if (Number(used) > CAP) {
        return await ageOnly('daily analyst budget spent (' + CAP + ' runs), aging only until midnight UTC',
          { transcripts: tr.length });
      }
    } catch (e) { /* a broken meter must not silence a working radio */ }

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: ANALYST_MODEL, max_tokens: 2000, system: ANALYST_SYSTEM,
        tools: [{ name: 'report_situations', description: 'Report the active situations.', input_schema: SIT_SCHEMA }],
        tool_choice: { type: 'tool', name: 'report_situations' },
        messages: [{
          role: 'user',
          content: openStoriesBlock(prev) +
            '\n\n---\n\nRecent scanner traffic (oldest first):\n\n' + lines,
        }],
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) throw new Error('anthropic ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const j = await r.json();
    const tu = (j.content || []).find(c => c.type === 'tool_use');
    const sits = (tu && tu.input && tu.input.situations) || [];

    // Ids the model is allowed to point at. Anything else it names is a
    // hallucinated reference to a story that does not exist, and gets dropped
    // rather than silently creating a link to nothing.
    const knownIds = new Set(prev.map(s => s && s.id).filter(Boolean));
    const ref = v => (v && knownIds.has(v) ? v : null);

    const fresh = await Promise.all(sits.map(async (s) => {
      const geo = await locate(s);
      const f = {
        headline: String(s.headline || '').slice(0, 200),
        summary: String(s.summary || '').slice(0, 600),
        type: String(s.type || 'situation').toLowerCase(),
        priority: s.priority === 'high' ? 'high' : 'normal',
        confidence: ['confirmed', 'reported', 'unclear'].includes(String(s.confidence || '').toLowerCase())
          ? String(s.confidence).toLowerCase() : 'reported',
        location: s.location || null,
        status: (s.status || 'active').toLowerCase(),
        lat: geo ? geo.lat : null, lon: geo ? geo.lon : null,
        matched: geo ? geo.matched : null,
        updates: ref(s.updates), relatedTo: ref(s.relatedTo),
        feeds: feedsHeard(s.feeds, heard),
        /* The audio behind the words. Matched off headline and summary
           together, since between them they quote the transmissions that
           mattered. Empty when nothing rings a bell, which reads on the
           board as a card with no play button, exactly right. */
        clips: clipsForText((s.headline || '') + ' ' + (s.summary || '')),
      };
      /* The handle a human correction hangs on before this thing has an id of
         its own. If the desk splits a beat out of a thread on Tuesday, the
         same beat coming back over the radio on Tuesday evening carries the
         same alertKey, so the split still holds. */
      f.proposedId = alertKey(f);
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

    const out = result.situations;
    return json(res, {
      ok: true, model: ANALYST_MODEL,
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
