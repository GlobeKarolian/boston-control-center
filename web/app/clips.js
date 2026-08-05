// app/clips.js
//
// John Ellement asked for audio so he does not have to stare at the screen,
// and Matt asked for a clip a reporter can play and download. This file is the
// naming and the trust check that both ends of that need, kept in one place
// because the relay, the server and the browser all have to agree on it and
// three copies of a filename rule is three chances to disagree.
//
// Nothing here touches the network or the DOM. It decides what a clip is
// called, where it is stored, whether a URL is one of ours, and when it is old
// enough to delete. All four are the kind of thing that is obvious right up
// until it is wrong at 2am, so all four are under test.
//
//   node tools/test-clips.js

(function (root) {
  'use strict';

  /* Where a clip lives.

       clips/2026-08-04/mass-state-police/mass-state-police-2026-08-04-004812-et.m4a

     Date first, and in UTC. Retention is the only thing that reads this path
     back, and retention wants to say "list everything from the fourth and
     delete it", which is one prefix and one pass. Putting the feed first would
     mean walking every feed to find one day. Putting a local date first would
     mean a folder that exists twice a year and one that never does.

     The clock inside the folder is UTC too, for the same reason a log file is:
     it only has to sort. What a reporter reads is a different string, built by
     downloadName below, and that one is Eastern because that is the newsroom
     they work in. */
  var STORE_TZ = 'UTC';
  var SHOW_TZ = 'America/New_York';

  /* Feed slugs arrive from the relay and are whatever somebody typed into the
     Mac app. Anything that is not a letter, a digit or a dash becomes a dash,
     because this string ends up in a URL path and in a filename on a
     reporter's laptop, and both of those have opinions about spaces. */
  function slug(s) {
    var v = String(s === null || s === undefined ? '' : s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
    return v || 'unknown';
  }

  function pad(n, w) {
    var s = String(n);
    while (s.length < w) s = '0' + s;
    return s;
  }

  /* Date parts in a named zone, without pulling in a date library for it.
     Intl is in every runtime this code touches, and it is the only thing in
     the standard library that knows when Massachusetts changes its clocks. */
  function partsIn(d, tz) {
    var out = { y: 1970, m: 1, d: 1, hh: 0, mm: 0, ss: 0 };
    try {
      var f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
      var got = {};
      f.formatToParts(d).forEach(function (p) { got[p.type] = p.value; });
      out.y = +got.year; out.m = +got.month; out.d = +got.day;
      /* Some engines render midnight as hour 24 under hour12:false. Left
         unhandled that puts a clip in the wrong folder once a night. */
      out.hh = (+got.hour) % 24; out.mm = +got.minute; out.ss = +got.second;
    } catch (e) { /* fall through to epoch, which sorts last and is visibly wrong */ }
    return out;
  }

  function whenOf(at) {
    var v = Date.parse(at || '');
    return isNaN(v) ? null : new Date(v);
  }

  /* The day folder, UTC, as YYYY-MM-DD. Exported because retention needs to
     build the same string for "seven days ago" that the uploader built for
     "now", and because a test that cannot name a day cannot test a sweep. */
  function dayOf(at) {
    var d = whenOf(at);
    if (!d) return '';
    var p = partsIn(d, STORE_TZ);
    return p.y + '-' + pad(p.m, 2) + '-' + pad(p.d, 2);
  }

  /* The full storage path: a UTC day folder, a feed folder, and then the name
     a reporter should end up with.

     The last part is the one worth explaining. Vercel Blob serves a download
     with a filename taken from the stored path, and a browser ignores the HTML
     download attribute on a cross-origin link, so the only chance to name the
     file well is here. A reporter who saves a clip to send to an editor should
     get mass-state-police-2026-08-04-004812-et.m4a and not 044812-1841.m4a.

     Which means the folders do the sorting and retention, and the filename does
     the explaining. The feed appears in both, which is redundant inside the
     bucket and load-bearing on somebody's desktop.

     Two transmissions in the same second on the same channel would collide, and
     that is what addRandomSuffix in lib/blob.js is for. Nothing reads this path
     back except the sweep, and the sweep only reads the day. */
  function pathFor(row) {
    var r = row || {};
    var d = whenOf(r.at || r.time);
    if (!d) return '';
    return 'clips/' + dayOf(d.toISOString()) + '/' + slug(r.src || r.source) + '/'
      + downloadName(r);
  }

  /* What the file is called once it is on a reporter's machine.

     Sortable first, readable second, and it says the zone out loud. A clip
     filed under "0448" that turns out to be UTC is a correction, so the string
     carries -et and there is no ambiguity to resolve later. */
  function downloadName(row) {
    var r = row || {};
    var d = whenOf(r.at || r.time);
    var name = slug(r.src || r.source);
    if (!d) return name + '.m4a';
    var p = partsIn(d, SHOW_TZ);
    return name + '-' + p.y + '-' + pad(p.m, 2) + '-' + pad(p.d, 2)
      + '-' + pad(p.hh, 2) + pad(p.mm, 2) + pad(p.ss, 2) + '-et.m4a';
  }

  /* Is this URL one of ours?

     A clip URL travels relay to server to store to browser, and at the far end
     it becomes the src of an audio element. That is a short list of hops but it
     is a list, and the browser should not be willing to fetch an arbitrary
     host because a string in the store said so. So the browser checks the host
     rather than trusting the pipe.

     Vercel Blob serves from <store-id>.public.blob.vercel-storage.com and
     <store-id>.private.blob.vercel-storage.com. Matching the suffix on a
     parsed hostname rather than on the raw string is the point: a URL like
     https://evil.example.com/?x=.blob.vercel-storage.com passes a substring
     test and fails this one. */
  var HOST_RE = /(^|\.)blob\.vercel-storage\.com$/i;

  function ok(url) {
    var u = String(url === null || url === undefined ? '' : url);
    if (!u) return false;
    /* No URL constructor in some older embedded runtimes, so this is written to
       degrade to false rather than to throw. A clip that does not play is a
       missing feature; an exception in a render is a blank column. */
    var parsed = null;
    try { parsed = new URL(u); } catch (e) { return false; }
    if (parsed.protocol !== 'https:') return false;
    return HOST_RE.test(parsed.hostname);
  }

  /* The download variant. Vercel Blob answers the same object with a
     content-disposition attachment header when ?download=1 is present, which is
     what makes a click save the file instead of navigating to it. Kept here
     rather than in the render so the query-string handling is tested once. */
  function downloadUrl(url) {
    if (!ok(url)) return '';
    return url + (url.indexOf('?') === -1 ? '?' : '&') + 'download=1';
  }

  /* Retention. Answers "should this path be swept" for a given cutoff, working
     off the day folder in the path rather than off any metadata, so a sweep
     needs the listing and nothing else.

     Compared as strings on purpose. YYYY-MM-DD sorts lexically the same way it
     sorts chronologically, and string comparison cannot drift by an hour when
     the clocks change. */
  function expired(pathname, days, now) {
    var p = String(pathname || '');
    var m = p.match(/^clips\/(\d{4}-\d{2}-\d{2})\//);
    if (!m) return false;
    var n = (typeof days === 'number' && days >= 0) ? days : 7;
    var base = whenOf(now) || new Date();
    var cutoff = dayOf(new Date(base.getTime() - n * 86400000).toISOString());
    return m[1] < cutoff;
  }

  /* The list of day folders a sweep should ask the store about: every day from
     the cutoff back through the window, so one pass cleans up after however
     many days the crons were not running. Bounded, because an unbounded list
     built from a bad clock is a very expensive way to find nothing. */
  function sweepDays(days, now, back) {
    var out = [], i;
    var n = (typeof days === 'number' && days >= 0) ? days : 7;
    var b = (typeof back === 'number' && back > 0) ? Math.min(back, 60) : 14;
    var base = whenOf(now) || new Date();
    for (i = 0; i < b; i++) {
      out.push(dayOf(new Date(base.getTime() - (n + i) * 86400000).toISOString()));
    }
    return out;
  }

  var API = {
    slug: slug,
    dayOf: dayOf,
    pathFor: pathFor,
    downloadName: downloadName,
    ok: ok,
    downloadUrl: downloadUrl,
    expired: expired,
    sweepDays: sweepDays,
    _tz: { store: STORE_TZ, show: SHOW_TZ },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.BCCClips = API;
})(this);
