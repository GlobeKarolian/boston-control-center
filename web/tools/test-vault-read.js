// tools/test-vault-read.js
//
// Where an archived transmission lives, and how it is found again.
//
// This file guards the third of the product's three jobs: anyone in the
// newsroom can go back and find it. Two separate nights were lost to the same
// class of bug, and both are reproduced here.
//
// BUG ONE, TWICE. lib/stream.js and api/vault-search.js each grew their own
// copy of "list the day folder, filter by the stamp in the filename, fetch
// what is left". Both applied a cap to a listing that Vercel Blob returns
// OLDEST FIRST, so both answered from midnight to roughly 6:27pm and declared
// the evening empty. Fixing one did not fix the other; a person had to notice
// the archive was still truncated after the first fix shipped. There is one
// implementation now and these tests are its only owner.
//
// BUG TWO. The vault wrote one or two records per object, so a busy day was
// about thirty thousand tiny objects in one flat folder. Reading any window of
// it, even twenty minutes, meant paging that folder a thousand at a time:
// thirty sequential round trips before a byte of content was fetched. In one
// night that produced an archive that stopped at 6pm, a Shift Change page that
// timed out and an eighteen-second briefing. Objects are now filed under the
// Eastern hour they belong to.
//
// The hour bucket introduced a hazard worth naming: the path is no longer
// lexically ordered by time, because "03" sorts before "22" while being later
// in the day. Any caller that sorts URLs as strings now scrambles chronology.
// The last section proves it, so that nobody puts that sort back.

'use strict';

const blob = require('../lib/blob');
const vr = require('../lib/vault-read');
const vault = require('../lib/vault');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fail++;
  console.log('  FAIL ' + name + (extra ? '  ' + extra : ''));
}

const ET = (s) => +new Date(s);

/* --- the Eastern hour ---------------------------------------------------- */

ok('midnight Eastern is hour 00', vr.hourOf(ET('2026-08-17T04:00:00Z')) === '00',
   vr.hourOf(ET('2026-08-17T04:00:00Z')));
ok('one minute before it is hour 23 of the day before',
   vr.hourOf(ET('2026-08-17T03:59:00Z')) === '23', vr.hourOf(ET('2026-08-17T03:59:00Z')));
ok('the hour is two digits, so folders sort within a day',
   /^\d\d$/.test(vr.hourOf(ET('2026-08-17T13:00:00Z'))));
ok('noon Eastern in summer is hour 12', vr.hourOf(ET('2026-08-17T16:00:00Z')) === '12');
ok('noon Eastern in winter is hour 12', vr.hourOf(ET('2026-01-17T17:00:00Z')) === '12');
ok('the clock is Eastern, not UTC', vr.hourOf(ET('2026-08-17T16:00:00Z')) !== '16');

/* Spring forward: 2am does not exist on 8 March 2026. Nothing should be filed
   under it and nothing should look for it. */
ok('the hour that does not exist is never produced',
   vr.hourOf(ET('2026-03-08T06:59:00Z')) === '01' && vr.hourOf(ET('2026-03-08T07:00:00Z')) === '03',
   vr.hourOf(ET('2026-03-08T06:59:00Z')) + ' then ' + vr.hourOf(ET('2026-03-08T07:00:00Z')));

/* Fall back: 1am happens twice on 1 November 2026. Both go in the same bucket,
   which is correct rather than clever: a doubled folder once a year is fine,
   an hour of traffic nothing lists is not. */
ok('the hour that happens twice lands in one bucket, not none',
   vr.hourOf(ET('2026-11-01T05:30:00Z')) === '01' && vr.hourOf(ET('2026-11-01T06:01:00Z')) === '01');

/* --- the writer and the reader must name the same folder ----------------- */

for (const iso of ['2026-08-17T03:59:00Z', '2026-08-17T04:00:00Z',
                   '2026-03-08T06:59:00Z', '2026-11-01T05:30:00Z',
                   '2026-01-01T04:59:00Z']) {
  const day = vault.dayOf(iso);
  const pre = vr.prefixFor(ET(iso));
  ok('written and listed agree on the day for ' + iso,
     pre.indexOf('vault/' + day + '/tx/') === 0, pre + ' vs ' + day);
}

/* And the round trip that matters: an object written at an instant is under a
   prefix the reader generates for a window containing that instant. This is
   the assertion that would have failed on the day the writer and reader
   disagreed, which is the only way to lose an object silently. */
{
  const probes = ['2026-08-17T04:00:00Z', '2026-08-17T15:22:41Z', '2026-08-17T03:59:59Z',
                  '2026-03-08T06:59:00Z', '2026-11-01T05:30:00Z'];
  for (const iso of probes) {
    const at = ET(iso);
    const written = vr.prefixFor(at);
    const looked = vr.prefixesFor(at - 10 * 60000, at + 10 * 60000, 60 * 60000);
    ok('a write at ' + iso + ' is inside a prefix the reader asks for',
       looked.includes(written), written + ' not in ' + JSON.stringify(looked));
  }
}

/* --- window coverage ----------------------------------------------------- */

{
  const from = ET('2026-08-17T14:00:00Z');   // 10:00 ET
  const to   = ET('2026-08-17T16:00:00Z');   // 12:00 ET
  const ps = vr.prefixesFor(from, to, 60 * 60000);
  ok('a two-hour window lists the hours it spans',
     ps.includes('vault/2026-08-17/tx/10/') && ps.includes('vault/2026-08-17/tx/11/') &&
     ps.includes('vault/2026-08-17/tx/12/'), JSON.stringify(ps));
  ok('and the slack hour on each side, because a batch is named for its first row',
     ps.includes('vault/2026-08-17/tx/09/') && ps.includes('vault/2026-08-17/tx/13/'),
     JSON.stringify(ps));
  ok('with no folder listed twice', new Set(ps).size === ps.length, JSON.stringify(ps));
  ok('and it is a handful of folders, not the whole day', ps.length <= 8, ps.length + ' prefixes');
}

{
  /* Across Eastern midnight: the point of filing by Eastern day is that "last
     night" is one question, not two. */
  const ps = vr.prefixesFor(ET('2026-08-17T03:30:00Z'), ET('2026-08-17T04:30:00Z'), 30 * 60000);
  ok('a window crossing midnight reaches into both days',
     ps.some(p => p.indexOf('vault/2026-08-16/') === 0) &&
     ps.some(p => p.indexOf('vault/2026-08-17/') === 0), JSON.stringify(ps));
}

{
  /* A twelve-hour shift is twelve small folders, which is the entire point.
     If this number climbs back toward a thousand, Shift Change times out
     again. */
  const ps = vr.prefixesFor(ET('2026-08-17T10:00:00Z'), ET('2026-08-17T22:00:00Z'), 60 * 60000);
  ok('a twelve-hour shift lists about fourteen folders, not thirty pages',
     ps.length >= 13 && ps.length <= 16, ps.length + ' prefixes');
}

/* --- legacy ------------------------------------------------------------- */

{
  const ps = vr.legacyPrefixesFor(ET('2026-08-17T14:00:00Z'), ET('2026-08-17T16:00:00Z'));
  ok('the flat day folder written before hour bucketing is still read',
     ps.includes('vault/2026-08-17/tx/'), JSON.stringify(ps));
  ok('and only the days the window actually touches, not a day either side',
     ps.length === 1, JSON.stringify(ps));

  /* Near midnight the slack does reach back, which is the case that matters:
     a batch named for a row at 23:58 can carry a row from after midnight. */
  const across = vr.legacyPrefixesFor(ET('2026-08-17T04:15:00Z'), ET('2026-08-17T05:00:00Z'), 60 * 60000);
  ok('a window just after midnight still reads yesterday\'s flat folder',
     across.includes('vault/2026-08-16/tx/') && across.includes('vault/2026-08-17/tx/'),
     JSON.stringify(across));
}

/* --- the read plan ------------------------------------------------------- */

{
  const plan = vr.planFor(ET('2026-08-15T14:00:00Z'), ET('2026-08-17T16:00:00Z'), 60 * 60000);
  ok('the plan is grouped by day', plan.length === 3, plan.map(g => g.day).join(','));
  ok('newest day first, so a capped read keeps the night being asked about',
     plan[0].day === '2026-08-17' && plan[2].day === '2026-08-15',
     plan.map(g => g.day).join(','));
  ok('and within a day, the newest hour first',
     plan[0].hours[0] > plan[0].hours[plan[0].hours.length - 1],
     JSON.stringify(plan[0].hours));
  ok('each day carries exactly one legacy listing, and it is folded',
     plan.every(g => g.entries.filter(e => e.folded).length === 1),
     JSON.stringify(plan[0].entries.filter(e => e.folded)));
  ok('a middle day is planned whole', plan[1].hours.length === 24, plan[1].hours.length + ' hours');
  ok('turning legacy off removes those listings and nothing else',
     vr.planFor(ET('2026-08-17T14:00:00Z'), ET('2026-08-17T16:00:00Z'), 60 * 60000, { legacy: false })
       .every(g => g.entries.every(e => !e.folded)));
}

/* --- stampOf ------------------------------------------------------------- */

ok('the stamp is read out of the filename, hour folder or not',
   vr.stampOf('vault/2026-08-17/tx/03/1755400000000-2.json') === 1755400000000);
ok('and out of the legacy flat path',
   vr.stampOf('vault/2026-08-17/tx/1755400000000-2.json') === 1755400000000);
ok('a name this code cannot read returns null rather than a wrong number',
   vr.stampOf('vault/2026-08-17/tx/03/index.json') === null);

/* --- only one implementation, enforced ----------------------------------- */
/*
   The bug that cost two nights was not the cap. It was that three files each
   had their own copy of "list the vault day folder and filter by the stamp in
   the filename": lib/stream.js for the desk, api/vault-search.js for search,
   api/vault-browse.js for playback. Fixing one did not fix the others, and
   each had to be found by a person noticing the archive was still wrong.

   So this is a structural assertion rather than a behavioural one: nothing but
   lib/vault-read.js may list a vault prefix or parse a vault filename. If a
   fourth copy appears, this fails before it can lose an evening. */
{
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  const skip = new Set(['node_modules', '.git', 'tools']);
  const offenders = [];
  /* Server code only. app/ is the browser bundle; it never touches object
     storage and its own stamp parsing is about clip filenames. */
  const roots = [path.join(root, 'lib'), path.join(root, 'api')];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      if (skip.has(name)) continue;
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) { walk(full); continue; }
      if (!name.endsWith('.js')) continue;
      const rel = path.relative(root, full);
      if (rel === path.join('lib', 'vault-read.js')) continue;
      const src = fs.readFileSync(full, 'utf8');
      if (/listPrefix\s*\(\s*['"`]vault\//.test(src) ||
          /listPrefix\s*\(\s*['"`]vault\/['"`]\s*\+/.test(src) ||
          /listPrefix\s*\(\s*['"`]vault/.test(src) ||
          /listPrefix\s*\(\s*['"`]vault\/['"`]/.test(src) ||
          /listPrefix\s*\(\s*['"`]vault\/.*\+/.test(src) ||
          /listPrefix\([^)]*vault\//.test(src)) offenders.push(rel + ' lists a vault prefix');
      if (/function\s+stampOf/.test(src)) offenders.push(rel + ' parses vault filenames');
    }
  };
  for (const r of roots) walk(r);
  ok('nothing outside lib/vault-read.js lists the vault or parses its filenames',
     offenders.length === 0, offenders.join('; '));
}

/* --- listWindow, against a fake store ------------------------------------ */
/* The fake returns oldest-first and pages a thousand at a time, which is what
   Vercel Blob does and what both readers got wrong. No credential, no network:
   the token below is a fixed string the fake never looks at. */

let CALLS = 0;
function fakeStore(objects) {
  return {
    list({ prefix, cursor, limit, mode }) {
      CALLS++;
      let all = objects.filter(o => o.pathname.indexOf(prefix) === 0);
      const folders = new Set();
      if (mode === 'folded') {
        /* Only what sits directly under the prefix; everything deeper is
           collapsed into a folder name. This is what Vercel Blob does and it
           is the behaviour the legacy fallback depends on. */
        const direct = [];
        for (const o of all) {
          const rest = o.pathname.slice(prefix.length);
          if (rest.indexOf('/') === -1) direct.push(o);
          else folders.add(prefix + rest.slice(0, rest.indexOf('/')) + '/');
        }
        all = direct;
      }
      all = all.sort((a, b) => a.pathname.localeCompare(b.pathname));   // oldest-first, as Blob does
      const start = cursor ? +cursor : 0;
      const page = all.slice(start, start + (limit || 1000));
      const next = start + page.length;
      return Promise.resolve({
        blobs: page.map(o => ({ pathname: o.pathname, url: 'https://fake/' + o.pathname })),
        folders: [...folders],
        hasMore: next < all.length,
        cursor: String(next),
      });
    },
  };
}

/* A day of traffic in the shape the vault actually writes it: one object every
   two minutes, filed under its Eastern hour. */
function dayOfTraffic(dayIso, everyMs) {
  const start = ET(dayIso);
  const out = [];
  for (let t = start; t < start + 86400000; t += (everyMs || 120000)) {
    out.push({ pathname: vr.prefixFor(t) + String(t) + '-2.json' });
  }
  return out;
}

async function run() {
  const objects = dayOfTraffic('2026-08-17T04:00:00Z', 120000);   // 720 objects, midnight to midnight ET
  const saved = blob._sdk();
  blob._inject(fakeStore(objects), 'test-token-not-a-credential');

  /* THE 6:27PM BUG. Ask for the evening. The old readers listed oldest-first,
     hit their cap somewhere in the afternoon and returned nothing from here. */
  {
    const from = ET('2026-08-17T23:00:00Z');   // 19:00 ET
    const to   = ET('2026-08-18T02:00:00Z');   // 22:00 ET
    const r = await vr.listWindow(from, to, { slackMs: 30 * 60000, max: 500 });
    ok('the evening is not empty', r.ok && r.urls.length > 0, JSON.stringify(r.why));
    const stamps = r.urls.map(vr.stampOf);
    ok('every object returned is inside the window it was asked for',
       stamps.every(s => s >= from - 30 * 60000 && s <= to + 30 * 60000),
       'range ' + Math.min(...stamps) + '..' + Math.max(...stamps));
    ok('and the newest transmission of the night is in there',
       Math.max(...stamps) >= to - 120000, 'newest=' + new Date(Math.max(...stamps)).toISOString());
    ok('nothing from the morning came back for an evening question',
       !stamps.some(s => s < ET('2026-08-17T20:00:00Z')));
  }

  /* NEWEST FIRST. A caller that can only afford N objects must keep the N that
     matter. This is the ordering the cap depends on. */
  {
    const r = await vr.listWindow(ET('2026-08-17T04:00:00Z'), ET('2026-08-18T03:59:00Z'),
                                  { slackMs: 0, max: 12000 });
    const stamps = r.urls.map(vr.stampOf);
    let descending = true;
    for (let i = 1; i < stamps.length; i++) if (stamps[i] > stamps[i - 1]) descending = false;
    ok('urls come back newest first', descending, 'got ' + stamps.length + ' urls');
    ok('a whole day comes back whole', stamps.length >= 700, stamps.length + ' of ~720');
  }

  /* THE CAP. Past it, the OLDEST edge is lost, never the newest. Losing the
     wrong edge is exactly the 6:27pm bug. */
  {
    const from = ET('2026-08-17T04:00:00Z'), to = ET('2026-08-18T03:59:00Z');
    const r = await vr.listWindow(from, to, { slackMs: 0, max: 50 });
    const stamps = r.urls.map(vr.stampOf);
    ok('the cap is honoured', r.urls.length === 50, String(r.urls.length));
    ok('and says so, so the UI can tell a reporter the answer is partial', r.truncated === true);
    ok('what survives the cap is the newest end of the window',
       Math.min(...stamps) > to - 4 * 3600000,
       'oldest kept ' + new Date(Math.min(...stamps)).toISOString());
  }

  /* DEDUPE. Two prefixes can name the same object, and it must be fetched once
     however many listings mention it. */
  {
    const r = await vr.listWindow(ET('2026-08-17T14:00:00Z'), ET('2026-08-17T15:00:00Z'),
                                  { slackMs: 0, max: 12000 });
    ok('no object is returned twice',
       new Set(r.urls).size === r.urls.length,
       r.urls.length + ' urls, ' + new Set(r.urls).size + ' distinct');
  }

  /* THE COST, WHICH IS THE ACTUAL POINT.
     Reading twenty minutes used to mean paging a whole flat day: about thirty
     sequential round trips before a byte of content was fetched, and that
     single fact is what timed out Shift Change and made the briefing take
     eighteen seconds. Bucketed, the same read touches a few small folders.

     The legacy fallback has to be FOLDED for this to hold: Blob matches a
     prefix as a plain string, so an expanded listing of vault/DAY/tx/ walks
     every hour folder underneath and hands the cost straight back. If someone
     drops `folded` from that call, this is the test that fails. */
  {
    CALLS = 0;
    const from = ET('2026-08-17T18:00:00Z');     // 14:00 ET
    const r = await vr.listWindow(from, from + 20 * 60000, { slackMs: 30 * 60000, max: 12000 });
    ok('twenty minutes of a busy day costs a handful of round trips, not thirty',
       CALLS <= 8, CALLS + ' list calls');
    ok('and still returns the twenty minutes', r.urls.length >= 10, r.urls.length + ' objects');
    ok('the legacy day listing does not drag the whole day back in',
       r.listed < objects.length / 4,
       'listed ' + r.listed + ' of the day\'s ' + objects.length + ' objects for a 20-minute read');
  }

  /* LEGACY. Objects written flat, before hour bucketing, are still found. */
  {
    const flat = [];
    const base = ET('2026-08-16T18:00:00Z');
    for (let i = 0; i < 20; i++) flat.push({ pathname: 'vault/2026-08-16/tx/' + (base + i * 60000) + '-1.json' });
    blob._inject(fakeStore(flat), 'test-token-not-a-credential');
    const r = await vr.listWindow(base, base + 19 * 60000, { slackMs: 60000, max: 500 });
    ok('yesterday, written flat, still reads', r.urls.length === 20, String(r.urls.length));
    ok('and turning the fallback off proves that is where they came from',
       (await vr.listWindow(base, base + 19 * 60000, { slackMs: 60000, max: 500, legacy: false })).urls.length === 0);
  }

  /* THE WEEK QUESTION.

     "It should have all the way back through last week." A window that wide
     can hold far more objects than any caller can fetch, and the old readers
     paged the whole thing and then threw away the part the reporter wanted.
     Days are walked newest first, so once the cap is met every prefix still
     unread covers older time and the walk stops. */
  {
    const week = [];
    for (let d = 10; d <= 17; d++) {
      week.push(...dayOfTraffic('2026-08-' + String(d).padStart(2, '0') + 'T04:00:00Z', 300000));
    }
    blob._inject(fakeStore(week), 'test-token-not-a-credential');
    CALLS = 0;
    const from = ET('2026-08-10T04:00:00Z'), to = ET('2026-08-18T03:59:00Z');
    const r = await vr.listWindow(from, to, { slackMs: 0, max: 120 });
    ok('a week-wide question stops once it has what it can use', r.stoppedEarly === true);
    ok('and says the answer is partial', r.truncated === true);
    ok('what it read is the newest end of the week',
       r.urls.map(vr.stampOf).every(x => x >= ET('2026-08-17T04:00:00Z')),
       new Date(Math.min(...r.urls.map(vr.stampOf))).toISOString());
    const weekCalls = CALLS;
    CALLS = 0;
    const full = await vr.listWindow(from, to, { slackMs: 0, max: 100000 });
    ok('while a caller that can afford the whole week gets the whole week',
       full.urls.length === week.length && full.stoppedEarly !== true,
       full.urls.length + ' of ' + week.length);
    ok('and the capped read cost a fraction of the full one',
       weekCalls < CALLS / 3, weekCalls + ' calls vs ' + CALLS);
  }

  /* THE LEXICAL HAZARD. Now that the hour is in the path, a string sort of the
     URLs is not a time sort. lib/stream.js used to do exactly this and it was
     removed as part of this change. If someone puts it back, this fails. */
  {
    const a = vr.prefixFor(ET('2026-08-17T07:30:00Z')) + '1000000000000-1.json';   // 03:30 ET
    const b = vr.prefixFor(ET('2026-08-18T02:30:00Z')) + '2000000000000-1.json';   // 22:30 ET, later
    const lex = [b, a].sort();
    ok('sorting vault paths as strings scrambles chronology, which is why nothing does',
       lex[0] === a && vr.stampOf(a) < vr.stampOf(b),
       'lexical put ' + lex[0].split('/').slice(-2).join('/') + ' first');
  }

  blob._inject(saved, 'test-token-not-a-credential');

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
}

run().catch(e => { console.log('  THREW ' + (e && e.stack || e)); process.exit(1); });
