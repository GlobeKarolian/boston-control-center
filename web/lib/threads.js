// lib/threads.js
// Turning a flat list of situations into stories that hold still.
//
// The problem this file exists to solve, in the shape it actually appeared:
// somebody went into the water off a bridge, and twenty minutes later their
// bag turned up on the walkway. The analyst had no way to say "this is the
// next beat of that", so it emitted a second situation, typed it as a
// suspicious package, and the red banner fired across the whole screen. The
// bag was not suspicious. It was the same story, later.
//
// Two things had to change for that to be expressible. First, identity has to
// survive a run: a model asked to invent "a stable short id slug" every sixty
// seconds produces `tobin-jumper` on one pass and `jumper-tobin-bridge` on the
// next, and every downstream Set keyed on that id treats the second one as a
// story it has never seen. Second, a situation needs somewhere to put a beat
// that belongs to another situation.
//
// So identity is derived here and never asked of the model, and a situation
// carries an events array. The model may PROPOSE a link; this file decides
// whether to believe it.

const crypto = require('crypto');

// How long a story stays open with nothing new said about it. The analyst only
// ever sees the last 70 transcript lines, so a story stops being mentioned the
// moment it stops generating radio traffic, which is much sooner than it stops
// being news. Forty-five minutes of silence closes it; another forty-five
// removes it. A fire from an hour ago is still on the board, which is what a
// desk coming back from lunch needs.
const QUIET_MS = 45 * 60 * 1000;
const DROP_MS = 90 * 60 * 1000;

// A model-proposed link is checked against these before it is believed.
const LINK_WINDOW_MS = 3 * 60 * 60 * 1000;
const LINK_MAX_M = 3000;

// Geometric fallback for when the model says nothing about a link. Tighter
// than the model-proposed limits on purpose: this is a guess with no language
// behind it, so it only fires when two things are close in space, close in
// time, and the same kind of thing.
const MATCH_MAX_M = 500;
const MATCH_WINDOW_MS = 45 * 60 * 1000;

const MAX_EVENTS = 40;

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 28);
}

function haversine(a, b, c, d) {
  if ([a, b, c, d].some(v => v === null || v === undefined)) return Infinity;
  const R = 6371000, r = Math.PI / 180;
  const dLat = (c - a) * r, dLon = (d - b) * r;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/* Identity is minted once, from the things about a story that do not change
   while it is happening: what kind of thing it is, roughly where, and when it
   started. The random tail is what keeps two simultaneous crashes in the same
   place from colliding into one card.

   Note what is NOT in here: the headline. A headline is the most volatile
   field a situation has, because it is rewritten every time the model learns
   one more fact, and hashing it would put us back where we started. */
function mintId(s, firstSeen) {
  const cell = (s.lat !== null && s.lat !== undefined)
    ? s.lat.toFixed(2) + ',' + s.lon.toFixed(2)
    : slug(s.location) || 'nowhere';
  const h = crypto.createHash('sha1')
    .update([s.type, cell, firstSeen, Math.random()].join('|'))
    .digest('hex').slice(0, 6);
  return (slug(s.type) || 'situation') + '-' + h;
}

/* What the browser dedupes alerts on, as opposed to what it keys cards on.
   Stable ids should make this redundant, and it is here for the case where
   they do not. An alarm that cries wolf gets muted within a shift, and a muted
   alarm is worse than no alarm because the room believes it is covered.

   It is the kind of thing and roughly where, and deliberately NOT the
   headline. Headlines were in here and had to come out. The model rewrites one
   every time it learns another fact, so "Working fire at 42 Boylston St" and
   "A working fire at the 42 Boylston St address" hashed to two different keys
   for one fire, which is precisely the failure this exists to prevent. Two
   working fires in the same square kilometre inside the alert window are the
   same fire often enough that collapsing them is the safer mistake, and the
   card ids underneath still keep them apart on the board.

   The headline comes back only when nothing geocoded and there is no place
   name either, because then it is the last thing left to tell two stories
   apart. */
const STOP = new Set(['the', 'a', 'an', 'at', 'in', 'on', 'of', 'to', 'and', 'for', 'with', 'is', 'are', 'after', 'near']);
function alertKey(s) {
  const hasPin = s.lat !== null && s.lat !== undefined && s.lon !== null && s.lon !== undefined;
  const cell = hasPin ? s.lat.toFixed(2) + ',' + s.lon.toFixed(2) : slug(s.location);
  if (cell) return slug(s.type) + '|' + cell;
  const words = String(s.headline || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/).filter(w => w && !STOP.has(w)).slice(0, 6).join('-');
  return slug(s.type) + '|nowhere|' + words;
}

function ev(kind, text, type, at, clips) {
  const e = { at: at || new Date().toISOString(), kind, text: String(text || '').slice(0, 400), type: type || null };
  /* The audio behind this beat, when the analyst found it. A small capped
     list of {u, at}, and absent entirely when there is none, so a board from
     before audio existed serialises exactly as it always did. */
  if (Array.isArray(clips) && clips.length) e.clips = clips.slice(0, 4);
  return e;
}

/* Words worth matching on: lowercased, letters and digits only, the tiny
   function words that ring true everywhere dropped so a match means shared
   content and not shared grammar. Lives here so the analyst and any future
   caller share one definition of "these two lines are about the same thing". */
const STOP_ = new Set(('the a an and or of to in on at for is are was were be been '
  + 'this that with from it its they them he she we you i as by up out').split(' '));
function normWords(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter(w => w.length > 2 && !STOP_.has(w));
}

/* Every radio that has carried this scene, ever. It only ever grows, and that
   is deliberate: which agency turned out is a fact about what happened, not a
   description of the last sixty seconds. A crash first heard on Boston Police
   that the State Police then took over stays State Police business even once
   the troopers stop talking, and a card that quietly dropped the tag would
   walk back out of that column while the story was still running. */
function mergeFeeds(a, b) {
  const out = [], seen = new Set();
  for (const list of [a, b]) {
    if (!Array.isArray(list)) continue;
    for (const v of list) {
      const k = String(v == null ? '' : v).trim();
      if (!k || seen.has(k) || out.length >= 6) continue;
      seen.add(k); out.push(k);
    }
  }
  return out;
}

/* Folding one card into another, the way somebody on the desk means it when
   they drag one onto the other. The parent keeps its headline and its id, and
   everything the child ever carried becomes beats inside it in the order they
   happened. Nothing is discarded, because the reason a person merged two cards
   is that both of them were true. */
function absorb(parent, child) {
  const incoming = (child.events && child.events.length)
    ? child.events
    : [ev('opened', child.headline, child.type, child.firstSeen)];
  parent.events = parent.events.concat(incoming)
    .sort((a, b) => Date.parse(a.at || 0) - Date.parse(b.at || 0));
  if (parent.events.length > MAX_EVENTS) parent.events = parent.events.slice(-MAX_EVENTS);
  if (child.priority === 'high') parent.priority = 'high';
  parent.feeds = mergeFeeds(parent.feeds, child.feeds);
  // A merge into a closed story reopens it. Somebody is looking at it now.
  if (parent.status === 'closed' && child.status && child.status !== 'closed') parent.status = child.status;
  if (Date.parse(child.firstSeen || 0) < Date.parse(parent.firstSeen || 0)) parent.firstSeen = child.firstSeen;
  if (Date.parse(child.updated || 0) > Date.parse(parent.updated || 0)) parent.updated = child.updated;
  parent.merged = (parent.merged || 0) + 1;
  parent.alertKey = alertKey(parent);
  return parent;
}

/* Does a proposed link hold up? The model has the language and we do not, so
   this is deliberately permissive about semantics and strict about physics. It
   never asks whether a bag and a jumper are the same kind of thing, because
   the whole point is that they are not. It asks whether they could be the same
   story: near each other, recent, and pointing at something that exists. */
function linkAllowed(parent, child) {
  if (!parent) return false;
  const age = Date.now() - Date.parse(parent.updated || parent.firstSeen || 0);
  if (!(age >= 0) || age > LINK_WINDOW_MS) return false;
  const d = haversine(parent.lat, parent.lon, child.lat, child.lon);
  // Infinity means one of them never geocoded. That is a failure of the
  // geocoder, not evidence against the link, so it is allowed through.
  return d === Infinity || d <= LINK_MAX_M;
}

function geometricMatch(prev, child) {
  let best = null, bestD = Infinity;
  for (const p of prev) {
    if (p.status === 'closed') continue;
    if (slug(p.type) !== slug(child.type)) continue;
    const age = Date.now() - Date.parse(p.updated || 0);
    if (!(age >= 0) || age > MATCH_WINDOW_MS) continue;
    const d = haversine(p.lat, p.lon, child.lat, child.lon);
    if (d < bestD && d <= MATCH_MAX_M) { best = p; bestD = d; }
  }
  return best;
}

/* The reconciliation itself.

   `prev` is what was on the board. `fresh` is what the model just said, already
   geocoded. `overrides` is what a human decided, and it wins over both.

   Returns the new board. Every situation on it either existed before and kept
   its id, or is genuinely new. */
function reconcile(prev, fresh, overrides = {}) {
  const now = Date.now();
  const nowIso = new Date().toISOString();
  // A local copy, because the merge pre-pass below adds derived handles to it.
  const merges = Object.assign({}, overrides.merge || {});
  const splits = overrides.split || {};

  const byId = new Map();
  for (const p of prev) if (p && p.id) byId.set(p.id, { ...p, events: Array.isArray(p.events) ? p.events.slice() : [] });

  /* Two handles reach a human correction: the id of a card already on the
     board, and the alertKey of something the radio has not finished saying
     yet. Both are checked. A desk that folds two cards together on Tuesday
     morning still means it on Tuesday evening, when the story has aged off the
     board and come back over the air as a fresh sighting with a new id. */
  const handles = x => [x && x.id, x && x.proposedId].filter(Boolean);
  const ruleFor = (table, x) => { for (const h of handles(x)) if (table[h] !== undefined) return table[h]; return null; };

  /* Human merges land first, and they land on the board itself. Somebody
     dragging one card into another is describing two things already on screen,
     so this runs before a word of the model's is read. The redirects are kept
     because everything downstream, the model's own `updates` and `relatedTo`
     included, may still be pointing at an id that just went away. */
  const redirect = new Map();
  for (const child of [...byId.values()]) {
    const target = merges[child.id];
    if (!target || target === child.id || !byId.has(target)) continue;
    absorb(byId.get(target), child);
    byId.delete(child.id);
    redirect.set(child.id, target);
    /* The child is off the board now, but the radio has not stopped talking
       about it, and the next run will hear the same thing again with no id to
       recognise it by. Its alert key survives its id, so the merge keeps
       holding. /api/sitlink writes the same handle into the stored table, so
       this still works once the card itself is long gone. */
    if (child.alertKey) merges[child.alertKey] = target;
  }
  const resolve = (id) => { let n = 0; while (id && redirect.has(id) && n++ < 8) id = redirect.get(id); return id; };

  const touched = new Set();
  const opened = [];

  for (const f of fresh) {
    /* A human who pulled this out of a thread is saying the machine got it
       wrong. `true` means it joins nothing; an id means it joins anything
       except that one. Read before every other rule, so nothing later can
       quietly put it back where a person just took it from. */
    const noLink = ruleFor(splits, f);
    const blocked = p => noLink === true || (p && noLink === p.id);

    let parent = null;
    const take = (cand) => { if (!cand || blocked(cand)) return false; parent = cand; return true; };

    // Human merge first, then the model's proposal, then geometry.
    const forced = resolve(ruleFor(merges, f));
    /* A forced link always arrives as a beat, never as an update. Somebody
       dragged this card into that one, which means they chose which headline
       the board keeps, and the machine does not get to overrule that choice
       sixty seconds later just because the radio said the other thing again. */
    const forcedLink = (forced && byId.has(forced)) ? take(byId.get(forced)) : false;

    const wantsUpdate = resolve(f.updates);
    const wantsRelated = resolve(f.relatedTo);
    for (const id of [wantsUpdate, wantsRelated]) {
      if (parent || !id || !byId.has(id)) continue;
      const cand = byId.get(id);
      if (linkAllowed(cand, f)) take(cand);
    }
    if (!parent && noLink !== true) {
      const g = geometricMatch([...byId.values()], f);
      if (g && !blocked(g)) parent = g;
    }

    if (parent) {
      touched.add(parent.id);
      const isBeat = forcedLink || (wantsRelated === parent.id && wantsUpdate !== parent.id);

      if (isBeat) {
        /* A related beat does not get to rewrite the story it belongs to.
           This is the jumper and the bag: the headline stays "person in the
           water", and the bag becomes a line inside it carrying its own type,
           so a reader can see that a suspicious package was called in without
           the board claiming a suspicious package is happening. */
        parent.events.push(ev('linked', f.headline, f.type, null, f.clips));
      } else {
        // Same story, moved on. The newest telling is the best telling,
        // because the model has heard more radio than it had last time.
        if (f.headline && f.headline !== parent.headline) parent.events.push(ev('update', f.headline, f.type, null, f.clips));
        parent.headline = f.headline || parent.headline;
        parent.summary = f.summary || parent.summary;
        parent.status = f.status || parent.status;
        if (f.lat !== null && f.lat !== undefined) {
          parent.lat = f.lat; parent.lon = f.lon; parent.location = f.location || parent.location;
          parent.matched = f.matched;
        }
        /* Priority can climb and cannot fall on its own. A story the model
           called high once is one a human decides to downgrade, not one that
           quietly relaxes because the next sixty seconds of radio were calmer
           than the last. */
        if (f.priority === 'high') parent.priority = 'high';
        if (f.confidence) parent.confidence = f.confidence;
      }
      /* Outside the beat/update branch, because it is true either way. A bag
         reported on the State Police radio is a beat of the search rather than
         a rewrite of it, and the search is still State Police business now. */
      parent.feeds = mergeFeeds(parent.feeds, f.feeds);
      parent.updated = nowIso;
      parent.alertKey = alertKey(parent);
      continue;
    }

    // Genuinely new.
    const firstSeen = nowIso;
    const id = mintId(f, firstSeen);
    const s = {
      id, headline: f.headline, summary: f.summary, type: f.type,
      priority: f.priority, confidence: f.confidence || 'reported',
      location: f.location, lat: f.lat, lon: f.lon, matched: f.matched, approx: true,
      status: f.status || 'developing',
      feeds: mergeFeeds(f.feeds, null),
      firstSeen, updated: nowIso,
      events: [ev('opened', f.headline, f.type, firstSeen, f.clips)],
    };
    s.alertKey = alertKey(s);
    byId.set(id, s);
    touched.add(id);
    opened.push(id);
  }

  /* Ageing. A story the model stopped mentioning is not necessarily over, it
     is just off the end of a 70-line window, so it closes quietly rather than
     vanishing mid-shift. */
  const out = [];
  for (const s of byId.values()) {
    const age = now - Date.parse(s.updated || s.firstSeen || 0);
    if (!(age >= 0)) { out.push(s); continue; }
    if (age > DROP_MS) continue;
    if (age > QUIET_MS && s.status !== 'closed') s.status = 'closed';
    if (s.events.length > MAX_EVENTS) s.events = s.events.slice(-MAX_EVENTS);
    out.push(s);
  }

  /* Board order. Open before closed, high before normal, newest first inside
     that. The wall screen is read top-down and rarely to the bottom, so the
     top of the list has to be the thing worth turning your head for. */
  const rank = s => (s.status === 'closed' ? 2 : 0) + (s.priority === 'high' ? 0 : 1);
  out.sort((a, b) => rank(a) - rank(b) || Date.parse(b.updated || 0) - Date.parse(a.updated || 0));

  return { situations: out, opened, touched: [...touched] };
}

module.exports = { reconcile, alertKey, mintId, haversine, normWords, QUIET_MS, DROP_MS };
