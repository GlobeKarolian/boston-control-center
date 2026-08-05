// Fill bcc:cams once, by hand, without waiting for the six-hourly cron.
//
// Run from the repo root:   node tools/prime-cameras.js
//
// Reads .env.local for the KV credentials the same way `vercel dev` would.
// Nothing here prints a credential; the only output is the run summary.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const envFile = path.join(root, '.env.local');

if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}

const kv = require(path.join(root, 'lib/kv'));
const cameras = require(path.join(root, 'lib/cameras'));

(async () => {
  if (!kv.live) {
    console.log('KV is not configured. Expected KV_REST_API_URL and KV_REST_API_TOKEN in .env.local.');
    process.exit(1);
  }
  const before = await kv.getJSON(cameras.KEY, null);
  console.log('before:', before && Array.isArray(before.cams) ? before.cams.length + ' cameras cached' : 'key empty');

  const out = await cameras.once();
  console.log('run   :', JSON.stringify(out));

  const after = await kv.getJSON(cameras.KEY, null);
  if (after && Array.isArray(after.cams)) {
    const towns = new Set(after.cams.map(c => c.town).filter(Boolean));
    console.log('after :', after.cams.length + ' cameras across ' + towns.size + ' towns');
    console.log('sample:', after.cams[0].label, '|', after.cams[0].url);
  } else {
    console.log('after : key still empty, the write did not land');
  }
  process.exit(0);
})().catch(e => { console.error('failed:', e.message); process.exit(1); });
