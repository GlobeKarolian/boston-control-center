/* deskviews.js — the Desk and the Story.

   Two alternate reading views over state the dashboard is already holding. This
   module opens no connection and fetches nothing. index.html hands it the arrays
   its own pollers fill, on the same 1500ms tick, and only while one of these two
   views is on screen. If this file fails to load, index.html null-guards every
   call into it and the board carries on exactly as it did before, which is the
   arrangement the other five modules here are under.

   The map is not redrawn either. Both views leave one grid cell unpainted and
   let the single live Leaflet instance show through it, so the pins in the
   window are the same objects the Map tab is showing, at the same moment.  */
(function (root) {
  'use strict';

  var MOUNTED = false;
  var theme = 'light';
  var routineOpen = false;
  var pick = null;                  /* selected situation id, Story view */
  var picked = false;               /* whether the user has chosen one */
  var S = { feed: [], sits: [], tx: [], pipe: null, now: 0 };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function byId(id) { return document.getElementById(id); }
  function T() { return root.BCCThread || null; }

  /* Both views repaint on the console tick, and a wholesale innerHTML swap on a
     1500ms timer would take the scroll position and the keyboard focus with it
     every time. So: build the string, and if it is the same string, do nothing
     at all. When it has changed, put the scroll and the focus back by the
     data-id they were on rather than by node identity, because the node they
     were on may legitimately be gone. */
  function swap(elm, html) {
    if (!elm || elm.__h === html) return false;
    var top = elm.scrollTop;
    var a = document.activeElement;
    var key = (a && elm.contains(a) && a.getAttribute) ? a.getAttribute('data-id') : null;
    elm.innerHTML = html;
    elm.__h = html;
    elm.scrollTop = top;
    if (key) {
      var back = elm.querySelector('[data-id="' + (window.CSS && CSS.escape ? CSS.escape(key) : key) + '"]');
      if (back && back.focus) back.focus();
    }
    return true;
  }

  function ago(d) {
    if (!d) return '';
    var ms = S.now - (d instanceof Date ? d.getTime() : new Date(d).getTime());
    if (!isFinite(ms)) return '';
    if (ms < 60000) return 'just now';
    var m = Math.round(ms / 60000);
    if (m < 60) return m + 'm ago';
    var h = Math.round(m / 60);
    return h < 36 ? h + 'h ago' : Math.round(h / 24) + 'd ago';
  }
  function clock(d) {
    var t = (d instanceof Date) ? d : new Date(d);
    if (isNaN(t.getTime())) return '';
    return t.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York' });
  }

  var CAT = {
    traffic: '--c-traffic', roads: '--c-traffic', transit: '--c-transit',
    scanner: '--c-scanner', alerts: '--c-alert', alert: '--c-alert',
    quakes: '--c-quake', choppers: '--c-chopper', civic311: '--c-civic',
    cameras: '--c-cam', webcams: '--c-cam', outages: '--c-traffic'
  };
  function catColor(c) { return 'var(' + (CAT[c] || '--t3') + ')'; }

  var KEYS =
    '<span class="k"><kbd>Tab</kbd> move</span>' +
    '<span class="k"><kbd>Enter</kbd> open</span>' +
    '<span class="k"><kbd>Esc</kbd> back to the map</span>' +
    '<span class="k">&copy; OpenStreetMap &copy; CARTO</span>' +
    '<span class="sp"></span>' +
    '<button class="btn" data-act="theme" type="button">Dark</button>';

  var DESK_SKEL =
    '<div class="dk-state" id="dkState"></div>' +
    '<div class="dk-board">' +
      '<div class="dk-h">On the board <span class="n" id="dkBoardN"></span></div>' +
      '<div class="dk-scroll" id="dkBoard"></div>' +
    '</div>' +
    '<div class="dk-mapwin">' +
      '<span class="dk-cap">Live map</span>' +
      '<div class="dk-routine" id="dkRoutine"></div>' +
    '</div>' +
    '<div class="dk-wire">' +
      '<div class="half">' +
        '<div class="dk-h">Coming in <span class="n" id="dkWireN"></span></div>' +
        '<div class="dk-scroll" id="dkWire"></div>' +
      '</div>' +
      '<div class="half">' +
        '<div class="dk-h">On the air</div>' +
        '<div class="dk-scroll" id="dkAudio"></div>' +
      '</div>' +
    '</div>' +
    '<div class="dk-keys">' + KEYS + '</div>';

  var STORY_SKEL =
    '<div class="sv-list">' +
      '<div class="dk-h">Threads <span class="n" id="svListN"></span></div>' +
      '<div class="dk-scroll" id="svList"></div>' +
    '</div>' +
    '<div class="sv-draft" id="svDraft"></div>' +
    '<div class="sv-ev">' +
      '<div class="pane">' +
        '<div class="dk-h">Where it came from</div>' +
        '<div id="svEv"></div>' +
      '</div>' +
      '<div class="sv-map" id="svMap"><span class="dk-cap">Live map</span></div>' +
    '</div>' +
    '<div class="dk-keys">' + KEYS + '</div>';

  /* The header is the one measurement neither view can guess. It is z-index
     1600 and floats above both of them, its height changes with the wrap rules
     at 1010px, and each view's first row has to start exactly at its bottom
     edge or there is a strip of dark map across the top. */
  function measure() {
    var h = document.querySelector('.hud-top');
    if (h) document.documentElement.style.setProperty('--dkhdr', h.offsetHeight + 'px');
  }

  function mount() {
    if (MOUNTED) return;
    var d = byId('deskview'), s = byId('storyview');
    if (!d || !s) return;
    d.innerHTML = DESK_SKEL;
    s.innerHTML = STORY_SKEL;
    d.setAttribute('data-theme', theme);
    s.setAttribute('data-theme', theme);
    d.addEventListener('click', onClick);
    s.addEventListener('click', onClick);
    root.addEventListener('resize', measure);
    MOUNTED = true;
    measure();
    setTheme(theme);
  }

  function closed(s) { return /clos|clear|resolv|over/i.test(s && s.status || ''); }
  function when(s) { return new Date(s && (s.updated || s.firstSeen) || 0).getTime() || 0; }

  /* High first, then anything still running, then newest. A situation the desk
     flagged high an hour ago outranks one that opened a minute ago, because the
     desk flagged it. */
  function sortSits(list) {
    return (list || []).slice().sort(function (a, b) {
      var ah = a.priority === 'high' ? 0 : 1, bh = b.priority === 'high' ? 0 : 1;
      if (ah !== bh) return ah - bh;
      var ac = closed(a) ? 1 : 0, bc = closed(b) ? 1 : 0;
      if (ac !== bc) return ac - bc;
      return when(b) - when(a);
    });
  }

  /* Audit finding 6, the whole of it. One line, in words, about whether what is
     underneath it can be believed. It says the least when everything is fine. */
  function renderState() {
    var box = byId('dkState');
    if (!box) return;
    var F = root.BCCFresh, v = (F && S.pipe) ? F.verdict(S.pipe, S.now) : null;
    var lvl = v ? v.level : 'unknown';
    var lede, why = v ? v.detail : 'The pipeline has not reported in yet.';
    if (!v) lede = 'Waiting on the pipeline.';
    else if (lvl === 'live') lede = 'Every feed is reporting.';
    else if (lvl === 'quiet') lede = 'Quiet.';
    else lede = v.text.charAt(0).toUpperCase() + v.text.slice(1) + '.';
    box.className = 'dk-state s-' + lvl;
    var stamp = (F && S.pipe) ? F.stamp(S.pipe, S.now) : '';
    swap(box, '<span class="dot"></span><span class="lede"><b>' + esc(lede) + '</b></span>' +
      '<span class="why">' + esc(why) + '</span>' +
      '<span class="when">' + esc(stamp) + '</span>');
  }

  function sitRow(s, cls) {
    var t = T(), n = t ? t.count(s) : 0, id = s.id || '';
    var bits = [];
    if (s.priority === 'high') bits.push('<span class="flag">Priority</span>');
    if (s.type) bits.push('<span>' + esc(s.type) + '</span>');
    if (s.location) bits.push('<span>' + esc(s.location) + '</span>');
    if (n) bits.push('<span class="beats">' + n + (n === 1 ? ' beat' : ' beats') + '</span>');
    bits.push('<span>' + esc(ago(new Date(when(s)))) + '</span>');
    if (closed(s)) bits.push('<span>' + esc(s.status) + '</span>');
    return '<button type="button" class="' + cls +
      (s.priority === 'high' ? ' high' : '') + (closed(s) ? ' closed' : '') +
      '" data-id="' + esc(id) + '" data-act="story">' +
      '<div class="hl">' + esc(s.headline || 'Untitled') + '</div>' +
      (s.summary ? '<div class="sum">' + esc(s.summary) + '</div>' : '') +
      '<div class="meta">' + bits.join('<span class="sep">&middot;</span>') + '</div>' +
      '</button>';
  }

  function renderBoard() {
    var box = byId('dkBoard'), n = byId('dkBoardN');
    if (!box) return;
    var list = sortSits(S.sits);
    if (n) n.textContent = list.length ? String(list.length) : '';
    if (!list.length) {
      swap(box, '<div class="dk-empty">Nothing on the board. The desk raises a card ' +
        'when the same thing turns up on the air more than once.</div>');
      return;
    }
    swap(box, list.map(function (s) { return sitRow(s, 'sit-row'); }).join(''));
  }

  var HOUR = 3600000;
  /* Audit finding 1. A routine call is a scanner transmission the desk never
     raised: a car stop, a well-being check, a box alarm that was nothing. There
     are dozens an hour and each one is real, so they are not thrown away. They
     are counted on one line and opened by clicking it, which is the amount of
     column a thing that happens forty times an hour has earned. */
  function isRoutine(it) { return !!it.isScanner && it.priority !== 'high'; }
  function tms(it) { var d = it && it.time; return (d instanceof Date ? d.getTime() : new Date(d).getTime()) || 0; }
  function splitFeed() {
    var routine = [], wire = [];
    (S.feed || []).forEach(function (it) {
      if (isRoutine(it)) { if (S.now - tms(it) < HOUR) routine.push(it); }
      else wire.push(it);
    });
    routine.sort(function (a, b) { return tms(b) - tms(a); });
    wire.sort(function (a, b) { return tms(b) - tms(a); });
    return { routine: routine, wire: wire };
  }

  function renderRoutine(routine) {
    var box = byId('dkRoutine');
    if (!box) return;
    var n = routine.length;
    var h = '<button type="button" class="bar" data-act="routine">' +
      '<span class="c">' + n + '</span>' +
      '<span>' + (n === 1 ? 'routine call' : 'routine calls') + ' on the air in the last hour</span>' +
      '<span class="tail">' + (routineOpen ? 'hide' : 'show') + '</span></button>';
    if (routineOpen) {
      h += '<div class="list">' + (n ? routine.slice(0, 60).map(function (it) {
        return '<div class="r"><span class="w">' + esc(clock(it.time)) + '</span>' +
          '<span class="x">' + esc(it.title || it.type || '') +
          (it.location ? ' &middot; ' + esc(it.location) : '') + '</span></div>';
      }).join('') : '<div class="r"><span class="x">Nothing routine in the last hour.</span></div>') + '</div>';
    }
    swap(box, h);
  }

  function renderWire(wire) {
    var box = byId('dkWire'), n = byId('dkWireN');
    if (!box) return;
    if (n) n.textContent = wire.length ? String(wire.length) : '';
    if (!wire.length) { swap(box, '<div class="dk-empty">Nothing but routine traffic.</div>'); return; }
    swap(box, wire.slice(0, 60).map(function (it) {
      var cleared = /clear|closed/i.test(it.status || '');
      return '<button type="button" class="w-row' + (cleared ? ' cleared' : '') +
        '" data-id="' + esc(it.id || '') + '" data-act="map">' +
        '<span class="dot" style="background:' + catColor(it.cat) + '"></span>' +
        '<span class="tx">' + esc(it.title || it.type || '') +
        (it.location ? '<span class="loc"> &middot; ' + esc(it.location) + '</span>' : '') + '</span>' +
        '<span class="at">' + esc(clock(it.time)) + '</span></button>';
    }).join(''));
  }

  function renderAudio() {
    var box = byId('dkAudio');
    if (!box) return;
    var list = (S.tx || []).slice(0, 40);
    if (!list.length) { swap(box, '<div class="dk-empty">No transmissions yet.</div>'); return; }
    swap(box, list.map(function (t) {
      var clear = !!(t.tags && t.tags.clear);
      /* The play control, same class the whole page shares. deskviews owns no
         audio logic: the page-level capture-phase delegate hears .cplay here
         exactly as it does on the map console. A row with no clip renders as
         it always did. */
      var ok = t.clip && root.BCCClips && root.BCCClips.ok(t.clip);
      var play = ok ? '<button class="cplay" data-clip="' + esc(t.clip) + '" tabindex="-1" title="hear the transmission">&#9654;</button>' : '';
      return '<div class="a-row' + (clear ? ' clear' : '') + '">' +
        '<span class="src">' + play + esc(t.source || '') + ' ' + esc(clock(t.time)) + '</span>' +
        '<span class="t">' + esc(t.text || '') + '</span></div>';
    }).join(''));
  }

  /* --- the Story --- */
  function current() {
    var list = sortSits(S.sits);
    if (!list.length) return null;
    var hit = null;
    if (pick) list.forEach(function (s) { if (s.id === pick) hit = s; });
    /* Until somebody picks one, the top of the board is the story. Once they
       have, it stays picked even when a newer card jumps above it, because the
       screen moving out from under a person mid-sentence is its own bug. */
    if (!hit) { hit = list[0]; if (!picked) pick = hit.id; }
    return hit;
  }

  function renderList() {
    var box = byId('svList'), n = byId('svListN');
    if (!box) return;
    var list = sortSits(S.sits), cur = current();
    if (n) n.textContent = list.length ? String(list.length) : '';
    if (!list.length) {
      swap(box, '<div class="dk-empty">No threads yet.</div>');
      return;
    }
    swap(box, list.map(function (s) {
      var on = cur && s.id === cur.id;
      var t = T(), c = t ? t.count(s) : 0;
      var bits = [];
      if (s.priority === 'high') bits.push('<span class="flag">Priority</span>');
      if (c) bits.push('<span>' + c + (c === 1 ? ' beat' : ' beats') + '</span>');
      bits.push('<span>' + esc(ago(new Date(when(s)))) + '</span>');
      return '<button type="button" class="sv-row' + (on ? ' on' : '') +
        (s.priority === 'high' ? ' high' : '') + (closed(s) ? ' closed' : '') +
        '" data-id="' + esc(s.id || '') + '" data-act="pick">' +
        '<div class="hl">' + esc(s.headline || 'Untitled') + '</div>' +
        '<div class="meta">' + bits.join('<span class="sep">&middot;</span>') + '</div></button>';
    }).join(''));
  }

  function draftText(s) {
    var t = T(), sh = (t && t.shown(s)) || { rows: [], hidden: 0 };
    var out = [];
    if (s.priority === 'high') out.push('PRIORITY');
    out.push(s.headline || 'Untitled');
    out.push('');
    if (s.summary) { out.push(s.summary); out.push(''); }
    if (s.location) { out.push('Location as heard: ' + s.location + ' (approximate)'); out.push(''); }
    out.push('How it came in:');
    sh.rows.forEach(function (b) {
      out.push('  ' + (clock(b.at) || '--:--') + '  ' + (b.text || ''));
    });
    if (sh.hidden) out.push('  (' + sh.hidden + ' earlier ' + (sh.hidden === 1 ? 'beat' : 'beats') + ' not shown)');
    out.push('');
    out.push('Read off scanner audio by machine. Nothing here is confirmed and none of it');
    out.push('is for publication until the desk checks it against the department.');
    return out.join('\n');
  }

  function renderDraft() {
    var box = byId('svDraft');
    if (!box) return;
    var s = current();
    if (!s) {
      swap(box, '<div class="dk-empty">Nothing on the board yet. A thread appears here ' +
        'when the same thing turns up on the air more than once.</div>');
      return;
    }
    var t = T(), sh = (t && t.shown(s)) || { rows: [], hidden: 0 };
    var k = [];
    if (s.priority === 'high') k.push('<span class="flag">Priority</span>');
    if (s.type) k.push('<span>' + esc(s.type) + '</span>');
    if (s.status) k.push('<span>' + esc(s.status) + '</span>');
    k.push('<span>' + esc(ago(new Date(when(s)))) + '</span>');

    var h = '<div class="kicker">' + k.join('<span class="sep">&middot;</span>') + '</div>' +
      '<h1>' + esc(s.headline || 'Untitled') + '</h1>' +
      (s.summary ? '<div class="sum">' + esc(s.summary) + '</div>' : '') +
      (s.location ? '<div class="where">' + esc(s.location) + ' &middot; approximate</div>' : '') +
      '<div class="sv-actions">' +
        '<button type="button" class="btn" data-act="copy" data-id="' + esc(s.id || '') + '">Copy as text</button>' +
        (s.lat != null && s.lon != null
          ? '<button type="button" class="btn" data-act="map" data-id="' + esc(s.id || '') + '">Open on the map</button>'
          : '') +
      '</div>' +
      '<div class="sv-note">Read off scanner audio by machine. Names, plates and addresses ' +
        'are transcribed as spoken and are frequently misheard. Nothing here is confirmed ' +
        'and none of it is for publication until the desk has checked it against the department.</div>' +
      '<div class="sv-beats"><div class="cap">How it came in</div>';
    if (sh.hidden) {
      h += '<div class="sv-hidden">' + sh.hidden + ' earlier ' +
        (sh.hidden === 1 ? 'beat' : 'beats') + ' not shown</div>';
    }
    h += sh.rows.map(function (b) {
      return '<div class="beat' + (b.canPull ? ' pull' : '') + '">' +
        '<div class="at">' + esc(clock(b.at) || 'no time') + '</div>' +
        '<div class="tx">' + (b.kind ? '<span class="kind">' + esc(b.kind) + '</span>' : '') +
        esc(b.text || '') + '</div></div>';
    }).join('');
    if (!sh.rows.length) h += '<div class="sv-hidden">No beats recorded on this thread yet.</div>';
    swap(box, h + '</div>');
  }

  function renderEv() {
    var box = byId('svEv');
    if (!box) return;
    var s = current();
    if (!s) { swap(box, '<div class="dk-empty">&mdash;</div>'); return; }
    var ids = {};
    if (s.id) ids[s.id] = 1;
    (s.events || []).forEach(function (e) {
      var id = e && (e.id || e.incidentId || e.eventId);
      if (id) ids[id] = 1;
    });
    var hits = (S.tx || []).filter(function (t) { return t.incidentId && ids[t.incidentId]; });
    if (!hits.length) {
      /* Said rather than left blank. A thread with no linked audio is normal:
         the beats can come from a wire alert or a 311 record, and an empty
         column with no explanation reads as a failure of this panel. */
      swap(box, '<div class="dk-empty">No scanner audio is linked to this thread. ' +
        'The beats above came from the feeds rather than off the air.</div>');
      return;
    }
    swap(box, hits.slice(0, 40).map(function (t) {
      return '<div class="ev-row"><span class="src">' + esc(t.source || '') + '</span>' +
        '<span class="at">' + esc(clock(t.time)) + '</span><br>' + esc(t.text || '') + '</div>';
    }).join(''));
  }

  /* Put a point in the middle of a window rather than in the middle of the
     screen. The map fills the whole viewport behind the view, so panTo would
     centre the pin under the draft column, where the one thing it cannot be
     seen through is a column of text. */
  function centreIn(elm, lat, lon, minZoom) {
    var m = root.map;
    if (!m || !elm || lat == null || lon == null) return;
    try {
      if (minZoom && m.getZoom() < minZoom) m.setZoom(minZoom, { animate: false });
      var r = elm.getBoundingClientRect(), c = m.getContainer().getBoundingClientRect();
      if (!r.width || !r.height) return;
      var wantX = r.left - c.left + r.width / 2, wantY = r.top - c.top + r.height / 2;
      var p = m.latLngToContainerPoint([lat, lon]);
      m.panBy([Math.round(p.x - wantX), Math.round(p.y - wantY)], { animate: false });
    } catch (e) { /* a map that will not pan is not worth an exception here */ }
  }

  function centreStory() {
    var s = current();
    if (s && s.lat != null && s.lon != null) centreIn(byId('svMap'), s.lat, s.lon, 13);
  }

  function showing(id) {
    var e = byId(id);
    return !!e && e.classList.contains('show');
  }

  function paint(next) {
    if (!MOUNTED) mount();
    if (next) {
      S.feed = next.feed || [];
      S.sits = next.sits || [];
      S.tx = next.tx || [];
      S.pipe = next.pipe || null;
      S.now = next.now || Date.now();
    } else S.now = Date.now();
    if (showing('deskview')) {
      renderState();
      renderBoard();
      var sp = splitFeed();
      renderRoutine(sp.routine);
      renderWire(sp.wire);
      renderAudio();
    }
    if (showing('storyview')) {
      renderList();
      renderDraft();
      renderEv();
    }
  }

  function go(v) {
    var b = document.querySelector('.tab[data-view="' + v + '"]');
    if (b) b.click();
  }

  function setTheme(t) {
    theme = (t === 'dark') ? 'dark' : 'light';
    ['deskview', 'storyview'].forEach(function (id) {
      var e = byId(id);
      if (e) e.setAttribute('data-theme', theme);
    });
    var alt = document.body.classList.contains('altview');
    document.body.classList.toggle('lightview', alt && theme === 'light');
    /* The basemap is the one piece of these views that lives outside them. A
       light sheet with a dark map in the middle of it is not a design, it is a
       hole, so the tiles follow the theme and go back to dark on the way out. */
    if (alt && root.baseMapTheme) root.baseMapTheme(theme);
    var lbl = theme === 'light' ? 'Dark' : 'Light';
    Array.prototype.forEach.call(
      document.querySelectorAll('#deskview [data-act="theme"],#storyview [data-act="theme"]'),
      function (b) { b.textContent = lbl; });
    try { localStorage.setItem('bcc.deskTheme', theme); } catch (e) {}
  }

  function changed(v) {
    if (!MOUNTED) mount();
    var alt = (v === 'desk' || v === 'story');
    document.body.classList.toggle('altview', alt);
    document.body.classList.toggle('lightview', alt && theme === 'light');
    if (root.baseMapTheme) root.baseMapTheme(alt ? theme : 'dark');
    measure();
    if (!alt) return;
    paint(null);
    if (v === 'story') setTimeout(centreStory, 60);
  }

  function goMap(id) {
    var pt = null;
    (S.sits || []).forEach(function (s) { if (s.id === id && s.lat != null) pt = [s.lat, s.lon]; });
    (S.feed || []).forEach(function (it) { if (it.id === id && it.lat != null) pt = [it.lat, it.lon]; });
    go('map');
    if (!pt || !root.map) return;
    setTimeout(function () {
      try { root.map.setView(pt, Math.max(root.map.getZoom(), 14)); } catch (e) {}
    }, 0);
  }

  function copyOut(btn) {
    var s = current();
    if (!s) return;
    var txt = draftText(s), old = btn.textContent;
    function done(okay) {
      btn.textContent = okay ? 'Copied' : 'Copy failed';
      setTimeout(function () { btn.textContent = old; }, 1600);
    }
    if (root.navigator && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function () { done(true); }, function () { done(legacy(txt)); });
      return;
    }
    done(legacy(txt));
  }
  /* execCommand is deprecated and is still the only thing that works when the
     page is served over plain http, which is how this board is read on the
     desk machine. */
  function legacy(txt) {
    try {
      var ta = document.createElement('textarea');
      ta.value = txt;
      ta.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      var okay = document.execCommand('copy');
      document.body.removeChild(ta);
      return okay;
    } catch (e) { return false; }
  }

  function onClick(e) {
    var el = e.target;
    var b = (el && el.closest) ? el.closest('[data-act]') : null;
    if (!b) return;
    var act = b.getAttribute('data-act'), id = b.getAttribute('data-id');
    if (act === 'theme') { setTheme(theme === 'light' ? 'dark' : 'light'); return; }
    if (act === 'routine') { routineOpen = !routineOpen; paint(null); return; }
    if (act === 'pick') { pick = id; picked = true; paint(null); centreStory(); return; }
    /* A card on the Desk is a question about a story, so pressing it hands the
       question to the view that answers it rather than opening a panel on top
       of the one you are reading. */
    if (act === 'story') { pick = id; picked = true; go('story'); return; }
    if (act === 'map') { goMap(id); return; }
    if (act === 'copy') { copyOut(b); return; }
  }

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!(showing('deskview') || showing('storyview'))) return;
    var a = document.activeElement;
    if (a && /^(input|textarea|select)$/i.test(a.tagName || '')) return;
    go('map');
  });

  try {
    var saved = localStorage.getItem('bcc.deskTheme');
    if (saved === 'dark' || saved === 'light') theme = saved;
  } catch (e) {}

  var api = { mount: mount, paint: paint, changed: changed, theme: setTheme, measure: measure };
  root.BCCDesk = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof window !== 'undefined' ? window : this));
