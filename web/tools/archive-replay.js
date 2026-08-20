#!/usr/bin/env node
// tools/archive-replay.js
//
// Run the archive search against a slice of the real vault, offline, and
// print what a reporter would have seen. The whole pipeline that
// api/vault-search.js runs, parse -> score -> scene expansion -> grouping,
// against the rows in a tools/vault-dump.js file instead of Blob, so a
// question can be asked a hundred times in a second while the ranking is
// being worked on, and a fix can be shown against the night it was for.
//
//   node tools/archive-replay.js _qa/vault-48h-*.json "bar fight in harvard square"
//   node tools/archive-replay.js _qa/vault-48h-*.json "stabbing last night" --now 2026-08-19T03:00:00Z
//   node tools/archive-replay.js _qa/vault-48h-*.json --scenes          what the archive groups into, unasked
//   node tools/archive-replay.js _qa/vault-48h-*.json --feeds           who was heard, how much
//
// Prints to stdout; nothing here writes anything. --now pins the clock for
// "last night" and "today", and defaults to the dump's own `to`, which is
// what the slice was the present of.

'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const file = args.find(a => a.endsWith('.json'));
if (!file) { console.error('usage: node tools/archive-replay.js <dump.json> "question" [--now ISO] [--scenes] [--feeds] [--all]'); process.exit(2); }
const flag = (n) => args.includes('--' + n);
const opt = (n) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : null; };
const q = args.filter((a, i) => !a.endsWith('.json') && !a.startsWith('--') && (i === 0 || !args[i - 1].startsWith('--now'))).join(' ').trim();

const dump = JSON.parse(fs.readFileSync(file, 'utf8'));
const rows = (dump.rows || []).slice().sort((a, b) => String(a.at).localeCompare(String(b.at)));
const now = opt('now') ? new Date(opt('now')) : new Date(dump.to || rows[rows.length - 1].at);

const vq = require('../lib/vault-query');
const search = require('../api/vault-search');
const sceneLib = require('../lib/scenes');

const TZ = 'America/New_York';
const et = (iso) => new Date(iso).toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const hm = (iso) => new Date(iso).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const trunc = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

console.log('dump: ' + path.basename(file) + '  ' + rows.length + ' rows  ' + et(dump.from) + ' → ' + et(dump.to) + '  (now = ' + et(now.toISOString()) + ')');

if (flag('feeds')) {
  const by = {};
  for (const r of rows) by[r.feed || '?'] = (by[r.feed || '?'] || 0) + 1;
  for (const [f, n] of Object.entries(by).sort((a, b) => b[1] - a[1])) console.log('  ' + String(n).padStart(6) + '  ' + f);
  process.exit(0);
}

if (flag('scenes')) {
  /* The archive's own idea of a scene: lib/scenes.js over the whole slice,
     exactly as group() sees it with every row a hit. */
  const ix = sceneLib.index(sceneLib.assemble(rows));
  const hits = rows.map(tx => ({ tx, s: 1 }));
  const groups = search._group(hits, ix);
  const withInc = groups.filter(g => !g.loose), loose = groups.filter(g => g.loose);
  console.log(groups.length + ' groups: ' + withInc.length + ' with an incidentId, ' + loose.length + ' loose bursts');
  const sizes = groups.map(g => g.tx.length).sort((a, b) => b - a);
  console.log('largest: ' + sizes.slice(0, 12).join(', ') + '   singletons: ' + sizes.filter(n => n === 1).length);
  const show = groups.filter(g => g.tx.length >= 3).sort((a, b) => b.tx.length - a.tx.length).slice(0, flag('all') ? 400 : 40);
  for (const g of show) {
    const feeds = [...new Set(g.tx.map(t => t.feed))].join(',');
    console.log('\n' + (g.loose ? 'LOOSE ' : 'INC   ') + trunc(g.id, 28).padEnd(28) + ' ' + String(g.tx.length).padStart(3) + ' tx  ' + hm(g.from) + '-' + hm(g.to)
      + '  ' + (g.type || '-') + ' @ ' + trunc(g.place || '-', 40) + '  [' + feeds + ']' + (g.units.length ? '  units ' + g.units.slice(0, 6).join(' ') : ''));
    for (const t of g.tx.slice(0, flag('all') ? 60 : 5)) console.log('      ' + hm(t.at) + ' ' + trunc(t.feed, 16).padEnd(16) + ' ' + trunc(t.text, 110));
    if (g.tx.length > 5 && !flag('all')) console.log('      … ' + (g.tx.length - 5) + ' more');
  }
  process.exit(0);
}

if (!q) { console.error('ask something, or pass --scenes / --feeds'); process.exit(2); }

const f = vq.parse(q, now);
console.log('understood: ' + JSON.stringify({ when: f.when, from: et(f.from), to: et(f.to), type: f.type, place: f.place, landmark: f.landmark, phrases: (f.phrases || []).map(p => p[0]), words: f.words, big: f.big }));

const t0 = Date.now();
let hits = [];
const inWindow = rows.filter(t => { const at = +new Date(t.at); return at >= +f.from && at <= +f.to; });
const ix = sceneLib.index(sceneLib.assemble(inWindow));
for (const t of inWindow) { const s = vq.score(t, f); if (s > 0) hits.push({ tx: t, s }); }
const before = hits.length;
hits = search._sceneExpand(hits, inWindow, f, ix);
const groups = search._group(hits, ix).slice(0, 40);
console.log('scanned ' + inWindow.length + ' in window, ' + before + ' matched, ' + (hits.length - before) + ' pulled in as context, ' + groups.length + ' cards, ' + (Date.now() - t0) + 'ms');

const top = groups[0] ? groups[0].score : 0;
groups.forEach((g, i) => {
  const strong = g.score >= top * 0.45 && i < 8;
  const feeds = [...new Set(g.tx.map(t => t.feed))].join(',');
  console.log('\n' + (strong ? '#' : ' ') + String(i + 1).padStart(2) + '  score ' + g.score.toFixed(1).padStart(5) + '  ' + (g.loose ? 'loose' : 'inc  ') + '  ' + hm(g.from) + '-' + hm(g.to)
    + '  ' + (g.type || '-') + ' @ ' + trunc(g.place || '-', 44) + '  [' + feeds + ']  ' + g.tx.length + ' tx' + (g.clips.length ? ', ' + g.clips.length + ' clips' : ''));
  const lines = flag('all') ? g.tx : g.tx.slice(0, 6);
  for (const t of lines) console.log('      ' + hm(t.at) + ' ' + trunc(t.feed, 16).padEnd(16) + (t.ctx ? ' · ' : ' * ') + trunc(t.text, 110));
  if (g.tx.length > lines.length) console.log('      … ' + (g.tx.length - lines.length) + ' more');
});
