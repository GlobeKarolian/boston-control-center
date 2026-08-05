// app/statepolice.js
//
// Which of the situations on the board are Massachusetts State Police business.
//
// John Ellement asked for a section on state police. Matt has since set the
// rule for what goes in it, and it is one sentence: only transmissions from
// the State Police feed.
//
// So the column is first-hand or it is nothing. A card earns its place by
// having been heard on the Mass State Police radio itself. Not by a Boston
// dispatcher saying "trooper", and not by this file noticing a road the State
// Police happen to patrol.
//
// assess() still returns all three tiers, because the tier is a real fact
// about a card and other parts of the page may want it. select() is the thing
// that changed: it hands back the feed tier alone. The other two are still
// reachable through select(list, { include: 'all' }) and still under test, so
// the judgement is a switch rather than a deletion:
//
//   feed           heard on a State Police channel. This is the column.
//
//   named          somebody on another radio said it. Real reporting, wrong
//                  column, because a Boston Police dispatcher mentioning a
//                  trooper is Boston Police radio.
//
//   jurisdiction   nobody said it and this file inferred it from a road. A
//                  lead to make a call on, never a line to publish, and now
//                  not a card either.
//
// What that costs is honest and worth writing down: State Police radio is
// terse unit chatter, so it produces a headline far less often than a
// municipal channel does, and the card list can sit empty while the feed is
// plainly live. That is the exact thing that looked broken before. So the
// section also carries the transmissions themselves, which is what Matt asked
// for in the first place, and radio() below is what picks them out. Cards when
// there are cards, the raw radio underneath either way.
//
// Runs in the browser against situations.json, which the page already fetches
// every five seconds, so the whole section costs nothing at the store. Given
// what tools/cron-cost.js has to say about the command budget, that is not a
// small consideration.
//
// The decision half is pure and DOM-free so tools/test-statepolice.js can
// drive it in node.

(function (root) {
  'use strict';

  /* The troops as they stand. Troop E was the Turnpike and nothing else, and
     it was abolished on 2 May 2018 after the overtime case; the Pike went to
     whichever geographic troop it runs through. So a card that appears to say
     Troop E is either very old or misheard, and gets no letter at all. A wrong
     troop printed next to a headline is worse than no troop.
     Source: mass.gov troop boundaries, and Troop F is Massport, which is Logan
     and the port property rather than a slice of the map. */
  var BARRACKS = {
    A: ['andover', 'newbury', 'concord', 'medford', 'revere', 'danvers'],
    B: ['lee', 'shelburne falls', 'springfield', 'cheshire', 'russell', 'northampton', 'westfield'],
    C: ['athol', 'millbury', 'brookfield', 'leominster', 'sturbridge', 'holden', 'belchertown', 'devens', 'charlton'],
    D: ['norwell', 'south yarmouth', 'north dartmouth', 'middleboro', 'middleborough', 'oak bluffs', 'nantucket', 'bourne'],
    F: ['logan', 'logan airport'],
    H: ['framingham', 'foxboro', 'foxborough', 'boston', 'south boston', 'milton', 'weston', 'tunnels', 'government center'],
  };

  /* Ordered most specific first, because the first one to match is the phrase
     the card reports back. "state police" is a better thing to show a reporter
     than "trooper" when the transmission happened to contain both. */
  var NAMED = [
    { re: /\bstate\s+police\b/i, phrase: 'state police' },
    { re: /\bstate\s+troopers?\b/i, phrase: 'state trooper' },
    { re: /\btroop\s+[a-h]\b/i, phrase: 'a troop' },
    { re: /\bbarracks\b/i, phrase: 'a barracks' },
    { re: /\btroopers?\b/i, phrase: 'trooper' },
    { re: /\bstaties?\b/i, phrase: 'statie' },
    /* Case sensitive. Whisper writes the letters out when they are spoken as
       letters, and lowercase "msp" in running prose is far more likely to be
       something else than it is to be the department. */
    { re: /\bMSP\b/, phrase: 'MSP' },
  ];

  /* Which radio a card was heard on, when the analyst managed to say. This is
     the strongest evidence in the file and it outranks everything below,
     because a transmission carried on a State Police channel IS the State
     Police, where a Boston Police dispatcher saying "trooper" is somebody
     mentioning them.

     A feed tag is a name a person typed into the relay rather than something
     said on the air, so it gets its own matcher. The lowercase "msp" veto in
     NAMED is deliberately not applied here: "msp" loose in a sentence is more
     likely a garble than the department, but a feed somebody sat down and
     named msp is the department. Matched with the punctuation opened out,
     because these arrive as slugs and "mass-state-police" has no spaces for
     \s+ to find. */
  var FEED_RE = /\bstate\s+police\b|\bstate\s+troopers?\b|\btroopers?\b|\bmsp\b|\bstatie|\btroop\s+[a-h]\b/i;

  function openOut(tag) {
    return String(tag == null ? '' : tag).replace(/[^a-z0-9]+/gi, ' ').trim();
  }

  /* The tag as a person would write it. Slugs are what the store holds and
     "mass-state-police" on a card in front of a reporter looks like a bug. */
  function prettyFeed(tag) {
    var s = openOut(tag);
    if (!s) return '';
    return s.replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); })
      .replace(/\bMsp\b/g, 'MSP').replace(/\bMbta\b/g, 'MBTA');
  }

  function feedMatch(s) {
    var list = s && s.feeds, i, open;
    if (!Array.isArray(list)) return null;
    for (i = 0; i < list.length; i++) {
      open = openOut(list[i]);
      if (open && FEED_RE.test(open)) return list[i];
    }
    return null;
  }

  /* Roads and property the State Police patrol. Specific names first so the
     card can say which road; the bare "parkway" catch-all is last and
     deliberately vaguer, because most parkways in greater Boston are DCR and
     some are not. */
  var ROADS = [
    { re: /\b(?:mass(?:achusetts)?\s*(?:pike|turnpike)|the\s+pike|i[\s.-]{0,2}90|route\s*90)\b/i, why: 'the Mass Pike' },
    { re: /\b(?:i[\s.-]{0,2}93|route\s*93|southeast\s+expressway|central\s+artery)\b/i, why: 'I-93' },
    { re: /\b(?:i[\s.-]{0,2}95|route\s*95|route\s*128|128\s*(?:north|south|northbound|southbound))\b/i, why: 'I-95 and Route 128' },
    { re: /\b(?:i[\s.-]{0,2}495|route\s*495)\b/i, why: 'I-495' },
    { re: /\b(?:ted\s+williams|sumner|callahan|(?:tip\s+)?o'?\s?neill)\s+tunnel\b|\bthe\s+tunnel\b/i, why: 'the Boston tunnels' },
    { re: /\b(?:logan|massport)\b/i, why: 'Logan and Massport property' },
    { re: /\bstorrow\b|\bsoldiers?\s+field\s+(?:road|rd)\b/i, why: 'Storrow Drive and Soldiers Field Road' },
    { re: /\bmemorial\s+(?:drive|dr)\b/i, why: 'Memorial Drive' },
    { re: /\b(?:jamaicaway|riverway|arborway)\b/i, why: 'the Emerald Necklace parkways' },
    { re: /\bmorrissey\b|\bday\s+boulevard\b|\bday\s+blvd\b/i, why: 'the Dorchester shore parkways' },
    { re: /\brevere\s+beach\s+parkway\b|\bmystic\s+valley\s+parkway\b|\balewife\s+brook\s+parkway\b|\bfresh\s+pond\s+parkway\b/i, why: 'the north shore parkways' },
    { re: /\bblue\s+hills?\s+parkway\b|\bfurnace\s+brook\s+parkway\b|\btruman\s+parkway\b|\bvfw\s+parkway\b|\bgallivan\b/i, why: 'a DCR parkway' },
    { re: /\b(?:route\s*24|route\s*3(?!\d)|route\s*2(?!\d))\b/i, why: 'a state highway' },
    { re: /\bstate\s+house\b|\bregistry\s+of\s+motor\s+vehicles\b/i, why: 'state property' },
    { re: /\bparkway\b/i, why: 'a parkway, most of which here are DCR' },
  ];

  var BARRACKS_RE = (function () {
    var out = [], letter, names, i;
    for (letter in BARRACKS) {
      if (!Object.prototype.hasOwnProperty.call(BARRACKS, letter)) continue;
      names = BARRACKS[letter];
      for (i = 0; i < names.length; i++) {
        /* The word "barracks" is required. Every one of these is also just a
           town, and a house fire in Milton is not a State Police matter. */
        out.push({ troop: letter, re: new RegExp('\\b' + names[i].replace(/\s+/g, '\\s+') + '\\s+barracks\\b', 'i') });
      }
    }
    return out;
  })();

  /* Everything the desk editor wrote about this card, including the beats
     folded into it. A thread whose headline is about the person in the water
     can still carry a linked event that says a trooper responded, and that
     event is the whole reason the card belongs in this column. */
  function textOf(s) {
    if (!s) return '';
    var bits = [s.headline, s.summary, s.location, s.type], ev = s.events, i;
    if (Array.isArray(ev)) {
      for (i = 0; i < ev.length; i++) {
        if (ev[i]) { bits.push(ev[i].text); bits.push(ev[i].type); }
      }
    }
    var out = [];
    for (i = 0; i < bits.length; i++) if (bits[i]) out.push(String(bits[i]));
    /* A non-whitespace separator, and that is the whole reason it is not a
       newline. Every pattern here spans words with \s+, so a headline ending
       "wanted by the state" followed by a summary opening "Police say" would
       read as one phrase across the seam and put a card in this column that
       nobody on the radio ever put there. Fields are separate sentences. */
    return out.join(' ; ');
  }

  function troopOf(text) {
    var m = text.match(/\btroop\s+([a-h])\b/i), i, L;
    if (m) {
      L = m[1].toUpperCase();
      if (/^[ABCDFH]$/.test(L)) return L;
      /* E is gone and any other letter is a mishearing, but fall through
         instead of giving up: the same transmission can name a barracks, and
         a barracks that exists is better evidence than a troop that does
         not. A wrong troop next to a headline is worse than no troop. */
    }
    for (i = 0; i < BARRACKS_RE.length; i++) {
      if (BARRACKS_RE[i].re.test(text)) return BARRACKS_RE[i].troop;
    }
    return null;
  }

  function assess(s) {
    var text = textOf(s), i, tag;

    /* Ahead of the text, and ahead of the empty-text guard below. A card off
       the State Police radio belongs in this column even if the desk wrote a
       headline so terse there is nothing here left to match on. */
    tag = feedMatch(s);
    if (tag) return { tier: 'feed', why: prettyFeed(tag), troop: troopOf(text) };

    if (!text) return null;

    for (i = 0; i < NAMED.length; i++) {
      if (NAMED[i].re.test(text)) {
        return { tier: 'named', why: NAMED[i].phrase, troop: troopOf(text) };
      }
    }
    for (i = 0; i < ROADS.length; i++) {
      if (ROADS[i].re.test(text)) {
        return { tier: 'jurisdiction', why: ROADS[i].why, troop: null };
      }
    }
    return null;
  }

  /* An unknown tier sorts last rather than turning the comparison into NaN,
     which in a sort comparator does not throw and does not sort, it just
     quietly leaves the column in whatever order it arrived. */
  var RANK = { feed: 0, named: 1, jurisdiction: 2 };
  function rankOf(t) { return Object.prototype.hasOwnProperty.call(RANK, t) ? RANK[t] : 9; }

  function stamp(s) {
    var t = Date.parse((s && (s.updated || s.firstSeen)) || '');
    return isNaN(t) ? 0 : t;
  }

  /* Feed tier only, by default and on purpose. Anything else is somebody
     mentioning the State Police rather than the State Police on the radio, and
     Matt's rule is that this column holds the second thing.

     The opts argument exists so the other two tiers are switched off rather
     than thrown away. They are a few hundred lines of regex that were checked
     against real Massachusetts road names and real troop boundaries, and the
     day somebody wants a "they are probably on this" panel, the work is here
     and still under test. An unrecognised opts value falls through to the
     strict answer, because the safe wrong result is a column that under-claims
     rather than one that quietly goes back to guessing. */
  function select(list, opts) {
    var out = [], i, s, mark;
    var all = !!(opts && opts.include === 'all');
    if (!Array.isArray(list)) return out;
    for (i = 0; i < list.length; i++) {
      s = list[i];
      if (!s || !s.id) continue;
      mark = assess(s);
      if (!mark) continue;
      if (!all && mark.tier !== 'feed') continue;
      out.push({ sit: s, mark: mark });
    }
    /* Sorted by how much the tier is worth, always, ahead of priority and
       ahead of time. Under the default that is a single tier and the sort is
       doing nothing, which is fine: it costs one subtraction per comparison
       and it means the include:'all' path is not a second code path with its
       own ordering bugs. */
    out.sort(function (a, b) {
      var t = rankOf(a.mark.tier) - rankOf(b.mark.tier);
      if (t) return t;
      var p = (b.sit.priority === 'high' ? 1 : 0) - (a.sit.priority === 'high' ? 1 : 0);
      if (p) return p;
      return stamp(b.sit) - stamp(a.sit);
    });
    return out;
  }

  /* The transmissions themselves, out of the console log the page already
     polls. Same matcher the cards use, deliberately: if a feed counts as State
     Police for a card it counts here, and there is no second definition to
     drift out of step with the first.

     The console log is the raw transcript array, whose rows are shaped
     { time, source, text } with source as a feed slug. Nothing here reaches
     for the store, so this section costs zero Redis commands and zero extra
     bytes on the wire. */
  function radio(list) {
    var out = [], i, t;
    if (!Array.isArray(list)) return out;
    for (i = 0; i < list.length; i++) {
      t = list[i];
      if (!t || !t.text) continue;
      if (!FEED_RE.test(openOut(t.source))) continue;
      out.push(t);
    }
    return out;
  }

  /* Why a buffer exists at all.

     The rendered transcript key holds the last 80 transmissions across every
     channel on the network. State Police are about a tenth of the traffic, so
     one poll carries maybe eight State Police lines and covers twenty minutes.
     A reporter who sat down an hour ago wants the hour.

     Raising the shared cap is the obvious fix and it is the wrong one. That
     log is polled every 1.5 seconds by every open dashboard, it sits behind
     auth so the CDN will not cache it, and doubling it doubles the heaviest
     number on the page for everyone in order to fill one column.

     So the browser keeps what it has already been sent. Each poll merges in
     whatever is new and the buffer grows into a real history at a cost of zero
     bytes and zero commands. Pure and DOM-free, so the merge is under test
     rather than being four lines of dedupe logic buried in a render.

     Keyed on source, time and text together. Time alone collides, because two
     channels can be transcribed in the same second, and a source and a second
     collide too when a long transmission is split. The text is what makes a
     line itself. */
  function key(t) {
    return String((t && t.source) || '') + ' ' + String((t && t.time) || '') +
      ' ' + String((t && t.text) || '');
  }

  function merge(buffer, incoming, cap) {
    var out = [], seen = {}, i, k;
    var n = (typeof cap === 'number' && cap > 0) ? cap : 150;
    var lists = [Array.isArray(incoming) ? incoming : [], Array.isArray(buffer) ? buffer : []];
    var j;
    /* Incoming first so a line the store has since corrected wins over the copy
       already on screen, and so the cheap path when nothing changed is a walk
       that finds every key already present. */
    for (j = 0; j < lists.length; j++) {
      for (i = 0; i < lists[j].length; i++) {
        k = key(lists[j][i]);
        if (Object.prototype.hasOwnProperty.call(seen, k)) continue;
        seen[k] = 1;
        out.push(lists[j][i]);
      }
    }
    /* Newest first, and by the clock rather than by arrival, because the two
       lists being spliced were each sorted on their own. A row with no
       parseable time sorts to the bottom instead of to 1970 at the top. */
    out.sort(function (a, b) { return stampOf(b) - stampOf(a); });
    return out.slice(0, n);
  }

  function stampOf(t) {
    var v = Date.parse((t && t.time) || '');
    return isNaN(v) ? 0 : v;
  }

  /* The short thing on the chip. Four feet away from the screen this is all
     anybody reads, so it has to carry the tier by itself. */
  function label(mark) {
    if (!mark) return '';
    /* A troop, when one was named, on either of the two real tiers. It is the
       most specific true thing available and it is what gets typed into a
       story, so it wins the four square millimetres of chip. */
    if (mark.troop && mark.tier !== 'jurisdiction') return 'Troop ' + mark.troop;
    if (mark.tier === 'feed') return 'MSP radio';
    if (mark.tier === 'named') return 'said on air';
    return 'MSP road';
  }

  /* The long version, for the tooltip. The jurisdiction wording says the
     inference out loud on purpose. A newsroom tool that quietly presents a
     guess as a fact is worse than one that has no section at all. */
  function detail(mark) {
    if (!mark) return '';
    if (mark.tier === 'feed') {
      return 'Heard on the ' + mark.why + ' feed, so this is State Police radio rather than '
        + 'somebody else mentioning them.'
        + (mark.troop ? ' Troop ' + mark.troop + ' was named.' : '')
        + ' Still machine-transcribed, so confirm the words before you use them.';
    }
    if (mark.tier === 'named') {
      return 'The radio said ' + mark.why + '.'
        + (mark.troop ? ' Troop ' + mark.troop + ' was named.' : '')
        + ' Still machine-transcribed, so confirm the words before you use them.';
    }
    return 'Nobody said state police. This is ' + mark.why + ', which the State Police patrol, '
      + 'so they are very likely on it. A lead to call on, not a fact.';
  }

  var API = {
    assess: assess,
    select: select,
    radio: radio,
    merge: merge,
    label: label,
    detail: detail,
    _consts: { NAMED: NAMED, ROADS: ROADS, BARRACKS: BARRACKS },
  };

  root.BCCStatePolice = API;
  if (typeof module === 'object' && module.exports) module.exports = API;
})(typeof globalThis === 'object' ? globalThis : this);
