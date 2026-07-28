/* ============================================================================
   ONE SHARED PER-SOURCE CACHE.

   On the Mac, two independent processes each called src-bikes.collect() on
   their own schedule: the activity loop every 60 seconds and the livefield
   loop every 5 minutes. Both wrote bikes-history.json. That was sloppy but
   harmless, because the history file was rewritten whole each time and the
   last writer simply won.

   On Redis it stops being harmless. The bike history is now a capped index
   list of 60 snapshot timestamps, and pickBaseline needs to reach 45 minutes
   back through it. Two writers pushing an entry each per minute halves the
   reach of that list to about 30 minutes, and the 45 minute baseline silently
   becomes unavailable. The flow numbers would not error, they would just quietly
   stop being computed.

   So there is one cache, both crons read it, and whoever finds it stale is the
   one who refreshes it. `stale` is returned rather than swallowed, because the
   activity layer's stated rule is that a source being down and a source
   reporting zero are different facts and are kept apart.
   ========================================================================== */

const kv = require('../lib/kv.js');

const K = name => 'bcc:activity:src:' + name;
/* Long enough that a source down for half an hour still has last-good data to
   serve, short enough that a retired source does not haunt the map for a day. */
const TTL_SEC = 3600;

async function read(name, maxAgeMs) {
  let s = null;
  try { s = await kv.getBig(K(name)); } catch (e) { return null; }
  if (!s) return null;
  let o = null;
  try { o = JSON.parse(s); } catch (e) { return null; }
  if (!o || typeof o.at !== 'number' || !Number.isFinite(o.at)) return null;
  const age = Date.now() - o.at;
  return { at: o.at, data: o.data, age, stale: maxAgeMs > 0 && age > maxAgeMs };
}

async function write(name, data) {
  const rec = { at: Date.now(), data };
  await kv.setBig(K(name), JSON.stringify(rec), TTL_SEC);
  return rec;
}

module.exports = { read, write, K, TTL_SEC };
