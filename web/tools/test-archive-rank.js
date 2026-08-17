// tools/test-archive-rank.js
//
//   node tools/test-archive-rank.js
//
// "Bar Fight in cambridge", 17 August, 10:10 am. The archive returned twenty
// calls. The Russell House Tavern brawl, eight men fighting outside 14 JFK
// Street, dispatched at 10:42 the night before, was nineteenth. First was a
// weapon call at 1426 Mass Ave whose transcript said "no active disturbance",
// wearing thirty-three lines of unrelated chatter as its scene: "Thank you
// very much", "Welcome to control", "Wilco 6 is going off".
//
// Three defects, reproduced here with the actual records:
//
//   1. The brawl was labelled "fight" by the extractor and the question was
//      typed "disturbance", so === gave the brawl half the type credit that a
//      call labelled "disturbance" got. The label IS the type.
//   2. "bar" appears nowhere in a transmission that says "Russell House
//      Tavern". The word scored as if the place had never been named.
//   3. Ten calls tied and the tie went to the OLDEST, because the sort was
//      stable over groups built in time order.
//
// And the scene: `matched` ends in the town, so "cambridge" was a street word
// and every Cambridge transmission within forty-five minutes was "linked".

'use strict';

const vq = require('../lib/vault-query');
const vs = require('../api/vault-search.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; return; }
  fail++; console.log('  FAIL ' + name + (detail ? '   ' + detail : ''));
};

const NOW = '2026-08-17T14:10:51Z';
const f = vq.parse('Bar Fight in cambridge', new Date(NOW));

/* The two records, as archived. */
const RUSSELL = {
  at: '2026-08-17T02:42:45Z', feed: 'cambridge-ma-police', callType: 'fight',
  town: 'Cambridge', city: 'Camebridge', address: '14 JFK Street', landmark: 'Russell House Tavern',
  matched: '14 JFK ST, CAMBRIDGE, MA, 02138', incidentId: 'inc-russell', units: ['419', '5', '4'],
  text: '419. Power vote. Gene. We will go 5. We will go 4. First on Russell House Tavern, 14 JFK Street for a fight. It is going to be about 8 men fighting another. No weapons, still in line, going further. Copy. Thank you.',
};
const WEAPON = {
  at: '2026-08-16T21:50:49Z', feed: 'cambridge-ma-police', callType: 'disturbance',
  town: 'Cambridge', city: 'Camebridge', matched: 'Cambridge', incidentId: 'inc-weapon', units: ['C5'],
  text: 'Possession of that weapon. Should be 14.26 mass. Copy. Thank you. Car 5, please. Answer 5. I do not know if you have us off. We are off. No active disturbance. Just trying to figure it out.',
};

/* --- the score ------------------------------------------------------------ */

ok('the brawl the reporter asked about outscores the weapon call',
   vq.score(RUSSELL, f) > vq.score(WEAPON, f),
   'russell=' + vq.score(RUSSELL, f).toFixed(1) + ' weapon=' + vq.score(WEAPON, f).toFixed(1));
ok('a call labelled "fight" is a disturbance', vq.ownType({ callType: 'fight' }, 'disturbance'));
ok('so is one labelled "assault"', vq.ownType({ callType: 'assault' }, 'disturbance'));
ok('and "mva" is a crash', vq.ownType({ callType: 'mva' }, 'crash'));
ok('but "medical" is not a disturbance', !vq.ownType({ callType: 'medical' }, 'disturbance'));
ok('a tavern is a bar', vq.saysWord(vq.tokenize('russell house tavern'), 'russell house tavern', 'bar'));
ok('and a pub is a bar', vq.saysWord(vq.tokenize('the plough and stars pub'), 'the plough and stars pub', 'bar'));
ok('but a barricade is not', !vq.saysWord(vq.tokenize('crash barricade in the road'), 'crash barricade in the road', 'bar'));

/* --- the tie --------------------------------------------------------------- */
{
  const mk = (i, hoursAgo) => ({
    at: new Date(+new Date(NOW) - hoursAgo * 3600000).toISOString(), feed: 'cambridge-ma-police',
    callType: 'disturbance', town: 'Cambridge', incidentId: 'inc-tie-' + i, matched: 'Cambridge',
    text: 'Respond over for a disturbance, party refusing to leave.',
  });
  const pool = [mk(1, 16), mk(2, 12), mk(3, 8), mk(4, 2)];
  const hits = pool.map(tx => ({ tx, s: vq.score(tx, f) })).filter(x => x.s > 0);
  const groups = vs._group(hits);
  ok('four equal disturbances come back newest first',
     groups.length === 4 && groups[0].id === 'inc-tie-4' && groups[3].id === 'inc-tie-1',
     groups.map(g => g.id).join(','));
}

/* --- the scene ------------------------------------------------------------- */
{
  const T = (m) => new Date(+new Date(WEAPON.at) + m * 60000).toISOString();
  const chatter = (m, text, over) => Object.assign({
    at: T(m), feed: 'cambridge-ma-police', town: 'Cambridge', city: 'Camebridge',
    matched: 'Cambridge', callType: null, incidentId: 'inc-other-' + m, text,
  }, over || {});
  const pool = [
    WEAPON,
    chatter(-16, 'There is nobody here working on a motorcycle. If the reporting party does not want to speak to us, we will be clear.'),
    chatter(-15, 'Cycles. They did not advise they wanted to speak, so I will show you guys now.'),
    chatter(-14, 'Thank you very much.', { feed: 'cambridge-ma-fire' }),
    chatter(-13, 'Welcome to control. Here is the local one.'),
    chatter(-12, 'and find the party for the spray paint, you can add us for a call with WOC2.'),
    chatter(-9, 'Wilco 6 is going off. Wilco 6 is going off.'),
    chatter(-6, 'We will go on to the drone. Yes sir, we will go on. We are on location.'),
    chatter(3, 'Car 5, we are clear of 1426 Mass Ave, weapon secured, one to Cambridge Hospital.',
            { incidentId: 'inc-weapon', matched: '1426 MASSACHUSETTS AVE, CAMBRIDGE, MA, 02138' }),
    chatter(40, 'Respond over to Newtown Court for a disturbance, party refusing to leave.',
            { callType: 'disturbance', incidentId: 'inc-newtowne' }),
  ];
  const hits = pool.map(tx => ({ tx, s: vq.score(tx, f) })).filter(x => x.s > 0);
  const expanded = vs._sceneExpand(hits, pool, f);
  const groups = vs._group(expanded);
  const weapon = groups.find(g => g.id === 'inc-weapon');
  const texts = weapon ? weapon.tx.map(t => t.text) : [];
  ok('the weapon call keeps its own follow-up', texts.some(t => /weapon secured/.test(t)));
  ok('and does not collect the motorcycle complaint', !texts.some(t => /motorcycle/.test(t)));
  ok('or the spray paint call', !texts.some(t => /spray paint/.test(t)));
  ok('or "Thank you very much"', !texts.some(t => /Thank you very much/.test(t)));
  ok('or Wilco 6', !texts.some(t => /Wilco 6/.test(t)));
  ok('or a different disturbance forty minutes later', !texts.some(t => /Newtown/.test(t)),
     'a common type reaches minutes, not a shift');
  ok('the scene is a handful of lines, not thirty-four', weapon && weapon.tx.length <= 3,
     'n=' + (weapon && weapon.tx.length));
}

/* --- street words ---------------------------------------------------------- */
{
  /* Reached through sceneExpand: an anchor at 1426 Mass Ave links a later
     line that says Mass Ave, and never a line that merely sits in Cambridge. */
  const T = (m) => new Date(+new Date(WEAPON.at) + m * 60000).toISOString();
  const anchor = Object.assign({}, WEAPON, { matched: '1426 MASSACHUSETTS AVE, CAMBRIDGE, MA, 02138', address: '1426 Massachusetts Avenue' });
  const pool = [
    anchor,
    { at: T(20), feed: 'cambridge-ma-fire', town: 'Cambridge', city: 'Camebridge', callType: null,
      matched: 'Cambridge', text: 'Engine 1 on Massachusetts Avenue for the police, standing by.' },
    { at: T(21), feed: 'cambridge-ma-police', town: 'Cambridge', city: 'Camebridge', callType: null,
      matched: '99 PROSPECT ST, CAMBRIDGE, MA', text: 'Out at 99 Prospect for the alarm.' },
  ];
  const hits = pool.map(tx => ({ tx, s: vq.score(tx, f) })).filter(x => x.s > 0);
  const groups = vs._group(vs._sceneExpand(hits, pool, f));
  const g = groups[0];
  ok('a line naming the anchor\'s street joins', g.tx.some(t => /Engine 1/.test(t.text)));
  ok('a line that only shares the town does not', !g.tx.some(t => /Prospect/.test(t.text)));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
