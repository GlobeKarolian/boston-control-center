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

const crypto = require('crypto');
const { cronAuth, json } = require('../../lib/http');
const kv = require('../../lib/kv');
const { K } = require('../../lib/store-io');
const { geocode, nominatim } = require('../../lib/geo');

const ANALYST_MODEL = process.env.ANALYST_MODEL || 'claude-sonnet-5';
const SIT_SCHEMA = { type: 'object', properties: { situations: { type: 'array', items: { type: 'object', properties: {
  id: { type: 'string' }, headline: { type: 'string' }, summary: { type: 'string' }, type: { type: 'string' },
  priority: { type: ['string', 'null'] }, location: { type: ['string', 'null'] }, status: { type: ['string', 'null'] }
}, required: ['headline', 'summary', 'type', 'location'] } } }, required: ['situations'] };
const ANALYST_SYSTEM = "You are a veteran newsroom desk editor and former public-safety dispatcher monitoring Boston-area police/fire/EMS scanner traffic. Transcripts are auto-generated from noisy radio and often garbled; use radio knowledge to interpret them. Notes: a 'patch' is a radio patch to talk to another agency; 'primary' is the lead unit; a vehicle that 'failed to stop' (often mis-heard as 'failed to start') did not pull over; phonetic letters (Sierra, Juliet) spell plate letters; 'northbound 93/95/128/3/24' are highways. Group related transmissions into distinct ACTIVE situations worth a reporter's attention (pursuit, working fire, serious crash, shooting, stabbing, search, barricade, major medical, hazmat). Ignore routine chatter, tests, and radio checks. For each situation give a stable short id slug, a punchy headline, a 1-2 sentence plain-English summary correcting obvious garbles, the type (lowercase e.g. 'pursuit'), priority ('high' for anything violent, fire, pursuit, or life-threatening, else 'normal'), a best-guess LOCATION a map can find (address, intersection, highway + town, or town/neighborhood), and status ('developing','active','winding down'). Return an empty list if it is all noise.";

// One analyst run at a time. Two crons overlapping would double the model
// spend and race on the situations key for no benefit.
const LOCK = 'bcc:lock:analyst';

// Fingerprint of the exact text last sent to the model.
const SIG = 'bcc:analyst:sig';

module.exports = async (req, res) => {
  if (!cronAuth(req)) return json(res, { error: 'unauthorized' }, { status: 401 });
  const key = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key) return json(res, { skipped: 'no ANTHROPIC_API_KEY' });

  const token = await kv.lock(LOCK, 90000, 0);
  if (!token) return json(res, { skipped: 'another analyst run is in flight' });

  const t0 = Date.now();
  try {
    let tr = [];
    try { tr = JSON.parse(await kv.get(K.outTranscripts) || '[]'); } catch (e) {}
    if (tr.length < 3) return json(res, { skipped: 'not enough traffic', transcripts: tr.length });

    const lines = tr.slice(0, 70).reverse().map(t => '[' + t.source + '] ' + t.text).join('\n');

    // A cron fires whether or not anything happened. At 4am the transcript key
    // still holds the last six hours of traffic, so without this guard the same
    // 70 lines would go to a frontier model 1,440 times a day and come back
    // with the same answer. Identical input, no call.
    const sig = crypto.createHash('sha1').update(lines).digest('hex').slice(0, 20);
    let prevSig = null;
    try { prevSig = await kv.get(SIG); } catch (e) {}
    if (prevSig === sig) return json(res, { skipped: 'no new traffic since last run', transcripts: tr.length });
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: ANALYST_MODEL, max_tokens: 2000, system: ANALYST_SYSTEM,
        tools: [{ name: 'report_situations', description: 'Report the active situations.', input_schema: SIT_SCHEMA }],
        tool_choice: { type: 'tool', name: 'report_situations' },
        messages: [{ role: 'user', content: 'Recent scanner traffic (oldest first):\n\n' + lines }],
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) throw new Error('anthropic ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const j = await r.json();
    const tu = (j.content || []).find(c => c.type === 'tool_use');
    const sits = (tu && tu.input && tu.input.situations) || [];

    // Geocode in parallel. Every situation is approximate by definition, so a
    // miss is a situation with no pin, not a dropped situation.
    const out = await Promise.all(sits.map(async (s, i) => {
      let geo = null;
      if (s.location) {
        try { geo = await geocode(s.location, 'Boston'); } catch (e) {}
        if (!geo) { try { geo = await nominatim(s.location + ', Massachusetts'); } catch (e) {} }
      }
      return {
        id: s.id || ('sit-' + i), headline: s.headline, summary: s.summary,
        type: (s.type || 'situation').toLowerCase(),
        priority: s.priority === 'high' ? 'high' : 'normal',
        location: s.location || null,
        status: (s.status || 'active').toLowerCase(),
        lat: geo ? geo.lat : null, lon: geo ? geo.lon : null,
        matched: geo ? geo.matched : null, approx: true,
        updated: new Date().toISOString(),
      };
    }));

    await kv.set(K.outSituations, JSON.stringify(out), 6 * 3600);
    // Recorded only after the write lands, so a failed run retries next minute.
    try { await kv.set(SIG, sig, 6 * 3600); } catch (e) {}
    return json(res, {
      ok: true, model: ANALYST_MODEL, situations: out.length,
      high: out.filter(s => s.priority === 'high').length,
      located: out.filter(s => s.lat !== null).length,
      read: tr.length, ms: Date.now() - t0,
    });
  } catch (e) {
    // Leave the previous situations in place. A failed analyst run should not
    // blank the editorial layer; stale beats empty here.
    return json(res, { error: 'analyst failed', detail: String(e.message || e).slice(0, 300), ms: Date.now() - t0 }, { status: 500 });
  } finally {
    await kv.unlock(LOCK, token);
  }
};
