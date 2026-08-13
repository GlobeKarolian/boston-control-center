// tools/test-vault-query.js
//
//   node tools/test-vault-query.js
//
// The archive search has one job a newsroom can check: when a reporter names
// a thing that happened, the thing comes back and the rest of the night does
// not. These are the cases that were failing in production on 2026-08-13.

'use strict';

const vq = require('../lib/vault-query');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '   ' + detail : '')); }
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
}

const NOW = '2026-08-13T04:00:00Z';           // just after midnight, Eastern

/* Hours after 6pm Eastern on Aug 12, which is where "last night" starts. Written
   as an offset rather than a UTC hour because the bug this file exists to catch
   is exactly the kind that hides behind a hand-converted timestamp. */
const NIGHT_START = Date.UTC(2026, 7, 12, 22, 0, 0);
const T = (h, m) => new Date(NIGHT_START + h * 3600000 + (m || 0) * 60000).toISOString();

/* ---------------------------------------------------------------- parsing --- */

console.log('\nparse');
{
  const f = vq.parse('body found at the TD Garden parking garage', NOW);
  eq('the type is a death, not a medical', f.type, 'death');
  eq('the landmark is the Garden', f.landmark, 'td garden');
  ok('the leftover words are the useful ones',
     f.words.includes('parking') && f.words.includes('garage'), JSON.stringify(f.words));
  ok('landmark words are not double counted as free text',
     !f.words.includes('garden') && !f.words.includes('td'), JSON.stringify(f.words));
}
{
  const f = vq.parse('big fire last night in Back Bay', NOW);
  eq('type', f.type, 'fire');
  eq('place', f.place, 'back bay');
  eq('big', f.big, true);
  eq('when', f.when, 'last night');
}
{
  const f = vq.parse('anything from north station', NOW);
  eq('north station resolves to the Garden complex', f.landmark, 'td garden');
}
{
  const f = vq.parse('shooting in southie yesterday', NOW);
  eq('nickname resolves', f.place, 'south boston');
  eq('type', f.type, 'shooting');
}

/* ------------------------------------------------------------- the corpus --- */

/* Lines that contain the letters b-o-d-y and are not about a body. Seventeen
   of these came back from the real archive for the real question. 
   This is the real shape of the false positives the old search returned. */
const NOISE = [
  'Can somebody check the tablet out for the moped, sir?',
  'Somebody call for a tow on that one',
  'Is anybody down there with him',
  'Somebody said the door was open',
  'Nobody answering at that address',
  'Have somebody meet us at the corner',
  'Anybody got a spare portable',
].map((text, i) => ({
  at: T(1, i), feed: 'boston-fire', text, callType: 'medical', town: 'Boston',
}));

const GARDEN = [
  { at: T(5, 10), feed: 'boston-police', town: 'Boston', callType: 'medical',
    address: '100 Legends Way', matched: 'TD Garden',
    text: 'We have an unresponsive party in the parking garage at the Garden, level three' },
  { at: T(5, 14), feed: 'boston-police', town: 'Boston', callType: 'death',
    address: '100 Legends Way', matched: 'TD Garden', tier: 3, priority: 'high',
    text: 'Confirming a body in the North Station garage, notify the medical examiner' },
];

const BACKBAY_FIRE = [
  { at: T(3, 0), feed: 'boston-fire', town: 'Boston', callType: 'fire', tier: 3,
    address: '500 Boylston St', matched: 'Back Bay', alarm: true, priority: 'high',
    text: 'Working fire, second alarm, heavy smoke showing from the third floor' },
];

const ELSEWHERE = [
  { at: T(4, 0), feed: 'boston-fire', town: 'Dorchester', callType: 'fire',
    address: '10 Adams St', text: 'Car fire on the ramp, one engine responding' },
  { at: T(2, 0), feed: 'boston-police', town: 'Revere', callType: 'crash',
    address: '5 Ocean Ave', text: 'Two car crash, no injuries reported' },
];

const CORPUS = [...NOISE, ...GARDEN, ...BACKBAY_FIRE, ...ELSEWHERE];

function search(q) {
  const f = vq.parse(q, NOW);
  return CORPUS
    .map(tx => ({ tx, s: vq.score(tx, f) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s);
}

/* ------------------------------------------------------------- the search --- */

console.log('\nthe question that failed in production');
{
  const hits = search('body found at the TD Garden parking garage');
  eq('two transmissions come back, both from the Garden', hits.length, 2);
  ok('no line containing "somebody" comes back',
     !hits.some(h => /somebody|anybody|nobody/i.test(h.tx.text)),
     hits.map(h => h.tx.text).join(' | '));
  ok('the confirmed body sorts above the unresponsive party',
     /Confirming a body/.test(hits[0].tx.text), hits[0].tx.text);
}

console.log('\nthe question the archive was built for');
{
  const hits = search('big fire last night in Back Bay');
  eq('only the Back Bay fire', hits.length, 1);
  eq('and it is the right one', hits[0].tx.matched, 'Back Bay');
}

console.log('\nprecision');
{
  eq('a fire question does not return crashes',
     search('fire last night').every(h => /fire|smoke/i.test(h.tx.text)), true);
  eq('a landmark question does not return the rest of the city',
     search('what happened at fenway park last night').length, 0);
  eq('a question about a word nobody said returns nothing',
     search('the call about the dog').length, 0);
}

console.log('\nbrowse');
{
  /* A bare time range is not a failed search, it is a request for the window,
     and it is the one case where returning everything is right. */
  const hits = search('last night');
  eq('a bare time range returns the window', hits.length, CORPUS.length);
}

console.log('\nthe window is still a hard gate');
{
  const f = vq.parse('body at the garden', NOW);
  const old = { at: '2026-07-01T23:10:00Z', text: 'body in the garage at TD Garden' };
  eq('a match outside the window is not a match', vq.score(old, f), 0);
}

console.log('\ntokens');
{
  const bag = vq.tokenize('Can somebody check the tablet');
  eq('somebody does not contain body', vq.hasWord(bag, 'body'), false);
  eq('plurals fold', vq.hasWord(vq.tokenize('two garages'), 'garage'), true);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
