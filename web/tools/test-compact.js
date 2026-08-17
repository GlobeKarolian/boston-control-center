// tools/test-compact.js
//
// One object per hour, and the archive question that took fourteen seconds.
//
// On 17 August "Bar Fight in cambridge" fetched six thousand objects, took
// 14.6 seconds, and because no request can fetch a two-day window's worth of
// two-transmission objects, it read only the newest sixteen hours of the two
// days it was asked about and said so only in a field the page did not show.
//
// lib/compact.js rolls every settled Eastern hour into one object. This file
// proves, against a fake store that behaves like Vercel Blob:
//
//   - a rolled hour is one fetch and no listing;
//   - the reader gets exactly the same rows either way, deduped at the seams;
//   - hours that are not settled are left alone, and the current hour is
//     still read piece by piece;
//   - a late piece gets its hour rolled again, and the old rollup retired;
//   - the legacy flat day rolls up too, and stops being listed once it has;
//   - the two-day question is fifty fetches, not six thousand.

'use strict';

const blob = require('../lib/blob');
const vr = require('../lib/vault-read');
const compact = require('../lib/compact');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fail++;
  console.log('  FAIL ' + name + (extra ? '  ' + extra : ''));
}
const ET = (s) => +new Date(s);

/* --- a fake object store with list / put / del and a fetch that reads it --- */

const STORE = new Map();          // pathname -> { body(json string), uploadedAt }
let LISTS = 0, FETCHES = 0, PUTS = 0;
const CLOCK = { now: ET('2026-08-17T14:10:00Z') };   // 10:10 am ET, 17 August

const fake = {
  list({ prefix, cursor, limit, mode }) {
    LISTS++;
    let all = [...STORE.keys()].filter(k => k.indexOf(prefix) === 0);
    const folders = new Set();
    if (mode === 'folded') {
      const direct = [];
      for (const k of all) {
        const rest = k.slice(prefix.length);
        if (rest.indexOf('/') === -1) direct.push(k);
        else folders.add(prefix + rest.slice(0, rest.indexOf('/')) + '/');
      }
      all = direct;
    }
    all.sort();
    const start = cursor ? +cursor : 0;
    const page = all.slice(start, start + (limit || 1000));
    const next = start + page.length;
    return Promise.resolve({
      blobs: page.map(k => ({ pathname: k, url: 'https://fake/' + k, uploadedAt: new Date(STORE.get(k).uploadedAt) })),
      folders: [...folders], hasMore: next < all.length, cursor: String(next),
    });
  },
  put(pathname, body) {
    PUTS++;
    if (STORE.has(pathname)) return Promise.reject(new Error('This blob already exists'));
    STORE.set(pathname, { body: String(body), uploadedAt: CLOCK.now });
    return Promise.resolve({ url: 'https://fake/' + pathname, pathname });
  },
  del(urls) {
    for (const u of (Array.isArray(urls) ? urls : [urls])) STORE.delete(String(u).replace('https://fake/', ''));
    return Promise.resolve();
  },
};
blob._inject(fake, 'test-token-not-a-credential');
vr._setFetch(async (u) => {
  FETCHES++;
  const k = String(u).replace('https://fake/', '');
  const o = STORE.get(k);
  if (!o) return { ok: false, status: 404 };
  return { ok: true, json: async () => JSON.parse(o.body) };
});

/* Write pieces the way the vault does: one object per ingest, one or two
   rows, named for its first row, filed under its Eastern hour. */
function piece(atMs, rows, opts) {
  const o = opts || {};
  const path = (o.flat ? ('vault/' + require('../lib/vault-query').dayString(new Date(atMs)) + '/tx/') : vr.prefixFor(atMs))
    + String(atMs) + '-' + rows.length + '.json';
  STORE.set(path, { body: JSON.stringify({ v: 1, tx: rows }), uploadedAt: o.uploadedAt || (atMs + 4000) });
  return path;
}
function row(atMs, i, feed) {
  return { at: new Date(atMs).toISOString(), feed: feed || 'boston-police', text: 'transmission ' + i + ' at ' + new Date(atMs).toISOString(), units: ['C' + (i % 9)] };
}

/* Two days of traffic, one piece every 90 seconds. Yesterday is LEGACY (flat);
   today is hour-bucketed. That is exactly the shape of the archive the
   morning this ships. */
const DAY1 = ET('2026-08-16T04:00:00Z');     // midnight ET, 16 Aug
const DAY2 = ET('2026-08-17T04:00:00Z');     // midnight ET, 17 Aug
let n = 0;
for (let t = DAY1; t < DAY2; t += 90000) piece(t, [row(t, n++)], { flat: true });
for (let t = DAY2; t < CLOCK.now; t += 90000) piece(t, [row(t, n++)]);
/* And a boundary piece: named for 22:59:30 ET, carrying a second row at 23:00:20. */
const B = ET('2026-08-17T02:59:30Z');
piece(B, [row(B, 90001), row(B + 50000, 90002)]);
const TOTAL_ROWS = n + 2;

/* The truth, read the slow way, before anything is rolled. */
async function truth(fromMs, toMs) {
  const r = await vr.readWindow(fromMs, toMs, { slackMs: 30 * 60000, max: 100000, rollups: false });
  return r.rows;
}

async function main() {
  const twoDaysFrom = ET('2026-08-15T14:10:00Z'), twoDaysTo = CLOCK.now;

  /* --- before: the shape of the problem ---------------------------------- */
  LISTS = 0; FETCHES = 0;
  const before = await vr.readWindow(twoDaysFrom, twoDaysTo, { slackMs: 30 * 60000, max: 100000 });
  const beforeFetches = FETCHES;
  ok('before rolling, a two-day read is more than a thousand fetches', beforeFetches > 1000, beforeFetches + ' fetches');
  ok('and it does read every row', before.rows.length === TOTAL_ROWS, before.rows.length + ' of ' + TOTAL_ROWS);

  /* --- one run of the compactor ------------------------------------------ */
  const r1 = await compact.run({ now: CLOCK.now, budgetMs: 60000, maxHours: 200 });
  ok('the run reports what it did', r1.ok && Array.isArray(r1.rolled), JSON.stringify(r1.why));
  const rolledKeys = new Set(r1.rolled.map(x => x.key));
  ok('the current hour is not rolled', !rolledKeys.has('2026-08-17/10'), [...rolledKeys].filter(k => /\/10$/.test(k)).join(','));
  ok('nor is the hour that just ended, because its last ingest may not have landed',
     !rolledKeys.has('2026-08-17/09'));
  ok('the hour before that is', rolledKeys.has('2026-08-17/08'));
  ok('and yesterday, the legacy flat day, is rolled hour by hour',
     rolledKeys.has('2026-08-16/00') && rolledKeys.has('2026-08-16/23'),
     [...rolledKeys].filter(k => k.indexOf('2026-08-16') === 0).length + ' hours of the 16th');
  ok('nothing failed', r1.failed.length === 0, JSON.stringify(r1.failed));
  const roll08 = JSON.parse(STORE.get([...STORE.keys()].find(k => k.indexOf('vault/2026-08-17/hour/08-') === 0)).body);
  ok('a rollup carries the hour whole and says so', roll08.count === roll08.tx.length && roll08.count === 40, 'count=' + roll08.count);
  ok('a rollup\'s rows are in time order',
     roll08.tx.every((t, i) => i === 0 || t.at >= roll08.tx[i - 1].at));

  /* --- after: same rows, a fraction of the fetches ------------------------ */
  LISTS = 0; FETCHES = 0;
  const after = await vr.readWindow(twoDaysFrom, twoDaysTo, { slackMs: 30 * 60000, max: 100000 });
  ok('after rolling, the two-day read is about one fetch per hour plus the live pieces',
     FETCHES < 120, FETCHES + ' fetches (was ' + beforeFetches + ')');
  ok('and it lists a handful of prefixes, not a legacy day thirty pages deep',
     LISTS <= 12, LISTS + ' list calls');
  ok('with exactly the same rows', after.rows.length === before.rows.length,
     after.rows.length + ' vs ' + before.rows.length);
  const bk = new Set(before.rows.map(vr.rowKey));
  ok('row for row', after.rows.every(t => bk.has(vr.rowKey(t))));
  ok('the boundary row that lives in a 22:59 piece but belongs to 23:00 is there once',
     after.rows.filter(t => t.text === 'transmission 90002 at ' + new Date(B + 50000).toISOString()).length === 1);
  ok('the listing knows how many hours came rolled', after.listing.rollups >= 40, after.listing.rollups + ' rollups');

  /* --- a narrow read inside a rolled hour ---------------------------------- */
  LISTS = 0; FETCHES = 0;
  const narrow = await vr.readWindow(ET('2026-08-16T18:00:00Z'), ET('2026-08-16T18:20:00Z'), { slackMs: 30 * 60000 });
  const narrowFetches = FETCHES, narrowLists = LISTS;
  const tn = await truth(ET('2026-08-16T18:00:00Z'), ET('2026-08-16T18:20:00Z'));
  ok('twenty minutes of a rolled legacy day is a couple of fetches', narrowFetches <= 3, narrowFetches + ' fetches');
  ok('and does not list the flat day at all', narrowLists <= 3, narrowLists + ' list calls');
  ok('and holds the same rows the slow way found', narrow.rows.length === tn.length && narrow.rows.length > 5,
     narrow.rows.length + ' vs ' + tn.length);

  /* --- idle run: nothing new is due ---------------------------------------- */
  const r2 = await compact.run({ now: CLOCK.now, budgetMs: 60000 });
  ok('a second run at the same instant rolls nothing', r2.rolled.length === 0, r2.rolled.length + ' rolled');

  /* --- a late piece: relay back from an outage ----------------------------- */
  {
    const late = ET('2026-08-17T12:30:00Z');       // 08:30 ET, an hour already rolled
    piece(late, [row(late, 777777)], { uploadedAt: CLOCK.now + 60000 });   // uploaded after the rollup
    const oldRollup = [...STORE.keys()].find(k => k.indexOf('vault/2026-08-17/hour/08-') === 0);
    CLOCK.now += 5 * 60000;
    const r3 = await compact.run({ now: CLOCK.now, budgetMs: 60000 });
    ok('a late piece gets its hour rolled again', r3.rolled.some(x => x.key === '2026-08-17/08' && x.late > 0),
       JSON.stringify(r3.rolled.map(x => x.key)));
    const rolls08 = [...STORE.keys()].filter(k => k.indexOf('vault/2026-08-17/hour/08-') === 0);
    ok('the old rollup is retired and one newer one stands', rolls08.length === 1 && rolls08[0] !== oldRollup, rolls08.join(','));
    const re = await vr.readWindow(ET('2026-08-17T12:00:00Z'), ET('2026-08-17T13:00:00Z'), { slackMs: 0 });
    ok('and the late transmission is now readable', re.rows.some(t => t.text.indexOf('777777') !== -1));
  }

  /* --- names -------------------------------------------------------------- */
  ok('a rollup name is parsed back', JSON.stringify(vr.rollupOf('vault/2026-08-17/hour/08-1755400000000.json'))
     === JSON.stringify({ day: '2026-08-17', hour: '08', written: 1755400000000 }));
  ok('a piece name is not mistaken for one', vr.rollupOf('vault/2026-08-17/tx/08/1755400000000-2.json') === null);
  const hw = vr.hourWindow('2026-11-01', '01');
  ok('the doubled 1am on the November change is one two-hour bucket', hw && hw.end - hw.start === 2 * 3600000,
     hw && (hw.end - hw.start) / 60000 + ' minutes');
  ok('the missing 2am on the March change is no bucket at all', vr.hourWindow('2026-03-08', '02') === null);
  const hw8 = vr.hourWindow('2026-08-17', '08');
  ok('an ordinary hour is sixty minutes starting on the hour, Eastern',
     hw8 && hw8.start === ET('2026-08-17T12:00:00Z') && hw8.end === ET('2026-08-17T13:00:00Z'));

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.log('  THREW ' + (e && e.stack || e)); process.exit(1); });
