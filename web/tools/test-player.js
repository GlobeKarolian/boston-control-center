/* tools/test-player.js - one audio element, eighty rows, and a queue.

   The rules being checked here are the ones that are obvious in a sentence and
   easy to get wrong in a handler: only one transmission plays at a time,
   switching follow on does not replay the page, a clip that will not load stops
   being offered, and the queue plays radio in the order it was said.

   node tools/test-player.js */

const P = require('../app/player.js');

let pass = 0, fail = 0;

const head = (s) => console.log('\n  ' + s);
const ok = (what, got) => {
  if (got) { pass++; console.log('    ok   ' + what); }
  else { fail++; console.log('    FAIL ' + what); }
};
const eq = (what, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; console.log('    ok   ' + what); }
  else { fail++; console.log('    FAIL ' + what + '\n         got  ' + a + '\n         want ' + b); }
};

const HOST = 'https://tstore123.public.blob.vercel-storage.com/';

/* A transcript row the way the store hands one back, plus the clip field this
   feature adds. n is minutes past the hour, so rows sort by their own name. */
function row(n, src, withClip) {
  const r = {
    time: '2026-08-04T04:' + String(n).padStart(2, '0') + ':00.000Z',
    source: src || 'mass-state-police',
    text: 'transmission ' + n,
  };
  if (withClip !== false) r.clip = HOST + 'clips/x' + n + '.m4a';
  return r;
}

/* The store hands the console back newest first. Every list in this file is
   built that way on purpose, because the queue has to put them back in the
   order they were said and a test that feeds them in already sorted proves
   nothing. */
const newestFirst = (rows) => rows.slice().reverse();

// ---------------------------------------------------------------------------

head('a row is identified the same way everywhere');
{
  P.reset();
  eq('by the time it was said and the feed it was said on',
    P.keyOf({ time: 't', source: 's' }), 't|s');
  eq('the relay shape gives the same answer as the store shape',
    P.keyOf({ at: 't', src: 's' }), P.keyOf({ time: 't', source: 's' }));
  eq('and a row with neither still gives a string rather than throwing',
    P.keyOf(null), '|');
}

head('a click plays, a second click pauses, a third resumes');
{
  P.reset();
  P.see([row(1)]);
  const k = P.keyOf(row(1));
  const a = P.click(k);
  eq('the first click plays', a.do, 'play');
  eq('handing the page the URL the store gave', a.url, HOST + 'clips/x1.m4a');
  eq('and the row says so', P.state(k), 'playing');
  eq('the second click pauses', P.click(k).do, 'pause');
  eq('the row says that too', P.state(k), 'paused');
  eq('the third resumes', P.click(k).do, 'resume');
  eq('back to playing', P.state(k), 'playing');
}

head('clicking a different row replaces, it does not stack');
{
  P.reset();
  P.see([row(2), row(1)]);
  const a = P.keyOf(row(1)), b = P.keyOf(row(2));
  P.click(a);
  const act = P.click(b);
  eq('the new row plays', act.do, 'play');
  eq('with the new URL', act.url, HOST + 'clips/x2.m4a');
  eq('the old row is no longer playing', P.state(a), 'ready');
  eq('and the new one is', P.state(b), 'playing');
}

head('a row with no stored audio is honest about it');
{
  P.reset();
  P.see([row(1, 'msp', false)]);
  const k = P.keyOf(row(1, 'msp'));
  eq('the state says there is nothing to play', P.state(k), 'none');
  eq('clicking does nothing', P.click(k).do, 'nothing');
  ok('and says why in words', /no audio/.test(P.click(k).why));
  ok('the label is something a screen reader can read',
    /No audio/.test(P.label(k)));
}

head('a clip that will not load is not offered again');
{
  P.reset();
  P.see([row(1)]);
  const k = P.keyOf(row(1));
  P.click(k);
  const a = P.failed(k);
  eq('the failure stops playback', a.do, 'stop');
  eq('the row says the clip is dead', P.state(k), 'dead');
  eq('clicking it again does nothing', P.click(k).do, 'nothing');
  ok('and the label explains rather than lying', /would not load/.test(P.label(k)));
}

head('a URL that is not ours is treated as no audio at all');
{
  P.reset();
  P.see([{ time: 't', source: 's', clip: 'https://evil.example.com/x.m4a' }]);
  eq('the row has nothing to play', P.state('t|s'), 'none');
  eq('and clicking it gets nowhere', P.click('t|s').do, 'nothing');
}

// ---------------------------------------------------------------------------
// Follow mode. This is the half John Ellement asked for.
// ---------------------------------------------------------------------------

head('switching follow on does not replay what is already on the page');
{
  P.reset();
  P.see(newestFirst([row(1), row(2), row(3)]));   // the first poll is the baseline
  P.setFollow(true);
  eq('nothing starts from the backlog', P.see(newestFirst([row(3), row(2), row(1)])), null);
  eq('and nothing is queued', P.status().queued, 0);
}
