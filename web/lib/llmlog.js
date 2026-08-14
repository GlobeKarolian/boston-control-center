// lib/llmlog.js
//
// Every model call, on the record.
//
// WHY. Tonight an OpenRouter key was rotated in the dashboard and not in
// production. Extraction went straight back to regex, the desk read stopped
// working, situations stopped being verified, and nothing anywhere said so.
// The board looked exactly as healthy as it had an hour earlier. The only
// reason it was noticed at all is that a panel happened to print its own
// error, and the only reason that panel existed is that it was written four
// hours ago.
//
// A model is a dependency like a database, and a dependency you cannot watch
// is a dependency that fails silently. So every call writes a line: what it
// was for, which model, how long it took, whether it worked, and what it said
// if it did not.
//
// A capped list in Redis rather than a table anywhere, because this is a
// debugging surface with a memory of a couple of hundred calls, and it should
// cost about as much as it is worth. Roughly 200 bytes a line, LTRIM'd to 200
// lines, expiring daily: about 40KB, which against the bandwidth this project
// has already spent is a rounding error.
//
// Logging never throws and never blocks. A failed log line must not fail the
// thing it was watching, which is the mistake that makes observability worse
// than none.

'use strict';

const kv = require('./kv');

const KEY = 'bcc:llm:log';
const KEEP = 200;
const TTL = 36 * 3600;

/* One line. `role` is what the call was for, which is the field that makes
   this readable at a glance: extract, desk-read, verify, analyst. */
async function record(role, { model, ms, ok, why, inTok, outTok, note } = {}) {
  try {
    const line = {
      at: new Date().toISOString(),
      role: String(role || '?').slice(0, 24),
      model: String(model || '?').slice(0, 60),
      ms: Math.max(0, Math.round(Number(ms) || 0)),
      ok: !!ok,
    };
    if (!ok && why) line.why = String(why).slice(0, 220);
    if (inTok) line.in = Math.round(Number(inTok) || 0);
    if (outTok) line.out = Math.round(Number(outTok) || 0);
    if (note) line.note = String(note).slice(0, 80);
    await kv.raw([
      ['LPUSH', KEY, JSON.stringify(line)],
      ['LTRIM', KEY, 0, KEEP - 1],
      ['EXPIRE', KEY, String(TTL)],
    ], 4000);
  } catch (e) { /* never let the watcher break the watched */ }
}

/* Newest first, with a small summary so the panel does not have to compute
   one and disagree with itself. */
async function recent(limit = 60) {
  let raw = [];
  try {
    const r = await kv.raw([['LRANGE', KEY, 0, Math.max(1, Math.min(KEEP, limit)) - 1]], 6000);
    raw = (r && r[0]) || [];
  } catch (e) {
    return { ok: false, why: String(e.message || e).slice(0, 160), calls: [], summary: null };
  }
  const calls = [];
  for (const s of raw) {
    try { calls.push(JSON.parse(s)); } catch (e) { /* a bad line is one line */ }
  }

  const byRole = {};
  let fails = 0, tot = 0, msSum = 0;
  for (const c of calls) {
    const r = byRole[c.role] || (byRole[c.role] = { n: 0, fail: 0, ms: 0, model: c.model });
    r.n++; tot++; msSum += c.ms || 0;
    if (!c.ok) { r.fail++; fails++; }
    r.ms += c.ms || 0;
  }
  for (const k in byRole) byRole[k].avgMs = Math.round(byRole[k].ms / Math.max(1, byRole[k].n));

  /* The single question this panel exists to answer, answered in one field
     rather than left for a person to infer from a list of red rows. */
  const lastFail = calls.find(c => !c.ok) || null;
  const healthy = tot > 0 && fails === 0;

  return {
    ok: true,
    calls,
    summary: {
      calls: tot,
      failures: fails,
      healthy,
      avgMs: Math.round(msSum / Math.max(1, tot)),
      byRole,
      lastFailure: lastFail ? { at: lastFail.at, role: lastFail.role, model: lastFail.model, why: lastFail.why } : null,
      /* Nothing logged at all is its own condition and reads very differently
         from everything succeeding. */
      silent: tot === 0,
    },
  };
}

module.exports = { record, recent, KEY, KEEP };
