// tools/orphan-audit.js
//
// The relay uploads a transmission's audio clip BEFORE its words enter the
// send queue. On the night of August 12 the queue overflowed during the
// Upstash outage and evicted its oldest transcripts, but their clips had
// already landed in Blob, which stayed healthy throughout. So the audio of
// the evicted evening may exist right now with nothing pointing at it.
//
//   cd web && npx vercel env pull .env.local
//   set -a; source .env.local; set +a
//   node tools/orphan-audit.js 2026-08-12
//
// Read-only. Reports, per feed and per hour, every clip in clips/DAY/ that
// no vault transmission references. Clips referenced by a NEIGHBORING day's
// vault folder (the midnight edges) are checked too, so an edge clip is not
// miscounted as lost.

const blob = require('../lib/blob');

const day = process.argv[2];
if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
  console.error('usage: node tools/orphan-audit.js YYYY-MM-DD');
  process.exit(1);
}
if (!blob.enabled()) {
  console.error('no blob token in env: ' + blob.reason());
  console.error('run: npx vercel env pull .env.local && set -a; source .env.local; set +a');
  process.exit(1);
}

function norm(u) {
  try { return new URL(u).pathname.replace(/^\//, ''); } catch (e) { return String(u || '').replace(/^\//, ''); }
}

function shift(d, days) {
  const t = new Date(d + 'T12:00:00Z');
  return new Date(+t + days * 86400000).toISOString().slice(0, 10);
}

(async () => {
  const clipList = await blob.listPrefix('clips/' + day + '/', { max: 30000 });
  console.log('clips in blob for ' + day + ': ' + clipList.blobs.length);

  const referenced = new Set();
  let txCount = 0;
  for (const d of [shift(day, -1), day, shift(day, 1)]) {
    const vaultList = await blob.listPrefix('vault/' + d + '/tx/', { max: 10000 });
    const urls = vaultList.blobs.map(b => b.url);
    let i = 0;
    async function worker() {
      for (;;) {
        const n = i++;
        if (n >= urls.length) return;
        try {
          const r = await fetch(urls[n]);
          if (!r.ok) continue;
          const j = await r.json();
          for (const t of (j.tx || [])) { txCount++; if (t.clip) referenced.add(norm(t.clip)); }
        } catch (e) { /* one unreadable batch is not a failed audit */ }
      }
    }
    await Promise.all(Array.from({ length: 48 }, worker));
    console.log('vault ' + d + ': ' + vaultList.blobs.length + ' batches read');
  }
  console.log('vault transmissions seen: ' + txCount + '   clips referenced: ' + referenced.size);

  const orphans = clipList.blobs.filter(b => !referenced.has(norm(b.pathname || b.url)));
  console.log('\nORPHANS, audio with no transcript anywhere: ' + orphans.length);

  const perFeed = {}, perHour = {};
  for (const b of orphans) {
    const p = norm(b.pathname || b.url);
    const feed = p.split('/')[2] || '?';
    const m = p.match(/-(\d{2})(\d{2})(\d{2})-et-/);
    const hh = m ? m[1] + ':00 ET' : '??';
    perFeed[feed] = (perFeed[feed] || 0) + 1;
    perHour[hh] = (perHour[hh] || 0) + 1;
  }
  console.log('\nby feed:');
  Object.keys(perFeed).sort().forEach(k => console.log('  ' + k.padEnd(34) + perFeed[k]));
  console.log('\nby hour (Eastern):');
  Object.keys(perHour).sort().forEach(k => console.log('  ' + k.padEnd(10) + perHour[k]));

  const window = orphans
    .map(b => norm(b.pathname || b.url))
    .filter(p => /-(1[6-9])\d{4}-et-/.test(p))
    .sort();
  console.log('\norphans between 4pm and 8pm ET, the stabbing window (' + window.length + '):');
  for (const p of window.slice(0, 60)) console.log('  ' + p);
  if (window.length > 60) console.log('  ... and ' + (window.length - 60) + ' more');
})();
