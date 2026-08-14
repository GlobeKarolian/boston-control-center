// lib/analyst-core.js
//
// The analyst's brain, factored out of api/cron/analyst.js so that a model on
// one of the Macs can do the same judging the cloud model does. The split is
// the same one extraction already lives by: the model PROPOSES situations,
// and the server DISPOSES — geocoding, feed verification, clip matching,
// id discipline and reconciliation all happen here, on the server, no matter
// which machine ran the model. A wrong local answer costs one board tick; a
// local model that could write the board directly would cost trust.
//
// One copy of everything. The prompt, the schema, the line format the
// signature is computed over, and the dispose pipeline are all here and only
// here, because the day the cron and the local path drift is the day they
// start disagreeing about what a situation is.

const crypto = require('crypto');
const { geocode, nominatim } = require('./geo');
const { alertKey, normWords } = require('./threads');

// Keeps the written payload under the chunk threshold in kv.js. See
// fitToBudget below; the number matches what api/cron/analyst.js always used.
const WRITE_BUDGET = 350000;

/* No `id` field, which is the whole point: the model reports what it heard and
   which open story it thinks that belongs to, and identity is assigned by
   lib/threads.js. `updates` means "this IS that story, later". `relatedTo`
   means "this belongs with that story but is its own thing". */
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

/* The same schema shaped for Ollama's constrained decoding. Two differences,
   both deliberate. `required` per item drops to the three fields that make a
   card renderable, because a forced field on a small model invites a
   fabricated location where an honest omission would have been fine, and the
   dispose path already treats missing and null the same. And the long prose
   descriptions stay, because the local model reads them the same way the
   cloud one does. */
const SIT_FORMAT_LOCAL = (() => {
  const f = JSON.parse(JSON.stringify(SIT_SCHEMA));
  f.properties.situations.items.required = ['headline', 'summary', 'type'];
  return f;
})();

/* Kept as an array of sentences because it is edited far more often than it is
   read. Joined with spaces, so it reaches the model as one paragraph. */
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
   and nothing more. Closed stories are left out: a story nobody has said a
   word about in forty-five minutes is one the model would only ever reopen by
   coincidence of wording. */
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

/* The exact text the model judges, and therefore the exact text the change
   signature is computed over. One copy, used by the cron, the work endpoint
   and the report endpoint, because two implementations of "the same lines"
   is how a signature stops matching itself. Oldest first. */
function linesOf(tr) {
  return (tr || []).slice(0, 70).reverse()
    .map(t => '[' + t.source + '] ' + t.text).join('\n');
}

function sigOf(lines) {
  return crypto.createHash('sha1').update(lines).digest('hex').slice(0, 20);
}

/* Which radios carried a scene, kept only where the tag was really in the
   batch the model was shown. A tag the model made up would file a Boston
   Police call under the wrong agency with nothing on the card to give it
   away. Unmatched tags are dropped in silence. */
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

/* Geocoding is per-situation and every situation is approximate by
   definition, so a miss is a situation with no pin, never a situation
   dropped. */
async function locate(s) {
  if (!s.location) return null;
  try { const g = await geocode(s.location, 'Boston'); if (g) return g; } catch (e) {}
  try { return await nominatim(s.location + ', Massachusetts'); } catch (e) {}
  return null;
}

/* The audio behind the words. The model never sees clip URLs (noise to it,
   and a place to hallucinate), so the clip for a situation is recovered
   afterwards by matching its summary back to the transmissions that produced
   it. Text-similarity, not exact, because the model paraphrases. */
function clipMatcher(batch) {
  const clipRows = (batch || [])
    .filter(t => t && t.clip && t.text)
    .map(t => ({ clip: t.clip, at: t.time || t.at || null, words: normWords(t.text) }));
  return function clipsForText(s) {
    const want = normWords(s);
    if (want.length < 3 || !clipRows.length) return [];
    /* Scored per transmission, normalized by the TRANSMISSION's length: what
       fraction of this thirty seconds of radio made it into the summary. The
       first version normalized by the summary's length, which quietly made
       matching impossible for verbose summaries: a 15-word transmission can
       never cover a third of a 60-word summary, so the situations written by
       wordier models carried no audio at all. The question was always "does
       the summary quote this clip", and that is the row's fraction, not the
       summary's. */
    const wantSet = new Set(want);
    const scored = clipRows.map(r => {
      let hit = 0; for (const w of r.words) if (wantSet.has(w)) hit++;
      return { clip: r.clip, at: r.at, score: hit / Math.max(6, r.words.length) };
    }).filter(x => x.score >= 0.34).sort((a, b) => b.score - a.score).slice(0, 4);
    return scored.sort((a, b) => String(a.at).localeCompare(String(b.at)))
      .map(x => ({ u: x.clip, at: x.at }));
  };
}

/* The dispose pipeline: everything that stands between "the model said" and
   "the board shows". Identical no matter which machine ran the model.
   Returns the mapped situations ready for lib/threads.reconcile. */
/* --------------------------------------------------- grounding the claim ---

   The night this was written, the board carried "Active Shooter at 81 Walden
   Street, Cambridge - Confirmed by Police", built out of a drunk call. Beside
   it sat "Pursuit of BMW 330-XX on I-93 Northbound - State Police Confirm",
   built out of a transmission that said "they're NOT pursuing". Both cards
   carried confidence: reported while their headlines said confirmed.

   Two distinct failures, and both are the server's job to catch, because
   asking a model not to hallucinate is a hope and checking its homework is a
   rule.

   The first is unearned corroboration. Every update was arriving with a
   "- Confirmed by Police" style suffix, because the analyst reads OPEN
   STORIES, sees its own previous headline, and treats it as a second source.
   A model confirming itself is the oldest failure in this building and it now
   gets stripped unless the radio actually said so.

   The second is severity with no root in the audio. If no transmission in the
   batch contains a word from the claimed category, the claim did not come
   from the radio, it came from the model. The highest-harm words are the ones
   worth policing hardest, because those are the ones that move a newsroom:
   shooter, hostage, explosion, fatality. A downgrade here costs a headline. A
   miss costs the Globe. */

const CONFIRM_SUFFIX = /\s*[-–—,:]\s*(?:as\s+)?(?:now\s+)?(?:officially\s+)?(?:confirmed|verified|corroborated)\b[^,.;]*$|\s*[-–—,:]\s*[A-Z][A-Za-z ]{2,30}\s+(?:confirms?|confirmed|verifies|verified)\b[^,.;]*$/i;
const CONFIRM_WORD = /\b(confirm|confirmed|confirming|verified|on scene and|we have it|positive)\b/i;

/* Claims that must be traceable to something a human said on the radio.
   Each is the word a reporter would repeat, and the transmission words that
   would justify it. */
/* Places the radio did not name. The Walden card said Cambridge with
   location, matched, lat, lon and feeds all null: nothing in the pipeline
   placed it, the model simply knows where Walden Street is and typed it. A
   city in a headline reads as dispatch information to a reporter, so it has
   to come from a transmission or from the geocoder, never from the model's
   general knowledge of Massachusetts. */
const CITIES = /\b(Boston|Cambridge|Somerville|Brookline|Quincy|Newton|Medford|Malden|Everett|Chelsea|Revere|Winthrop|Watertown|Belmont|Arlington|Lowell|Lynn|Waltham|Framingham|Braintree|Milton|Dedham|Melrose|Needham)\b/g;

const GROUNDED = [
  { claim: /\bactive shooter\b/i, evidence: /\b(active shooter|shooter|shots fired|shooting|gunfire|gunshots?|man with a gun|armed (?:male|female|party|suspect))\b/i },
  { claim: /\bhostage\b/i, evidence: /\b(hostage|barricad\w*)\b/i },
  { claim: /\bexplosion|\bbomb\b/i, evidence: /\b(explosion|explosive|blast|bomb|detonat\w*)\b/i },
  { claim: /\bfatal|\bdeceased\b|\bdead\b|\bkilled\b/i, evidence: /\b(fatal\w*|deceased|dead|doa|expired|coroner|medical examiner|signal 7|unresponsive|cpr)\b/i },
  { claim: /\bmass casualty\b/i, evidence: /\b(mass casualty|multiple (?:victims|patients)|mci)\b/i },
  { claim: /\bstabb\w*/i, evidence: /\b(stab\w*|knife|knives|laceration|slashing)\b/i },
  /* Not bare "fleeing": "history of fleeing from all of the two stops" is a
     records check on a driver, and it is the sentence that talked the analyst
     into a high-speed chase that dispatch had explicitly called off. The
     evidence for a pursuit is somebody pursuing. */
  { claim: /\bpursuit\b|\bchase\b/i, evidence: /\b(in pursuit|pursuit is|pursuing|chasing|actively fleeing|refus\w+ to stop|failed to stop)\b/i },
  { claim: /\bofficer (?:down|shot)\b/i, evidence: /\b(officer down|officer shot|signal 1000|shots fired at (?:an )?officer)\b/i },
];

/* Negation the model reliably drops. "They're not pursuing" became "a pursuit
   is underway": the word it needed was there, and the word in front of it was
   not. Evidence found inside a negation does not count as evidence. */
const NEGATED = /\b(?:not|no longer|never|negative on|disregard|unfounded|cancel(?:led)?|call off|called off|terminated?)\b[^.!?]{0,40}$/i;

function saidOnAir(re, batch) {
  for (const t of (batch || [])) {
    const text = String((t && t.text) || '');
    let m;
    const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    while ((m = rx.exec(text)) !== null) {
      const before = text.slice(0, m.index);
      if (NEGATED.test(before)) continue;      // "they're not pursuing"
      return String(m[0]);
    }
  }
  return null;
}

/* Returns the claims a situation makes that the radio does not support. */
function ungrounded(f, batch) {
  const claimText = (f.headline || '') + ' ' + (f.summary || '');
  const out = [];
  for (const g of GROUNDED) {
    if (!g.claim.test(claimText)) continue;
    if (!saidOnAir(g.evidence, batch)) out.push(String(claimText.match(g.claim)[0]).toLowerCase());
  }
  return out;
}

async function disposeReported(sits, { batch, prev }) {
  const clipsForText = clipMatcher(batch);
  const heard = new Map();
  (batch || []).forEach(t => {
    if (t && t.source) heard.set(String(t.source).toLowerCase(), String(t.source));
  });
  // Ids the model is allowed to point at. Anything else it names is a
  // hallucinated reference to a story that does not exist, and gets dropped
  // rather than silently creating a link to nothing.
  const knownIds = new Set((prev || []).map(s => s && s.id).filter(Boolean));
  const ref = v => (v && knownIds.has(v) ? v : null);

  return Promise.all((sits || []).map(async (s) => {
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
      clips: clipsForText((s.headline || '') + ' ' + (s.summary || '')),
    };
    /* Corroboration has to have been heard, not decided. */
    if (CONFIRM_SUFFIX.test(f.headline) && !saidOnAir(CONFIRM_WORD, batch)) {
      f.headline = f.headline.replace(CONFIRM_SUFFIX, '').trim();
      f.trimmedClaim = true;
    }
    if (f.confidence === 'confirmed' && !saidOnAir(CONFIRM_WORD, batch)) {
      f.confidence = 'reported';
      f.trimmedClaim = true;
    }

    /* A city named by nobody. If the geocoder placed this, the city is
       earned and stays. Otherwise it has to have been said out loud. */
    if (!geo) {
      const named = String(f.headline + ' ' + f.summary).match(CITIES) || [];
      for (const city of [...new Set(named)]) {
        if (saidOnAir(new RegExp('\\b' + city + '\\b', 'i'), batch)) continue;
        const strip = new RegExp('[,\\s]*\\b' + city + '\\b', 'gi');
        f.headline = f.headline.replace(strip, '').replace(/\s{2,}/g, ' ').replace(/[,\s-]+$/, '').trim();
        f.summary = f.summary.replace(strip, '').replace(/\s{2,}/g, ' ').trim();
        f.trimmedClaim = true;
      }
    }

    /* And the claim itself has to be in the audio somewhere. A situation whose
       headline says active shooter when no transmission said shooter, shots,
       or a gun is not a story with a weak source; it is a story with no
       source, and it is held rather than published. Held, not deleted: it
       keeps its transmissions and says why, so a person can look. */
    const missing = ungrounded(f, batch);
    if (missing.length) {
      f.held = true;
      f.heldWhy = 'no transmission supports: ' + missing.join(', ');
      f.priority = 'normal';
      f.confidence = 'unclear';
    }

    f.proposedId = alertKey(f);
    return f;
  }));
}

/* Keeps the written payload under the chunk threshold in kv.js, by dropping
   the oldest beats off the longest threads until it fits. In practice this
   never fires; it exists because the alternative is a silent switch to
   chunked writes that the board's pipelined read would serve to the browser
   as a sentinel string. */
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

module.exports = {
  SIT_SCHEMA, SIT_FORMAT_LOCAL, ANALYST_SYSTEM, WRITE_BUDGET,
  openStoriesBlock, linesOf, sigOf, feedsHeard, locate, clipMatcher,
  disposeReported, fitToBudget, hhmm, ungrounded, saidOnAir,
  GROUNDED, CONFIRM_SUFFIX, CONFIRM_WORD,
};
