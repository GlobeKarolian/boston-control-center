// tools/test-grounding.js
//
//   node tools/test-grounding.js
//
// The two situations the board carried at 12:10am on August 14, 2026, built
// from the transmissions printed below them. Neither claim was in the audio.
// This file exists so neither can reach a reporter again.

const core = require('../lib/analyst-core.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '   ' + detail : '')); }
};

/* Verbatim from the archive. A drunk brother and a unit clearing a street. */
const WALDEN = [
  { source: 'boston-police', text: 'I am good to go. All right, Jake 201. Sorry. 81 Walden Street.' },
  { source: 'boston-police', text: "Carlos says the brother is under the influence causing issues in the house. She's 43 years old." },
];

/* Verbatim. Note the word "not" three words before "pursuing". */
const PURSUIT = [
  { source: 'boston-police', text: "from Cambridge, how does history of fleeing from all of the two stops? Over the issue, birds, they're not pursuing five Bravo Popeye Zulu 4-6, 23 BMW 330 in Franklin." },
];

const REAL_STABBING = [
  { source: 'boston-ems', text: 'P1 A15 reports of a person being stabbed, 30 Lancaster Street' },
  { source: 'boston-police', text: 'We have one stab in the abdomen, he was holding the knife, two victims' },
];

(async () => {
  const walden = (await core.disposeReported([{
    headline: 'Active Shooter at 81 Walden Street, Cambridge - Confirmed by Police',
    summary: 'Police confirm an active shooter situation at 81 Walden Street, Cambridge. A call from Boston Police indicates the incident is ongoing and involves a person under the influence in a residence.',
    type: 'shooting', priority: 'high', confidence: 'confirmed', status: 'active',
  }], { batch: WALDEN, prev: [] }))[0];

  ok('the active shooter claim is held', walden.held === true, JSON.stringify(walden.heldWhy));
  ok('and it says which claim had no source', /shooter/i.test(walden.heldWhy || ''), walden.heldWhy);
  ok('the unearned "Confirmed by Police" is stripped',
     !/confirmed by police/i.test(walden.headline), walden.headline);
  ok('confidence cannot outrank the radio', walden.confidence !== 'confirmed', walden.confidence);
  ok('it is no longer high priority', walden.priority === 'normal', walden.priority);
  /* Nothing on the radio said Cambridge, and nothing in the pipeline placed
     the address. A city the model supplied from general knowledge reads to a
     reporter as dispatch information. */
  ok('the city nobody said is stripped',
     !/cambridge/i.test(walden.headline + ' ' + walden.summary),
     walden.headline);

  const pursuit = (await core.disposeReported([{
    headline: 'Pursuit of BMW 330-XX on I-93 Northbound - State Police Confirm',
    summary: 'A high-speed pursuit is underway. State Police confirm the vehicle is fleeing.',
    type: 'pursuit', priority: 'high', confidence: 'reported', status: 'active',
  }], { batch: PURSUIT, prev: [] }))[0];

  ok('"they are NOT pursuing" does not support a pursuit', pursuit.held === true, pursuit.heldWhy);
  ok('and the borrowed State Police confirmation is stripped',
     !/state police confirm/i.test(pursuit.headline), pursuit.headline);

  const stab = (await core.disposeReported([{
    headline: 'Stabbing at 30 Lancaster Street, two victims',
    summary: 'EMS dispatched for a person stabbed at 30 Lancaster Street. Officers on scene report two victims and one knife.',
    type: 'stabbing', priority: 'high', confidence: 'reported', status: 'active',
  }], { batch: REAL_STABBING, prev: [] }))[0];

  ok('a real stabbing still runs', !stab.held, stab.heldWhy || '');
  ok('and keeps its priority', stab.priority === 'high', stab.priority);
  ok('and keeps its headline intact', /Lancaster/.test(stab.headline), stab.headline);

  ok('negation is only read backwards, not across sentences',
     core.saidOnAir(/\bpursuit\b/i, [{ text: 'Not a medical. We have a pursuit northbound.' }]) !== null);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
