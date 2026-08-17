// api/desk-read.js
//
//   GET /api/desk-read?minutes=20
//   -> { ok, read, watching[], quiet, heard{feed:n}, window, tx[], ms }
//
// What a person sitting in front of eleven scanners would tell you if you
// walked up and asked "anything going on?"
//
// This is deliberately not the Situations pipeline. Situations are discrete
// claims about specific events, they carry a severity, they get verified by a
// second model, and they can page somebody. This is the running read: the
// texture of the radio right now, what is worth half an eye, and an honest
// "it's quiet" when it is quiet. A desk editor spends most of the night
// saying nothing is happening, and a listener that cannot say that is a
// listener that will invent something.
//
// It reads from lib/stream.js, which means the whole window rather than a
// buffer, and it hands the model back the exact transmissions it read so the
// person asking can check the read against the radio in one glance. Every
// sentence here is answerable by scrolling.
//
// The prompt's job is to make quiet an acceptable answer. On the night this
// was written the analyst turned one unit clearing an address into a
// confirmed active shooter, and the root of that is a system that treats
// finding nothing as failure.

const { requireRead, json, harden } = require('../lib/http');
const stream = require('../lib/stream');
const llm = require('../lib/llm');
const trace = require('../lib/trace');
const et = require('../lib/etime');
const severity = require('../lib/severity');
const blob = require('../lib/blob');

const MAX_MINUTES = 60;
const MAX_LINES = 260;

/* Watch items are traced back to their transmissions by lib/trace.js, which
   does the same job for the ask box. Shared on purpose: a play button that
   points at the wrong audio is the same bug in both places, and it should
   only ever be fixed once. */

function traceWatch(what, rows) {
  const t = watchTokens(what);
  if (!t.nums.size && t.words.size < 2) return [];
  const hits = [];
  for (const r of rows) {
    const hay = String(r.text || '').toLowerCase();
    let score = 0;
    for (const n of t.nums) if (hay.includes(n)) score += 5;
    for (const w of t.words) if (hay.includes(w)) score += 1;
    /* A bare word overlap is coincidence; a digit run, or three words
       together, is a citation. */
    if (score >= 5 || score >= 3) hits.push({ r, score });
  }
  hits.sort((a, b) => b.score - a.score || String(a.r.at).localeCompare(String(b.r.at)));
  return hits.slice(0, 8).map(h => h.r).sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

const SYSTEM = [
  'You are a Boston Globe desk editor who has been listening to police, fire,',
  'EMS and transit scanners for the last few minutes. Someone just walked up',
  'and asked what is going on.',
  '',
  'The transcripts are machine-made from poor radio. Many are garbled or',
  'meaningless. Unit numbers, ten-codes, and "responding, received, clear" are',
  'the normal sound of a working night and are not news.',
  '',
  'Most of the time the honest answer is that nothing much is happening, and',
  'saying so is doing the job well. Do not manufacture significance. Do not',
  'resolve a garbled word into a plausible street or name. Do not describe',
  'something as confirmed unless a transmission says it was.',
  '',
  'Reply as JSON with exactly these keys:',
  '  read     : 2-4 sentences, plain English, what the radio sounds like right',
  '             now. If it is routine, say that and name the ordinary stuff.',
  '  watching : array of 0-3 short strings, things you would keep half an eye',
  '             on. Each must be something a transcript actually mentions.',
  '             Empty array when there is nothing.',
  '  quiet    : true when this is an ordinary stretch with nothing developing',
  '  unsure   : array of 0-3 short strings naming anything you could not make',
  '             out that might matter. Empty array when nothing.',
].join('\n');

module.exports = async (req, res) => {
  harden(res);
  if (!(await requireRead(req, res))) return;

  const t0 = Date.now();
  const minutes = Math.max(2, Math.min(MAX_MINUTES, parseInt((req.query && req.query.minutes) || '20', 10) || 20));
  const to = new Date();
  const from = new Date(+to - minutes * 60000);

  let got;
  try {
    got = await stream.since(from.toISOString(), to.toISOString());
  } catch (e) {
    return json(res, { ok: false, why: 'could not read the radio: ' + String(e.message || e).slice(0, 160) }, { status: 503 });
  }

  const rows = got.rows || [];
  /* The vault is eventually consistent: a write lands, the list lags a few
     seconds behind it, and for those seconds the archive reads empty while
     the radio is plainly talking. Redis holds the same window in
     bcc:out:transcripts, so when the vault comes back empty on a fresh
     deployment, read the buffer the live board is already reading. */
  if (!rows.length) {
    /* Vault empty for this window, which on a busy night usually means it is
       lagging, not that the city is quiet. Read the live board's buffer, which
       carries the exact minutes the vault has not caught up on. The earlier
       inline version of this filtered on `t.at`; the buffer field is `time`,
       so it dropped every row and the desk still said silence. */
    const live = await stream.bufferSince(from.toISOString());
    if (live.length) { rows.push(...live); got.complete = false; got.sampled = true; }
  }
  /* The transmissions go back with the read, always, so the answer is
     checkable without a second request. This is the whole difference between
     a summary and a claim. */
  const tx = rows.slice(-MAX_LINES).map(stream.forListening);

  if (!rows.length) {
    /* An empty vault with Blob configured is genuinely a quiet window or a
       relay problem. An empty vault with Blob OFF is the archive being dead,
       and blaming the relay for it is the lie that sat on this panel for six
       hours on 15 August 2026. Name the actual cause. */
    const vaultOff = !blob.enabled();
    return json(res, {
      ok: true,
      read: vaultOff
        ? 'The archive is not being written: blob storage is not configured (' + blob.reason() + '). The live radio below is real, but nothing is being kept, so this panel has nothing to read. Set BLOB_READ_WRITE_TOKEN.'
        : 'Nothing at all has come across in the last ' + minutes + ' minutes. That usually means the relay is not sending rather than that the city is silent.',
      watching: [], quiet: true, unsure: [],
      heard: {}, window: { from: from.toISOString(), to: to.toISOString(), minutes },
      vault: vaultOff ? { ok: false, why: blob.reason() } : { ok: true },
      complete: got.complete, tx: [], ms: Date.now() - t0,
    }, { priv: 0 });
  }

  const heard = stream.densityByFeed(rows);

  if (!llm.enabled()) {
    /* Still useful without a model: which radios are busy and how busy. */
    const busiest = Object.keys(heard).sort((a, b) => heard[b] - heard[a]).slice(0, 3);
    return json(res, {
      ok: true,
      read: rows.length + ' transmissions in ' + minutes + ' minutes, busiest on ' + busiest.join(', ') + '. No model configured, so this is a count rather than a read.',
      watching: [], quiet: null, unsure: [],
      heard, window: { from: from.toISOString(), to: to.toISOString(), minutes },
      complete: got.complete, tx, ms: Date.now() - t0,
    }, { priv: 0 });
  }

  const lines = tx.map(t => {
    /* Eastern. A running read is compared against a wall clock by whoever is
       sitting in front of it, and a four hour offset makes every line of it
       look like it is about some other night. */
    const clock = et.clock(t.at) + ' ET';
    return clock + ' [' + t.src + '] ' + String(t.text || '').slice(0, 300);
  }).join('\n');

  try {
    const out = await llm.chatJSON({
      system: SYSTEM,
      user: 'The last ' + minutes + ' minutes, in order:\n\n' + lines,
      maxTokens: 800,
      timeoutMs: 28000,
      role: 'desk-read',
    });
    return json(res, {
      ok: true,
      read: String(out.read || '').slice(0, 900),
      /* Each watch item carries the transmissions it was traced to, with their
         audio, so it can be clicked into and heard rather than read and
         wondered about. */
      /* Each watch item carries the transmissions it traced to AND a
         mechanical score for them, then they are ordered by that score.

         The model picks these three strings with no memory between polls and
         no sense of magnitude, so at 02:07 a twenty-five minute fireground
         with ladders up was dropped from the list entirely in favour of a man
         asleep in a vehicle, and the poll before that had called the same
         fire "large" with nothing on the radio saying so. The prose is the
         model's. The ORDER is not, and neither is the score printed next to
         it: lib/severity.js reads the transmissions the item actually traced
         to, which is the same floor that decides what reaches Situations. */
      watching: (Array.isArray(out.watching) ? out.watching.slice(0, 6) : []).map((x) => {
        const what = String(x).slice(0, 140);
        const found = trace.toTransmissions(what, rows, { cap: 8 });
        const feeds = [...new Set(found.map(r => r.feed || r.src).filter(Boolean))];
        const units = [...new Set(found.flatMap(r => r.units || []))];
        const span = found.length > 1
          ? (+new Date(found[found.length - 1].at) - +new Date(found[0].at)) / 60000 : 0;
        const fl = severity.floor({ tx: found, feeds, units, spanMin: span, anomaly: { level: 'normal' } });
        return {
          what,
          at: found.map(r => r.at),
          clips: found.filter(r => r.clip).map(r => r.clip),
          n: found.length,
          severity: fl.score,
          severityLabel: severity.label(fl.score),
          why: fl.reasons.slice(0, 3),
        };
      }).sort((a, b) => (b.severity - a.severity) || (b.n - a.n)).slice(0, 3),
      quiet: out.quiet === true,
      unsure: Array.isArray(out.unsure) ? out.unsure.slice(0, 3).map(x => String(x).slice(0, 140)) : [],
      heard,
      window: { from: from.toISOString(), to: to.toISOString(), minutes },
      complete: got.complete,
      skipped: got.skipped || 0,
      model: llm.PRIMARY,
      tx,
      ms: Date.now() - t0,
    }, { priv: 0 });
  } catch (e) {
    /* A failed read is reported as a failed read. The transmissions still go
       back, because the radio is the product and the paragraph is the
       convenience. */
    return json(res, {
      ok: true,
      read: null,
      why: String(e.message || e).slice(0, 200),
      watching: [], quiet: null, unsure: [],
      heard, window: { from: from.toISOString(), to: to.toISOString(), minutes },
      complete: got.complete, tx, ms: Date.now() - t0,
    }, { priv: 0 });
  }
};
