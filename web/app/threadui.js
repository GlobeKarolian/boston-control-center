// app/threadui.js
//
// The display half of story threads, with no DOM in it.
//
// A thread is one card carrying every beat that belongs to it: the jumper, and
// then the bag found on the walkway afterwards. What makes that useful in a
// newsroom is not the threading, which will sometimes be wrong. It is that the
// person who spots it wrong can pull the beat back out in one gesture and have
// it stay pulled out. So the decisions in this file are the ones that gesture
// depends on: what order the beats read in, which of them can actually be
// pulled, and whether a request is worth sending before the page sends it.
//
// That last one is not politeness. api/sitlink.js locates a beat with
// findIndex(e => e.at === at), so it always takes the FIRST beat carrying that
// timestamp, and two transmissions can land in the same second. Offering a
// pull control on the second of them would send a request that comes back 200
// having removed a different beat than the one under the cursor. That is worse
// than an error, because nothing about it looks wrong afterwards.
//
//   node tools/test-threadui.js

(function (root) {
  'use strict';

  /* Long threads exist and the rail is 340px wide. Everything past this is
     still on the card, still in the store and still counted on the chip; it is
     just not painted, because a column that scrolls for a minute is a column
     nobody scrolls. */
  var MAX_SHOWN = 12;

  function str(v) { return v == null ? '' : String(v); }

  function stamp(v) {
    var t = v ? Date.parse(v) : NaN;
    return isNaN(t) ? null : t;
  }

  /* Ascending, oldest first, which is the order the story happened in and the
     order it reads in once somebody opens the card. The collapsed card shows
     the newest beat instead, because the one thing a wall display owes a room
     at a glance is what happened last. */
  function beats(sit) {
    var ev = (sit && Array.isArray(sit.events)) ? sit.events : [];
    var firstAt = {}, rows = [], i, e, at, text, r;
    for (i = 0; i < ev.length; i++) {
      e = ev[i];
      if (!e || typeof e !== 'object') continue;
      at = str(e.at);
      /* Recorded against the server's own array order rather than the sorted
         order below, because the server's findIndex walks the array as it is
         stored. Which beat a timestamp resolves to is its question, not ours. */
      if (at && !(at in firstAt)) firstAt[at] = i;
      text = str(e.text).trim();
      if (!text) continue;
      rows.push({ i: i, at: at || null, kind: str(e.kind) || 'note', text: text,
        type: str(e.type) || null, t: stamp(at) });
    }
    /* Undated beats sort last and hold their arrival order among themselves,
       the same rule the state police column uses on undated cards. Putting an
       unplaceable beat at the top would date the whole thread by it. */
    rows.sort(function (a, b) {
      if (a.t === b.t) return a.i - b.i;
      if (a.t === null) return 1;
      if (b.t === null) return -1;
      return a.t - b.t;
    });
    var many = ev.length >= 2;
    for (i = 0; i < rows.length; i++) {
      r = rows[i];
      r.key = r.i + '|' + (r.at || '');
      r.first = (i === 0);
      r.last = (i === rows.length - 1);
      /* why is the sentence, tag is the two words that fit in a 340px column
         where the button would have been. Both, because a control that is
         missing with no mark at all reads as a bug, and a mark with no
         explanation reads as a rule nobody will guess. */
      if (!many) {
        r.canPull = false;
        r.tag = 'only beat';
        r.why = 'the only beat on this card, so there is nothing to pull it away from';
      } else if (!r.at) {
        r.canPull = false;
        r.tag = 'no time';
        r.why = 'no time on this beat, and the time is the only handle the desk has on it';
      } else if (firstAt[r.at] !== r.i) {
        r.canPull = false;
        r.tag = 'same second';
        r.why = 'another beat landed in the same second, and pulling by time would take that one';
      } else {
        r.canPull = true;
        r.tag = null;
        r.why = null;
      }
      delete r.t;
    }
    return rows;
  }

  function latest(sit) {
    var b = beats(sit);
    return b.length ? b[b.length - 1] : null;
  }

  function count(sit) { return beats(sit).length; }

  function isThread(sit) { return beats(sit).length >= 2; }

  function label(sit) {
    var n = beats(sit).length;
    return n === 1 ? '1 beat' : n + ' beats';
  }

  /* The tail, not the head. A thread that has run to fifteen beats is being
     read for what has happened on it lately, and the opening beat is already
     the headline standing above the whole card. */
  function shown(sit) {
    var b = beats(sit);
    if (b.length <= MAX_SHOWN) return { rows: b, hidden: 0 };
    return { rows: b.slice(b.length - MAX_SHOWN), hidden: b.length - MAX_SHOWN };
  }

  function bad(why) { return { ok: false, why: why }; }

  /* Every answer carries a sentence for the person who pressed the control.
     A correction that lands silently and a correction that failed silently
     look identical on a board that repaints every five seconds anyway. */
  function plan(action, a) {
    a = a || {};
    var id = str(a.id).trim();
    if (!id) return bad('no card');

    if (action === 'merge') {
      var into = str(a.into).trim();
      if (!into) return bad('no card to fold it into');
      if (into === id) return bad('a card cannot be folded into itself');
      /* Checked against the board the person is looking at. Five seconds is
         long enough for the target to have aged off, and the route answers a
         missing card with a 404 that would surface as a failure rather than
         as the ordinary thing it is. */
      if (a.ids && a.ids.indexOf(id) < 0) return bad('that card has left the board');
      if (a.ids && a.ids.indexOf(into) < 0) return bad('the card you dropped it on has left the board');
      return { ok: true, body: { action: 'merge', id: id, into: into },
        say: 'Folded together.' };
    }

    if (action === 'split') {
      var at = str(a.at).trim();
      if (!at) {
        return { ok: true, body: { action: 'split', id: id },
          say: 'Pinned on its own. Nothing gets threaded into it now.' };
      }
      /* Two beats can share a timestamp, and only one of them is the one the
         server would take. Look for that one first: rejecting a legitimate
         pull because its duplicate happened to sort ahead of it would be this
         file inventing a problem the server does not have. */
      var rows = beats(a.sit), i, hit = null;
      for (i = 0; i < rows.length; i++) {
        if (rows[i].at !== at) continue;
        if (rows[i].canPull) { hit = rows[i]; break; }
        if (!hit) hit = rows[i];
      }
      if (!hit) return bad('that beat is not on this card any more');
      if (!hit.canPull) return bad(hit.why);
      return { ok: true, body: { action: 'split', id: id, at: at },
        say: 'Pulled out into its own card.' };
    }

    if (action === 'undo') {
      return { ok: true, body: { action: 'undo', id: id },
        say: 'Put back the way it was.' };
    }

    return bad('unknown action');
  }

  var api = {
    beats: beats, latest: latest, count: count, isThread: isThread,
    label: label, shown: shown, plan: plan,
    _consts: { MAX_SHOWN: MAX_SHOWN },
  };

  root.BCCThread = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof window !== 'undefined' ? window : this));
