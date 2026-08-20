#!/usr/bin/env node
// tools/ask-replay.js
//
// Ask the desk a question against a slice of the real vault, offline, and
// see what it would have read and what it would have said.
//
//   node tools/ask-replay.js _qa/vault-48h-*.json "what were the biggest calls tonight"
//   node tools/ask-replay.js _qa/vault-48h-*.json "any stabbings overnight" --now 2026-08-19T10:00:00Z
//   node tools/ask-replay.js _qa/vault-48h-*.json "fight in harvard square" --prompt     print the whole prompt
//   node tools/ask-replay.js _qa/vault-48h-*.json "..." --model                          also ask the model
//
// The retrieval half of api/desk-ask.js runs exactly as it does in
// production: the question is parsed, the window cut from the slice, the
// rows grouped into scenes, the scenes chosen and ranked, the prompt built.
// That half is what went wrong on 19 August and it needs no network to be
// looked at. The model half runs only with --model and only if an
// OPENROUTER_API_KEY is in the environment or in .env.local; it calls the
// same model the route calls, so the answer is the answer a reporter would
// have got. Nothing here is written anywhere.

'use strict';

const fs = require('fs');
const path = require('path');

function loadEnv() {
  const f = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}

const args = process.argv.slice(2);
const file = args.find(a => a.endsWith('.json'));
if (!file) { console.error('usage: node tools/ask-replay.js <dump.json> "question" [--now ISO] [--prompt] [--model]'); process.exit(2); }
const flag = (n) => args.includes('--' + n);
const opt = (n) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : null; };
const q = args.filter((a, i) => !a.endsWith('.json') && !a.startsWith('--') && !(i > 0 && args[i - 1] === '--now')).join(' ').trim();
if (!q) { console.error('ask something'); process.exit(2); }

if (flag('model')) loadEnv();

const dump = JSON.parse(fs.readFileSync(file, 'utf8'));
const rows = (dump.rows || []).slice().sort((a, b) => String(a.at).localeCompare(String(b.at)));
const now = opt('now') ? new Date(opt('now')) : new Date(dump.to || rows[rows.length - 1].at);

const vq = require('../lib/vault-query');
const ask = require('../api/desk-ask');
const et = require('../lib/etime');

const DEFAULT_HOURS = 2;
const f = vq.parse(q, now);
const from = f.named ? f.from : new Date(+now - DEFAULT_HOURS * 3600000);
const to = f.named ? f.to : now;
const inWindow = rows.filter(t => { const at = +new Date(t.at); return at > +from && at <= +to; });
const got = { rows: inWindow, complete: true, sampled: false, objects: 0 };

console.log('dump: ' + path.basename(file) + '  ' + rows.length + ' rows  (now = ' + et.full(now) + ')');
console.log('question: ' + q);
console.log('understood: ' + JSON.stringify({ when: f.named ? f.when : 'the last ' + DEFAULT_HOURS + ' hours', type: f.type, place: f.place, landmark: f.landmark, phrases: (f.phrases || []).map(p => p[0]), words: f.words, big: f.big }));
console.log('window: ' + et.full(from) + ' to ' + et.full(to) + '  (' + inWindow.length + ' transmissions)');

const t0 = Date.now();
const picked = ask._shortlist(inWindow, f);
console.log('scenes: ' + picked.scenes + ' in the window, ' + picked.hits.length + ' chosen' + (picked.asked ? ' as matches' : ' by weight') + ', ' + picked.context.length + ' for context, ' + (Date.now() - t0) + 'ms\n');

const show = (b, i, label) => {
  console.log((label + ' ' + (i + 1)).padEnd(11) + et.clock(b.from) + (b.to !== b.from ? '-' + et.clock(b.to) : '') + '  ' + b.feeds.join(',') + '  ' + (b.type || '-') + ' @ ' + String(b.place || '-').slice(0, 44)
    + '  ' + b.n + ' tx' + (b.shown < b.n ? ' (' + b.shown + ' shown)' : '') + '  sev ' + b.severity + ' tier ' + b.tier + (b.matched ? '  matched ' + b.matched : '')
    + (b.units.length ? '  units ' + b.units.slice(0, 6).join(' ') : ''));
  for (const t of b.lines.slice(0, flag('all') ? 60 : 4)) console.log('           ' + et.clock(t.at) + ' ' + String(t.feed || '').slice(0, 16).padEnd(16) + ' ' + String(t.text || '').slice(0, 110));
  if (b.lines.length > 4 && !flag('all')) console.log('           … ' + (b.lines.length - 4) + ' more shown to the model');
};
picked.hits.forEach((b, i) => show(b, i, 'SCENE'));
if (picked.context.length) { console.log(''); picked.context.forEach((b, i) => show(b, i, 'CONTEXT')); }

const prompt = ask._composePrompt(q, inWindow, got, picked, from, to);
if (flag('prompt')) { console.log('\n----- PROMPT -----\n' + prompt + '\n----- END -----'); }
console.log('\nprompt: ' + prompt.length + ' chars, about ' + Math.round(prompt.length / 4) + ' tokens');

if (flag('model')) {
  const llm = require('../lib/llm');
  if (!llm.enabled()) { console.log('no OPENROUTER_API_KEY in the environment or .env.local; skipping the model'); process.exit(0); }
  (async () => {
    const m = ask._model;
    console.log('asking ' + m.model + ' (fallback ' + m.fallback + ') …');
    const t1 = Date.now();
    try {
      const answer = await llm.chat({ system: ask._SYSTEM, user: prompt, maxTokens: 700, timeoutMs: 40000, role: 'ask-replay', model: m.model, fallback: m.fallback });
      console.log('\n----- ANSWER (' + (Date.now() - t1) + 'ms) -----\n' + answer + '\n----- END -----');
    } catch (e) { console.log('model failed: ' + (e && e.message || e)); }
  })();
}
