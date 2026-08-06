// tools/test-threads.js
// Run: node tools/test-threads.js
//
// The jumper and the bag, plus the ways that fix could go wrong. No test
// framework on purpose: this repo has no dependencies and adding one so a
// pure function can be checked would be a poor trade.

const { reconcile, alertKey } = require('../lib/threads');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '   ' + JSON.stringify(extra) : '')); }
};

const ago = ms => new Date(Date.now() - ms).toISOString();

// A model report, already geocoded, the way api/cron/analyst.js builds them.
function said(o) {
  const f = Object.assign({
    headline: '', summary: '', type: 'situation', priority: 'normal',
    confidence: 'reported', location: null, status: 'active',
    lat: null, lon: null, matched: null, updates: null, relatedTo: null,
  }, o);
  f.proposedId = alertKey(f);
  return f;
}

const JUMPER = said({
  headline: 'Report of a person in the water off the Tobin Bridge',
  type: 'search', location: 'Tobin Bridge, Chelsea', lat: 42.3906, lon: -71.0604,
  priority: 'high', status: 'developing',
});

console.log('\nthe jumper and the bag');

// Run 1: nothing on the board.
let r = reconcile([], [JUMPER]);
const jid = r.situations[0] && r.situations[0].id;
ok('opens one story', r.situations.length === 1);
ok('mints an id that is not the model\'s', !!jid && /^search-[0-9a-f]{6}$/.test(jid), { jid });
ok('reports it as opened', r.opened.length === 1);
ok('carries an opened beat', r.situations[0].events.length === 1 && r.situations[0].events[0].kind === 'opened');

// Run 2: same story, the model has heard more radio.
r = reconcile(r.situations, [said({
  headline: 'Dive team searching for person who went off the Tobin Bridge',
  type: 'search', location: 'Tobin Bridge, Chelsea', lat: 42.3906, lon: -71.0604,
  priority: 'high', status: 'active', updates: jid,
})]);
ok('keeps the same id across runs', r.situations.length === 1 && r.situations[0].id === jid);
ok('opens nothing new', r.opened.length === 0);
ok('takes the newer headline', /Dive team/.test(r.situations[0].headline));
ok('records the rewrite as a beat', r.situations[0].events.length === 2 && r.situations[0].events[1].kind === 'update');

// Run 3: THE CASE. A bag turns up, and the model says it belongs to the search.
r = reconcile(r.situations, [said({
  headline: 'Backpack found unattended on the Tobin Bridge walkway',
  type: 'suspicious package', location: 'Tobin Bridge, Chelsea', lat: 42.3907, lon: -71.0605,
  priority: 'high', status: 'active', relatedTo: jid,
})]);
ok('the bag does not become a second card', r.situations.length === 1);
ok('the bag does not rewrite the headline', /Dive team/.test(r.situations[0].headline));
const beat = r.situations[0].events[r.situations[0].events.length - 1];
ok('the bag becomes a linked beat', beat.kind === 'linked' && /Backpack/.test(beat.text));
ok('the beat keeps its own type', beat.type === 'suspicious package');
ok('the card is still a search', r.situations[0].type === 'search');

console.log('\nthings that must NOT thread');

const board = r.situations;

// A hallucinated parent id. The analyst filters these, but reconcile is the
// last line and must not invent a link to a story that does not exist.
let x = reconcile(board, [said({
  headline: 'Two-car crash with entrapment on Route 128 southbound',
  type: 'crash', location: 'Route 128, Needham', lat: 42.2809, lon: -71.2367,
  priority: 'high', relatedTo: 'search-deadbee',
})]);
ok('an unknown parent id opens its own card', x.situations.length === 2);

// Far away, different kind of thing, no proposal. Geometry must not reach.
x = reconcile(board, [said({
  headline: 'Working fire in a three-decker on Blue Hill Ave',
  type: 'fire', location: 'Blue Hill Ave, Dorchester', lat: 42.2921, lon: -71.0834,
  priority: 'high',
})]);
ok('a distant unrelated event opens its own card', x.situations.length === 2);

// Same kind of thing, 60m away, minutes apart, no proposal at all. This is
// what geometricMatch exists for: the model forgot to say so.
x = reconcile(board, [said({
  headline: 'Second search unit requested at the Tobin',
  type: 'search', location: 'Tobin Bridge, Chelsea', lat: 42.3911, lon: -71.0604,
})]);
ok('geometry catches an unproposed repeat', x.situations.length === 1 && x.situations[0].id === jid);

// Priority ratchets up and never quietly down.
x = reconcile(board, [said({
  headline: 'Search continuing at the Tobin', type: 'search',
  lat: 42.3906, lon: -71.0604, priority: 'normal', updates: jid,
})]);
ok('priority does not fall on its own', x.situations[0].priority === 'high');

console.log('\nwhat a human on the desk decides');

// Two cards the machine kept apart. A person says they are one story.
const two = reconcile([], [
  said({ headline: 'Shots fired call on Washington St', type: 'shooting', lat: 42.33, lon: -71.08, priority: 'high' }),
  said({ headline: 'Person shot, transported from Washington St', type: 'medical', lat: 42.331, lon: -71.081, priority: 'high' }),
]).situations;
ok('the machine kept them apart', two.length === 2);

const merged = reconcile(two, [], { merge: { [two[1].id]: two[0].id } });
ok('a human merge folds them into one', merged.situations.length === 1);
ok('the merge keeps the parent id', merged.situations[0].id === two[0].id);
ok('the merge keeps both beats', merged.situations[0].events.length === 2);
ok('the merge is marked', merged.situations[0].merged === 1);

// And it holds on the next run, when the radio says the same thing again and
// the card that carried the correction is gone. This is the pair of handles
// /api/sitlink writes: the child's id, and the child's alert key, which
// outlives it.
const sticky = { merge: { [two[1].id]: two[0].id, [two[1].alertKey]: two[0].id } };
const again = reconcile(merged.situations, [said({
  headline: 'Person shot, transported from Washington St', type: 'medical',
  lat: 42.331, lon: -71.081, priority: 'high',
})], sticky);
ok('the merge survives the next run', again.situations.length === 1);
ok('the re-report lands as a beat, not a takeover', /Shots fired/.test(again.situations[0].headline));

// The opposite: a person pulls something out and it must stay out.
const stuck = reconcile(board, [said({
  headline: 'Backpack found unattended on the Tobin Bridge walkway',
  type: 'suspicious package', location: 'Tobin Bridge, Chelsea', lat: 42.3907, lon: -71.0605,
  relatedTo: jid,
})], { split: { [alertKey({ headline: 'Backpack found unattended on the Tobin Bridge walkway', type: 'suspicious package', lat: 42.3907, lon: -71.0605 })]: jid } });
ok('a human split blocks the relink', stuck.situations.length === 2);
ok('the split thing is its own story', stuck.situations.some(s => /Backpack/.test(s.headline) && s.id !== jid));

console.log('\ngoing quiet');

/* Ages picked against the 20-minute-close, 40-minute-drop policy set on
   6 August. 30 minutes of silence is closed but still on the board; an hour
   is gone. */
const old = [
  { id: 'fire-aaa111', headline: 'Working fire, Dorchester', type: 'fire', priority: 'high',
    status: 'active', lat: 42.29, lon: -71.08, firstSeen: ago(35 * 60000), updated: ago(30 * 60000), events: [] },
  { id: 'crash-bbb222', headline: 'Crash cleared, Route 1', type: 'crash', priority: 'normal',
    status: 'active', lat: 42.4, lon: -71.0, firstSeen: ago(200 * 60000), updated: ago(60 * 60000), events: [] },
  { id: 'pursuit-ccc333', headline: 'Pursuit on 93 north', type: 'pursuit', priority: 'high',
    status: 'active', lat: 42.36, lon: -71.06, firstSeen: ago(5 * 60000), updated: ago(60000), events: [] },
];
const aged = reconcile(old, []);
ok('half an hour of silence closes a story', aged.situations.find(s => s.id === 'fire-aaa111').status === 'closed');
ok('an hour of silence drops it', !aged.situations.find(s => s.id === 'crash-bbb222'));
ok('a live story is untouched', aged.situations.find(s => s.id === 'pursuit-ccc333').status === 'active');
ok('open and high sorts to the top', aged.situations[0].id === 'pursuit-ccc333');
ok('closed sorts to the bottom', aged.situations[aged.situations.length - 1].status === 'closed');

console.log('\nwhich radio carried it');

// The scanner has no agency field. Which feed a scene was heard on is the only
// evidence there is about whose scene it is, and app/statepolice.js reads this
// field to decide whether a card is State Police business or a guess off a road
// name. Which means it has to survive threading.

let fx = reconcile([], [said({
  headline: 'Two-car crash blocking the left lane on Route 2',
  type: 'crash', location: 'Route 2, Concord', lat: 42.4604, lon: -71.3489,
  priority: 'high', feeds: ['boston-police'],
})]);
const cid = fx.situations[0].id;
ok('a new card carries the radio it was heard on',
  JSON.stringify(fx.situations[0].feeds) === '["boston-police"]', fx.situations[0].feeds);

// The troopers take it over. The card is State Police business from here.
fx = reconcile(fx.situations, [said({
  headline: 'State Police have the left lane on Route 2 shut', type: 'crash',
  lat: 42.4604, lon: -71.3489, priority: 'high', updates: cid, feeds: ['mass-state-police'],
})]);
ok('a second radio is added, not swapped in',
  JSON.stringify(fx.situations[0].feeds) === '["boston-police","mass-state-police"]', fx.situations[0].feeds);

// And then the troopers stop talking. Which agency turned out is a fact about
// what happened, not a description of the last sixty seconds, so the card does
// not walk back out of that column while the story is still running.
fx = reconcile(fx.situations, [said({
  headline: 'Route 2 reopened after the crash', type: 'crash',
  lat: 42.4604, lon: -71.3489, updates: cid, feeds: ['boston-police'],
})]);
ok('a radio never drops off once it has carried the story',
  fx.situations[0].feeds.indexOf('mass-state-police') > -1, fx.situations[0].feeds);
ok('and it is not listed twice for coming back', fx.situations[0].feeds.length === 2, fx.situations[0].feeds);

fx = reconcile(fx.situations, [said({
  headline: 'Tow clearing the Route 2 crash', type: 'crash',
  lat: 42.4604, lon: -71.3489, updates: cid,
})]);
ok('a run where the model says nothing about feeds does not empty it',
  fx.situations[0].feeds.length === 2, fx.situations[0].feeds);

// The jumper and the bag, from the feeds side. A beat is not a rewrite, but
// which radio carried it is true either way.
fx = reconcile(fx.situations, [said({
  headline: 'Trooper requesting a second wrecker', type: 'other',
  lat: 42.4605, lon: -71.3489, relatedTo: cid, feeds: ['msp-troop-a'],
})]);
ok('a linked beat hands its radio up to the parent',
  fx.situations[0].feeds.indexOf('msp-troop-a') > -1, fx.situations[0].feeds);
ok('without rewriting the headline to do it', /Tow clearing/.test(fx.situations[0].headline), fx.situations[0].headline);

// A human merge runs on the board before a word of the model is read, so it
// takes a different path through the file and has to union the same way.
const shots = reconcile([], [
  said({ headline: 'Shots fired call on Washington St', type: 'shooting', lat: 42.33, lon: -71.08, priority: 'high', feeds: ['boston-police'] }),
  said({ headline: 'Person shot, transported from Washington St', type: 'medical', lat: 42.331, lon: -71.081, priority: 'high', feeds: ['mass-state-police'] }),
]).situations;
ok('the machine kept them apart', shots.length === 2);
const folded = reconcile(shots, [], { merge: { [shots[1].id]: shots[0].id } }).situations[0];
ok('a human merge unions both radios',
  folded.feeds.length === 2 && folded.feeds.indexOf('mass-state-police') > -1, folded.feeds);

// Six, in both directions. A card listing nine radios tells a reporter nothing,
// and there is room on the chip for one.
const manyFeeds = reconcile([], [said({
  headline: 'Something loud downtown', type: 'other', lat: 42.35, lon: -71.06,
  feeds: ['a-1', 'b-2', 'c-3', 'd-4', 'e-5', 'f-6', 'g-7', 'h-8'],
})]).situations[0];
ok('the list stops at six', manyFeeds.feeds.length === 6, manyFeeds.feeds);
ok('and it keeps the first six, not the last', manyFeeds.feeds[5] === 'f-6', manyFeeds.feeds);

// The analyst whitelist should stop most of this. reconcile is the last thing
// standing between a bad field and a stored card, so it does not assume.
const junkFeeds = reconcile([], [said({
  headline: 'Something else downtown', type: 'other', lat: 42.36, lon: -71.07,
  feeds: ['boston-police', 'boston-police', '  boston-police  ', null, '', 7],
})]).situations[0];
ok('duplicates collapse, trailing spaces and all', junkFeeds.feeds.length === 2, junkFeeds.feeds);
ok('and the tag is stored trimmed', junkFeeds.feeds[0] === 'boston-police', junkFeeds.feeds);

const looseFeeds = reconcile([], [said({
  headline: 'A third thing downtown', type: 'other', lat: 42.37, lon: -71.09, feeds: 'boston-police',
})]).situations[0];
ok('a bare string where a list belongs comes back as an empty list',
  Array.isArray(looseFeeds.feeds) && looseFeeds.feeds.length === 0, looseFeeds.feeds);

console.log('\nalert keys');
const a = { headline: 'Working fire at 42 Boylston St', type: 'fire', lat: 42.35, lon: -71.07 };
const b = { headline: 'A working fire at the 42 Boylston St address', type: 'fire', lat: 42.3502, lon: -71.0701 };
const c = { headline: 'Working fire on Blue Hill Ave', type: 'fire', lat: 42.29, lon: -71.08 };
const d = { headline: 'Person shot at 42 Boylston St', type: 'shooting', lat: 42.35, lon: -71.07 };
const e1 = { headline: 'Barricaded subject, location unclear', type: 'barricade', lat: null, lon: null, location: null };
const e2 = { headline: 'Hazmat spill, location unclear', type: 'barricade', lat: null, lon: null, location: null };
ok('two tellings of one story share a key', alertKey(a) === alertKey(b), { a: alertKey(a), b: alertKey(b) });
ok('two fires a mile apart do not', alertKey(a) !== alertKey(c));
ok('a shooting and a fire at one address do not', alertKey(a) !== alertKey(d));
ok('with nothing geocoded the headline still separates', alertKey(e1) !== alertKey(e2));

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
