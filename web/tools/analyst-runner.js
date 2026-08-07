#!/usr/bin/env node
// tools/analyst-runner.js
//
// The local analyst. Runs on a Mac beside the radio, asks the dashboard for
// judging work (api/analyst-work), runs the model on this machine's Ollama,
// and posts what the model said back (api/analyst-report), where every
// guardrail runs server-side. This script is deliberately dumb transport:
// the prompt, the schema and the dispose pipeline all live on the server,
// so the day the editorial policy changes, nothing here needs to.
//
//   BCC_URL=https://boston-control-center.vercel.app \
//   BCC_TOKEN=<ingest token> node tools/analyst-runner.js
//
// Optional: OLLAMA_HOST (default http://127.0.0.1:11434),
//           BCC_ANALYST_MODEL (default qwen3:4b-instruct),
//           BCC_INTERVAL_MS (default 75000).
//
// Designed to be run by launchd with KeepAlive, so a crash is a restart and
// a sleeping laptop resumes on wake. One line of log per cycle.

'use strict';

const URL_BASE = String(process.env.BCC_URL || '').replace(/\/+$/, '');
const TOKEN = String(process.env.BCC_TOKEN || '').trim();
const OLLAMA = String(process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const MODEL = process.env.BCC_ANALYST_MODEL || 'qwen3:4b-instruct';
const INTERVAL = Math.max(30000, parseInt(process.env.BCC_INTERVAL_MS || '75000', 10) || 75000);

if (!URL_BASE || !TOKEN) {
  console.error('need BCC_URL and BCC_TOKEN');
  process.exit(1);
}

const ts = () => new Date().toISOString().slice(11, 19);
const log = (m) => console.log(ts() + '  ' + m);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getWork() {
  const r = await fetch(URL_BASE + '/api/analyst-work', {
    headers: { authorization: 'Bearer ' + TOKEN },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error('work ' + r.status + ' ' + (await r.text()).slice(0, 120));
  return r.json();
}

/* Ollama with the schema-constrained decode, so the model cannot answer in
   prose. Temperature zero because judging is a reading task with a right
   answer, and a reproducible analyst is one you can regress. num_ctx 8192:
   the system prompt plus open stories plus seventy transcript lines is
   comfortably under it, and a context that silently truncates the oldest
   lines would judge half the radio and never say so. */
async function judge(work) {
  const r = await fetch(OLLAMA + '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      format: work.format,
      options: { temperature: 0, num_ctx: 8192, num_predict: 1500 },
      messages: [
        { role: 'system', content: work.system },
        { role: 'user', content: work.user },
      ],
    }),
    signal: AbortSignal.timeout(240000),
  });
  if (!r.ok) throw new Error('ollama ' + r.status + ' ' + (await r.text()).slice(0, 120));
  const j = await r.json();
  const raw = j && j.message && j.message.content;
  if (!raw) throw new Error('ollama: empty response');
  let o;
  try { o = JSON.parse(raw); } catch (e) { throw new Error('ollama: unparseable JSON'); }
  return Array.isArray(o.situations) ? o.situations : [];
}

async function report(sig, situations) {
  const r = await fetch(URL_BASE + '/api/analyst-report', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ sig, situations }),
    signal: AbortSignal.timeout(55000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('report ' + r.status + ' ' + (j.why || j.error || ''));
  return j;
}

async function cycle() {
  const work = await getWork();
  if (work.skip) { log('idle: ' + work.skip); return; }
  const t0 = Date.now();
  const sits = await judge(work);
  const out = await report(work.sig, sits);
  log('judged ' + out.reported + ' -> board ' + out.situations +
    ' (opened ' + out.opened + ', threaded ' + out.threaded + ', high ' + out.high +
    ', located ' + out.located + ') in ' + Math.round((Date.now() - t0) / 1000) + 's');
}

(async () => {
  log('local analyst up: ' + MODEL + ' -> ' + URL_BASE + ' every ' + Math.round(INTERVAL / 1000) + 's');
  let failures = 0;
  for (;;) {
    try {
      await cycle();
      failures = 0;
    } catch (e) {
      failures++;
      log('cycle failed (' + failures + '): ' + String(e.message || e).slice(0, 160));
    }
    /* Back off on repeated failure so a down Ollama costs one line a few
       minutes rather than a log the size of the disk. The dashboard's cloud
       fallback (when enabled) reopens on its own after ten quiet minutes. */
    await sleep(Math.min(INTERVAL * (1 + failures), 5 * 60000));
  }
})();
