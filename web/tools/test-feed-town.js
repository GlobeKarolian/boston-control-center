// tools/test-feed-town.js
//
// Which town, and the path where nobody ever asked.
//
// Most transmissions never say their city. The feed always knows: a
// boston-police transmission is in Boston, cambridge-ma-fire is in Cambridge.
// That inference is the single biggest geocoding win in the pipeline, because
// a transmission with no town cannot be placed on the map, cannot join the
// scene it belongs to, and cannot be found by a search that names a
// neighbourhood. All three of this tool's jobs run through it.
//
// The table that does it existed twice, character for character, in
// regexExtract and in mapFields. Two copies of one fact is one place to fix
// and one place to forget, and the forgotten place was worse than a stale
// copy: api/ingest.js called mapFields with no feed argument at all on the
// mini path, so every transmission the Mac's own model extracted, which is
// most of them when the relay is doing its job, arrived with town: null.
//
// One table now, and the arguments are threaded from the ingest through
// extractBatch to both models and to the regex fallback.

'use strict';

const path = require('path');
const fs = require('fs');
const ex = require('../lib/extractor');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fail++;
  console.log('  FAIL ' + name + (extra ? '  ' + extra : ''));
}

/* --- the table, wherever it is asked from -------------------------------- */

const CASES = [
  ['boston-police', 'Boston'],
  ['bostonfire', 'Boston'],
  ['cambridge-ma-police', 'Cambridge'],
  ['somerville-fire', 'Somerville'],
  ['brookline-police', 'Brookline'],
  ['needham-fire', 'Needham'],
  ['quincy-police', 'Quincy'],
  ['mbta-transit-police', 'Boston'],
  ['mit-police', 'Cambridge'],
];
for (const [feed, town] of CASES) {
  ok('the feed names the town: ' + feed, ex.townFromFeed(feed) === town, String(ex.townFromFeed(feed)));
}

ok('a state feed covering forty towns guesses none of them',
   ex.townFromFeed('mass-state-police') === null, String(ex.townFromFeed('mass-state-police')));
ok('and neither does a feed nobody recognises',
   ex.townFromFeed('channel-17') === null, String(ex.townFromFeed('channel-17')));

/* Configuration beats string matching on a channel label. */
ok('a feed that declares exactly one town is believed over its own name',
   ex.townFromFeed('metrofire-northwest', ['Needham']) === 'Needham');
ok('and a feed that declares forty is still not guessed at',
   ex.townFromFeed('metrofire-northwest', ['Needham', 'Newton', 'Wellesley']) === null);

/* --- both extraction paths reach it -------------------------------------- */

ok('the regex path infers the town',
   ex.regexExtract('Engine 3 responding, alarm activation.', 'cambridge-ma-fire').town === 'Cambridge');
ok('the model path infers the town',
   ex.mapFields({ call_type: 'alarm' }, 'cloud', 'Engine 3 responding.', 'boston-fire').town === 'Boston');
ok('the mini path infers the town, which is the one that was broken',
   ex.mapFields({ call_type: 'alarm' }, 'mini', 'Engine 3 responding.', 'boston-fire').town === 'Boston');

/* A town the model actually heard is never overwritten by the feed's guess. */
ok('a spoken town beats the feed',
   ex.mapFields({ town: 'Quincy' }, 'cloud', 'Responding to Quincy.', 'boston-police').town === 'Quincy');

/* --- the wiring, which is what actually broke ---------------------------- */

{
  const root = path.join(__dirname, '..');
  const src = fs.readFileSync(path.join(root, 'lib', 'extractor.js'), 'utf8');
  const table = (src.match(/includes\('winthrop'\)|\['winthrop'/g) || []).length;
  ok('the town table exists exactly once', table === 1, table + ' copies found');

  const ing = fs.readFileSync(path.join(root, 'api', 'ingest.js'), 'utf8');
  ok('the ingest hands mapFields the feed on the mini path',
     /mapFields\(raw,\s*'mini',\s*fresh\[i\]\.text,\s*fresh\[i\]\.src/.test(ing),
     'mini extraction is still dropping the feed');
  ok('and hands extractBatch the declared coverage too',
     /towns:\s*fresh\[i\]\.towns/.test(ing));

  /* o is the raw model output. It never carried _feedSrc, so the noise rescue
     was always running against undefined. */
  ok('the noise rescue reads the feed argument, not a field that never existed',
     !/o\._feedSrc/.test(src), 'carriesFact is still passed o._feedSrc');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
