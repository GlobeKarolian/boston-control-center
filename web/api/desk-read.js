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

const MAX_MINUTES = 60;
const MAX_LINES = 260;

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
  /* The transmissions go back with the read, always, so the answer is
     checkable without a second request. This is the whole difference between
     a summary and a claim. */
  const tx = rows.slice(-MAX_LINES).map(stream.forListening);

  if (!rows.length) {
    return json(res, {
      ok: true,
      read: 'Nothing at all has come across in the last ' + minutes + ' minutes. That usually means the relay is not sending rather than that the city is silent.',
      watching: [], quiet: true, unsure: [],
      heard: {}, window: { from: from.toISOString(), to: to.toISOString(), minutes },
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
    const clock = String(t.at || '').slice(11, 16) + 'Z';
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
      watching: Array.isArray(out.watching) ? out.watching.slice(0, 3).map(x => String(x).slice(0, 140)) : [],
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
