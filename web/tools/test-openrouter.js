// tools/test-openrouter.js
//
// Prove the OpenRouter key and the model slugs work BEFORE a deploy bets the
// extraction pipeline on them. Runs one real transmission through the same
// code path api/ingest.js uses, prints what came back and what it cost.
//
//   cd web && npx vercel env pull .env.local
//   set -a; source .env.local; set +a
//   node tools/test-openrouter.js
//   node tools/test-openrouter.js "your own test transcript here"

const ex = require('../lib/extractor.js');

const text = process.argv.slice(2).join(' ')
  || 'P1 A15 reports of a person being stabbed, 30 Lancaster Street, priority one';

if (!(process.env.OPENROUTER_API_KEY || '').trim()) {
  console.error('OPENROUTER_API_KEY is not in the environment.');
  console.error('run: npx vercel env pull .env.local && set -a; source .env.local; set +a');
  process.exit(1);
}

(async () => {
  const t0 = Date.now();
  const { results, by, errors } = await ex.extractBatch([{ text, src: 'test' }]);
  console.log('in:     ' + text);
  console.log('by:     ' + by + '   ms: ' + (Date.now() - t0));
  if (errors && errors.length) console.log('errors: ' + errors.join(' | '));
  console.log(JSON.stringify(results[0], null, 1));
  const r = results[0] || {};
  const ok = by !== 'regex' && (r.callType || r.address || (r.units && r.units.length));
  console.log(ok ? '\nLOOKS GOOD: the model answered and mapFields accepted it.'
                 : '\nNOT GOOD: fell back to regex; check the key, the slugs, or the errors above.');
  process.exit(ok ? 0 : 1);
})();
