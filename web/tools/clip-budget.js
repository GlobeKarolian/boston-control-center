#!/usr/bin/env node
// tools/clip-budget.js
//
// Before storing audio, find out how much audio there is.
//
// The question is not whether keeping clips is a good idea. It is whether the
// bill for keeping them is forty megabytes a day or four hundred, because
// those are different decisions and the difference is a factor this file can
// measure instead of guess. Upstash already taught this project what happens
// when nobody watches a meter until the wall arrives.
//
// Reads the live transcript list, works out the real arrival rate from the
// timestamps on it, and projects storage at a few bitrates and retentions.
//
//   node tools/clip-budget.js
//   node tools/clip-budget.js 32        (kbps, default 24)

const fs = require('fs');
const path = require('path');

const envFile = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}

const kv = require('../lib/kv');
const { K } = require('../lib/store-io');

const KBPS = Number(process.argv[2] || 24);
const SEG = 15;                       // seconds per segment, from Capture.swift

function mb(bytes) { return (bytes / 1048576).toFixed(1) + ' MB'; }
function gb(bytes) { return (bytes / 1073741824).toFixed(2) + ' GB'; }

(async () => {
  const tr = JSON.parse((await kv.get(K.outTranscripts)) || '[]');
  if (!tr.length) { console.log('no transcripts in the store'); process.exit(0); }

  const times = tr.map(t => Date.parse(t.at || t.time || 0)).filter(n => n > 0).sort();
  const spanMs = times.length > 1 ? times[times.length - 1] - times[0] : 0;
  const spanMin = spanMs / 60000;

  console.log('');
  console.log('  what the store is holding');
  console.log('  ' + '-'.repeat(66));
  console.log('  ' + tr.length + ' transcripts spanning ' + spanMin.toFixed(1) + ' minutes');

  const bySrc = {};
  tr.forEach(t => { const s = t.source || '(none)'; bySrc[s] = (bySrc[s] || 0) + 1; });
  Object.keys(bySrc).sort((a, b) => bySrc[b] - bySrc[a]).forEach(s => {
    const share = (100 * bySrc[s] / tr.length).toFixed(0);
    console.log('    ' + (s + '                        ').slice(0, 24) +
      String(bySrc[s]).padStart(4) + '   ' + share + '%');
  });

  /* The list is capped, so its span is a window on the real rate rather than
     the whole day. That is fine: the rate is what the projection needs, and a
     capped window measures rate honestly as long as it is full. */
  if (spanMin < 1) { console.log('\n  window too short to project a rate'); process.exit(0); }
  const perHour = tr.length / (spanMin / 60);
  const perDay = perHour * 24;

  const clipBytes = Math.round(KBPS * 1000 / 8 * SEG);
  console.log('');
  console.log('  what clips would cost, at ' + KBPS + ' kbps mono, ' + SEG + 's a segment');
  console.log('  ' + '-'.repeat(66));
  console.log('  one clip                 ' + Math.round(clipBytes / 1024) + ' KB');
  console.log('  arriving                 ' + Math.round(perHour) + ' an hour, ' +
    Math.round(perDay) + ' a day');
  console.log('');
  [2, 6, 24, 72, 168].forEach(h => {
    const held = perHour * h * clipBytes;
    const label = h < 24 ? h + ' hours' : (h / 24) + ' days';
    console.log('  keep ' + (label + '          ').slice(0, 10) +
      String(Math.round(perHour * h)).padStart(6) + ' clips   ' +
      (held > 1073741824 ? gb(held) : mb(held)).padStart(9));
  });

  /* Upload bandwidth is the number that surprises people. Storage is what a
     retention window holds; egress is every clip ever sent, forever. */
  console.log('');
  console.log('  uploaded per day         ' + mb(perDay * clipBytes) +
    '   (' + gb(perDay * clipBytes * 30) + ' a month)');
  console.log('');
  console.log('  A reporter listening to a hundred clips a day pulls back ' +
    mb(100 * clipBytes) + '.');
  console.log('');
})().catch(e => { console.error(String(e.message || e)); process.exit(1); });
