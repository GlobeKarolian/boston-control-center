// tools/test-alerts.js
//
// Drives the decision half of app/alerts.js with no browser. Everything that
// decides whether a room full of people gets interrupted is in decide(), so
// that is what gets tested. The oscillators are not interesting; the rule that
// an unclear situation never makes a noise is.
//
//   node tools/test-alerts.js

const A = require('../app/alerts.js');
const { REARM_MS, FLOOR_MS, STALE_MS, MAX_SEEN } = A._consts;

let pass = 0, fail = 0, section = '';
function head(s) { section = s; console.log('\n' + s); }
function ok(label, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + label); return; }
  fail++;
  console.log('  FAIL ' + label + (extra === undefined ? '' : '\n         ' + JSON.stringify(extra)));
}
const eq = (label, got, want) => ok(label + '  =  ' + JSON.stringify(got), JSON.stringify(got) === JSON.stringify(want), { got, want });

const sit = (o) => Object.assign({
  id: 'x', alertKey: 'k', headline: 'A thing happened', type: 'other',
  priority: 'normal', confidence: 'reported', location: 'Boston',
}, o);

const HIGH = (k) => sit({ id: k, alertKey: k, priority: 'high', type: 'water rescue', location: 'Tobin Bridge', headline: 'Person in the water' });
const NORM = (k) => sit({ id: k, alertKey: k });
const VAGUE = (k) => sit({ id: k, alertKey: k, priority: 'high', confidence: 'unclear', headline: 'Possible shots, unconfirmed' });

const T0 = 1800000000000;                       // a fixed clock, no Date.now()

// A page that has already taken its opening board and gone quiet, which is the
// state nearly every rule below is about. RAW() is the page at the instant it
// loads, and only the priming section wants that.
const RAW = () => { const s = A._freshState(); s.started = T0; return s; };
const S = () => { const s = RAW(); s.primed = true; return s; };
const good = { ok: true };

// ---------------------------------------------------------------------------
head('opening the page does not replay the backlog');
{
  const st = RAW();
  const d = A._decide(st, [HIGH('a'), HIGH('b'), NORM('n')], good, T0, 'high');
  eq('the board that was already there makes no sound', d.cue, null);
  eq('and raises nothing with the operating system', d.notify, null);
  eq('none of it is reported as new', d.fresh.length, 0);
  eq('but all of it is remembered', Object.keys(st.seen).sort(), ['a', 'b', 'n']);
  ok('and the page is now armed', st.primed === true);
  const next = A._decide(st, [HIGH('a'), HIGH('b'), NORM('n'), HIGH('c')], good, T0 + FLOOR_MS + 1, 'high');
  eq('so the first thing to land after that does ring', next.cue, 'high');
  eq('and only that one', next.fresh.map((s) => s.alertKey), ['c']);
}

head('an empty board still counts as the opening one');
{
  // Otherwise a quiet morning leaves the page unarmed, and the priming pass
  // eats the first real situation of the day instead of announcing it.
  const st = RAW();
  eq('nothing to say about nothing', A._decide(st, [], good, T0, 'high').cue, null);
  ok('but it armed anyway', st.primed === true);
  eq('so the first card of the day rings', A._decide(st, [HIGH('a')], good, T0 + FLOOR_MS + 1, 'high').cue, 'high');
}

head('a page that opens onto a dead feed arms on the board, not the clock');
{
  // The stale path returns before priming, so an outage at load cannot spend
  // the arming pass on a board we never received.
  const st = RAW();
  const d = A._decide(st, null, { ok: false }, T0 + STALE_MS + 1000, 'high');
  eq('the outage is announced', d.cue, 'stale');
  ok('and it is still unarmed, because no board ever arrived', st.primed === false);
  const back = A._decide(st, [HIGH('a')], good, T0 + STALE_MS + 60000, 'high');
  eq('the board that comes back is a baseline, not news', back.cue, null);
  eq('what lands after it is news', A._decide(st, [HIGH('a'), HIGH('b')], good, T0 + STALE_MS + 120000, 'high').cue, 'high');
}

head('an unclear card on the opening board can still ring when it firms up');
{
  const st = RAW();
  A._decide(st, [VAGUE('v')], good, T0, 'high');
  eq('priming skipped it, same as every other pass', Object.keys(st.seen), []);
  const d = A._decide(st, [sit({ id: 'v', alertKey: 'v', priority: 'high', confidence: 'reported' })], good, T0 + 60000, 'high');
  eq('so confirmation is heard', d.cue, 'high');
}

// ---------------------------------------------------------------------------
head('a high-priority situation gets a sound and a notification');
{
  const st = S();
  const d = A._decide(st, [HIGH('a')], good, T0, 'high');
  eq('the cue', d.cue, 'high');
  ok('there is a notification', !!d.notify);
  eq('titled with the headline', d.notify.title, 'Person in the water');
  eq('and bodied with type and place', d.notify.body, 'water rescue / Tobin Bridge');
  eq('tagged on the alertKey so the OS collapses repeats', d.notify.tag, 'a');
  eq('one thing was new', d.fresh.length, 1);
}

head('and does not do it twice for the same thing');
{
  const st = S();
  A._decide(st, [HIGH('a')], good, T0, 'high');
  const d = A._decide(st, [HIGH('a')], good, T0 + 30000, 'high');
  eq('no second cue', d.cue, null);
  eq('no second notification', d.notify, null);
  eq('and nothing counted as new', d.fresh.length, 0);
}

head('a different situation does ring, once the floor has passed');
{
  const st = S();
  A._decide(st, [HIGH('a')], good, T0, 'high');
  const soon = A._decide(st, [HIGH('a'), HIGH('b')], good, T0 + 1000, 'high');
  eq('inside the floor, no sound', soon.cue, null);
  ok('but it was still counted as new', soon.fresh.length === 1);
  const later = A._decide(st, [HIGH('a'), HIGH('b'), HIGH('c')], good, T0 + FLOOR_MS + 1, 'high');
  eq('past the floor, it rings', later.cue, 'high');
}

head('a burst is one story, so it is one sound');
{
  const st = S();
  const d = A._decide(st, [HIGH('a'), HIGH('b'), HIGH('c'), HIGH('d'), HIGH('e')], good, T0, 'high');
  eq('one cue', d.cue, 'high');
  eq('five marked new', d.fresh.length, 5);
  eq('and all five remembered, so none comes back later pretending to be new',
    Object.keys(st.seen).sort(), ['a', 'b', 'c', 'd', 'e']);
}

// ---------------------------------------------------------------------------
head('an unclear situation never makes a noise');
{
  const st = S();
  const d = A._decide(st, [VAGUE('v')], good, T0, 'all');
  eq('no cue even on high priority', d.cue, null);
  eq('no notification', d.notify, null);
  eq('and it is not even counted as new', d.fresh.length, 0);
  eq('it is not remembered either, so it can ring later if it firms up',
    Object.keys(st.seen), []);
}

head('and it does not drown out a real one sitting next to it');
{
  const st = S();
  const d = A._decide(st, [VAGUE('v'), HIGH('a')], good, T0, 'high');
  eq('the real one rings', d.cue, 'high');
  eq('only the real one is new', d.fresh.map((s) => s.alertKey), ['a']);
  eq('and the notification is about the real one', d.notify.tag, 'a');
}

head('the same situation, once it is no longer unclear');
{
  const st = S();
  A._decide(st, [VAGUE('v')], good, T0, 'high');
  const d = A._decide(st, [sit({ id: 'v', alertKey: 'v', priority: 'high', confidence: 'reported' })], good, T0 + 60000, 'high');
  eq('now it rings', d.cue, 'high');
}

// ---------------------------------------------------------------------------
head('what each mode actually does');
{
  const off = S(), hi = S(), all = S();
  eq('off: a high situation makes no sound', A._decide(off, [HIGH('a')], good, T0, 'off').cue, null);
  eq('high: a normal situation makes no sound', A._decide(hi, [NORM('n')], good, T0, 'high').cue, null);
  eq('all: a normal situation blips', A._decide(all, [NORM('n')], good, T0, 'all').cue, 'new');
  eq('all: a high situation still gets the high cue', A._decide(all, [HIGH('a')], good, T0 + FLOOR_MS + 1, 'all').cue, 'high');
}

head('a routine situation never raises a desktop notification');
{
  // The sound and the notification are separate promises. 'all' mode says you
  // want to hear a blip when something opens. It does not say you want the
  // operating system to stack a card in the corner of your screen for every
  // fender bender, which is the behaviour that gets notifications revoked at
  // the browser level, taking the high-priority ones down with them.
  const st = S();
  const d = A._decide(st, [NORM('n1'), NORM('n2')], good, T0, 'all');
  eq('it blips', d.cue, 'new');
  eq('and says nothing to the OS', d.notify, null);
  const mixed = A._decide(st, [NORM('n3'), HIGH('h1')], good, T0 + FLOOR_MS + 1, 'all');
  ok('a high one in the same batch does notify', !!mixed.notify);
  eq('and the notification is about the high one, not the first in the list',
    mixed.notify.tag, 'h1');
}

head('turning the sound on does not dump the backlog');
{
  const st = S();
  A._decide(st, [HIGH('a'), HIGH('b')], good, T0, 'off');
  eq('they were remembered while it was off', Object.keys(st.seen).sort(), ['a', 'b']);
  const d = A._decide(st, [HIGH('a'), HIGH('b')], good, T0 + 60000, 'high');
  eq('so switching on says nothing about what was already on screen', d.cue, null);
}

head('a normal situation seen while quiet does not ring on the way to loud');
{
  const st = S();
  A._decide(st, [NORM('n')], good, T0, 'high');
  const d = A._decide(st, [NORM('n')], good, T0 + 60000, 'all');
  eq('it was already on the board, so no', d.cue, null);
}

// ---------------------------------------------------------------------------
head('the same corner, much later, is a new story');
{
  const st = S();
  A._decide(st, [HIGH('a')], good, T0, 'high');
  const before = A._decide(st, [HIGH('a')], good, T0 + REARM_MS - 1000, 'high');
  eq('just inside the window, still quiet', before.cue, null);
  const after = A._decide(st, [HIGH('a')], good, T0 + REARM_MS + 1000, 'high');
  eq('past it, it rings again', after.cue, 'high');
}

// ---------------------------------------------------------------------------
head('silence has to be trustworthy, so the feed going dark is a sound');
{
  const st = S();
  A._decide(st, [HIGH('a')], good, T0, 'high');
  const early = A._decide(st, null, { ok: false }, T0 + 60000, 'high');
  eq('one failed poll is not an outage', early.cue, null);
  const late = A._decide(st, null, { ok: false }, T0 + STALE_MS + 1000, 'high');
  eq('three minutes of it is', late.cue, 'stale');
  ok('and it says so', late.stale === true);
  eq('with a notification of its own', late.notify && late.notify.tag, 'bcc-stale');
  const again = A._decide(st, null, { ok: false }, T0 + STALE_MS + 90000, 'high');
  eq('it does not nag', again.cue, null);
}

head('and it re-arms when the feed comes back');
{
  const st = S();
  A._decide(st, null, { ok: false }, T0 + STALE_MS + 1000, 'high');
  ok('it fired once', st.staleFired === true);
  A._decide(st, [], good, T0 + STALE_MS + 2000, 'high');
  ok('a good poll clears it, silently', st.staleFired === false);
  const d = A._decide(st, null, { ok: false }, T0 + STALE_MS * 2 + 5000, 'high');
  eq('so the next outage is heard too', d.cue, 'stale');
}

head('a board that parses fine but stopped advancing is also dark');
{
  const st = S();
  const stale = { ok: true, at: new Date(T0 - STALE_MS - 60000).toISOString() };
  const d = A._decide(st, [HIGH('a')], stale, T0, 'high');
  eq('the fetch worked, so the cue is not high', d.cue, 'stale');
  eq('and nothing off an old board counts as new', d.fresh.length, 0);
  eq('nor is it remembered, so it rings properly when the feed recovers',
    Object.keys(st.seen), []);
  ok('and it says so on the very first poll, with no grace window, because '
    + 'the board told us its own age rather than us having to infer it',
    A._decide(S(), [HIGH('a')], stale, T0, 'high').cue === 'stale');
  eq('while a failed fetch at that same instant still gets its grace',
    A._decide(S(), null, { ok: false }, T0, 'high').cue, null);
}

head('a fresh board is not mistaken for an old one');
{
  const st = S();
  const d = A._decide(st, [HIGH('a')], { ok: true, at: new Date(T0 - 4000).toISOString() }, T0, 'high');
  eq('four seconds old is fine', d.cue, 'high');
}

head('a slow first load is not an outage');
{
  const st = S();
  const d = A._decide(st, null, { ok: false }, T0 + 5000, 'high');
  eq('five seconds after opening the page, nothing', d.cue, null);
  const d2 = A._decide(st, null, { ok: false }, T0 + STALE_MS + 1000, 'high');
  eq('but it is measured from when the page opened, so it does fire', d2.cue, 'stale');
}

head('somebody who turned the sound off gets no sound, even for this');
{
  const st = S();
  const d = A._decide(st, null, { ok: false }, T0 + STALE_MS + 1000, 'off');
  eq('no cue', d.cue, null);
  ok('but the tab still flashes, because the notification is still there', !!d.notify);
  ok('and the state still says it is down', d.stale === true);
}

// ---------------------------------------------------------------------------
head('it does not grow forever on a wall display');
{
  const st = S();
  const many = [];
  for (let i = 0; i < MAX_SEEN + 120; i++) many.push(NORM('k' + i));
  A._decide(st, many, good, T0, 'all');
  eq('the table is capped', Object.keys(st.seen).length, MAX_SEEN);
  ok('and it is the oldest that went', st.seen['k' + (MAX_SEEN + 119)] !== undefined);
}

head('junk on the board does not take the alerts down with it');
{
  const st = S();
  const d = A._decide(st, [null, undefined, {}, { alertKey: null }, HIGH('a')], good, T0, 'high');
  eq('the real one still rings', d.cue, 'high');
  eq('and only it counted', d.fresh.length, 1);
  eq('a situation with no key at all is skipped', Object.keys(st.seen), ['a']);
  eq('a non-array is survivable too', A._decide(S(), 'nope', good, T0, 'high').cue, null);
}

head('an id stands in when there is no alertKey yet');
{
  const st = S();
  const d = A._decide(st, [sit({ id: 'only-an-id', alertKey: null, priority: 'high' })], good, T0, 'high');
  eq('it rings', d.cue, 'high');
  eq('keyed on the id', Object.keys(st.seen), ['only-an-id']);
}

head('say(), the alarm the board raises for itself');
{
  /* The scanner-dark alarm goes through here rather than through tick(), because
     tick() watches situations.json and a Vercel cron kept that file arriving on
     time all through the August 3 outage. Nothing below can make a sound in
     node, so what is being checked is that it exists, that it survives having no
     audio context, no Notification and no document, and that it reports back
     whether the alarm was allowed rather than swallowing the answer. */
  ok('it is exported', typeof A.say === 'function');
  eq('a bare cue is allowed through at the default mode', A.say('stale'), true);
  eq('so is a full one', A.say('stale', { title: 'Scanners are dark', body: 'x', tag: 't' }, 'x'), true);
  eq('an unknown cue is not an error, just no sound', A.say('kazoo'), true);
  let threw = null;
  try { A.say(); A.say(null, null, null); } catch (e) { threw = e.message; }
  ok('and nothing throws with nothing passed', threw === null, threw);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
