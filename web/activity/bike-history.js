/* ============================================================================
   Dock history for the bike flow signal, in Redis.

   On the Mac this was one 1.2 MB JSON file rewritten every poll. That works on
   a local disk and is a bad idea over a network: 45 snapshots of 600 stations
   read and written every minute is about 3.5 GB a day of Redis traffic to
   answer a question that needs exactly two snapshots.

   So each poll writes its own key and expires on its own, and a short index
   list says which ones exist. Picking a baseline reads the index (a few hundred
   bytes) and then exactly one snapshot.
   ========================================================================== */

const kv = require('../lib/kv');

const IDX  = 'bcc:bikes:idx';
const SNAP = t => 'bcc:bikes:snap:' + t;

/* One poll a minute, and pickBaseline never looks further back than 45
   minutes. 60 entries is that window plus room for a slow cron. */
const KEEP = 60;
const TTL_SEC = 46 * 60;

/* Returns [{t}] newest first. pickBaseline only reads .t, so this is enough to
   choose with, and the chosen snapshot is the only one actually fetched. */
async function index() {
  const raw = await kv.lrange(IDX, 0, KEEP - 1);
  return (raw || []).map(Number).filter(t => Number.isFinite(t) && t > 0).map(t => ({ t }));
}

async function get(t) {
  const s = await kv.get(SNAP(t));
  if (!s) return null;                    // expired between index read and fetch
  try { return { t, b: JSON.parse(s) }; } catch (e) { return null; }
}

async function put(t, bikes) {
  await kv.set(SNAP(t), JSON.stringify(bikes), TTL_SEC);
  await kv.lpushCapped(IDX, String(t), KEEP);
}

module.exports = { index, get, put };
