#!/usr/bin/env node
// tools/peek.js — read-only look at what is actually in the live store.
// Loads .env.local the same way tools/prime-cameras.js does, without printing
// any credential. Usage: node tools/peek.js sources | situations | raw <key>

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

(async () => {
  const cmd = process.argv[2] || 'sources';

  if (cmd === 'sources') {
    const tr = JSON.parse((await kv.get(K.outTranscripts)) || '[]');
    const inc = JSON.parse((await kv.get(K.outIncidents)) || '[]');
    const bySrc = {};
    tr.forEach(t => { const s = t.source || '(none)'; bySrc[s] = (bySrc[s] || 0) + 1; });
    console.log('transcripts:', tr.length, ' incidents:', inc.length);
    console.log('\ndistinct transcript sources:');
    Object.entries(bySrc).sort((a, b) => b[1] - a[1]).forEach(([s, n]) => console.log('  ' + String(n).padStart(5) + '  ' + s));
    if (tr.length) {
      console.log('\nnewest transcript record keys:', Object.keys(tr[0]).join(', '));
      console.log('newest sample:', JSON.stringify(tr[0]).slice(0, 400));
    }
    if (inc.length) console.log('\nnewest incident keys:', Object.keys(inc[0]).join(', '));
  }

  if (cmd === 'situations') {
    const s = JSON.parse((await kv.get(K.outSituations)) || '[]');
    console.log('situations:', s.length);
    s.forEach(x => console.log('  [' + x.id + '] ' + x.priority + ' ' + x.type + ' :: ' + x.headline));
    if (s.length) console.log('\nkeys:', Object.keys(s[0]).join(', '));
  }

  if (cmd === 'raw') {
    const v = await kv.get(process.argv[3]);
    console.log(String(v).slice(0, 3000));
  }
})().catch(e => { console.error('FAILED', e.message); process.exit(1); });
