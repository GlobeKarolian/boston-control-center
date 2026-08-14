// tools/test-wiring.js
//
// The seams between files, which is where this system actually breaks.
//
// Every individual piece here was correct on 14 August. lib/stream.js emitted
// a well-formed row. lib/analyst-core.js labelled every line with its feed.
// lib/severity.js scored a scene properly. api/cron/analyst.js selected a
// situation's own transmissions and weighed them.
//
// And Situations Mode could not have shown a card if the city had burned
// down, because stream called the feed `src` and analyst-core read `source`.
// Every line the model saw was tagged "[undefined]", it copied that into
// `feeds` exactly as instructed, feedsHeard dropped the unknown tag, and the
// analyst then selected each situation's transmissions with
// feeds.includes(r.feed) against an empty list. So the severity floor scored
// every situation over zero transmissions, everything settled below 3, and
// major was false for all of them. Forever. Nothing logged, nothing failed,
// no test caught it, because no test crossed the seam.
//
// These do.

'use strict';

const stream = require('../lib/stream');
const core = require('../lib/analyst-core');
const severity = require('../lib/severity');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fail++;
  console.log('  FAIL ' + name + (extra ? '  ' + extra : ''));
}

/* A vault row, in the shape lib/stream.js actually reads out of the vault. */
const vaultRow = (over) => Object.assign({
  at: '2026-08-14T06:24:10.000Z',
  feed: 'boston-ems',
  text: 'Stabbing to Dunkin Donuts, 510 South Hampton Street. 224-21.',
  units: ['A21'],
  callType: 'stabbing',
  tier: 3,
  signals: [{ id: 'stabbing', tier: 3, label: 'stabbing' }],
  clip: 'https://example/clip.m4a',
}, over || {});

/* --- the seam that broke ---------------------------------------------- */

const listen = stream.forListening(vaultRow());

ok('forListening carries the feed under the name the UI reads', listen.src === 'boston-ems');
ok('and under the name analyst-core reads', listen.source === 'boston-ems');
ok('and under the name the analyst filters on', listen.feed === 'boston-ems');

const line = core.linesOf([listen]);
ok('so the model is shown a real feed tag, not [undefined]',
   line.indexOf('[boston-ems]') === 0, JSON.stringify(line.slice(0, 40)));
ok('and never the literal string undefined', line.indexOf('undefined') === -1, line.slice(0, 60));

/* A row that genuinely has no feed must not print "undefined" either, because
   the model is instructed to copy the tag verbatim and would copy that. */
const orphan = core.linesOf([{ text: 'something', at: '2026-08-14T06:00:00.000Z' }]);
ok('an unnamed feed says so rather than saying undefined',
   orphan.indexOf('[unknown-feed]') === 0, orphan.slice(0, 40));

/* --- the second seam: feeds -> the situation's own transmissions -------- */

const heard = new Map([['boston-ems', 'boston-ems'], ['boston-police', 'boston-police']]);
const feeds = core.feedsHeard(['boston-ems'], heard);
ok('a tag copied off a real line survives feedsHeard', feeds.length === 1 && feeds[0] === 'boston-ems',
   JSON.stringify(feeds));
ok('the old broken tag would not have', core.feedsHeard(['undefined'], heard).length === 0);

/* This is the filter api/cron/analyst.js runs. With feeds:[] it matched
   nothing, which is what zeroed every severity floor. */
const rows = [vaultRow(), vaultRow({ at: '2026-08-14T06:26:00.000Z', text: 'Ambulance 21 on scene, 510 South Hampton.' })];
const mine = rows.filter(r => feeds.includes(r.feed));
ok('a situation can find its own transmissions', mine.length === 2, 'got ' + mine.length);

/* --- the third seam: signals survive into the floor -------------------- */

ok('signals stay as objects so severity can read id and tier',
   Array.isArray(listen.signals) && listen.signals[0] && listen.signals[0].id === 'stabbing',
   JSON.stringify(listen.signals));
ok('and a flat list is still there for anything that wants labels',
   Array.isArray(listen.signalIds) && listen.signalIds[0] === 'stabbing');

const flOnListened = severity.floor({
  tx: [stream.forListening(vaultRow())], feeds: ['boston-ems'], units: ['A21'],
  spanMin: 2, anomaly: { level: 'normal' },
});
ok('a stabbing reaches a story through the listening shape, not just the raw one',
   flOnListened.score >= 3, 'floor=' + flOnListened.score + ' ' + JSON.stringify(flOnListened.reasons));

/* --- end to end: the Dunkin Donuts stabbing ---------------------------- */

const fl = severity.floor({ tx: mine, feeds, units: ['A21'], spanMin: 2, anomaly: { level: 'normal' } });
const settled = severity.settle(fl, { score: 4 });
ok('so the stabbing settles at or above the bar Situations requires',
   settled.score >= 3, 'settled=' + settled.score);

/* And the failure mode itself: zero transmissions must never look like a
   story. This is the state every situation was in. */
const starved = severity.floor({ tx: [], feeds: [], units: [], spanMin: 0, anomaly: { level: 'normal' } });
ok('a situation with no transmissions scores nothing, as it did all night',
   starved.score < 3, 'floor=' + starved.score);

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
