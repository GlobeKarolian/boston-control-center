// tools/webcam-channels.js - find the channel behind every webcam video id.
//
//   node tools/webcam-channels.js
//
// Why this exists: webcams.js pins cameras by YouTube video id, and video ids
// die every time the owner restarts a stream. That is Error 153 on the wall.
// embedSrc() already prefers a channel live-stream embed when a camera has
// channelId set, because a channel resolves to whatever is live right now and
// never goes stale. Nobody ever recorded the channel ids. This looks them up.
//
// A video id keeps its channel binding even after the stream it named has
// died, so the stale ids in the catalog are still good enough to ask about.
// Run it from any Mac, paste the block it prints to whoever is editing
// webcams.js, or hand it straight back to the agent.

const CAMS = require('node:path').join(__dirname, '..', 'app', 'webcams.js');

async function channelOf(id) {
  const r = await fetch('https://www.youtube.com/watch?v=' + id, {
    headers: { 'accept-language': 'en-US,en;q=0.9',
               'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' } });
  if (!r.ok) return { err: 'HTTP ' + r.status };
  const t = await r.text();
  const ch = t.match(/"channelId":"(UC[\w-]{22})"/);
  const by = t.match(/"author":"([^"]{1,80})"/);
  return ch ? { ch: ch[1], by: by ? by[1] : '?' } : { err: 'no channelId in page' };
}

(async () => {
  const src = require('node:fs').readFileSync(CAMS, 'utf8');
  const ids = [...src.matchAll(/\{ id: '([\w-]{11})'/g)].map(m => m[1]);
  console.log('looking up ' + ids.length + ' cameras\n');
  for (const id of ids) {
    const r = await channelOf(id);
    if (r.err) console.log('  ' + id + '  FAILED  ' + r.err);
    else console.log('  ' + id + "  channelId: '" + r.ch + "',   // " + r.by);
    await new Promise(res => setTimeout(res, 800));
  }
  console.log('\nPaste each channelId line into its camera in app/webcams.js.');
})().catch(e => { console.error(String(e.message || e)); process.exit(1); });
