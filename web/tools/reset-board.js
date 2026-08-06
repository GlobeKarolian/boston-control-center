// tools/reset-board.js - wipe the transmissions and start the board fresh.
//
//   node tools/reset-board.js          shows what would go, deletes nothing
//   node tools/reset-board.js --yes    deletes it
//
// Wipes exactly the state that transmissions built: the correlation store
// and its lock, every rendered output surface, feed health, the situation
// links and their undo, and the per-machine dedupe marks. The relay refills
// all of it within a minute of the next POST, which is the whole point: the
// board starts from silence, not from a backup.
//
// Keeps everything transmissions did not build and a wipe should not cost:
// the login table, the baselines (weeks of traffic-rate history), the
// geocode cache (thousands of Census answers this app never wants to buy
// twice), the pulse venues, the camera catalog. Audio clips in Blob are
// left alone too: the rows pointing at them are gone, and retention deletes
// the orphans inside a week for free.

const PATTERNS = ['bcc:store', 'bcc:lock:*', 'bcc:out:*', 'bcc:health',
                  'bcc:sit:*', 'bcc:seen:*'];

const URL_ = (process.env.KV_REST_API_URL || '').replace(/\/$/, '');
const TOK = process.env.KV_REST_API_TOKEN || '';
if (!URL_ || !TOK) {
  console.error('need KV_REST_API_URL and KV_REST_API_TOKEN in the environment');
  console.error('run it as:  set -a; source .env.local; set +a; node tools/reset-board.js');
  process.exit(1);
}

async function rest(path) {
  const r = await fetch(URL_ + path, { headers: { Authorization: 'Bearer ' + TOK } });
  if (!r.ok) throw new Error('redis answered HTTP ' + r.status + ' for ' + path.slice(0, 40));
  return (await r.json()).result;
}

async function scan(pattern) {
  let cursor = '0'; const keys = [];
  do {
    const r = await rest('/scan/' + cursor + '/match/' + encodeURIComponent(pattern) + '/count/500');
    cursor = String(r[0]);
    keys.push(...r[1]);
  } while (cursor !== '0');
  return keys;
}

(async () => {
  const doIt = process.argv.includes('--yes');
  let all = [];
  for (const p of PATTERNS) {
    const ks = await scan(p);
    console.log('  ' + String(ks.length).padStart(5) + '  ' + p);
    all = all.concat(ks);
  }
  all = [...new Set(all)];
  if (!all.length) { console.log('\nnothing to wipe, the board is already fresh'); return; }
  if (!doIt) {
    console.log('\n' + all.length + ' keys would go. Nothing was deleted.');
    console.log('Run it again with --yes to actually wipe the board.');
    return;
  }
  let gone = 0;
  for (let i = 0; i < all.length; i += 40) {
    const batch = all.slice(i, i + 40);
    gone += await rest('/del/' + batch.map(encodeURIComponent).join('/'));
  }
  console.log('\nwiped ' + gone + ' keys. The board is silent until the radio speaks.');
})().catch(e => { console.error(String(e.message || e)); process.exit(1); });
