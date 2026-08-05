// tools/test-freshness.js
//
// Drives app/freshness.js with no browser.
//
// The case this file exists for is the one at the bottom of the first section:
// a payload where every feed says "live" and the newest audio is twenty hours
// old. That is what the board actually served on August 3, and it read as
// healthy for the whole day. If that assertion ever goes green as 'live'
// again, the header is lying again.
//
// The other case worth guarding is its opposite. Boston Fire at four in the
// morning is silent for an hour and is perfectly fine, so a long gap in speech
// must never be reported as an outage.
//
//   node tools/test-freshness.js

const F = require('../app/freshness.js');
const { QUIET_MS, STALE_MS, DARK_MS } = F._consts;

let pass = 0, fail = 0;
function head(s) { console.log('\n' + s); }
function ok(label, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + label); return; }
  fail++;
  console.log('  FAIL ' + label + (extra === undefined ? '' : '\n         ' + JSON.stringify(extra)));
}
const eq = (label, got, want) => ok(label + '  =  ' + JSON.stringify(got),
  JSON.stringify(got) === JSON.stringify(want), { got, want });

const NOW = 1800000000000;                      // a fixed clock, no Date.now()
const SEC = 1000, MIN = 60000, HR = 3600000;
const ago = (ms) => new Date(NOW - ms).toISOString();

/* Audio and speech default to fresh, so each case below only has to state the
   one thing it is actually about. */
const feed = (o) => Object.assign(
  { id: 'bpd', label: 'Boston Police', status: 'live', lastAudioAt: ago(3 * SEC), lastSegAt: ago(20 * SEC) },
  o || {});
const pipe = (feeds) => ({ generatedAt: ago(0), feeds: feeds, stats: {} });
const v = (feeds) => F.verdict(pipe(feeds), NOW);

// ---------------------------------------------------------------------------
head('the outage that started this');
{
  /* Six feeds, every one of them claiming live, every one of them last heard
     from at 3:16 in the morning. The header said "live, updated 08:27 AM". */
  const dead = [];
  for (let i = 0; i < 6; i++) {
    dead.push(feed({ id: 'f' + i, lastAudioAt: ago(20.2 * HR), lastSegAt: ago(20.2 * HR) }));
  }
  const got = v(dead);
  eq('twenty hours of nothing is not live', got.level, 'dark');
  ok('and the headline carries the age', /20\.2h/.test(got.text), got.text);
  ok('the detail names the relay, which is the thing to go restart',
    /relay/i.test(got.detail), got.detail);
  eq('the age is reported in ms too', Math.round(got.ageMs / HR * 10) / 10, 20.2);
}

// ---------------------------------------------------------------------------
head('quiet is not broken');
{
  /* The opposite mistake. If this ever reports an outage, the overnight desk
     learns to ignore the pill, and then the pill is worth nothing. */
  const nightWatch = v([feed({ label: 'Boston Fire', lastAudioAt: ago(4 * SEC), lastSegAt: ago(55 * MIN) })]);
  eq('an hour of no transmissions on a working feed', nightWatch.level, 'quiet');
  ok('and it says how long the quiet has run', /55m|1\.0h/.test(nightWatch.text), nightWatch.text);
  ok('the detail says the audio is still arriving',
    /arriving/i.test(nightWatch.detail), nightWatch.detail);

  eq('audio arriving with nothing transcribed yet is quiet, not dark',
    v([feed({ lastSegAt: null })]).level, 'quiet');
  eq('everything current is live', v([feed({})]).level, 'live');
}

// ---------------------------------------------------------------------------
head('the levels in between');
{
  eq('no feeds at all', v([]).level, 'dark');
  eq('and it says so plainly', v([]).text, 'no feeds');
  eq('feeds that have never reported audio', v([feed({ lastAudioAt: null, lastSegAt: null })]).level, 'dark');

  eq('one feed offline out of three', v([
    feed({ id: 'a' }), feed({ id: 'b' }), feed({ id: 'c', status: 'offline' }),
  ]).text, '1 of 3 offline');
  eq('every feed offline', v([feed({ status: 'offline' }), feed({ id: 'b', status: 'offline' })]).level, 'dark');
}

// ---------------------------------------------------------------------------
head('what counts as a feed being up');
{
  /* A feed mid reconnect is still trying, and calling that degraded would make
     the pill flap every time a Broadcastify stream hiccups. The audio clock is
     the backstop for one that never comes back. */
  ['live', 'connected', 'connecting', 'reconnecting'].forEach((s) => {
    eq('status ' + s + ' is not a fault', v([feed({ status: s })]).offline, 0);
  });
  eq('status offline is', v([feed({ status: 'offline' })]).offline, 1);
  eq('OFFLINE in caps is too', v([feed({ status: 'OFFLINE' })]).offline, 1);
  /* A record with no status is not a working feed. Letting a missing field
     read as healthy is how you get a green pill over a dead machine. */
  eq('and a record with no status at all', v([feed({ status: undefined })]).offline, 1);
}

// ---------------------------------------------------------------------------
head('where the lines fall');
{
  const audio = (ms) => v([feed({ lastAudioAt: ago(ms), lastSegAt: ago(ms) })]).level;
  /* Both clocks move together here, because speech cannot be newer than the
     audio it was transcribed from. Nine minutes is still inside every line. */
  eq('just inside the stale line', audio(STALE_MS - MIN), 'live');
  eq('just past it', audio(STALE_MS + MIN), 'stale');
  eq('just inside the dark line', audio(DARK_MS - MIN), 'stale');
  eq('just past it', audio(DARK_MS + MIN), 'dark');

  const spoke = (ms) => v([feed({ lastSegAt: ago(ms) })]).level;
  eq('just inside the quiet line', spoke(QUIET_MS - MIN), 'live');
  eq('just past it', spoke(QUIET_MS + MIN), 'quiet');
}

// ---------------------------------------------------------------------------
head('reading the timestamps the relay actually writes');
{
  /* These have been ISO strings and epoch numbers at different points, and a
     feed with no audio yet writes null. Anything unreadable has to land on 0,
     because a NaN in here silently poisons every comparison after it. */
  eq('an ISO string', F.parseAt('2027-01-15T12:00:00.000Z'), Date.parse('2027-01-15T12:00:00.000Z'));
  eq('an epoch number', F.parseAt(NOW), NOW);
  [null, undefined, '', 0, -5, NaN, 'soon', {}, []].forEach((bad) => {
    eq('junk reads as zero: ' + JSON.stringify(bad === undefined ? 'undefined' : bad), F.parseAt(bad), 0);
  });

  eq('the newest wins', F.newest([
    { lastAudioAt: ago(5 * MIN) }, { lastAudioAt: ago(1 * MIN) }, { lastAudioAt: null },
  ], 'lastAudioAt'), NOW - MIN);
  eq('no feeds, no timestamp', F.newest([], 'lastAudioAt'), 0);
  eq('one live scanner is enough to prove the relay is talking',
    F.verdict(pipe([feed({ id: 'a', lastAudioAt: ago(20 * HR) }), feed({ id: 'b' })]), NOW).level, 'live');
}

// ---------------------------------------------------------------------------
head('how long ago reads');
{
  eq('seconds', F.phrase(45 * SEC), '45s');
  eq('the last second before minutes', F.phrase(89 * SEC), '89s');
  eq('minutes', F.phrase(90 * SEC), '2m');
  eq('still minutes at an hour and a half', F.phrase(89 * MIN), '89m');
  eq('hours, with a decimal so 20.2 is not 20', F.phrase(90 * MIN), '1.5h');
  eq('two days', F.phrase(49 * HR), '2d');
  eq('a clock skew on the viewing machine does not print a negative',
    F.phrase(-4000), '0s');
}

// ---------------------------------------------------------------------------
head('the line under the header');
{
  /* Whatever else it says, it says how old the audio is. That is the one fact
     that would have caught August 3, so no branch is allowed to drop it. */
  eq('normal', F.stamp(pipe([feed({})]), NOW), 'audio 3s ago');
  eq('the outage', F.stamp(pipe([feed({ lastAudioAt: ago(20.2 * HR) })]), NOW), 'audio 20.2h ago');
  eq('nothing yet', F.stamp(pipe([feed({ lastAudioAt: null })]), NOW), 'no audio yet');
  eq('no feeds at all', F.stamp(pipe([]), NOW), 'no audio yet');

  ok('and it never reads like a wall clock',
    !/AM|PM|:/.test(F.stamp(pipe([feed({})]), NOW)));
}

// ---------------------------------------------------------------------------
head('nothing throws on a payload that is missing pieces');
{
  [undefined, null, {}, { feeds: null }, { feeds: 'six' }, { feeds: [null, undefined] }].forEach((p) => {
    let threw = null;
    try { F.verdict(p, NOW); F.stamp(p, NOW); } catch (e) { threw = e.message; }
    ok('survives ' + JSON.stringify(p === undefined ? 'undefined' : p), threw === null, threw);
  });
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
