// api/ingest.js
// The one door the Mac fleet talks to.
//
// The agent POSTs:
//   authorization: Bearer <token>
//   x-bcc-machine: <name>
//   { machine, at, items: [{src, city, text, at, seq}], health: [...] }
//
// Order of operations matters and is the whole point of this file:
//
//   1. auth, parse, dedupe            (cheap)
//   2. extract + geocode every item   (slow, network, FULLY PARALLEL, NO LOCK)
//   3. take the store mutex           (two Redis round trips of work inside)
//   4. apply the pre-computed items, sweep, save
//   5. release, then render the four output keys the browser reads
//
// Step 2 is what would otherwise serialise the fleet. A Haiku call plus a
// geocode is 300-2000ms; holding a lock across that with three Macs POSTing
// every two seconds would queue permanently. Outside the lock, the lock hold
// is ~50-100ms and the Macs never wait on each other in practice.

const { ingestAuth, json, harden } = require('../lib/http');
const { extractBatch, MODEL } = require('../lib/extractor');
const { geocodeBatch } = require('../lib/geo');
const store_io = require('../lib/store-io');

const MAX_ITEMS = 200;
const MAX_TEXT = 4000;

function parseBody(req) {
  const b = req.body;
  if (!b) return {};
  if (typeof b === 'string') { try { return JSON.parse(b); } catch (e) { return null; } }
  if (Buffer.isBuffer(b)) { try { return JSON.parse(b.toString('utf8')); } catch (e) { return null; } }
  return b;
}

module.exports = async (req, res) => {
  harden(res);
  if (req.method !== 'POST') return json(res, { error: 'POST only' }, { status: 405 });

  const auth = ingestAuth(req);
  if (!auth.ok) {
    // 401 is what makes the agent back off 60-300s instead of hammering.
    return json(res, { error: 'unauthorized', detail: auth.why }, { status: 401 });
  }

  const body = parseBody(req);
  if (!body) return json(res, { error: 'body is not valid JSON' }, { status: 400 });

  const machine = String(body.machine || auth.machine || 'unnamed').slice(0, 64);
  const rawItems = Array.isArray(body.items) ? body.items : [];
  const health = Array.isArray(body.health) ? body.health : [];

  if (rawItems.length > MAX_ITEMS) {
    return json(res, { error: 'too many items', max: MAX_ITEMS }, { status: 413 });
  }

  // Normalise before anything expensive touches it.
  const items = rawItems
    .filter(i => i && typeof i.text === 'string' && i.text.trim().length >= 4)
    .map(i => ({
      src: String(i.src || 'unknown').slice(0, 40),
      city: String(i.city || 'Boston').slice(0, 60),
      text: i.text.trim().slice(0, MAX_TEXT),
      at: i.at || new Date().toISOString(),
      seq: i.seq,
    }));

  const t0 = Date.now();
  const warnings = [];

  try {
    // Health first: renderOutputs reads the health hash, so writing it now
    // means this POST's own feed status shows up in the same render.
    const healthWrite = store_io.putHealth(machine, health).catch(e => {
      warnings.push('health: ' + String(e.message || e).slice(0, 120));
    });

    const fresh = await store_io.claimNew(machine, items);
    const duplicates = items.length - fresh.length;

    if (!fresh.length) {
      // Heartbeat, or a retry of a batch already applied. Re-render so feed
      // status changes reach the dashboard, but do not take the write lock:
      // nothing is changing and a heartbeat must never block a real ingest.
      await healthWrite;
      const store = await store_io.loadStore();
      const counts = await store_io.renderOutputs(store, { extractorLabel: labelFor('none') });
      return json(res, {
        ok: true, machine, accepted: 0, duplicates, ...counts,
        ms: Date.now() - t0, warnings,
      });
    }

    // ---- outside the lock: the two slow network stages, in parallel -------
    const { results: exs, by, errors } = await extractBatch(fresh.map(i => i.text));
    for (const e of errors.slice(0, 2)) warnings.push('extract: ' + e);

    const geos = await geocodeBatch(fresh.map((it, i) => ({ ex: exs[i], city: it.city })));

    await healthWrite;

    // ---- inside the lock: pure computation over pre-resolved inputs ------
    const applied = [];
    const { store } = await store_io.withStore(async (s) => {
      for (let i = 0; i < fresh.length; i++) {
        const it = fresh[i];
        try {
          const inc = await s.ingest({
            source: it.src,
            city: it.city,
            text: it.text,
            time: it.at,
            pre: { ex: exs[i], geo: geos[i] === undefined ? null : geos[i] },
          });
          if (inc) applied.push(inc.id);
        } catch (e) {
          // One bad transmission must not cost the whole batch. The agent
          // has already deleted its copy, so swallowing here is the end of
          // the line for this item; say so in the response.
          warnings.push('item ' + i + ': ' + String(e.message || e).slice(0, 120));
        }
      }
    });

    const counts = await store_io.renderOutputs(store, { extractorLabel: labelFor(by) });

    return json(res, {
      ok: true,
      machine,
      accepted: fresh.length,
      duplicates,
      incidentsTouched: [...new Set(applied)].length,
      extractor: labelFor(by),
      ...counts,
      ms: Date.now() - t0,
      warnings,
    });
  } catch (e) {
    const status = e && e.status === 503 ? 503 : 500;
    // 503 tells the agent to hold the batch and retry. It keeps its disk
    // queue, so a busy store costs latency, never transcripts.
    return json(res, {
      error: status === 503 ? 'store busy, retry' : 'ingest failed',
      detail: String(e.message || e).slice(0, 300),
      ms: Date.now() - t0,
    }, { status });
  }
};

function labelFor(by) {
  if (by === 'cloud') return 'cloud (' + MODEL + ')';
  if (by === 'mixed') return 'mixed (' + MODEL + ' + regex fallback)';
  if (by === 'regex') return 'regex (extractor unavailable)';
  return 'idle';
}
