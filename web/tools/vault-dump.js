#!/usr/bin/env node
// tools/vault-dump.js
//
// One file holding a slice of the real radio, so the archive, the desk and
// the shift briefing can be worked on against what the newsroom actually
// heard rather than against fixtures somebody typed.
//
//   node tools/vault-dump.js              the last 48 hours
//   node tools/vault-dump.js 10           the last 10 hours
//   node tools/vault-dump.js 48 /tmp/x    somewhere other than _qa/
//
// WHY A FILE. Every bug that has mattered in these three surfaces was a bug
// against real transmissions: the brawl that ranked nineteenth, the window
// that said "no fights" over a fight, the archive that stopped at 6pm. None
// of them would have shown against a fixture, because a fixture is written by
// the same person who wrote the code and shares its blind spots. The tests
// that follow replay real questions against this slice, and a slice is the
// only way to do that without a token in the test runner and a network call
// in the sweep.
//
// WHAT IS IN IT. The vault rows for the window, read through lib/vault-read
// exactly the way the routes read them (rollups where they exist, pieces where
// they do not, deduped), plus the live board as it stood at the moment the
// dump ran: incidents, situations, the transcript buffer, stops, and feed
// health. The board is included because Shift Change's "things to watch" is
// built from it, and because a slice of the archive with no picture of what
// was open at the time cannot say whether a call was still running.
//
// WHAT IS NOT. No credentials, no env values, nothing but the data. Reads
// .env.local the way tools/peek.js does, names only, and never prints a
// value. The output lands under _qa/, which is gitignored, and it should
// stay there: it is a day of police radio with names in it.
//
// TWO WAYS IN, because `vercel env pull` cannot pull everything. The Blob
// token is marked sensitive in Vercel, which means the platform will hand it
// to a running function and to nobody else: the pull writes
// BLOB_READ_WRITE_TOKEN= with nothing after the equals sign, and the local
// path reports the store as unattached. That is the token working as
// designed, not a broken pull. So when the token is absent and AUTH_USER and
// AUTH_PASS are present (those do pull), this reads the vault THROUGH the
// deployed site instead: hour-window calls to /api/vault-browse, the same
// authenticated route the Archive tab's browse bar uses, which runs where
// the token lives. Slower, a request per hour of radio, and it needs the
// site up; the rows are identical. The board still reads straight from
// Redis, whose vars pull fine.
//
// `vercel env pull .env.local` from web/ refreshes the credentials either
// way. BCC_URL overrides the site for the remote path.

'use strict';

const fs = require('fs');
const path = require('path');

/* Same loader tools/peek.js and tools/who-is-feeding.js use, and the same
   rule: names are read, values are never printed anywhere in this file. */
function loadEnv() {
  const f = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(f)) return false;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
  return true;
}
loadEnv();

const hours = Math.max(1, Math.min(24 * 7, parseFloat(process.argv[2]) || 48));
const outArg = process.argv[3];

const blob = require('../lib/blob');
const vaultRead = require('../lib/vault-read');
const store_io = require('../lib/store-io');

/* The vault, through the site's own authenticated browse route. Hour windows,
   newest first; a window the route clips at its 500-row cap is split in half
   and read again, down to five minutes, which at the measured ~223 rows an
   hour is a ceiling nothing real approaches. AUTH_USER and AUTH_PASS come
   from .env.local and are sent to exactly one place: the site they belong to.
   Neither is ever printed. */
async function readRemote(fromMs, toMs) {
  const site = String(process.env.BCC_URL || 'https://www.scan.boston').replace(/\/+$/, '');
  const user = process.env.AUTH_USER || '', pass = process.env.AUTH_PASS || '';
  if (!user || !pass) {
    return { ok: false, why: 'no Blob token and no AUTH_USER/AUTH_PASS either; `vercel env pull .env.local` from web/ and try again' };
  }
  const headers = { authorization: 'Basic ' + Buffer.from(user + ':' + pass).toString('base64') };
  const HOUR = 3600000, MIN_SPLIT = 5 * 60000;
  const windows = [];
  for (let hi = toMs; hi > fromMs; hi -= HOUR) windows.push([Math.max(fromMs, hi - HOUR), hi]);
  const rows = [];
  const seen = new Set();
  const key = (t) => String(t.at || '') + '|' + String(t.feed || t.src || '') + '|' + String(t.text || '').slice(0, 96);
  let calls = 0, splits = 0, failed = 0, truncated = false, done = 0;
  async function readWin(lo, hi, depth) {
    calls++;
    let r, j;
    try {
      r = await fetch(site + '/api/vault-browse?from=' + new Date(lo).toISOString() + '&to=' + new Date(hi).toISOString(),
                      { headers, signal: AbortSignal.timeout(45000) });
    } catch (e) { failed++; return; }
    /* The status before the body: a 401 answers in plain text, and parsing it
       as JSON throws first, which turned a wrong password into forty-eight
       silent failures and an empty dump that looked like a quiet week. */
    if (r.status === 401 || r.status === 429) throw new Error('the site refused the login (' + r.status + '); check AUTH_USER/AUTH_PASS in .env.local');
    try { j = await r.json(); } catch (e) { failed++; return; }
    if (!r.ok || !j || j.ok === false) { failed++; return; }
    if (j.truncated) truncated = true;
    if (j.clipped && (hi - lo) > MIN_SPLIT) {
      /* More than the route returns in one answer: half and half again. */
      splits++;
      const mid = lo + Math.floor((hi - lo) / 2);
      await readWin(lo, mid, depth + 1);
      await readWin(mid, hi, depth + 1);
      return;
    }
    for (const t of (j.tx || [])) {
      const at = +new Date(t.at);
      if (!Number.isFinite(at) || at < fromMs || at > toMs) continue;
      const k = key(t);
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push(t);
    }
  }
  /* A few at a time: each call is one serverless invocation reading an hour
     rollup, and forty-eight in flight at once is a burst the site does not
     need at one in the morning. */
  const POOL = 4;
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= windows.length) return;
      await readWin(windows[i][0], windows[i][1], 0);
      done++;
      if (done % 6 === 0 || done === windows.length) process.stderr.write('  ' + done + '/' + windows.length + ' hours, ' + rows.length + ' rows\n');
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(POOL, windows.length) }, worker));
  } catch (e) {
    return { ok: false, why: String(e.message || e) };
  }
  rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return { ok: true, rows, listing: { mode: 'remote', site, calls, splits, failed, truncated } };
}

(async () => {
  const t0 = Date.now();
  const to = Date.now();
  const from = to - hours * 3600000;

  process.stderr.write('reading ' + hours + 'h of the vault, ' + new Date(from).toISOString() + ' to ' + new Date(to).toISOString() + ' ...\n');
  let read, listingNote;
  if (blob.enabled()) {
    read = await vaultRead.readWindow(from, to, {
      slackMs: 30 * 60 * 1000,
      max: 40000,
      evenly: true,
      concurrency: 32,
    });
    if (!read.ok) { console.error('vault read failed: ' + read.why); process.exit(3); }
    const L = read.listing || {};
    listingNote = { mode: 'blob', objects: (L.urls || []).length, rollups: L.rollups || 0, pieces: L.found || 0,
                    truncated: !!L.truncated, sampled: !!L.sampled, failed: read.failed, deduped: read.deduped };
    process.stderr.write('  ' + read.rows.length + ' rows from ' + listingNote.objects + ' objects ('
      + listingNote.rollups + ' hour rollups, ' + listingNote.pieces + ' pieces'
      + (listingNote.truncated ? ', TRUNCATED' : '') + (listingNote.sampled ? ', SAMPLED' : '') + '), ' + read.failed + ' fetch failures\n');
  } else {
    process.stderr.write('  no Blob token locally (' + blob.reason().slice(0, 60) + '); reading through the site instead\n');
    read = await readRemote(from, to);
    if (!read.ok) { console.error('remote read failed: ' + read.why); process.exit(3); }
    listingNote = read.listing;
    process.stderr.write('  ' + read.rows.length + ' rows from ' + listingNote.calls + ' window calls to ' + listingNote.site
      + (listingNote.splits ? ' (' + listingNote.splits + ' busy windows split)' : '')
      + (listingNote.truncated ? ', some windows TRUNCATED' : '') + (listingNote.failed ? ', ' + listingNote.failed + ' window(s) failed' : '') + '\n');
  }

  /* The board, as it stands. Each is one command; a missing one is noted and
     the dump still happens, because the vault rows are the point. */
  const board = {};
  const keys = { incidents: store_io.K.outIncidents, situations: store_io.K.outSituations,
                 transcripts: store_io.K.outTranscripts, stops: store_io.K.outStops };
  for (const [name, key] of Object.entries(keys)) {
    try {
      const raw = await store_io.readOut(key, '');
      board[name] = raw ? JSON.parse(raw) : null;
      process.stderr.write('  board.' + name + ': ' + (Array.isArray(board[name]) ? board[name].length + ' records' : (board[name] ? 'object' : 'empty')) + '\n');
    } catch (e) {
      board[name] = null;
      process.stderr.write('  board.' + name + ': unavailable (' + String(e.message || e).slice(0, 80) + ')\n');
    }
  }
  try { board.health = await store_io.getHealth(); } catch (e) { board.health = null; }

  const out = {
    v: 1,
    generatedAt: new Date().toISOString(),
    hours,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    listing: listingNote,
    rows: read.rows,
    board,
  };

  const stamp = out.generatedAt.replace(/[:.]/g, '').slice(0, 15);
  const file = outArg
    ? (fs.existsSync(outArg) && fs.statSync(outArg).isDirectory() ? path.join(outArg, 'vault-' + hours + 'h-' + stamp + '.json') : outArg)
    : path.join(__dirname, '..', '..', '_qa', 'vault-' + hours + 'h-' + stamp + '.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out));
  const mb = (fs.statSync(file).size / 1048576).toFixed(1);

  const feeds = {};
  for (const r of read.rows) feeds[r.feed || '?'] = (feeds[r.feed || '?'] || 0) + 1;
  const top = Object.entries(feeds).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([f, n]) => f + ' ' + n).join(', ');
  console.log('wrote ' + path.relative(process.cwd(), file) + '  (' + mb + ' MB, ' + read.rows.length + ' rows, '
    + Object.keys(feeds).length + ' feeds, ' + (Date.now() - t0) + 'ms)');
  console.log('busiest: ' + top);
  console.log('hand this file to the session; it stays out of git (_qa/ is ignored).');
})().catch(e => {
  console.error('dump failed: ' + (e && e.stack || e));
  process.exit(1);
});
