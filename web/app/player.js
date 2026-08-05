// app/player.js
//
// What happens when a reporter clicks a transmission.
//
// The obvious version of this is four lines in a click handler, and it is
// wrong by the second feature. One audio element and eighty rows means the row
// that was playing has to be told it stopped. A clip that will not load has to
// stop being offered rather than being retried on every click. And John
// Ellement asked for audio so he does not have to stare at the screen, which
// means new transmissions have to be able to play themselves, in the order
// they were said, without replaying everything already on the page the moment
// he switches it on.
//
// So the decisions live here and the DOM lives in index.html. Every method
// returns an action for the page to carry out, and never touches an element:
//
//     var act = BCCPlayer.click(key);
//     if (act.do === 'play')   { audio.src = act.url; audio.play(); }
//     if (act.do === 'pause')  audio.pause();
//     if (act.do === 'resume') audio.play();
//     if (act.do === 'stop')   audio.pause();
//
// That split is the whole point. A queue that plays the wrong clip is a bug a
// test can catch. A queue tangled up in event listeners is a bug somebody
// catches at 2am with the newsroom watching.
//
//   node tools/test-player.js

(function (root) {
  'use strict';

  /* The URL check and the download naming live in app/clips.js, because the
     relay and the server need the same rules and three copies of a filename
     rule is three chances to disagree. If it is missing, every clip reads as
     having no audio, which is the safe way to be wrong: a page with no play
     buttons rather than a page that will fetch any host a string names. */
  var Clips = null;
  try {
    Clips = (typeof module !== 'undefined' && module.exports)
      ? require('./clips.js')
      : (root && root.BCCClips) || null;
  } catch (e) { Clips = (root && root.BCCClips) || null; }

  /* Long enough that a busy minute on four feeds does not run dry, short
     enough that switching follow on does not commit the desk to sitting
     through five minutes of radio before it hears anything current. Twelve
     transmissions at the measured average is about a minute and a half. */
  var QUEUE_MAX = 12;

  var cur = '';          // the key currently loaded, playing or paused
  var playing = false;
  var manual = false;    // started by a click rather than by the queue
  var following = false;
  var feeds = null;      // null means every feed
  var primed = false;    // has see() run once, so there is a baseline
  var known = {};        // every key see() has ever been shown
  var urls = {};         // key -> clip URL
  var dead = {};         // keys whose audio would not load
  var queue = [];

  function nothing(why) { return { do: 'nothing', why: why || '' }; }

  /* The identity of a transmission, everywhere. Exported rather than inlined
     so the data attribute in the markup and the lookup in here cannot drift
     apart, which is the kind of bug that shows as "the wrong clip played" and
     takes an hour to see. */
  function keyOf(row) {
    var r = row || {};
    return String(r.time || r.at || '') + '|' + String(r.source || r.src || '');
  }

  function usable(row) {
    var u = row && row.clip;
    if (!u || !Clips || !Clips.ok(u)) return '';
    return String(u);
  }

  function allowed(row) {
    if (!feeds || !feeds.length) return true;
    var s = String((row && (row.source || row.src)) || '');
    return feeds.indexOf(s) !== -1;
  }

  function playAction(key) {
    cur = key;
    playing = true;
    return { do: 'play', key: key, url: urls[key] };
  }

  /* The next thing worth playing, or nothing. Skips anything that has since
     died or been forgotten rather than handing the page a URL it will only
     fail on, because a queue that stalls on one bad clip is a queue that has
     stopped working and has not said so. */
  function pull() {
    while (queue.length) {
      var k = queue.shift();
      if (!dead[k] && urls[k]) return k;
    }
    return '';
  }

  function advance() {
    playing = false;
    manual = false;
    var next = following ? pull() : '';
    if (!next) { cur = ''; return { do: 'stop' }; }
    return playAction(next);
  }

  // -------------------------------------------------------------------------

  /* A click on a row. Three outcomes, and the third is the one worth being
     careful about: clicking a different row while one is playing does not
     stack, it replaces, because there is one audio element and the alternative
     is two transmissions talking over each other. */
  function click(key) {
    var k = String(key || '');
    if (!k) return nothing('no transmission');
    if (dead[k]) return nothing('that clip would not load');
    if (!urls[k]) return nothing('no audio was stored for that transmission');

    if (k === cur) {
      playing = !playing;
      return playing ? { do: 'resume', key: k } : { do: 'pause', key: k };
    }

    /* Taken out of the queue so that following along and then clicking ahead
       does not play the same thing twice a minute later. */
    var at = queue.indexOf(k);
    if (at !== -1) queue.splice(at, 1);

    manual = true;
    return playAction(k);
  }

  /* The clip finished on its own. In follow mode the next queued transmission
     starts; otherwise the player goes quiet, which is what a reporter who
     clicked one line expects. */
  function ended() { return advance(); }

  /* The clip would not load. Marked rather than retried, because a clip that
     404s once will 404 every time and the only thing retrying buys is a row
     that flickers. */
  function failed(key) {
    var k = String(key || '');
    if (!k) return nothing('no transmission');
    dead[k] = true;
    if (k !== cur) return nothing('noted');
    return advance();
  }

  /* Every poll hands the whole visible list over. Two jobs: index the audio so
     a click can find it, and in follow mode queue whatever is new.

     The first call never queues. That is the same lesson the alerts learned:
     opening the page must not replay the last hour, and without a baseline the
     first poll looks like eighty things that just happened. */
  function see(rows) {
    var list = Array.isArray(rows) ? rows : [];
    var fresh = [], i, r, k, u;

    for (i = 0; i < list.length; i++) {
      r = list[i];
      k = keyOf(r);
      u = usable(r);
      if (u) urls[k] = u;
      if (!known[k]) {
        known[k] = true;
        if (u && allowed(r)) fresh.push(r);
      }
    }

    if (!primed) { primed = true; return null; }
    if (!following || !fresh.length) return null;

    /* Oldest first. The store hands back newest first because that is how the
       console reads, but radio only makes sense in the order it was said. */
    fresh.sort(function (a, b) {
      return (Date.parse(a.time || a.at || '') || 0) - (Date.parse(b.time || b.at || '') || 0);
    });

    for (i = 0; i < fresh.length; i++) {
      k = keyOf(fresh[i]);
      if (!dead[k] && queue.indexOf(k) === -1 && k !== cur) queue.push(k);
    }
    /* Over the cap the oldest go, not the newest. A desk that has fallen a
       minute behind wants to hear what is happening now and catch up on the
       text, rather than listen its way forward through a backlog. */
    if (queue.length > QUEUE_MAX) queue = queue.slice(queue.length - QUEUE_MAX);

    if (cur && playing) return null;
    if (cur && !playing && manual) return null;   // paused on purpose; leave it paused

    var next = pull();
    return next ? playAction(next) : null;
  }

  /* Follow mode on or off. opts.feeds narrows it to a list of feed slugs, so a
     reporter can have State Police in their ear without the whole city.

     Turning it on queues nothing by itself. Everything on screen is already
     known by then, so the first thing it plays is the next thing said. */
  function setFollow(on, opts) {
    following = !!on;
    feeds = (opts && Array.isArray(opts.feeds) && opts.feeds.length)
      ? opts.feeds.slice() : null;
    if (!following) queue = [];
    return null;
  }

  /* What a row should look like. The page reads this per row on render, so it
     has to be cheap and it has to cover every case, including the common one
     where there is simply no audio because the clip failed to store. */
  function state(key) {
    var k = String(key || '');
    if (dead[k]) return 'dead';
    if (!urls[k]) return 'none';
    if (k === cur) return playing ? 'playing' : 'paused';
    if (queue.indexOf(k) !== -1) return 'queued';
    return 'ready';
  }

  /* Said out loud, because a play button that is only an icon is a play button
     a screen reader calls "button". */
  function label(key) {
    switch (state(key)) {
      case 'playing': return 'Pause this transmission';
      case 'paused': return 'Resume this transmission';
      case 'queued': return 'Queued to play, or click to hear it now';
      case 'dead': return 'This clip would not load';
      case 'none': return 'No audio was stored for this transmission';
      default: return 'Play this transmission';
    }
  }

  function status() {
    var d = 0, k;
    for (k in dead) if (Object.prototype.hasOwnProperty.call(dead, k)) d++;
    return {
      following: following,
      feeds: feeds ? feeds.slice() : null,
      playing: playing,
      current: cur,
      queued: queue.length,
      dead: d,
      withAudio: Object.keys(urls).length,
    };
  }

  /* Test seam, and also what a page reload would do. Nothing in the browser
     calls it. */
  function reset() {
    cur = ''; playing = false; manual = false; following = false; feeds = null;
    primed = false; known = {}; urls = {}; dead = {}; queue = [];
  }

  var API = {
    keyOf: keyOf,
    click: click,
    ended: ended,
    failed: failed,
    see: see,
    setFollow: setFollow,
    state: state,
    label: label,
    status: status,
    reset: reset,
    QUEUE_MAX: QUEUE_MAX,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.BCCPlayer = API;
})(this);
