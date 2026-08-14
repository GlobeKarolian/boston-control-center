// tools/test-verify.js
//
//   node tools/test-verify.js
//
// The verifier's contract, tested with a stubbed model so it runs offline and
// in CI. The question here is not whether a model can spot a fabrication; it
// is whether this module fails in the safe direction when it cannot.

const path = require('path');
const llmPath = require.resolve('../lib/llm.js');

let reply = null;
let seen = null;
require.cache[llmPath] = {
  id: llmPath, filename: llmPath, loaded: true, exports: {
    enabled: () => true,
    PRIMARY: 'stub', FALLBACK: 'stub2',
    chat: async () => JSON.stringify(reply),
    chatJSON: async (o) => { seen = o; if (reply instanceof Error) throw reply; return reply; },
  },
};

const verify = require('../lib/verify.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '   ' + detail : '')); }
};

const WALDEN = [{ at: '2026-08-14T04:05:45Z', src: 'boston-police',
  text: 'I am good to go. All right, Jake 201. Sorry. 81 Walden Street.' }];

(async () => {
  reply = { supported: false, quote: '', refutes: 'no transcript mentions a shooter, a gun or Cambridge', worst: 'active shooter' };
  const v = await verify.check('Active Shooter at 81 Walden Street, Cambridge - Confirmed by Police', WALDEN);
  ok('a fabrication is refused', v.ran === true && v.supported === false);

  const held = verify.apply({ headline: 'Active Shooter at 81 Walden Street', priority: 'high', confidence: 'confirmed' }, v);
  ok('and the card is held', held.held === true);
  ok('with the reason in plain words', /could not stand this up/.test(held.heldWhy), held.heldWhy);
  ok('and it stops claiming confidence', held.confidence === 'unclear');
  ok('the worst element is named', held.heldWorst === 'active shooter');

  /* The prompt must not leak the writer's certainty into the review. */
  ok('the skeptic never sees the writer confidence',
     !/confirmed|high priority|severity/i.test(String(seen.user).replace(/Confirmed by Police/, '')),
     'prompt leaked');
  ok('the skeptic does see the transcripts verbatim', /Jake 201/.test(seen.user));

  reply = { supported: true, quote: 'reports of a person being stabbed, 30 Lancaster Street', refutes: '', worst: '' };
  const good = await verify.check('Stabbing at 30 Lancaster Street, two victims',
    [{ at: '2026-08-13T16:57:39Z', src: 'boston-ems', text: 'P1 A15 reports of a person being stabbed, 30 Lancaster Street' }]);
  const okCard = verify.apply({ headline: 'Stabbing at 30 Lancaster Street', priority: 'high' }, good);
  ok('a real story passes', okCard.verified === true && !okCard.held);
  ok('and carries the quote that stood it up', /person being stabbed/.test(okCard.verifiedQuote));

  /* The failure that matters most: the verifier is down. */
  reply = new Error('openrouter timeout');
  const dead = await verify.check('Active Shooter somewhere', WALDEN);
  ok('an unreachable verifier does not approve anything', dead.supported === false && dead.ran === false);
  const unver = verify.apply({ headline: 'Active Shooter somewhere', priority: 'high' }, dead);
  ok('silence is not consent', unver.held === true && /unverified/.test(unver.heldWhy), unver.heldWhy);

  /* A claim with nothing behind it at all. */
  reply = null;
  const empty = await verify.check('Something enormous happened', []);
  ok('a claim with no transcripts is refused outright',
     empty.ran === true && empty.supported === false && /no transcripts/.test(empty.refutes));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
