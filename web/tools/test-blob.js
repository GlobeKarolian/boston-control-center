/* tools/test-blob.js - the storage layer, with a fake store instead of a bill.

   lib/blob.js is the only file in this project that can destroy something. The
   sweep deletes, and a sweep that gets its window wrong deletes audio a
   reporter is still working from. So it is tested the way a delete path
   deserves: against a store that records every call it is asked to make, with
   no network, no real token and no money involved.

   The seam is _inject(). It swaps the module the real code got from require()
   for an object carrying the same three methods, which is enough because those
   three methods are the entire surface lib/blob.js uses.

   node tools/test-blob.js */

/* Removed before the module is loaded, so the off path below is the same on
   Matt's Mac as it is anywhere else. Nothing here reads a real credential; it
   only makes sure this process is not holding one. */
delete process.env.BLOB_READ_WRITE_TOKEN;

const B = require('../lib/blob.js');
const C = require('../app/clips.js');

/* Not a credential. The fake store never looks at it and no request leaves the
   machine. It is here because enabled() checks that a store is attached, and
   an empty string is how this file proves the opposite case. */
const STUB_TOKEN = 'test-only-not-a-token';

let pass = 0, fail = 0;

const head = (s) => console.log('\n  ' + s);
const ok = (what, got) => {
  if (got) { pass++; console.log('    ok   ' + what); }
  else { fail++; console.log('    FAIL ' + what); }
};
const eq = (what, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; console.log('    ok   ' + what); }
  else { fail++; console.log('    FAIL ' + what + '\n         got  ' + a + '\n         want ' + b); }
};

/* ---- the fake store -------------------------------------------------------

   Answers the way Blob answers, including the parts that matter to the code
   under test: a listing is paged and hands back a cursor, a URL is on the real
   host, and a delete takes either one URL or an array of them.

   The cursor walks a snapshot taken when paging started, rather than a live
   view of the map. That is the honest model of a server-side cursor, and it is
   also the only way to test a loop that deletes the very rows it is paging
   through. Without it the second page silently skips whatever the first page
   removed, and the test would be measuring the fake rather than the sweep. */
function store(seed) {
  const blobs = new Map();
  (seed || []).forEach((p) => blobs.set(p, {
    pathname: p,
    url: 'https://tstore123.public.blob.vercel-storage.com/' + p,
    size: 44000,
  }));
  const snapshots = new Map();
  const calls = { put: [], list: [], del: [] };
  return {
    calls,
    blobs,
    failList: false,
    failDel: false,
    hangPut: false,
    async put(path, body, opts) {
      calls.put.push({ path, bytes: body && body.length, opts });
      if (this.hangPut) return new Promise(function () {});
      // Blob's random suffix goes on the filename, before the extension, which
      // matters here because the sweep reads the day out of the path and a
      // suffix in the wrong place would quietly make that test meaningless.
      const p = path.replace(/(\.[a-z0-9]+)$/i, '-Ab3xY9$1');
      const rec = { pathname: p, url: 'https://tstore123.public.blob.vercel-storage.com/' + p };
      blobs.set(p, rec);
      return rec;
    },
    async list(opts) {
      calls.list.push(opts);
      if (this.failList) throw new Error('the store is having a day');
      const prefix = (opts && opts.prefix) || '';
      const from = opts && opts.cursor ? +opts.cursor : 0;
      let all;
      if (from === 0 || !snapshots.has(prefix)) {
        all = [...blobs.values()].filter((b) => b.pathname.indexOf(prefix) === 0);
        snapshots.set(prefix, all);
      } else {
        all = snapshots.get(prefix);
      }
      const size = (opts && opts.limit) || 1000;
      const slice = all.slice(from, from + size);
      const next = from + size;
      return { blobs: slice, hasMore: next < all.length, cursor: String(next) };
    },
    async del(urls) {
      const list = Array.isArray(urls) ? urls : [urls];
      calls.del.push(list);
      if (this.failDel) throw new Error('delete refused');
      list.forEach((u) => {
        for (const [k, v] of blobs) if (v.url === u) blobs.delete(k);
      });
    },
  };
}

const NOW = '2026-08-04T12:00:00Z';
const day = (n) => C.dayOf(new Date(Date.parse(NOW) - n * 86400000).toISOString());

// ---------------------------------------------------------------------------

async function main() {

  head('with no store attached the feature is off and nothing throws');
  {
    ok('enabled() is false', !B.enabled());
    ok('and it says why in words a person can read', /clip storage is off/.test(B.reason()));
    ok('naming the missing piece rather than saying "error"',
      /* Case-insensitive because the missing piece is spelled two ways: with
         the module absent the reason says "not installed", and with the module
         present but no store attached it names BLOB_READ_WRITE_TOKEN, in the
         capitals the variable actually wears. This suite runs in both worlds
         depending on whether npm install has happened on this machine. */
      /token|not installed|no put/i.test(B.reason()));
  }

  head('an upload with the feature off answers, rather than failing');
  {
    const r = await B.putClip(Buffer.from('xx'), { src: 'msp', at: NOW });
    eq('ok is false', r.ok, false);
    ok('and why is the same sentence reason() gives', r.why === B.reason());
  }

  head('a sweep with the feature off is a no-op, not an exception');
  {
    const r = await B.sweep({ now: NOW });
    eq('ok is false', r.ok, false);
    eq('and it deleted nothing', r.deleted, 0);
  }

  // From here the fake is injected, which is what turns enabled() on.

  head('a clip is written under the path app/clips.js chose');
  {
    const s = store();
    B._inject(s, STUB_TOKEN);
    const row = { src: 'Mass State Police', at: '2026-08-04T04:48:12Z', seq: 1841 };
    const r = await B.putClip(Buffer.alloc(44000, 7), row);
    ok('it reports success', r.ok === true);
    eq('the store was asked for exactly one put', s.calls.put.length, 1);
    eq('under the path clips.js names', s.calls.put[0].path, C.pathFor(row));
    eq('as a public object', s.calls.put[0].opts.access, 'public');
    eq('typed as audio a browser will play', s.calls.put[0].opts.contentType, 'audio/mp4');
    ok('with a random suffix, so two clips in the same second cannot collide',
      s.calls.put[0].opts.addRandomSuffix === true);
    ok('cached long, because a clip never changes once written',
      s.calls.put[0].opts.cacheControlMaxAge > 86400);
    ok('and the URL it hands back passes the host check', C.ok(r.url));
    eq('the byte count is reported, so the meter has something to add up',
      r.bytes, 44000);
  }

  head('the things that should never reach the store never reach it');
  {
    const s = store();
    B._inject(s, STUB_TOKEN);
    const row = { src: 'msp', at: NOW };
    eq('an empty body is refused', (await B.putClip(Buffer.alloc(0), row)).ok, false);
    eq('a string that is not a buffer is refused', (await B.putClip('not audio', row)).ok, false);
    eq('and so is nothing at all', (await B.putClip(null, row)).ok, false);
    const big = await B.putClip(Buffer.alloc(B.MAX_BYTES + 1), row);
    eq('a body over the cap is refused', big.ok, false);
    ok('and the refusal says how big it was', /over the/.test(big.why));
    const unnamed = await B.putClip(Buffer.alloc(100), { src: 'msp', at: 'tuesday-ish' });
    eq('a row with no usable time is refused', unnamed.ok, false);
    eq('every one of those was refused before the store was called', s.calls.put.length, 0);
  }

  head('a store that answers with somebody else\'s URL is not believed');
  {
    const s = store();
    s.put = async function (path) {
      return { pathname: path, url: 'https://evil.example.com/' + path };
    };
    B._inject(s, STUB_TOKEN);
    const r = await B.putClip(Buffer.alloc(100), { src: 'msp', at: NOW });
    eq('the upload is reported as failed', r.ok, false);
    ok('because that URL would not survive the host check',
      /will not serve/.test(r.why));
  }

  head('a store that never answers is given up on');
  {
    const s = store();
    s.hangPut = true;
    B._inject(s, STUB_TOKEN);
    const t = Date.now();
    const r = await B.putClip(Buffer.alloc(100), { src: 'msp', at: NOW }, { timeoutMs: 120 });
    eq('the upload fails rather than hanging the request', r.ok, false);
    ok('quickly, so the transmissions queued behind it are not held up',
      Date.now() - t < 2000);
    ok('and the reason names the timeout', /did not answer/.test(r.why));
  }

  head('a store that throws costs a play button and nothing else');
  {
    const s = store();
    s.put = async function () { throw new Error('507 insufficient storage'); };
    B._inject(s, STUB_TOKEN);
    const r = await B.putClip(Buffer.alloc(100), { src: 'msp', at: NOW });
    eq('reported as failed', r.ok, false);
    ok('with the store\'s own words carried through for the log',
      /insufficient storage/.test(r.why));
  }

  // -------------------------------------------------------------------------
  // The sweep. This is the part that deletes.
  // -------------------------------------------------------------------------

  head('the sweep takes the old days and only the old days');
  {
    const s = store([
      'clips/' + day(30) + '/msp/010101.m4a',
      'clips/' + day(10) + '/msp/010101.m4a',
      'clips/' + day(8) + '/msp/010101.m4a',
      'clips/' + day(7) + '/msp/010101.m4a',   // the boundary: this one stays
      'clips/' + day(1) + '/msp/010101.m4a',
      'clips/' + day(0) + '/msp/010101.m4a',
    ]);
    B._inject(s, STUB_TOKEN);
    const r = await B.sweep({ now: NOW, days: 7, back: 40 });
    ok('it reports success', r.ok === true);
    eq('three clips went', r.deleted, 3);
    ok('the boundary day is still there',
      s.blobs.has('clips/' + day(7) + '/msp/010101.m4a'));
    ok('so is yesterday', s.blobs.has('clips/' + day(1) + '/msp/010101.m4a'));
    ok('so is today', s.blobs.has('clips/' + day(0) + '/msp/010101.m4a'));
    ok('and the old ones are not',
      !s.blobs.has('clips/' + day(30) + '/msp/010101.m4a')
      && !s.blobs.has('clips/' + day(10) + '/msp/010101.m4a')
      && !s.blobs.has('clips/' + day(8) + '/msp/010101.m4a'));
    ok('it names the days it cleared, so a cron log means something',
      r.cleared.length === 3);
  }

  head('a listing that comes back wrong deletes nothing');
  {
    /* The belt-and-braces case, and the whole reason expired() is checked per
       blob rather than trusted from the prefix. Here the store answers a
       request for an old day with a clip from this morning, which is what a
       prefix bug on either side would look like. */
    const s = store();
    s.list = async function (opts) {
      s.calls.list.push(opts);
      return {
        blobs: [{
          pathname: 'clips/' + day(0) + '/msp/010101.m4a',
          url: 'https://tstore123.public.blob.vercel-storage.com/today.m4a',
        }],
        hasMore: false,
        cursor: null,
      };
    };
    B._inject(s, STUB_TOKEN);
    const r = await B.sweep({ now: NOW, days: 7, back: 2 });
    ok('the sweep saw blobs', r.scanned > 0);
    eq('and deleted none of them', r.deleted, 0);
    eq('no delete was even attempted', s.calls.del.length, 0);
  }

  head('a blob whose URL is not ours is left alone too');
  {
    const s = store();
    s.list = async function (opts) {
      s.calls.list.push(opts);
      return {
        blobs: [{
          pathname: 'clips/' + day(30) + '/msp/010101.m4a',
          url: 'https://evil.example.com/clips/x.m4a',
        }],
        hasMore: false,
        cursor: null,
      };
    };
    B._inject(s, STUB_TOKEN);
    const r = await B.sweep({ now: NOW, days: 7, back: 40 });
    ok('it is old enough to delete',
      C.expired('clips/' + day(30) + '/msp/010101.m4a', 7, NOW));
    eq('but it is still not deleted', r.deleted, 0);
    eq('and no delete was attempted', s.calls.del.length, 0);
  }

  head('a day with more clips than fit in one listing is fully swept');
  {
    const many = [];
    for (let i = 0; i < 2500; i++) {
      many.push('clips/' + day(8) + '/msp/' + String(100000 + i) + '.m4a');
    }
    const s = store(many);
    B._inject(s, STUB_TOKEN);
    const r = await B.sweep({ now: NOW, days: 7, back: 2 });
    eq('every one of them went', r.deleted, 2500);
    ok('which took more than one listing', s.calls.list.length >= 3);
    ok('and a later listing carried the cursor the one before it returned',
      s.calls.list.some((c) => c && c.cursor));
    eq('the store is empty afterwards', s.blobs.size, 0);
  }

  head('the sweep stops at its budget rather than running all night');
  {
    const many = [];
    for (let i = 0; i < 900; i++) {
      many.push('clips/' + day(8) + '/msp/' + String(100000 + i) + '.m4a');
    }
    const s = store(many);
    B._inject(s, STUB_TOKEN);
    const r = await B.sweep({ now: NOW, days: 7, back: 2, maxDeletes: 100 });
    eq('exactly the budget went', r.deleted, 100);
    eq('and the rest are there for the next run', s.blobs.size, 800);
  }

  head('a store that fails mid-sweep leaves storage behind, not an exception');
  {
    const s = store([
      'clips/' + day(30) + '/msp/010101.m4a',
      'clips/' + day(29) + '/msp/010101.m4a',
    ]);
    s.failList = true;
    B._inject(s, STUB_TOKEN);
    const r = await B.sweep({ now: NOW, days: 7, back: 40 });
    eq('the sweep still returns', r.ok, true);
    eq('having deleted nothing', r.deleted, 0);
    eq('and having kept every clip', s.blobs.size, 2);
  }

  head('and a delete that fails is the same: a bill, not an outage');
  {
    const s = store(['clips/' + day(30) + '/msp/010101.m4a']);
    s.failDel = true;
    B._inject(s, STUB_TOKEN);
    const r = await B.sweep({ now: NOW, days: 7, back: 40 });
    eq('the sweep returns', r.ok, true);
    eq('nothing was counted as deleted', r.deleted, 0);
    eq('and the clip is still in the store', s.blobs.size, 1);
  }

  head('nothing outside clips/ is ever in range');
  {
    const s = store([
      'clips/' + day(30) + '/msp/010101.m4a',
      'backups/2019-01-01/db.sql',
      'exports/' + day(30) + '/report.csv',
    ]);
    B._inject(s, STUB_TOKEN);
    const r = await B.sweep({ now: NOW, days: 7, back: 40 });
    eq('the old clip went', r.deleted, 1);
    ok('the backup is untouched', s.blobs.has('backups/2019-01-01/db.sql'));
    ok('and so is the export', s.blobs.has('exports/' + day(30) + '/report.csv'));
    ok('because every listing asked under clips/ and nowhere else',
      s.calls.list.every((c) => c && String(c.prefix).indexOf('clips/') === 0));
  }

  head('the meter counts the things the invoice counts');
  {
    const s = store(['clips/' + day(30) + '/msp/010101.m4a']);
    B._inject(s, STUB_TOKEN);
    const before = B.meter();
    await B.putClip(Buffer.alloc(44000, 1), { src: 'msp', at: NOW, seq: 1 });
    await B.putClip(Buffer.alloc(44000, 1), { src: 'msp', at: NOW, seq: 2 });
    await B.sweep({ now: NOW, days: 7, back: 40 });
    const after = B.meter();
    eq('two more puts', after.puts - before.puts, 2);
    eq('one more delete', after.deletes - before.deletes, 1);
    ok('some listings', after.lists > before.lists);
    ok('the megabyte figure moved', after.megabytes > before.megabytes);
    ok('it projects a monthly cost rather than leaving it to be discovered',
      typeof after.projectedMonthlyUSD === 'number');
    ok('and it says the feature is on', after.on === true);
  }

  head('injecting nothing turns it back off, which is how a bad deploy behaves');
  {
    B._inject(null);
    ok('enabled() is false again', !B.enabled());
    const r = await B.putClip(Buffer.alloc(100), { src: 'msp', at: NOW });
    eq('and an upload is a polite no', r.ok, false);
    const w = await B.sweep({ now: NOW });
    eq('as is a sweep', w.ok, false);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.log('\n  the harness itself threw: ' + (e && e.message));
  console.log('\n' + pass + ' passed, ' + (fail + 1) + ' failed\n');
  process.exit(1);
});
