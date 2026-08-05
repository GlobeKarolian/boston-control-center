// tools/test-threadui.js
//
// Drives app/threadui.js with no browser.
//
// The interesting thing here is not that beats come back sorted. It is the
// rule about which beat a person is allowed to pull out, because the server
// resolves a pull by timestamp alone and a timestamp is not unique. Every
// case below where canPull comes back false is a case where the request would
// have succeeded and removed the wrong beat.
//
//   node tools/test-threadui.js

const TH = require('../app/threadui.js');
const { MAX_SHOWN } = TH._consts;

let pass = 0, fail = 0;
function head(s) { console.log('\n' + s); }
function ok(label, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + label); return; }
  fail++;
  console.log('  FAIL ' + label + (extra === undefined ? '' : '\n         ' + JSON.stringify(extra)));
}
const eq = (label, got, want) => ok(label + '  =  ' + JSON.stringify(got),
  JSON.stringify(got) === JSON.stringify(want), { got, want });

const T0 = 1800000000000;                       // a fixed clock, no Date.now()
const at = (m) => new Date(T0 - m * 60000).toISOString();
const ev = (m, text, o) => Object.assign({ at: at(m), kind: 'linked', text: text, type: 'other' }, o || {});
const card = (events, o) => Object.assign({ id: 'c1', headline: 'Person in the water', events: events }, o || {});
const texts = (sit) => TH.beats(sit).map((b) => b.text);

// ---------------------------------------------------------------------------
head('a thread reads in the order the story happened');
{
  const c = card([
    ev(20, 'Person in the water', { kind: 'opened' }),
    ev(6, 'Bag on the walkway', { type: 'suspicious package' }),
    ev(2, 'Divers in the water'),
  ]);
  eq('oldest first', texts(c), ['Person in the water', 'Bag on the walkway', 'Divers in the water']);
  ok('the first one is flagged', TH.beats(c)[0].first === true);
  ok('and so is the last', TH.beats(c)[2].last === true);
  eq('the collapsed card shows what happened last', TH.latest(c).text, 'Divers in the water');
  eq('three of them', TH.count(c), 3);
  eq('which makes it a thread', TH.isThread(c), true);
  eq('and the chip says so', TH.label(c), '3 beats');
}

head('a card that is only itself is not a thread');
{
  const c = card([ev(20, 'Person in the water', { kind: 'opened' })]);
  eq('one beat', TH.count(c), 1);
  eq('not a thread', TH.isThread(c), false);
  eq('and the chip does not say beats', TH.label(c), '1 beat');
  eq('nothing to pull', TH.beats(c)[0].canPull, false);
  ok('and it says why in words a person could read out loud',
    /nothing to pull it away from/.test(TH.beats(c)[0].why));
}

head('a card with no events at all');
{
  eq('no beats', TH.beats(card(undefined)), []);
  eq('no latest', TH.latest(card(undefined)), null);
  eq('not a thread', TH.isThread(null), false);
  eq('a non-array is survivable', TH.beats({ events: 'nope' }), []);
  eq('and so is nothing whatsoever', TH.beats(undefined), []);
}

head('junk in the events array does not take the thread down');
{
  const c = card([
    null, undefined, 'a string', 42,
    ev(20, 'Person in the water', { kind: 'opened' }),
    { at: at(9) },                                   // no text
    { at: at(8), text: '   ' },                      // whitespace only
    ev(2, 'Divers in the water'),
  ]);
  eq('only the two real ones', texts(c), ['Person in the water', 'Divers in the water']);
  eq('and they are both pullable', TH.beats(c).map((b) => b.canPull), [true, true]);
}

head('an undated beat sorts last rather than dating the whole thread');
{
  const c = card([
    { kind: 'linked', text: 'Somebody heard something' },
    ev(20, 'Person in the water', { kind: 'opened' }),
    ev(2, 'Divers in the water'),
  ]);
  eq('it goes to the bottom', texts(c),
    ['Person in the water', 'Divers in the water', 'Somebody heard something']);
  eq('and it cannot be pulled, because time is the only handle there is',
    TH.beats(c)[2].canPull, false);
}

// ---------------------------------------------------------------------------
// The whole reason this file exists.
head('two beats in the same second, and only one of them can be pulled');
{
  const t = at(6);
  const c = card([
    ev(20, 'Person in the water', { kind: 'opened' }),
    { at: t, kind: 'linked', text: 'Bag on the walkway' },
    { at: t, kind: 'linked', text: 'Coast Guard responding' },
  ]);
  const b = TH.beats(c);
  eq('both are on the card', b.map((x) => x.text),
    ['Person in the water', 'Bag on the walkway', 'Coast Guard responding']);
  eq('the one the server would take offers the control', b[1].canPull, true);
  eq('the other one does not', b[2].canPull, false);
  ok('and it says what would have happened',
    /same second/.test(b[2].why), b[2].why);
  eq('with two words for the space the button would have taken', b[2].tag, 'same second');
  eq('and the one that can be pulled carries no mark at all', b[1].tag, null);
  ok('their keys are still distinct, so the DOM can tell them apart',
    b[1].key !== b[2].key);
}

head('a beat whose timestamp resolves to a beat nobody can see');
{
  // The empty one is dropped from the display and is still index 0 on the
  // server, so a pull sent for this timestamp takes the invisible one.
  const t = at(6);
  const c = card([
    ev(20, 'Person in the water', { kind: 'opened' }),
    { at: t, kind: 'linked', text: '' },
    { at: t, kind: 'linked', text: 'Bag on the walkway' },
  ]);
  const b = TH.beats(c);
  eq('one beat is painted for that second', b.length, 2);
  eq('and it is not offered, because the pull would land somewhere else',
    b[1].canPull, false);
}

// ---------------------------------------------------------------------------
head('a long thread paints its tail');
{
  const many = [];
  for (let i = 0; i < MAX_SHOWN + 3; i++) many.push(ev(200 - i * 5, 'beat ' + i));
  const c = card(many);
  const s = TH.shown(c);
  eq('capped', s.rows.length, MAX_SHOWN);
  eq('and it says how many it is not showing', s.hidden, 3);
  eq('the three it dropped are the oldest', s.rows[0].text, 'beat 3');
  eq('the newest is still there', s.rows[MAX_SHOWN - 1].text, 'beat ' + (MAX_SHOWN + 2));
  eq('and the count is the whole thread, not what fits', TH.count(c), MAX_SHOWN + 3);
}

head('a short thread is not capped');
{
  const c = card([ev(20, 'a', { kind: 'opened' }), ev(2, 'b')]);
  const s = TH.shown(c);
  eq('both', s.rows.length, 2);
  eq('nothing hidden', s.hidden, 0);
}

// ---------------------------------------------------------------------------
head('folding one card into another');
{
  const ids = ['a', 'b'];
  const p = TH.plan('merge', { id: 'a', into: 'b', ids });
  eq('it goes', p.ok, true);
  eq('as the route wants it', p.body, { action: 'merge', id: 'a', into: 'b' });
  ok('with something to say afterwards', typeof p.say === 'string' && p.say.length > 0);
}

head('and the folds that never get sent');
{
  const ids = ['a', 'b'];
  eq('into itself', TH.plan('merge', { id: 'a', into: 'a', ids }).ok, false);
  eq('with nothing to fold', TH.plan('merge', { id: '', into: 'b', ids }).ok, false);
  eq('with nowhere to fold it', TH.plan('merge', { id: 'a', into: '', ids }).ok, false);
  eq('onto a card that has aged off the board', TH.plan('merge', { id: 'a', into: 'gone', ids }).ok, false);
  eq('from a card that has aged off the board', TH.plan('merge', { id: 'gone', into: 'b', ids }).ok, false);
  ok('and the reason is a sentence, not a code',
    / /.test(TH.plan('merge', { id: 'a', into: 'a', ids }).why));
  eq('without a board to check against it still goes, because the route checks too',
    TH.plan('merge', { id: 'a', into: 'b' }).ok, true);
}

head('pinning a card standalone');
{
  const p = TH.plan('split', { id: 'a' });
  eq('no timestamp means pin', p.body, { action: 'split', id: 'a' });
  ok('and it says what pinning means', /threaded into it/.test(p.say));
}

head('pulling one beat out');
{
  const t = at(6);
  const c = card([ev(20, 'Person in the water', { kind: 'opened' }),
    { at: t, kind: 'linked', text: 'Bag on the walkway' }]);
  const p = TH.plan('split', { id: 'c1', at: t, sit: c });
  eq('it goes', p.body, { action: 'split', id: 'c1', at: t });
}

head('and the pulls that never get sent');
{
  const t = at(6);
  const one = card([ev(20, 'Person in the water', { kind: 'opened' })]);
  eq('the only beat on the card', TH.plan('split', { id: 'c1', at: at(20), sit: one }).ok, false);

  const dup = card([ev(20, 'Person in the water', { kind: 'opened' }),
    { at: t, text: 'Bag on the walkway' }, { at: t, text: 'Coast Guard responding' }]);
  const first = TH.plan('split', { id: 'c1', at: t, sit: dup });
  eq('the first of two in the same second still goes', first.ok, true);

  const shadow = card([ev(20, 'Person in the water', { kind: 'opened' }),
    { at: t, text: '' }, { at: t, text: 'Bag on the walkway' }]);
  const s = TH.plan('split', { id: 'c1', at: t, sit: shadow });
  eq('but not when the timestamp resolves to a beat nobody can see', s.ok, false);
  ok('and the refusal carries the reason from the beat itself', /same second/.test(s.why));

  eq('a beat that is no longer on the card',
    TH.plan('split', { id: 'c1', at: at(99), sit: dup }).ok, false);
}

head('undo, and the things that are not verbs');
{
  eq('undo is always worth sending, because only the server knows what it undoes',
    TH.plan('undo', { id: 'a' }).body, { action: 'undo', id: 'a' });
  eq('an unknown action does not', TH.plan('reticulate', { id: 'a' }).ok, false);
  eq('and neither does a verb with no card', TH.plan('undo', {}).ok, false);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
