// api/ingest.js
// The one door the Mac fleet talks to.
//
// The agent POSTs:
//   authorization: Bearer <token>
//   x-bcc-machine: <name>
//   { machine, at, items: [{src, city, scope, text, at, seq}], health: [...] }
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
//
// `scope` is new and load-bearing. Every town in Massachusetts has a Main
// Street, so a street name off the radio is meaningless without knowing which
// municipalities the transmitter covers. A feed declares that list; the
// geocoder refuses to place a bare street name when the list has more than one
// town in it and nobody said which.

const { ingestAuth, json, harden } = require('../lib/http');
const clips = require('../app/clips.js');
const { extractBatch, mapFields, MODEL } = require('../lib/extractor');
const { geocodeBatch } = require('../lib/geo');
const store_io = require('../lib/store-io');
const threat = require('../lib/threat');
const baseline = require('../lib/baseline');

const MAX_ITEMS = 200;
const MAX_TEXT = 4000;

/* ---------------------------------------------------------------- quiet POSTs

   A Mac with nothing to say still POSTs every two seconds, and until now that
   heartbeat cost seven Redis commands: one HSET for health, one GET to hydrate
   the store, and five SETs to re-render output keys whose contents had not
   changed. One idle machine therefore burned about 302,000 commands a day
   saying nothing, which is the entire Upstash free month in roughly forty
   hours. That is how this store ran out of requests.

   The two clocks below are the fix. Neither one drops information; both stop
   paying for the same information twice.

   Module scope is deliberate. A warm Vercel instance keeps these across
   invocations, and a cold one starts at zero, which means a fresh instance
   always writes and always renders on its first POST. Several instances in
   parallel therefore render a little more often than one would, and the
   failure mode of the whole mechanism is doing the old thing. There is no
   state here that can go stale in a way that loses a transmission, because a
   POST that actually carries items never consults these clocks at all.

   HEALTH_MIN_MS has to stay comfortably under store-io's OFFLINE_AFTER_MS of
   120s, because a feed is called offline on the age of its last health write.
   Writing at least every 45s keeps that judgement honest with a wide margin;
   anything approaching 120s would start reporting live feeds as dead. */
const HEALTH_MIN_MS = 45000;
const RENDER_MIN_MS = 30000;
let lastHealthSig = null, lastHealthAt = 0, lastRenderAt = 0;

// Only the fields that change what a reader sees. A record whose only
// difference is its own timestamp is not a change worth a write.
function healthSig(records) {
  if (!Array.isArray(records) || !records.length) return '';
  return records.map(r => [r && r.id, r && r.state, r && r.status, r && r.error, r && r.up]
    .map(v => (v === undefined || v === null) ? '' : String(v)).join('~')).sort().join('|');
}

function parseBody(req) {
  const b = req.body;
  if (!b) return {};
  if (typeof b === 'string') { try { return JSON.parse(b); } catch (e) { return null; } }
  if (Buffer.isBuffer(b)) { try { return JSON.parse(b.toString('utf8')); } catch (e) { return null; } }
  return b;
}

// scope arrives as "Boston, Brookline, Cambridge" from the Mac app, or as an
// array, or not at all. An empty list means the feed did not say, and the
// geocoder treats that as "do not guess a town" rather than "anywhere".
function townsFrom(i) {
  const raw = i.scope !== undefined ? i.scope : i.towns;
  const list = Array.isArray(raw) ? raw : String(raw || '').split(',');
  const out = list.map(s => String(s || '').trim()).filter(Boolean).slice(0, 40);
  if (out.length) return out;
  const city = String(i.city || '').trim();
  return city ? [city] : [];
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
      // Which agency this channel belongs to, if the sender knows. No Scanner
      // Relay build sends it today, and the store derives it from the feed
      // label instead. It matters because the stop tracker refuses to open a
      // stop on a fire or EMS channel, where "Engine 15 clear" is a truck
      // going back in service rather than a car finishing with a driver, and
      // guessing that from a label like "bostonfire" works until the day
      // someone names a feed something else.
      dept: i.dept ? String(i.dept).slice(0, 60) : null,
      towns: townsFrom(i),
      text: i.text.trim().slice(0, MAX_TEXT),
      at: i.at || new Date().toISOString(),
      seq: i.seq,
      /* The clip URL the relay got from /api/clip a moment before this POST.
         Checked against the one host this app will serve rather than taken on
         faith, because this string ends up as the src of an audio element in
         the newsroom and the pipe it rode in on is not a credential. */
      clip: (i.clip && clips.ok(i.clip)) ? String(i.clip).slice(0, 500) : undefined,
      /* The relay's own extraction, raw and unmapped. Object only, size
         capped, and never trusted further than mapFields is willing to take
         it. A relay that sends garbage here has bought its transmission a
         trip through the same ladder as everyone else, nothing worse. */
      ex: (i.ex && typeof i.ex === 'object' && !Array.isArray(i.ex)
           && JSON.stringify(i.ex).length <= 4000) ? i.ex : undefined,
    }));

  const t0 = Date.now();
  const warnings = [];

  try {
    // Health first: renderOutputs reads the health hash, so writing it now
    // means this POST's own feed status shows up in the same render.
    //
    // Gated on having something new to say. A changed record is written at
    // once, an unchanged one at least every HEALTH_MIN_MS so the offline
    // detector still has a fresh timestamp to judge on. `healthNew` is carried
    // down to the heartbeat branch below, because a feed that just went down
    // is exactly the case where a re-render must not wait on a clock.
    const sig = healthSig(health);
    const nowMs = Date.now();
    const healthNew = sig !== lastHealthSig;
    const healthWrite = (health.length && (healthNew || nowMs - lastHealthAt > HEALTH_MIN_MS))
      ? (lastHealthSig = sig, lastHealthAt = nowMs,
         store_io.putHealth(machine, health).catch(e => {
           // Roll back so the next POST retries rather than trusting a write
           // that never landed and going quiet for another 45 seconds.
           lastHealthAt = 0;
           warnings.push('health: ' + String(e.message || e).slice(0, 120));
         }))
      : Promise.resolve();

    const fresh = await store_io.claimNew(machine, items);
    const duplicates = items.length - fresh.length;

    if (!fresh.length) {
      // Heartbeat, or a retry of a batch already applied. Re-render so feed
      // status changes reach the dashboard, but do not take the write lock:
      // nothing is changing and a heartbeat must never block a real ingest.
      await healthWrite;

      /* The re-render is what the six of those seven commands were for, and
         it is worth doing only when the render would come out different.
         Nothing in the store has changed on this path by definition, so the
         only input that can differ is the health hash, and a health change
         renders immediately. Otherwise once every RENDER_MIN_MS is enough to
         keep the relative timestamps on the page from drifting.

         A quiet heartbeat now costs nothing at all: no read, no write, no
         command. The agent still gets its 200 and still learns nothing is
         wrong, which is all a heartbeat was ever asking for. */
      if (!healthNew && nowMs - lastRenderAt < RENDER_MIN_MS) {
        return json(res, {
          ok: true, machine, accepted: 0, duplicates, quiet: true,
          ms: Date.now() - t0, warnings,
        });
      }
      lastRenderAt = nowMs;
      const store = await store_io.loadStore();
      const counts = await store_io.renderOutputs(store, { extractorLabel: labelFor('none') });
      return json(res, {
        ok: true, machine, accepted: 0, duplicates, ...counts,
        ms: Date.now() - t0, warnings,
      });
    }

    // ---- outside the lock: the two slow network stages, in parallel -------

    // A 3-second transmission carries no context of its own. "We're on scene"
    // means nothing alone and everything after "Engine 7, 40 Boylston". Hand
    // the extractor the last few lines from the SAME channel so a follow-up
    // can find its call. One cheap read of a key the dashboard already polls.
    const prior = await store_io.recentBySource().catch(() => ({}));

    /* The mini's own extraction, when the relay did it. The raw model output
       rides the item and every guardrail runs HERE: mapFields owns the
       landmark hallucination check, the records-answer guard, the noise
       rescue, and it does not care which machine ran the model. An item the
       mini judged costs this server zero model budget; an item it did not,
       or judged into garbage, falls into the batch below exactly as if the
       relay had never learned to think. */
    const exs = new Array(fresh.length);
    let mini = 0;
    for (let i = 0; i < fresh.length; i++) {
      const raw = fresh[i].ex;
      if (!raw) continue;
      try {
        const mapped = mapFields(raw, 'mini', fresh[i].text);
        if (mapped && typeof mapped === 'object') { exs[i] = mapped; mini++; }
      } catch (e) { /* fall through to the batch */ }
    }

    const need = [];
    for (let i = 0; i < fresh.length; i++) if (!exs[i]) need.push(i);
    let by = 'mini', errors = [], skipped = 0, hallucinated = 0;
    if (need.length) {
      const batch = await extractBatch(need.map(i => ({ text: fresh[i].text, src: fresh[i].src })), { priorBySrc: prior });
      need.forEach((idx, k) => { exs[idx] = batch.results[k]; });
      by = mini ? 'mini+' + batch.by : batch.by;
      errors = batch.errors; skipped = batch.skipped; hallucinated = batch.hallucinated;
    }
    for (const e of errors.slice(0, 2)) warnings.push('extract: ' + e);

    const geos = await geocodeBatch(fresh.map((it, i) => ({
      ex: exs[i], city: it.city, towns: it.towns, text: it.text,
    })));

    // Severity and category, straight off the raw transcript. Pure regex, so
    // it costs microseconds and, unlike the model, cannot invent a fact that
    // was never said. Computed here rather than inside the store because the
    // same assessment feeds two consumers: the incident record, which uses it
    // for scene escalation, and the hourly baseline, which needs a category on
    // every transmission including the 70% the model leaves unlabelled.
    const threats = fresh.map((it, i) => threat.assess({
      text: it.text,
      units: exs[i] && exs[i].units,
    }));

    // Deliberately not awaited here. The baseline is a background statistic
    // and must never be the reason a transmission fails to reach the map.
    const counted = baseline
      .observe(fresh.map((it, i) => ({ feed: it.src, category: threats[i].category, at: it.at })))
      .catch(e => { warnings.push('baseline: ' + String(e.message || e).slice(0, 120)); });

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
            dept: it.dept || undefined,   // undefined, so the store derives it
            text: it.text,
            time: it.at,
            clip: it.clip,

            pre: {
              ex: exs[i],
              geo: geos[i] === undefined ? null : geos[i],
              threat: threats[i],
            },
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

    // A real ingest always renders, and resets the heartbeat clock along with
    // it. Without this line the next quiet POST could render again 30 seconds
    // after a render that had just happened for a better reason.
    lastRenderAt = Date.now();
    const counts = await store_io.renderOutputs(store, { extractorLabel: labelFor(by) });

    // Collected now rather than left dangling. A serverless function stops
    // executing the moment it returns, so an un-awaited KV write is a write
    // that may simply never land. It ran in parallel with the store work
    // above, so this costs nothing in the normal case.
    await counted;

    return json(res, {
      ok: true,
      machine,
      accepted: fresh.length,
      duplicates,
      noise: skipped || 0,
      placed: geos.filter(Boolean).length,
      hallucinated: hallucinated || 0,
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
  if (by === 'noise') return 'idle (silence only)';
  return 'idle';
}
