// tools/who-is-feeding.js
//
// Answers one question: which Macs are actually posting to the dashboard, and
// when did each one last say anything. The relay writes a health record per
// feed keyed machine|feedId, so the store already knows this and nobody has
// to guess from whichever machine happens to be in front of you.
//
// Costs one Redis command.
//
//   node tools/who-is-feeding.js

const fs = require('fs');
const path = require('path');

/* Same loader tools/peek.js and tools/sp-preview.js use, and the same rule:
   names are read, values are never printed anywhere in this file. */
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

loadEnv();
const URL = process.env.KV_REST_API_URL;
const TOK = process.env.KV_REST_API_READ_ONLY_TOKEN || process.env.KV_REST_API_TOKEN;
if (!URL || !TOK) {
  console.log('no store credentials in .env.local (need KV_REST_API_URL and a token)');
  process.exit(1);
}

function ago(ms) {
  const s = Math.round(ms / 1000);
  if (s < 90) return s + 's ago';
  const m = Math.round(s / 60);
  if (m < 90) return m + 'm ago';
  const h = m / 60;
  return (h < 48 ? h.toFixed(1) + 'h ago' : Math.round(h / 24) + 'd ago');
}

(async function () {
  const res = await fetch(URL + '/hgetall/bcc:health', {
    headers: { Authorization: 'Bearer ' + TOK },
  });
  if (!res.ok) {
    console.log('store said HTTP ' + res.status + '. ' + (await res.text()).slice(0, 200));
    process.exit(1);
  }
  const flat = (await res.json()).result || [];
  const recs = [];
  for (let i = 0; i < flat.length; i += 2) {
    try { recs.push(JSON.parse(flat[i + 1])); } catch (e) { /* skip junk */ }
  }
  report(recs);
}()).catch(e => { console.log('could not reach the store: ' + e.message); process.exit(1); });

function report(recs) {
  if (!recs.length) {
    console.log('bcc:health is empty. No Mac has checked in inside the retention window.');
    return;
  }
  const now = Date.now();
  const by = {};
  for (const r of recs) {
    const m = r.machine || 'unnamed';
    (by[m] = by[m] || []).push(r);
  }
  const names = Object.keys(by).sort();
  console.log(names.length + ' machine(s) in the store\n');
  for (const m of names) {
    const rs = by[m];
    const newest = Math.min(...rs.map(r => now - new Date(r.reportedAt || 0).getTime()));
    const live = rs.filter(r => r.status && r.status !== 'offline').length;
    console.log(m);
    console.log('  last heard from   ' + ago(newest));
    console.log('  feeds             ' + rs.length + ' known, ' + live + ' not marked offline');
    for (const r of rs.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
      const age = now - new Date(r.reportedAt || 0).getTime();
      console.log('    ' + String(r.status || '?').padEnd(9) +
        String(r.label || r.id || '').slice(0, 34).padEnd(36) + ago(age));
    }
    console.log('');
  }
}
