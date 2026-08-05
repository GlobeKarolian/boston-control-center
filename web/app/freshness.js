// app/freshness.js
//
// What the board says about its own health, computed from the scanners rather
// than from the browser.
//
// The header used to read "live" whenever the JSON files downloaded, and
// "updated 08:27 AM" straight off the browser clock. Both of those describe
// this tab. Neither describes the audio. On August 3 the relay Mac lost its
// route to the dashboard at 3:16 in the morning and stayed dark for twenty
// hours while the header said "live, updated 08:27 AM" the entire time.
//
// So the headline comes off the newest audio any feed has reported, which is
// the one clock that stops when the relay stops. Audio and speech are kept
// apart deliberately: Boston Fire at 4am goes an hour without a transmission
// and that is a healthy feed. Silence is only alarming once the audio itself
// has stopped arriving.
//
// Reads the pipeline payload the board already polls, so it costs no request
// and no Redis command.
//
//   node tools/test-freshness.js

(function (root) {
  'use strict';

  var QUIET_MS = 12 * 60 * 1000;   // no speech this long reads as quiet, not broken
  var STALE_MS = 10 * 60 * 1000;   // no audio this long is worth a colour
  var DARK_MS = 45 * 60 * 1000;    // no audio this long is an outage, say so loudly

  /* The relay has written these as ISO strings and as epoch numbers at various
     points, and a feed that has never had audio writes null. All three have to
     come back as a number, and anything unreadable has to come back as 0 rather
     than NaN, because NaN quietly poisons every comparison downstream. */
  function parseAt(v) {
    if (v === null || v === undefined || v === '') return 0;
    if (typeof v === 'number') return isFinite(v) && v > 0 ? v : 0;
    var t = Date.parse(v);
    return isFinite(t) && t > 0 ? t : 0;
  }

  /* The newest timestamp across every feed, because one live scanner is enough
     to prove the relay is talking. Feeds that have never reported contribute 0
     and drop out. */
  function newest(feeds, field) {
    if (!feeds || !feeds.length) return 0;
    var best = 0;
    for (var i = 0; i < feeds.length; i++) {
      var t = parseAt(feeds[i] && feeds[i][field]);
      if (t > best) best = t;
    }
    return best;
  }

  function newestAudio(pipe) { return newest(pipe && pipe.feeds, 'lastAudioAt'); }
  function newestSpeech(pipe) { return newest(pipe && pipe.feeds, 'lastSegAt'); }

  /* Same shape tools/who-is-feeding.js prints, minus the trailing "ago", so the
     header and the command line describe an outage in the same words. A clock
     skew on the viewing machine can make this negative; clamp rather than print
     "-3s", which reads like a bug and buries the real point. */
  function phrase(ms) {
    if (!isFinite(ms) || ms < 0) ms = 0;
    var s = Math.round(ms / 1000);
    if (s < 90) return s + 's';
    var m = Math.round(s / 60);
    if (m < 90) return m + 'm';
    var h = m / 60;
    if (h < 48) return h.toFixed(1) + 'h';
    return Math.round(h / 24) + 'd';
  }

  /* One shared sentence for the age, so every level says it the same way and no
     level can accidentally omit it. The age is the whole point of this file. */
  function since(at, now) {
    return at ? phrase(now - at) : '';
  }

  /* The whole judgement, in one place. Returns a level for the colour, a short
     text for the pill, and a longer detail for the tooltip. */
  function verdict(pipe, now) {
    now = now || Date.now();
    var feeds = (pipe && pipe.feeds) || [];
    var total = feeds.length;
    var offline = 0;
    for (var i = 0; i < total; i++) {
      var st = String((feeds[i] && feeds[i].status) || '').toLowerCase();
      /* A record with no status at all is not a working feed. Count it with the
         offline ones rather than letting a missing field read as healthy. */
      if (!st || st === 'offline') offline++;
    }

    var audioAt = newestAudio(pipe);
    var speechAt = newestSpeech(pipe);
    var age = since(audioAt, now);
    var quietFor = since(speechAt, now);

    var out = {
      ageMs: audioAt ? Math.max(0, now - audioAt) : Infinity,
      offline: offline, total: total, audioAt: audioAt, speechAt: speechAt
    };
    function say(level, text, detail) {
      out.level = level; out.text = text; out.detail = detail;
      return out;
    }

    if (!total) return say('dark', 'no feeds', 'No scanner has checked in.');
    if (!audioAt) return say('dark', 'no audio', 'No feed has reported any audio yet.');

    /* Audio age is checked before the status strings on purpose. The status is
       written by the relay and relabelled server side, so a payload can still
       claim "live" when the machine behind it went away. The timestamp cannot:
       it stops the moment the relay stops. This is the branch that would have
       caught August 3. */
    if (out.ageMs >= DARK_MS) {
      return say('dark', 'no audio ' + age,
        'The newest audio on any feed is ' + age + ' old. The relay has stopped talking to the dashboard.');
    }
    if (offline >= total) {
      return say('dark', 'feeds offline',
        'All ' + total + ' feeds are offline. Newest audio ' + age + ' ago.');
    }
    if (offline > 0) {
      return say('degraded', offline + ' of ' + total + ' offline',
        offline + ' of ' + total + ' feeds are offline. Newest audio ' + age + ' ago.');
    }
    if (out.ageMs >= STALE_MS) {
      return say('stale', 'no audio ' + age,
        'Every feed reports connected, but the newest audio is ' + age + ' old.');
    }

    /* Quiet is not broken. Boston Fire at four in the morning goes an hour
       without a transmission and every part of that chain is working. The only
       reason to mention it is so nobody stares at a still screen wondering. */
    if (!speechAt || (now - speechAt) >= QUIET_MS) {
      return say('quiet', 'quiet ' + (quietFor || age),
        speechAt
          ? 'Audio is arriving. Nobody has said anything for ' + quietFor + '.'
          : 'Audio is arriving, but nothing has been transcribed yet.');
    }

    return say('live', 'live',
      'Newest audio ' + age + ' ago, newest transmission ' + quietFor + ' ago.');
  }

  /* What goes in the #updated slot. This used to be the browser's own clock,
     which is current no matter what the scanners are doing, which is exactly
     how twenty hours of silence read as "updated 08:27 AM". */
  function stamp(pipe, now) {
    now = now || Date.now();
    var at = newestAudio(pipe);
    if (!at) return 'no audio yet';
    return 'audio ' + phrase(now - at) + ' ago';
  }

  var api = {
    parseAt: parseAt,
    newest: newest,
    newestAudio: newestAudio,
    newestSpeech: newestSpeech,
    phrase: phrase,
    verdict: verdict,
    stamp: stamp,
    _consts: { QUIET_MS: QUIET_MS, STALE_MS: STALE_MS, DARK_MS: DARK_MS }
  };

  root.BCCFresh = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof window !== 'undefined' ? window : this));
