// tools/race-check.js
//
// Does an analyst run that started BEFORE a newsroom drag clobber the drag?
//
// The analyst reads the board at the top of its handler, then goes off to call
// the model and geocode, which takes seconds. Anything the desk does inside
// that window is invisible to the write that lands at the end of it. This
// script makes that window explicit and shows what survives it.
//
// Timestamps are pinned to constants on purpose. An earlier version of this
// script recomputed the beat time at the call site and only passed when both
// calls happened to land in the same millisecond, which made a real bug look
// like a flake and a flake look like a real bug.

const kv = require('../lib/kv');
const { K } = require('../lib/store-io');
const { reconcile, alertKey } = require('../lib/threads');
const handler = require('../api/sitlink');

const LINKS = 'bcc:sit:links';
const iso = (m) => new Date(Date.now() - m * 60000).toISOString();
const OPENED = iso(20);
const BAG = iso(6);

const card = (o) => {
  const s = Object.assign({
    type: 'other', priority: 'normal', confidence: 'reported',
    location: 'Tobin Bridge', lat: 42.3875, lon: -71.0631,
    status: 'developing', firstSeen: OPENED, updated: iso(2),
  }, o);
  s.events = s.events || [{ at: s.firstSeen, kind: 'opened', text: s.headline, type: s.type }];
  s.alertKey = alertKey(s);
  return s;
};

const call = async (payload) => {
  let captured = null;
  const res = {
    _s: 200, setHeader() {}, status(x) { this._s = x; return this; },
    send(b) { captured = { status: this._s, body: JSON.parse(b) }; },
  };
  await handler({ method: 'POST', body: payload, headers: {} }, res);
  return captured;
};

const thread = () => card({
  id: 'water-rescue-a', headline: 'Person in the water', type: 'water rescue',
  events: [
    { at: OPENED, kind: 'opened', text: 'Person in the water', type: 'water rescue' },
    { at: BAG, kind: 'linked', text: 'Bag on the walkway', type: 'suspicious package' },
  ],
});

const heads = () => (kv._get(K.outSituations) || []).map((s) => s.headline).sort();

let failed = 0;
function is(label, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { console.log('  ok   ' + label + '  ' + a); return; }
  failed++;
  console.log('  FAIL ' + label + '\n         got  ' + a + '\n         want ' + b);
}

(async () => {
  // ---- 1. the drag itself lands -------------------------------------------
  console.log('\nthe desk pulls the bag out of the thread');
  kv._reset();
  kv._put(K.outSituations, [thread()]);
  const r = await call({ action: 'split', id: 'water-rescue-a', at: BAG });
  if (!r || r.status !== 200) throw new Error('split did not take: ' + JSON.stringify(r));
  is('board right after the drag', heads(), ['Bag on the walkway', 'Person in the water']);
  const bornId = r.body.spawned;

  // ---- 2. a stale analyst clobbers it -------------------------------------
  // Sequence: analyst reads, desk drags, analyst writes what it read.
  console.log('\nan analyst that read the board BEFORE the drag, and wrote after it');
  kv._reset();
  kv._put(K.outSituations, [thread()]);
  const [staleLinks, staleSits] = await kv.raw([['GET', LINKS], ['GET', K.outSituations]]);
  await call({ action: 'split', id: 'water-rescue-a', at: BAG });
  const stale = reconcile(JSON.parse(staleSits), [], JSON.parse(staleLinks || '{}'));
  await kv.raw([['SET', K.outSituations, JSON.stringify(stale.situations)]]);
  is('the split card is gone', heads(), ['Person in the water']);
  is('and nothing on the board is the card that was minted',
    (kv._get(K.outSituations) || []).some((s) => s.id === bornId), false);

  // ---- 3. the same sequence, re-reading immediately before the write -------
  console.log('\nthe same analyst, re-reading the board and the table before it writes');
  kv._reset();
  kv._put(K.outSituations, [thread()]);
  await kv.raw([['GET', LINKS], ['GET', K.outSituations]]);          // the stale read
  const r3 = await call({ action: 'split', id: 'water-rescue-a', at: BAG });   // the drag
  const [freshLinks, freshSits] = await kv.raw([['GET', LINKS], ['GET', K.outSituations]]);
  const fresh = reconcile(JSON.parse(freshSits), [], JSON.parse(freshLinks || '{}'));
  await kv.raw([['SET', K.outSituations, JSON.stringify(fresh.situations)]]);
  is('both cards survive', heads(), ['Bag on the walkway', 'Person in the water']);
  // mintId salts its hash with Math.random(), so the id from the first section
  // is not the id this one produced. Ask this section for its own.
  is('and the card that survived is the one this drag minted',
    (kv._get(K.outSituations) || []).some((s) => s.id === r3.body.spawned), true);
  is('which is a card the analyst had never seen', r3.body.spawned !== bornId, true);

  // ---- 4. a merge is only ever late, never lost ---------------------------
  // Worth separating out. A merge rule persists in the link table, so a stale
  // write undoes it on the board and the next tick puts it back. A split mints
  // a card that exists nowhere but the board, so a stale write ends it.
  console.log('\na merge clobbered the same way, then one more analyst tick');
  kv._reset();
  const bag = card({ id: 'susp-b', headline: 'Bag on the walkway', type: 'suspicious package',
    lat: 42.3878, lon: -71.0629, firstSeen: BAG, events: [{ at: BAG, kind: 'opened', text: 'Bag on the walkway', type: 'suspicious package' }] });
  kv._put(K.outSituations, [card({ id: 'water-rescue-a', headline: 'Person in the water', type: 'water rescue' }), bag]);
  const [mLinks, mSits] = await kv.raw([['GET', LINKS], ['GET', K.outSituations]]);
  await call({ action: 'merge', id: 'susp-b', into: 'water-rescue-a' });
  is('the desk merged them', heads(), ['Person in the water']);
  const clobber = reconcile(JSON.parse(mSits), [], JSON.parse(mLinks || '{}'));
  await kv.raw([['SET', K.outSituations, JSON.stringify(clobber.situations)]]);
  is('the stale write splits them back apart', heads(), ['Bag on the walkway', 'Person in the water']);
  const [nextLinks, nextSits] = await kv.raw([['GET', LINKS], ['GET', K.outSituations]]);
  const nextTick = reconcile(JSON.parse(nextSits), [], JSON.parse(nextLinks || '{}'));
  await kv.raw([['SET', K.outSituations, JSON.stringify(nextTick.situations)]]);
  is('and the next tick puts the merge back on its own', heads(), ['Person in the water']);

  console.log('\n' + (failed ? failed + ' FAILED' : 'all clear') + '\n');
  process.exit(failed ? 1 : 0);
})();
