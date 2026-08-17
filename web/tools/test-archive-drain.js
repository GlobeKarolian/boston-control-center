// tools/test-archive-drain.js
//
// The full-incident archive, which had never once run.
//
// A scene that goes quiet is retired by store.sweep() and handed to
// takeDropped(). At that moment it is gone from Redis and lives nowhere else.
// The live board only ever kept the last few lines of a call to stay small;
// the vault was supposed to keep the whole timeline, because the whole
// timeline is what somebody asks for six months later.
//
// Only api/cron/sweep.js drained it, every five minutes. But withStore() calls
// sweep() on EVERY ingest, at thirty to seventy a minute, and this runs
// serverless so the store is rebuilt from Redis on each request. So almost
// every retirement happened during an ingest, went into that process's dropped
// list, and vanished with the process. Five minutes later the cron found an
// empty list and reported archiving zero, which reads as "nothing retired"
// rather than "the archive is not running".
//
// The drain now lives with the sweep, so every path that retires a scene also
// files it.

'use strict';

const path = require('path');
const fs = require('fs');
const vault = require('../lib/vault');
const store_io = require('../lib/store-io');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fail++;
  console.log('  FAIL ' + name + (extra ? '  ' + extra : ''));
}

const realPut = vault.putIncident;
let written = [];

const fakeStore = (dropped) => ({
  _taken: false,
  takeDropped() { if (this._taken) return []; this._taken = true; return dropped; },
});

async function run() {
  vault.putIncident = async (inc) => { written.push(inc && inc.id); return { ok: true }; };

  /* --- the drain itself ---------------------------------------------------- */

  written = [];
  {
    const r = await store_io.archiveDropped(fakeStore([{ id: 'inc-a' }, { id: 'inc-b' }]));
    ok('a retired scene is written to the vault', written.length === 2, JSON.stringify(written));
    ok('and the count comes back', r.ok === 2 && r.failed === 0, JSON.stringify(r));
  }

  written = [];
  {
    const r = await store_io.archiveDropped(fakeStore([]));
    ok('nothing retired costs nothing', written.length === 0 && r.ok === 0);
  }

  /* A vault that cannot be reached loses a record. It must not lose the
     transmission the ingest was actually there to save. */
  written = [];
  vault.putIncident = async () => { throw new Error('blob is down'); };
  {
    let threw = false;
    let r = null;
    try { r = await store_io.archiveDropped(fakeStore([{ id: 'inc-c' }])); }
    catch (e) { threw = true; }
    ok('a failing object store does not throw into the ingest path', !threw);
    ok('and the failure is counted rather than swallowed silently',
       r && r.failed === 1 && r.ok === 0, JSON.stringify(r));
  }
  vault.putIncident = async (inc) => { written.push(inc && inc.id); return { ok: true }; };

  /* Drained exactly once: a second drain of the same store must not rewrite
     what has already been filed. */
  written = [];
  {
    const st = fakeStore([{ id: 'inc-d' }]);
    await store_io.archiveDropped(st);
    await store_io.archiveDropped(st);
    ok('a scene is filed once, not once per caller', written.length === 1, JSON.stringify(written));
  }

  /* --- the wiring, which is the part that was actually wrong --------------- */

  {
    const io = fs.readFileSync(path.join(__dirname, '..', 'lib', 'store-io.js'), 'utf8');
    ok('withStore drains what its own sweep retired',
       /out\.archived\s*=\s*await\s+archiveDropped/.test(io),
       'withStore sweeps but does not archive');
    ok('and does it outside the lock, so object writes hold nothing up',
       io.indexOf('kv.unlock(K.lock, token)') < io.indexOf('await archiveDropped(out.store)'));

    const cron = fs.readFileSync(path.join(__dirname, '..', 'api', 'cron', 'sweep.js'), 'utf8');
    ok('the sweep cron no longer keeps its own private drain',
       !/takeDropped/.test(cron), 'two drains means whichever runs first wins');
    ok('and reports what retired separately from what was filed',
       /retired:/.test(cron) && /archived:/.test(cron),
       'one number for both hides scenes retiring with none written');
  }

  vault.putIncident = realPut;
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
}

run().catch(e => { vault.putIncident = realPut; console.log('  THREW ' + (e && e.stack || e)); process.exit(1); });
