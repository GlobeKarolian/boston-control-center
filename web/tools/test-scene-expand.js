// tools/test-scene-expand.js
//
//   node tools/test-scene-expand.js
//
// The Lancaster failure, exactly: the EMS dispatch is the only transmission
// that says the street's name, the BPD scene traffic never does, and a search
// for "stabbing lancaster street" must return the scene anyway. And the Lowell
// knife call twenty minutes later must stay in Lowell.

const vq = require('../lib/vault-query');
const vs = require('../api/vault-search.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '   ' + detail : '')); }
};

const T = m => new Date(Date.UTC(2026, 7, 13, 16, 57 + m)).toISOString();
const POOL = [
  { at: T(0), feed: 'boston-ems', city: 'Boston', incidentId: 'inc-1', callType: null,
    address: '30 Lancaster Street', matched: '30 LANCASTER ST, BOSTON, MA, 02114',
    text: 'P1 A15 reports of a person being stabbed, 30 Lancaster Street' },
  { at: T(18), feed: 'boston-police', city: 'Boston', callType: null,
    text: 'We have one stab in the abdomen, he was holding the knife, two victims' },
  { at: T(30), feed: 'boston-police', city: 'Boston', callType: 'weapons',
    text: 'Take me off at the stabbing and make full notifications' },
  { at: T(37), feed: 'boston-police', city: 'Boston', callType: 'medical',
    text: 'Auto investigator for anyone going with the one ambulance' },
  { at: T(19), feed: 'lowell-police-department', city: 'Lowell, MA', callType: null,
    text: 'female down with a needle and a knife, whatever' },
  { at: T(2), feed: 'boston-police', city: 'Boston', callType: null,
    text: 'You can send that removal on the public alleyway, thank you' },
  { at: T(-300), feed: 'boston-police', city: 'Boston', callType: 'weapons',
    text: 'ex-boyfriend possible stabbing and this one is a husband possible stabbing' },
];

const f = vq.parse('stabbing on lancaster street today', '2026-08-13T21:00:00Z');
let hits = POOL.map(tx => ({ tx, s: vq.score(tx, f) })).filter(x => x.s > 0);
ok('strict match alone finds only the dispatch', hits.length === 1 && /Lancaster/.test(hits[0].tx.text),
   hits.map(h => h.tx.text).join('|'));

hits = vs._sceneExpand(hits, POOL, f);
const texts = hits.map(h => h.tx.text);
ok('the two-victims traffic rides along', texts.some(t => /two victims/.test(t)), texts.join('|'));
ok('the notifications call rides along', texts.some(t => /full notifications/.test(t)));
/* Kinship alone is NOT a thread. This line is a medical near the scene that
   never names the street, never shares a unit, and never says the word: on a
   citywide channel forty-five minutes of that is most of the channel, and
   letting it in is how a stabbing card filled up with a strangulation, a
   Canal Street follow-up and the fire department's chest pains. */
ok('kin-only chatter does NOT ride along', !texts.some(t => /Auto investigator/.test(t)));
ok('Lowell stays in Lowell', !texts.some(t => /needle/.test(t)));
ok('unrelated Boston chatter stays out', !texts.some(t => /alleyway/.test(t)));
ok('the 6am domestic stays out of the scene', !texts.some(t => /ex-boyfriend/.test(t)));
ok('context is marked as context', hits.filter(h => h.tx.ctx).length === 2,
   'ctx=' + hits.filter(h => h.tx.ctx).length);

const groups = vs._group(hits);
ok('one card, the whole scene', groups.length === 1 && groups[0].tx.length === 3,
   'groups=' + groups.length + ' tx=' + (groups[0] && groups[0].tx.length));
ok('chronological inside the card',
   groups[0].tx[0].at <= groups[0].tx[1].at && groups[0].tx[1].at <= groups[0].tx[2].at);
ok('the card is named for its anchor, not its first line',
   groups[0].place && /Lancaster/i.test(groups[0].place), 'place=' + groups[0].place);
ok('every clip in the scene is playable in order',
   groups[0].clips ? groups[0].clips.length === groups[0].tx.filter(t => t.clip).length : true);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
