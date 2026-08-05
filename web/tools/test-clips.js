/* tools/test-clips.js - what a clip is called, where it lives, and when it goes.
   node tools/test-clips.js */

const C = require('../app/clips.js');

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

// ---------------------------------------------------------------------------

head('feed slugs survive whatever was typed into the Mac app');
{
  eq('a clean slug is left alone', C.slug('mass-state-police'), 'mass-state-police');
  eq('spaces and capitals come out as a path-safe string', C.slug('Boston Fire Department'),
    'boston-fire-department');
  eq('punctuation collapses rather than repeating', C.slug('MSP // Troop  H!!'), 'msp-troop-h');
  eq('leading and trailing junk is trimmed, not left as a dash', C.slug('  -bpd-  '), 'bpd');
  eq('nothing usable still gives a folder name', C.slug('!!!'), 'unknown');
  eq('missing gives a folder name too', C.slug(undefined), 'unknown');
  ok('and it never grows past a sane length',
    C.slug('x'.repeat(200)).length <= 48);
}

head('the storage path sorts by day first, because retention reads it back');
{
  const row = { src: 'mass-state-police', at: '2026-08-04T04:48:12.000Z' };
  eq('a UTC day folder, a feed folder, and the name a reporter should get',
    C.pathFor(row),
    'clips/2026-08-04/mass-state-police/mass-state-police-2026-08-04-004812-et.m4a');
  eq('the transcript row shape works too, not just the relay item shape',
    C.pathFor({ source: 'boston-police', time: '2026-08-04T04:48:12Z' }),
    'clips/2026-08-04/boston-police/boston-police-2026-08-04-004812-et.m4a');
  // The last segment is the whole reason the path is shaped this way: Blob
  // names the download after the stored path, and a cross-origin link cannot
  // override it from the page.
  eq('the last segment is exactly what downloadName says',
    C.pathFor(row).split('/').pop(), C.downloadName(row));
  eq('an unparseable time gets no path at all, so nothing is filed under 1970',
    C.pathFor({ src: 'a', at: 'sometime tuesday' }), '');
  eq('and neither does junk', C.pathFor(null), '');
  ok('the day folder is still the first thing after clips/, which is what the sweep reads',
    /^clips\/\d{4}-\d{2}-\d{2}\//.test(C.pathFor(row)));
  // 20:00 Eastern is already the next UTC day. The folder and the filename
  // disagree on the date on purpose, and this is the case that proves it is on
  // purpose rather than an accident nobody noticed.
  const evening = { src: 'msp', at: '2026-08-05T00:30:00Z' };
  eq('an evening transmission is filed under the UTC day',
    C.pathFor(evening).split('/')[1], '2026-08-05');
  eq('but named for the Eastern evening it actually was',
    C.pathFor(evening).split('/').pop(), 'msp-2026-08-04-203000-et.m4a');
}

head('the day folder is UTC, so it is one folder that always exists');
{
  eq('an evening in Boston is already tomorrow in the folder',
    C.dayOf('2026-08-04T23:30:00-04:00'), '2026-08-05');
  eq('midnight UTC lands on the day it starts, not the one it ends',
    C.dayOf('2026-08-04T00:00:00Z'), '2026-08-04');
  eq('the last second of a UTC day is still that day',
    C.dayOf('2026-08-04T23:59:59Z'), '2026-08-04');
  eq('junk gives an empty string rather than a folder called NaN',
    C.dayOf('not a date'), '');
}

head('the download name is Eastern, because that is the newsroom');
{
  eq('an 04:48 UTC transmission files as the 12:48am it actually was',
    C.downloadName({ src: 'mass-state-police', at: '2026-08-04T04:48:12Z' }),
    'mass-state-police-2026-08-04-004812-et.m4a');
  // Same instant, two ways of writing it. If these disagree the parser is
  // reading the offset and not the clock.
  eq('an explicit offset gives the same answer as the Z form',
    C.downloadName({ src: 'msp', at: '2026-08-04T00:48:12-04:00' }),
    C.downloadName({ src: 'msp', at: '2026-08-04T04:48:12Z' }));
  eq('and winter is one hour further off, which is the whole reason to use Intl',
    C.downloadName({ src: 'msp', at: '2026-01-15T05:30:00Z' }),
    'msp-2026-01-15-003000-et.m4a');
  eq('a clip with no usable time is still downloadable, just plainly named',
    C.downloadName({ src: 'msp', at: '' }), 'msp.m4a');
  ok('the name always ends in the extension a player will recognise',
    /\.m4a$/.test(C.downloadName({ src: 'msp', at: '2026-08-04T04:48:12Z' })));
}

head('a clip URL is checked on its host, not on whether the string looks right');
{
  const real = 'https://ce0rcu23vrrdzqap.public.blob.vercel-storage.com/clips/x.m4a';
  ok('the real thing passes', C.ok(real));
  ok('a private store passes too, since the plan may change',
    C.ok('https://abc.private.blob.vercel-storage.com/clips/x.m4a'));
  ok('http is refused even on the right host',
    !C.ok('http://abc.public.blob.vercel-storage.com/clips/x.m4a'));
  // The reason this check parses instead of matching a substring.
  ok('a hostile host that merely contains the string is refused',
    !C.ok('https://evil.example.com/?x=.blob.vercel-storage.com'));
  ok('and so is one that ends with it as a word rather than as a domain',
    !C.ok('https://notblob.vercel-storage.com.evil.example.com/x.m4a'));
  ok('a bare path is refused, because a relative src would hit our own origin',
    !C.ok('/clips/x.m4a'));
  ok('so is javascript:', !C.ok('javascript:alert(1)'));
  ok('so is data:', !C.ok('data:audio/mp4;base64,AAAA'));
  ok('empty is refused without throwing', !C.ok(''));
  ok('and so is junk', !C.ok(null) && !C.ok(undefined) && !C.ok({}));
}

head('the download link is the same object asked for as an attachment');
{
  const real = 'https://ce0rcu23vrrdzqap.public.blob.vercel-storage.com/clips/x.m4a';
  eq('a plain URL gets the flag on a fresh query string',
    C.downloadUrl(real), real + '?download=1');
  eq('a URL that already has a query gets it appended',
    C.downloadUrl(real + '?v=2'), real + '?v=2&download=1');
  eq('a URL that failed the host check gets no link at all',
    C.downloadUrl('https://evil.example.com/x.m4a'), '');
  eq('and neither does junk', C.downloadUrl(null), '');
}

head('retention reads the day out of the path and nothing else');
{
  const now = '2026-08-04T12:00:00Z';
  ok('a clip from three weeks ago is gone',
    C.expired('clips/2026-07-14/msp/010101.m4a', 7, now));
  ok('a clip from this morning stays',
    !C.expired('clips/2026-08-04/msp/010101.m4a', 7, now));
  // The boundary, both sides, because off-by-one here deletes a day of audio
  // a reporter is still working from.
  ok('the oldest day inside the window stays',
    !C.expired('clips/2026-07-28/msp/010101.m4a', 7, now));
  ok('the day before that goes',
    C.expired('clips/2026-07-27/msp/010101.m4a', 7, now));
  ok('a longer window keeps more', !C.expired('clips/2026-07-14/msp/x.m4a', 30, now));
  ok('a zero-day window still keeps today, so a sweep cannot eat a live clip',
    !C.expired('clips/2026-08-04/msp/x.m4a', 0, now));
  // Anything not under clips/ is not ours to delete. This is the guard that
  // stops a sweep from touching a blob some other part of the app wrote.
  ok('a path outside clips/ is never expired, whatever its date',
    !C.expired('backups/2020-01-01/db.sql', 7, now));
  ok('a path with no date folder is never expired',
    !C.expired('clips/msp/010101.m4a', 7, now));
  ok('junk is never expired', !C.expired(null, 7, now) && !C.expired('', 7, now));
}

head('a sweep asks about a window of days, so a missed cron catches up');
{
  const days = C.sweepDays(7, '2026-08-04T12:00:00Z', 3);
  eq('starting at the cutoff and walking backwards',
    days, ['2026-07-28', '2026-07-27', '2026-07-26']);
  ok('every day it names is one expired() agrees about',
    days.every((d) => C.expired('clips/' + d + '/msp/x.m4a', 7, '2026-08-04T12:00:00Z')
      || d === '2026-07-28'));
  ok('the list is bounded however silly the argument',
    C.sweepDays(7, '2026-08-04T12:00:00Z', 9999).length <= 60);
  ok('and it is never empty', C.sweepDays(7, '2026-08-04T12:00:00Z', 0).length > 0);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
