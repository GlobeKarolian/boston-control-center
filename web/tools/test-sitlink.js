// tools/test-sitlink.js
// Round trips through api/sitlink.js against an in-process store.
//
// No test framework, same reason as tools/test-threads.js: this repo has no
// dependencies and adding one so a route handler can be driven is a poor
// trade. Run it with `node tools/test-sitlink.js`. Exit code is the answer.
//
// What is being checked is not that the handler returns 200. It is that a
// person who drags one card onto another gets a board that stays that way,
// and that the same person can put it back.

const kv = require('../lib/kv');
const { K } = require('../lib/store-io');
const { alertKey } = require('../lib/threads');
const handler = require('../api/sitlink');

const LINKS = 'bcc:sit:links';
const KEEP = 'bcc:sit:undo';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fail++;
  console.log('  FAIL  ' + name + (extra === undefined ? '' : '\n        ' + JSON.stringify(extra)));
}
function eq(name, got, want) { ok(name + '  (got ' + JSON.stringify(got) + ')', got === want); }
function section(t) { console.log('\n' + t); }

/* ---- fixtures ------------------------------------------------------------- */

const minsAgo = m => new Date(Date.now() - m * 60000).toISOString();

function sit(o) {
  const s = Object.assign({
    headline: '', summary: '', type: 'other', priority: 'normal', confidence: 'reported',
    location: '', lat: null, lon: null, matched: null, approx: true,
    status: 'developing', firstSeen: minsAgo(10), updated: minsAgo(2), events: null,
  }, o);
  if (!s.events) s.events = [{ at: s.firstSeen, kind: 'opened', text: s.headline, type: s.type }];
  s.alertKey = alertKey(s);
  return s;
}

// The case the whole feature is named after.
const JUMPER = () => sit({
  id: 'water-rescue-aa1111',
  headline: 'Person in the water off the Tobin Bridge',
  type: 'water rescue', priority: 'high', location: 'Tobin Bridge',
  lat: 42.3875, lon: -71.0631, firstSeen: minsAgo(20), updated: minsAgo(3),
});
const BAG = () => sit({
  id: 'suspicious-package-bb2222',
  headline: 'Bag reported on the walkway',
  type: 'suspicious package', priority: 'high', location: 'Tobin Bridge walkway',
  lat: 42.3878, lon: -71.0629, firstSeen: minsAgo(6), updated: minsAgo(2),
});
const FIRE = () => sit({
  id: 'fire-cc3333', headline: 'Working fire on Boylston',
  type: 'fire', location: '42 Boylston St', lat: 42.3505, lon: -71.0776,
  firstSeen: minsAgo(15), updated: minsAgo(1),
});

/* ---- driving the handler -------------------------------------------------- */

function seed(situations, links) {
  kv._reset();
  kv._put(K.outSituations, situations || []);
  if (links) kv._put(LINKS, links);
}

async function call(payload, method) {
  const req = { method: method || 'POST', body: payload, headers: {} };
  let captured = null;
  const res = {
    _s: 200,
    setHeader() {},
    status(c) { this._s = c; return this; },
    send(b) { captured = { status: this._s, body: typeof b === 'string' ? JSON.parse(b) : b }; },
  };
  await handler(req, res);
  return captured;
}

const board = () => kv._get(K.outSituations);
const table = () => kv._get(LINKS);
const stash = () => kv._get(KEEP) || {};
const find = (list, id) => (list || []).find(s => s.id === id) || null;
const beats = s => (s ? s.events.map(e => e.text) : []);

/* ========================================================================== */

(async function run() {

  section('a merge is what the desk meant by it');
  {
    const [j, b] = [JUMPER(), BAG()];
    seed([j, b]);
    const r = await call({ action: 'merge', id: b.id, into: j.id });

    eq('answers 200', r.status, 200);
    eq('one card left', board().length, 1);
    const card = board()[0];
    eq('the parent kept its id', card.id, j.id);
    eq('the parent kept its headline', card.headline, j.headline);
    ok('the bag is a beat inside it', beats(card).includes(b.headline), beats(card));
    eq('and it is counted as a merge', card.merged, 1);
    eq('the answer carries the new board', r.body.situations.length, 1);
    eq('and says where it went', r.body.into, j.id);

    const t = table();
    eq('the rule is keyed on the id', t.merge[b.id], j.id);
    eq('and on the alert key, so it outlives the card', t.merge[b.alertKey], j.id);
    ok('undo has something to work with', !!stash()[b.id], Object.keys(stash()));
    ok('and the snapshot is not in the table the analyst reads', !('keep' in t), Object.keys(t));
  }

  section('and it survives the machine changing its mind');
  {
    const [j, b] = [JUMPER(), BAG()];
    seed([j, b]);
    await call({ action: 'merge', id: b.id, into: j.id });

    // What the analyst does on its next run: same board, same override table,
    // and the bag comes back over the radio as a brand new report.
    const { reconcile } = require('../lib/threads');
    const fresh = {
      headline: 'Unattended bag on the Tobin walkway', summary: '', type: 'suspicious package',
      priority: 'high', confidence: 'reported', location: 'Tobin Bridge walkway',
      lat: 42.3878, lon: -71.0629, matched: null, status: 'developing',
    };
    fresh.proposedId = alertKey(fresh);
    const r = reconcile(board(), [fresh], table());

    eq('it does not come back as a second card', r.situations.length, 1);
    eq('it lands inside the thread', r.situations[0].id, j.id);
    eq('without stealing the headline', r.situations[0].headline, j.headline);
    ok('as a beat', beats(r.situations[0]).includes(fresh.headline), beats(r.situations[0]));
  }

  section('undo puts the card back');
  {
    const [j, b] = [JUMPER(), BAG()];
    seed([j, b]);
    await call({ action: 'merge', id: b.id, into: j.id });
    const r = await call({ action: 'undo', id: b.id });

    eq('answers 200', r.status, 200);
    eq('two cards again', board().length, 2);
    const back = find(board(), b.id);
    ok('the bag is back', !!back);
    eq('with its own headline', back && back.headline, b.headline);
    const parent = find(board(), j.id);
    ok('and out of the thread', !beats(parent).includes(b.headline), beats(parent));
    eq('the merge count came back down', parent.merged, 0);
    eq('the answer says what it restored', r.body.restored, b.id);

    const t = table();
    eq('the id rule is gone', t.merge[b.id], undefined);
    eq('the alert key rule is gone too', t.merge[b.alertKey], undefined);
    ok('and so is the snapshot', !stash()[b.id]);
  }

  section('undo really means it, not just for one run');
  {
    const [j, b] = [JUMPER(), BAG()];
    seed([j, b]);
    await call({ action: 'merge', id: b.id, into: j.id });
    await call({ action: 'undo', id: b.id });

    const { reconcile } = require('../lib/threads');
    const r = reconcile(board(), [], table());
    eq('still two cards after a quiet analyst pass', r.situations.length, 2);
  }

  section('pulling one beat out of a thread');
  {
    const j = JUMPER();
    const at = minsAgo(4);
    j.events.push({ at, kind: 'linked', text: 'Bag reported on the walkway', type: 'suspicious package' });
    seed([j]);

    const r = await call({ action: 'split', id: j.id, at });
    eq('answers 200', r.status, 200);
    eq('two cards now', board().length, 2);

    const parent = find(board(), j.id);
    ok('the thread lost the beat', !beats(parent).includes('Bag reported on the walkway'), beats(parent));
    eq('and kept its headline', parent.headline, j.headline);

    const born = find(board(), r.body.spawned);
    ok('the beat became a card', !!born);
    eq('carrying its own words', born && born.headline, 'Bag reported on the walkway');
    eq('and its own type', born && born.type, 'suspicious package');
    eq('inheriting the pin so it stays on the map', born && born.lat, j.lat);
    eq('never at high priority', born && born.priority, 'normal');
    eq('and knowing where it came from', table().split[born.id], j.id);
  }

  section('and the split holds against the model');
  {
    const j = JUMPER();
    const at = minsAgo(4);
    j.events.push({ at, kind: 'linked', text: 'Bag reported on the walkway', type: 'suspicious package' });
    seed([j]);
    const r = await call({ action: 'split', id: j.id, at });
    const bornId = r.body.spawned;

    const { reconcile } = require('../lib/threads');
    const fresh = {
      headline: 'Bag still on the Tobin walkway', summary: '', type: 'suspicious package',
      priority: 'normal', confidence: 'reported', location: 'Tobin Bridge walkway',
      lat: 42.3878, lon: -71.0629, matched: null, status: 'developing',
      relatedTo: j.id,
    };
    fresh.proposedId = alertKey(fresh);
    const out = reconcile(board(), [fresh], table());

    const parent = find(out.situations, j.id);
    ok('the model cannot put it back', !beats(parent).some(t => /still on the Tobin/.test(t)), beats(parent));
    ok('it joins its own card instead', beats(find(out.situations, bornId)).some(t => /still on the Tobin/.test(t)));
    eq('and no third card appears', out.situations.length, 2);
  }

  section('undo of a split folds the beat back');
  {
    const j = JUMPER();
    const at = minsAgo(4);
    j.events.push({ at, kind: 'linked', text: 'Bag reported on the walkway', type: 'suspicious package' });
    seed([j]);
    const s = await call({ action: 'split', id: j.id, at });
    const bornId = s.body.spawned;

    const r = await call({ action: 'undo', id: bornId });
    eq('answers 200', r.status, 200);
    eq('it went home', r.body.folded, j.id);
    eq('one card again', board().length, 1);
    ok('with the beat back inside', beats(board()[0]).includes('Bag reported on the walkway'), beats(board()[0]));
    eq('and the block lifted', table().split[bornId], undefined);
  }

  section('pinning a card standalone');
  {
    const [j, b] = [JUMPER(), BAG()];
    seed([j, b]);
    const r = await call({ action: 'split', id: b.id });
    eq('answers 200', r.status, 200);
    eq('both cards still there', board().length, 2);
    eq('the pin is recorded', table().split[b.id], true);
    eq('on the alert key too', table().split[b.alertKey], true);

    const { reconcile } = require('../lib/threads');
    const fresh = {
      headline: 'Bag on the walkway, second call', summary: '', type: 'suspicious package',
      priority: 'normal', confidence: 'reported', location: 'Tobin Bridge walkway',
      lat: 42.3878, lon: -71.0629, matched: null, status: 'developing', relatedTo: j.id,
    };
    fresh.proposedId = alertKey(fresh);
    const out = reconcile(board(), [fresh], table());
    ok('and nothing swallows it', !beats(find(out.situations, j.id)).includes(fresh.headline));
  }

  section('a merge overrules an earlier split of the same thing');
  {
    const [j, b] = [JUMPER(), BAG()];
    seed([j, b]);
    await call({ action: 'split', id: b.id });
    await call({ action: 'merge', id: b.id, into: j.id });
    eq('the pin is gone', table().split[b.id], undefined);
    eq('the merge stands', table().merge[b.id], j.id);
    eq('and the board shows it', board().length, 1);
  }

  section('chains flatten instead of breaking');
  {
    const [j, b, f] = [JUMPER(), BAG(), FIRE()];
    seed([j, b, f]);
    await call({ action: 'merge', id: b.id, into: j.id });
    const r = await call({ action: 'merge', id: j.id, into: f.id });

    eq('answers 200', r.status, 200);
    eq('one card left', board().length, 1);
    eq('and it is the last target', board()[0].id, f.id);
    eq('the bag follows the card it was inside', table().merge[b.id], f.id);
    ok('every beat came along', beats(board()[0]).includes(b.headline), beats(board()[0]));
  }

  section('merging into something on its way out lands at the far end');
  {
    const [j, b, f] = [JUMPER(), BAG(), FIRE()];
    seed([j, b, f], { merge: { [j.id]: f.id }, split: {}, keep: {}, at: {} });
    // j is already destined for f. Dropping b onto j should mean f.
    const r = await call({ action: 'merge', id: b.id, into: j.id });
    eq('the rule points past it', r.body.into, f.id);
    eq('one card left', board().length, 1);
    eq('and it is f', board()[0].id, f.id);
    ok('carrying the bag', beats(board()[0]).includes(b.headline), beats(board()[0]));
  }

  section('the things it must refuse');
  {
    const [j, b] = [JUMPER(), BAG()];
    // Two beats, so the "nothing left to split from" guard is not what
    // answers the bad-timestamp case below.
    j.events.push({ at: minsAgo(5), kind: 'update', text: 'Divers in the water', type: j.type });
    seed([j, b]);
    eq('no id', (await call({ action: 'merge' })).status, 400);
    eq('unknown card', (await call({ action: 'merge', id: 'nope', into: j.id })).status, 404);
    eq('unknown target', (await call({ action: 'merge', id: b.id, into: 'nope' })).status, 404);
    eq('into itself', (await call({ action: 'merge', id: b.id, into: b.id })).status, 400);
    eq('no such beat', (await call({ action: 'split', id: j.id, at: '2020-01-01T00:00:00.000Z' })).status, 404);
    eq('unknown verb', (await call({ action: 'frobnicate', id: j.id })).status, 400);
    eq('wrong method', (await call({ action: 'merge', id: b.id, into: j.id }, 'DELETE')).status, 405);
    eq('and the board was not touched', board().length, 2);
  }

  section('a dead store does not eat the board');
  {
    const [j, b] = [JUMPER(), BAG()];
    seed([j, b]);
    kv.raw.fail = 'ERR max requests limit exceeded. Limit: 500000, Usage: 500000';
    const r = await call({ action: 'merge', id: b.id, into: j.id });
    kv.raw.fail = null;
    eq('it says so', r.status, 503);
    ok('and says why', /max requests/.test(r.body.error), r.body.error);
    eq('the board is untouched', board().length, 2);
  }

  section('reading the table back');
  {
    const [j, b] = [JUMPER(), BAG()];
    seed([j, b]);
    await call({ action: 'merge', id: b.id, into: j.id });
    const r = await call(null, 'GET');
    eq('answers 200', r.status, 200);
    eq('with the rule in it', r.body.merge[b.id], j.id);
    eq('and the count', r.body.situations, 1);
    ok('and what can be undone', r.body.undoable.includes(b.id), r.body.undoable);
  }

  section('old corrections age out');
  {
    const [j, b] = [JUMPER(), BAG(), FIRE()];
    const old = new Date(Date.now() - 9 * 24 * 3600 * 1000).toISOString();
    seed([j, b], {
      merge: { 'ancient-card': 'ancient-target' },
      split: { 'ancient-other': true },
      at: { 'ancient-card': old, 'ancient-other': old },
    });
    kv._put(KEEP, { 'ancient-card': { kind: 'merge', into: 'x', at: old, card: { id: 'ancient-card' } } });
    await call({ action: 'merge', id: b.id, into: j.id });
    const t = table();
    eq('the nine day old merge is gone', t.merge['ancient-card'], undefined);
    eq('so is the nine day old split', t.split['ancient-other'], undefined);
    eq('their timestamps went with them', t.at['ancient-card'], undefined);
    eq('the nine day old snapshot is gone', stash()['ancient-card'], undefined);
    eq('and today\'s rule stayed', t.merge[b.id], j.id);
  }

  section('splitting the only beat out of a card is refused');
  {
    const j = JUMPER();
    seed([j]);
    const r = await call({ action: 'split', id: j.id, at: j.events[0].at });
    eq('it says no', r.status, 400);
    ok('and says why', /only beat/.test(r.body.error), r.body.error);
    eq('and nothing was duplicated', board().length, 1);
  }

  section('the snapshot ceiling holds');
  {
    const j = JUMPER();
    const stale = {};
    for (let i = 0; i < 60; i++) {
      stale['old-' + i] = { kind: 'merge', into: 'x', at: minsAgo(600 - i), card: { id: 'old-' + i, events: [] } };
    }
    const b = BAG();
    seed([j, b]);
    kv._put(KEEP, stale);
    await call({ action: 'merge', id: b.id, into: j.id });
    const s = stash();
    ok('trimmed to the ceiling', Object.keys(s).length <= 40, Object.keys(s).length);
    ok('the newest correction survived', !!s[b.id], Object.keys(s).slice(0, 5));
    ok('and the oldest did not', !s['old-0']);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
