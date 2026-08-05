// app/alerts.js
// So nobody has to sit and stare at the map.
//
// John Ellement asked for alerts and audio, and the ask underneath the ask is
// that the tool should be usable by someone doing something else. That means
// the sound has to carry a meaning across a room, it has to be rare enough
// that people leave it on, and silence has to be trustworthy. The last one is
// the one that gets skipped: a feed that quietly stops looks exactly like a
// quiet night, and a newsroom that has learned to read silence as "nothing
// happening" will keep reading it that way for the hour the pipeline is down.
// So the feed going dark is itself one of the sounds.
//
// Three cues, deliberately unlike each other:
//
//   high   two rising tones, twice        something is happening now
//   new    one short soft blip            a situation opened, off by default
//   stale  two falling tones, low         the board stopped moving, look at it
//
// Off by default is doing real work in that table. A tool that beeps at
// everything gets muted in one shift, and a muted tool is worse than a silent
// one because everybody believes it is armed.
//
// Wiring, two lines in app/index.html:
//
//   <script src="./alerts.js"></script>              once, near the end of body
//   BCCAlert.mount(document.querySelector('#hdr'));  once, after the header exists
//
// then inside pollSituations(), where the list has just been fetched:
//
//   BCCAlert.tick(list, {ok: true});                 on success
//   BCCAlert.tick(null, {ok: false});                in the catch
//
// If situations.json carries a generated-at stamp, pass it and the stale alarm
// gets much sharper, because it can then catch a pipeline that stopped while
// the file it already wrote keeps serving:
//
//   BCCAlert.tick(list, {ok: true, at: payload.at});
//
// One rule of CSS, since mount() only sets a class:
//
//   .alertbtn{background:#1b2430;color:#c7d4e2;border:1px solid #2c3a4a;
//     border-radius:6px;padding:4px 9px;font:inherit;font-size:12px;cursor:pointer}
//   .alertbtn[data-mode="off"]{opacity:.55}
//   .alertbtn[data-mode="high"]{border-color:#3d6ea5}
//   .alertbtn[data-mode="all"]{border-color:#c8912f}
//
// It never touches the map, the cards, or sitState. If this file is missing,
// the guard in mount() means nothing else breaks.

(function (root) {
  'use strict';

  /* An alertKey stays quiet for six hours after it has sounded. The same
     corner catching fire twice in one afternoon is two stories and should ring
     twice; the same fire reported by four scanners in ninety seconds is one
     story and should ring once. Six hours sits well past the ninety minutes
     after which threads.js drops a situation, so a key that comes back has
     genuinely come back. */
  var REARM_MS = 6 * 3600 * 1000;

  /* No more than one sound every four seconds however much lands at once. A
     burst is one event to a human. This gates the audio only; the cards still
     appear and the keys are still marked, so nothing gets silently swallowed
     and re-announced later. */
  var FLOOR_MS = 4000;

  /* Three minutes of a failing fetch, or of a board whose own timestamp has
     stopped advancing, counts as the feed being down. The analyst runs on a
     minute, so three misses is a pattern rather than a blip. */
  var STALE_MS = 3 * 60 * 1000;

  /* Ceiling on the seen table. Keys are small, but this runs for days on a
     wall display and an unbounded object on a page nobody reloads is a leak
     with a slow fuse. */
  var MAX_SEEN = 600;

  var PREF_KEY = 'bcc.alert.mode';
  var MODES = ['off', 'high', 'all'];

  // ---------------------------------------------------------------- decision
  // Kept pure and free of the DOM so tools/test-alerts.js can drive it in node.
  // Everything below this line that matters is decided here.

  function freshState() {
    return { seen: {}, lastSoundMs: 0, lastGoodMs: 0, staleFired: false, started: 0, primed: false };
  }

  /* An unclear situation never makes a sound and never raises a notification.
     It can sit on the board where somebody can weigh it, which is what unclear
     means, but the whole contract of the noise is that it is worth turning
     around for, and a maybe is not. */
  function alertable(s) {
    return !!s && s.confidence !== 'unclear';
  }

  function keyOf(s) {
    return (s && (s.alertKey || s.id)) || null;
  }

  function decide(state, list, meta, now, mode) {
    var out = { cue: null, notify: null, fresh: [], stale: false };
    var ok = !!(meta && meta.ok);

    if (!state.started) state.started = now;

    // ---- is the feed alive -------------------------------------------------
    // A board that parses fine but carries an old timestamp is the same
    // problem as a fetch that throws, so both land here.
    var boardAt = meta && meta.at ? Date.parse(meta.at) : NaN;
    var boardOld = !isNaN(boardAt) && (now - boardAt) > STALE_MS;
    if (ok && !boardOld) {
      state.lastGoodMs = now;
      if (state.staleFired) state.staleFired = false;   // re-arm, quietly
    } else {
      /* Two kinds of dark, and they earn the alarm differently.

         A board that arrived carrying its own timestamp is evidence on the
         spot: it says how old it is, and if that is minutes then the pipeline
         behind it has stopped, whether the page opened ten seconds ago or ten
         hours ago. Nothing is gained by waiting to be told again.

         A fetch that threw tells us nothing yet. It could be the first request
         still finding its way out on a cold load, or a phone changing towers.
         That one has to keep failing before it means anything, and before the
         first success there is no last-good time to measure from, so it runs
         from when the page opened. */
      var since = state.lastGoodMs || state.started;
      var dark = boardOld || (now - since) > STALE_MS;
      if (dark && !state.staleFired) {
        state.staleFired = true;
        out.stale = true;
        /* The stale cue ignores mode 'high' vs 'all' but not 'off'. Somebody
           who turned the sound off gets no sound. It also ignores the floor,
           because it fires at most once per outage anyway. */
        if (mode !== 'off') out.cue = 'stale';
        out.notify = { title: 'Feed stopped', body: 'No fresh board in the last few minutes.', tag: 'bcc-stale' };
      }
      return out;   // nothing arrived, so there is nothing new to weigh
    }

    // ---- what is new -------------------------------------------------------
    var arr = Array.isArray(list) ? list : [];
    var i, s, k, high = false;

    /* The first board a page ever sees is the backlog, not the news. A wall
       display switched on at nine would otherwise announce everything the
       overnight left behind, all at once, which teaches the room to ignore the
       sound on day one.

       There is a worse version of it than the noise. A browser that has not
       been clicked yet cannot start an AudioContext and has not been asked
       about notifications, so that opening alarm is swallowed by the platform
       while the keys are spent anyway: marked seen, then silent for six hours.
       The one card that mattered would have announced itself to nobody and
       then refused to try again.

       So take the board as it stands at open as the baseline, say nothing, and
       let the next poll be the first thing that counts as new. */
    if (!state.primed) {
      state.primed = true;
      for (i = 0; i < arr.length; i++) {
        k = alertable(arr[i]) ? keyOf(arr[i]) : null;
        if (k) state.seen[k] = now;
      }
      trimSeen(state);
      return out;
    }

    for (i = 0; i < arr.length; i++) {
      s = arr[i];
      if (!alertable(s)) continue;
      k = keyOf(s);
      if (!k) continue;
      var last = state.seen[k];
      if (last && (now - last) < REARM_MS) continue;
      state.seen[k] = now;
      out.fresh.push(s);
      if (s.priority === 'high') high = true;
    }

    if (!out.fresh.length) { trimSeen(state); return out; }

    /* Marked seen above whatever happens next. The cards are on screen either
       way, so a key held back here would be announced on some later poll as
       though it had just landed, which is worse than never announcing it. */
    var want = high ? 'high' : (mode === 'all' ? 'new' : null);
    if (want && mode !== 'off' && (now - state.lastSoundMs) >= FLOOR_MS) {
      out.cue = want;
      state.lastSoundMs = now;
    }

    if (high) {
      var lead = null;
      for (i = 0; i < out.fresh.length; i++) {
        if (out.fresh[i].priority === 'high') { lead = out.fresh[i]; break; }
      }
      if (lead) {
        out.notify = {
          title: String(lead.headline || 'Situation').slice(0, 110),
          body: [lead.type, lead.location].filter(Boolean).join(' / ').slice(0, 160),
          tag: keyOf(lead) || 'bcc',
        };
      }
    }

    trimSeen(state);
    return out;
  }

  function trimSeen(state) {
    var keys = Object.keys(state.seen);
    if (keys.length <= MAX_SEEN) return;
    keys.sort(function (a, b) { return state.seen[a] - state.seen[b]; });
    for (var i = 0; i < keys.length - MAX_SEEN; i++) delete state.seen[keys[i]];
  }

  // ------------------------------------------------------------------- sound
  // Tones are generated rather than loaded. No asset to ship, no CORS, no
  // second request that can fail on the one morning it matters.

  var ctx = null;

  function tone(startAt, freq, ms, gainTo) {
    var osc = ctx.createOscillator();
    var g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, startAt);
    /* Ramped rather than switched. A square edge on a gain node is an audible
       click, and a click on every beep is the kind of small ugliness that gets
       a feature turned off. */
    g.gain.setValueAtTime(0.0001, startAt);
    g.gain.exponentialRampToValueAtTime(gainTo, startAt + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, startAt + ms / 1000);
    osc.connect(g); g.connect(ctx.destination);
    osc.start(startAt); osc.stop(startAt + ms / 1000 + 0.02);
  }

  var CUES = {
    high: [[0, 660, 140, 0.16], [0.16, 880, 190, 0.18], [0.52, 660, 140, 0.16], [0.68, 880, 190, 0.18]],
    new: [[0, 740, 90, 0.07]],
    stale: [[0, 420, 200, 0.13], [0.24, 300, 320, 0.13]],
  };

  function play(cue) {
    if (!ctx || ctx.state !== 'running') return false;
    var spec = CUES[cue];
    if (!spec) return false;
    var t0 = ctx.currentTime + 0.02;
    for (var i = 0; i < spec.length; i++) tone(t0 + spec[i][0], spec[i][1], spec[i][2], spec[i][3]);
    return true;
  }

  // -------------------------------------------------------------- title flash
  // For the case the sound is off, or the machine is muted, or somebody is in
  // a different tab with headphones on a call.

  var baseTitle = null, flashTimer = null, flashOn = false;

  function flash(label) {
    if (typeof document === 'undefined') return;
    if (baseTitle === null) baseTitle = document.title;
    stopFlash();
    flashTimer = setInterval(function () {
      flashOn = !flashOn;
      document.title = flashOn ? label + ' ' + baseTitle : baseTitle;
    }, 1200);
  }

  function stopFlash() {
    if (flashTimer) { clearInterval(flashTimer); flashTimer = null; }
    if (baseTitle !== null) document.title = baseTitle;
    flashOn = false;
  }

  // ------------------------------------------------------------ notifications

  function notify(n) {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    /* Only when the tab is in the background. A desktop notification for
       something already filling the screen in front of you is noise, and the
       browser stacks them, so it is noise that piles up. */
    if (typeof document !== 'undefined' && !document.hidden) return;
    try {
      var h = new Notification(n.title, { body: n.body, tag: n.tag, renotify: false });
      h.onclick = function () { try { window.focus(); h.close(); } catch (e) {} };
      setTimeout(function () { try { h.close(); } catch (e) {} }, 20000);
    } catch (e) { /* Safari throws here outside a service worker. Not fatal. */ }
  }

  // -------------------------------------------------------------------- prefs

  function readMode() {
    try {
      var v = window.localStorage.getItem(PREF_KEY);
      return MODES.indexOf(v) >= 0 ? v : 'high';
    } catch (e) { return 'high'; }
  }

  function writeMode(m) {
    try { window.localStorage.setItem(PREF_KEY, m); } catch (e) {}
  }

  // ------------------------------------------------------------------- public

  var state = freshState();
  var mode = 'high';
  var btn = null;

  var LABEL = { off: 'Sound off', high: 'Alerts on', all: 'All sounds' };
  var GLYPH = { off: '\uD83D\uDD07', high: '\uD83D\uDD14', all: '\uD83D\uDD0A' };

  function paint() {
    if (!btn) return;
    btn.textContent = GLYPH[mode] + ' ' + LABEL[mode];
    btn.setAttribute('aria-label', LABEL[mode] + ', click to change');
    btn.setAttribute('data-mode', mode);
    btn.title = mode === 'off'
      ? 'No sound. Click for high-priority alerts.'
      : mode === 'high'
        ? 'Sounds on high-priority situations and if the feed stops. Click for every new situation.'
        : 'Sounds on every new situation. Click to silence.';
  }

  function arm() {
    /* Both of these need a real click behind them, which is why they live in
       the button handler and not in mount(). A browser will refuse an
       AudioContext and a permission prompt that no human asked for, and it
       refuses them silently. */
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC && !ctx) ctx = new AC();
      if (ctx && ctx.state === 'suspended') ctx.resume();
    } catch (e) {}
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        Notification.requestPermission();
      }
    } catch (e) {}
  }

  function cycle() {
    mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
    writeMode(mode);
    arm();
    paint();
    if (mode !== 'off') play(mode === 'all' ? 'new' : 'high');   // so you know it works
  }

  function mount(host) {
    if (!host || typeof document === 'undefined') return null;
    mode = readMode();
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'alertbtn';
    btn.onclick = cycle;
    host.appendChild(btn);
    paint();

    /* Coming back to the tab clears the flash. Whatever it was announcing is
       now in front of the person it was announcing to. */
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) stopFlash();
    });
    return btn;
  }

  function tick(list, meta) {
    var now = Date.now();
    var d = decide(state, list, meta || { ok: true }, now, mode);
    if (d.cue) play(d.cue);
    if (d.notify) {
      notify(d.notify);
      flash(d.stale ? '\u26A0' : '\uD83D\uDD34');
    }
    return d;
  }

  /* An alarm raised by something other than the situations board. The board
     poll owns tick() and its whole re-arm dance; this is for a condition the
     caller has already decided is worth a noise, and the caller owns the
     deciding and the not-repeating.

     It exists because the situations board is the wrong thing to watch for a
     dead scanner. That file is rebuilt by a cron on Vercel, so it kept arriving
     on time all through August 3 while the relay Mac was unreachable, and the
     alert layer had nothing to complain about. The scanner audio clock is the
     one that stopped, and now something can say so out loud.

     Mute still means mute. Off is off. */
  function say(cue, n, label) {
    if (mode === 'off') return false;
    play(cue);
    if (n) notify(n);
    if (label) flash(label);
    return true;
  }

  var api = {
    mount: mount,
    tick: tick,
    say: say,
    stopFlash: stopFlash,
    mode: function () { return mode; },
    // exposed for tools/test-alerts.js
    _decide: decide,
    _freshState: freshState,
    _consts: { REARM_MS: REARM_MS, FLOOR_MS: FLOOR_MS, STALE_MS: STALE_MS, MAX_SEEN: MAX_SEEN },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.BCCAlert = api;
})(typeof window !== 'undefined' ? window : globalThis);
