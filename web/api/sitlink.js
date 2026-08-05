// api/sitlink.js
// Where the newsroom overrules the machine about what belongs with what.
//
// The threading in lib/threads.js is good and it is not going to be right.
// A model listening to garbled radio will sometimes fold two stories into one
// and sometimes split one story into two, and no amount of prompt will get
// that to zero. What decides whether the feature is usable is not the error
// rate, it is whether the person who spots the error can fix it in one click
// and have the fix stay fixed. A newsroom will trust an imperfect thread it
// can correct. It will not trust a perfect one it cannot.
//
// So: three verbs, applied to the board immediately rather than on the next
// cron tick, and written into a table the analyst reads every run so the
// correction survives the machine changing its mind again a minute later.
//
//   merge  {action:'merge', id, into}   fold one card into another
//   split  {action:'split', id}         pin a card standalone, never absorbed
//          {action:'split', id, at}     pull one beat out into its own card
//   undo   {action:'undo',  id}         forget every correction about a card
//
// Gated on requireRead, the same door as the map. Anyone trusted to look at
// the board is trusted to tidy it, because the alternative is that the one
// person with the admin login becomes the bottleneck on every bad thread, and
// a correction nobody is empowered to make does not get made.
//
// That does make this the first route where a read credential writes, so the
// blast radius is worth stating plainly. It can only rearrange situations
// that are already on the board. It cannot invent one, cannot touch any key
// other than the situations output and its own link table, and every verb it
// has is reversible. The worst somebody can do through this door is make the
// situations panel wrong in a way the next person undoes in a click.
//
// Undo is real, not a rule change. A merge that cannot be taken back is a
// scary button, a scary button does not get pressed, and a thread nobody
// dares to fix is the exact failure this file exists to prevent. So a merge
// stashes the card it swallowed, and undo puts it back.

const { requireRead, json } = require('../lib/http');
const kv = require('../lib/kv');
const { K } = require('../lib/store-io');
const { reconcile, alertKey, mintId } = require('../lib/threads');

const LINKS = 'bcc:sit:links';

/* Undo snapshots live in their own key rather than inside the link table.
   The analyst reads LINKS on every run and has no use for them, and a whole
   card is a thousand times the size of a rule, so folding them together would
   put a hundred kilobytes of stashed cards into a pipeline that already
   carries the transcripts and the board. Nothing but this route reads it. */
const KEEP = 'bcc:sit:undo';

// Corrections expire. A merge decided during a Tuesday night fire is about
// that fire, and keeping it forever means a rule nobody remembers writing
// quietly shaping the board months later.
const LINK_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_LINKS = 400;

// Twice the entry lifetime, so what governs is the pruning below rather than
// the key expiring out from under a table somebody is still adding to.
const LINK_TTL_SEC = Math.round((LINK_TTL_MS * 2) / 1000);

// Undo snapshots are whole cards where everything else here is a short
// string, so they get their own smaller ceiling.
const MAX_KEEP = 40;

// Same six hours every other output key gets, set here rather than imported
// because store-io does not export it.
const OUT_TTL = 6 * 3600;

/* ---- request body --------------------------------------------------------- */

/* The same three cases api/admin.js handles, for the same reason: Vercel
   parses JSON for you most of the time, and the exception is the one that
   matters. The stream is capped because a body this route cares about is a
   few hundred bytes, and anything larger is either a mistake or somebody
   seeing what happens. */
async function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  let raw = '';
  for await (const c of req) { raw += c; if (raw.length > 16384) break; }
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

/* ---- the link table ------------------------------------------------------- */

/* Three maps, all keyed on the same handles:

     merge  handle -> id of the card it belongs inside
     split  handle -> true (joins nothing) or an id (joins anything but that)
     at     handle -> when the rule was made, for expiry

   reconcile() reads only `merge` and `split`, so `at` is invisible to it and
   costs nothing. The undo snapshots are in KEEP, a key of their own. */
const emptyLinks = () => ({ merge: {}, split: {}, at: {} });

function parseLinks(raw) {
  let t = null;
  try { t = raw ? JSON.parse(raw) : null; } catch (e) { t = null; }
  const e = emptyLinks();
  if (!t || typeof t !== 'object') return e;
  for (const k of Object.keys(e)) if (t[k] && typeof t[k] === 'object') e[k] = t[k];
  return e;
}

/* id -> what undo needs to reverse the last correction made to that card.
   Each memo carries its own timestamp, because it expires on its own schedule
   and in its own key. */
function parseKeep(raw) {
  let t = null;
  try { t = raw ? JSON.parse(raw) : null; } catch (e) { t = null; }
  return (t && typeof t === 'object' && !Array.isArray(t)) ? t : {};
}

function parseSits(raw) {
  let s = null;
  try { s = raw ? JSON.parse(raw) : null; } catch (e) { s = null; }
  return Array.isArray(s) ? s : [];
}

/* Every correction reaches two handles: the id of the card on screen, and its
   alertKey, which is what the same story carries when it comes back over the
   radio hours later with a new id. A merge that only knew the id would stop
   holding the moment the card aged off the board.

   The alertKey is coarse on purpose (a type and roughly a square kilometre),
   so a rule written against one card can catch a genuinely different one of
   the same kind nearby. That is the trade the key was chosen for, it is
   bounded to one type in one cell for seven days, and undo reverses it. */
const handlesOf = s => (s ? [s.id, s.alertKey].filter(Boolean) : []);

function setRule(links, table, handles, value, nowIso) {
  for (const h of handles) { links[table][h] = value; links.at[h] = nowIso; }
}
function clearRule(links, table, handles) {
  for (const h of handles) delete links[table][h];
}

/* Trimming happens on write rather than on a cron, because a table only this
   route writes is a table only this route needs to tidy, and a cron that
   exists to delete four strings is a cron that will outlive the feature. */
function prune(links, nowIso) {
  const TABLES = ['merge', 'split'];
  const now = Date.parse(nowIso);
  const stamps = links.at;

  for (const t of TABLES) {
    for (const h of Object.keys(links[t])) {
      // A handle with no timestamp is one written by an older version of this
      // file. It ages from now rather than being thrown away for it.
      if (!stamps[h]) stamps[h] = nowIso;
      if (now - Date.parse(stamps[h]) > LINK_TTL_MS) delete links[t][h];
    }
  }

  const live = new Set();
  for (const t of TABLES) for (const h of Object.keys(links[t])) live.add(h);
  if (live.size > MAX_LINKS) {
    // Oldest first, so what falls off the end is the correction nobody has
    // touched since rather than the one somebody just made.
    const oldest = [...live].sort((a, b) => Date.parse(stamps[a] || 0) - Date.parse(stamps[b] || 0));
    for (const h of oldest.slice(0, live.size - MAX_LINKS)) {
      for (const t of TABLES) delete links[t][h];
      live.delete(h);
    }
  }
  for (const h of Object.keys(stamps)) if (!live.has(h)) delete stamps[h];
  return links;
}

/* Snapshots expire on the same clock and a much smaller ceiling, because one
   of them outweighs a hundred rules. What gets lost when the ceiling bites is
   the ability to reverse a correction nobody has looked at in days, which is
   the cheap thing to lose. */
function pruneKeep(keep, nowIso) {
  const now = Date.parse(nowIso);
  for (const id of Object.keys(keep)) {
    const m = keep[id];
    if (!m || typeof m !== 'object') { delete keep[id]; continue; }
    if (!m.at) m.at = nowIso;
    if (now - Date.parse(m.at) > LINK_TTL_MS) delete keep[id];
  }
  const ids = Object.keys(keep);
  if (ids.length > MAX_KEEP) {
    ids.sort((a, b) => Date.parse(keep[a].at || 0) - Date.parse(keep[b].at || 0));
    for (const id of ids.slice(0, ids.length - MAX_KEEP)) delete keep[id];
  }
  return keep;
}

/* A card with no beats renders as a headline with nothing under it, which
   reads as a bug rather than as a quiet story. Anything that can empty an
   events array puts the opening beat back. */
function floorEvents(s) {
  if (!s.events || !s.events.length) {
    s.events = [{ at: s.firstSeen || s.updated, kind: 'opened', text: s.headline, type: s.type || null }];
  }
  return s;
}

/* ---- the route ------------------------------------------------------------ */

module.exports = async (req, res) => {
  if (!(await requireRead(req, res))) return;

  const nowIso = new Date().toISOString();
  let rawLinks = null, rawSits = null, rawKeep = null;
  try {
    [rawLinks, rawSits, rawKeep] = await kv.raw([
      ['GET', LINKS], ['GET', K.outSituations], ['GET', KEEP],
    ], 8000);
  } catch (e) {
    /* Say so rather than writing a guess. Reconciling against a board we
       could not read would replace the real one with whatever this request
       happened to know about, which is a correction that deletes the news. */
    return json(res, { ok: false, error: 'store unavailable: ' + String(e.message || e).slice(0, 200) }, { status: 503 });
  }

  const links = parseLinks(rawLinks);
  const prev = parseSits(rawSits);
  const keep = parseKeep(rawKeep);

  if (req.method === 'GET') {
    return json(res, {
      ok: true, at: nowIso, situations: prev.length,
      merge: links.merge, split: links.split, undoable: Object.keys(keep),
    });
  }
  if (req.method !== 'POST') return json(res, { ok: false, error: 'GET or POST' }, { status: 405 });

  const b = await body(req);
  const action = String(b.action || '').toLowerCase();
  const id = String(b.id || '').trim();
  const fail = (msg, status = 400) => json(res, { ok: false, action, error: msg }, { status });
  if (!id) return fail('id is required');

  const byId = new Map();
  for (const s of prev) if (s && s.id) byId.set(s.id, s);
  const card = byId.get(id) || null;
  const out = { ok: true, action, id };

  if (action === 'merge') {
    const into = String(b.into || '').trim();
    if (!card) return fail('no card ' + id + ' on the board', 404);
    if (!into) return fail('into is required');
    if (into === id) return fail('a card cannot be merged into itself');
    if (!byId.has(into)) return fail('no card ' + into + ' on the board', 404);

    /* If the target is itself on its way inside something else, point at the
       far end instead. Only hops that are still on the board are followed,
       because a rule aimed at a card nobody can see is a rule that does
       nothing and looks like it worked. */
    let dest = into;
    for (let hop = 0; hop < 8; hop++) {
      const next = links.merge[dest];
      if (!next || next === dest || !byId.has(next)) break;
      dest = next;
    }
    if (dest === id) return fail('that would fold the card into itself');

    // Anything already pointing at this card follows it in, so a chain built
    // one drag at a time still ends where the last drag put it.
    for (const h of Object.keys(links.merge)) if (links.merge[h] === id) links.merge[h] = dest;

    /* A merge overrules an earlier split of the same thing. Somebody has
       changed their mind, and the newer decision is the one they made while
       looking at the board. */
    clearRule(links, 'split', handlesOf(card));
    setRule(links, 'merge', handlesOf(card), dest, nowIso);

    keep[id] = { kind: 'merge', into: dest, at: nowIso, card: JSON.parse(JSON.stringify(card)) };
    out.into = dest;

  } else if (action === 'split') {
    if (!card) return fail('no card ' + id + ' on the board', 404);
    const at = b.at ? String(b.at) : '';

    if (!at) {
      // Pin it standalone: it joins nothing until somebody says otherwise.
      clearRule(links, 'merge', handlesOf(card));
      delete keep[id];
      setRule(links, 'split', handlesOf(card), true, nowIso);
      out.pinned = true;

    } else {
      /* A card whose only beat is the one being pulled out has nothing to be
         left behind as. Splitting it would leave the headline standing over a
         regenerated copy of the beat that just left, next to a new card
         saying the same thing, which reads as the tool having duplicated
         something rather than as anybody's correction. */
      if ((card.events || []).length < 2) return fail('that is the only beat in the card, so there is nothing to split it from');

      const i = (card.events || []).findIndex(e => e && e.at === at);
      if (i < 0) return fail('no beat at ' + at + ' in ' + id, 404);
      const beat = card.events[i];
      card.events = card.events.slice(0, i).concat(card.events.slice(i + 1));
      floorEvents(card);

      /* It inherits the parent's pin. Being near the thread is why it got
         threaded, and a card with no coordinates falls off the map entirely,
         which is a worse answer than a rough one. */
      const born = {
        id: mintId({ type: beat.type || card.type, lat: card.lat, lon: card.lon, location: card.location }, beat.at || nowIso),
        headline: beat.text,
        summary: 'Pulled out of: ' + String(card.headline || '').slice(0, 160),
        type: beat.type || card.type,
        /* Normal, always. A beat gets pulled out because it is not what the
           thread said it was, and the banner has already fired for the
           thread. Firing it again for the correction would be the tool
           shouting about its own mistake. It can climb again on its own. */
        priority: 'normal',
        confidence: card.confidence || 'reported',
        location: card.location, lat: card.lat, lon: card.lon,
        matched: card.matched, approx: true,
        status: 'developing',
        firstSeen: beat.at || nowIso,
        // Somebody just decided this is its own story, so the clock that
        // closes it starts now and not whenever the beat was first heard.
        updated: nowIso,
        events: [{ at: beat.at || nowIso, kind: 'opened', text: beat.text, type: beat.type || null }],
      };
      born.alertKey = alertKey(born);
      prev.push(born);

      /* It came out of that card, so it does not go back into that card. It
         is free to join anything else.

         Both handles, unless the beat left with the same type and the same
         pin as the card it came out of, in which case its alertKey IS the
         parent's and a rule written against it would be telling the parent it
         may not join itself. The minted id carries the rule alone there. */
      const bornHandles = handlesOf(born).filter(h => h !== card.alertKey);
      clearRule(links, 'merge', bornHandles);
      setRule(links, 'split', bornHandles, id, nowIso);
      keep[born.id] = { kind: 'split-at', from: id, at: nowIso };
      out.spawned = born.id;
    }

  } else if (action === 'undo') {
    const memo = keep[id];
    const known = card || (memo && memo.card) || null;
    let handles = new Set([id, ...handlesOf(known)].filter(Boolean));

    if (memo && memo.kind === 'merge' && memo.card) {
      /* Put the card back, and take its beats out of whatever swallowed them.
         Matched on time and text together: two beats can share a second, and
         a beat the analyst added at the same second as one of these is not
         one of these. */
      const beatKey = e => JSON.stringify([(e && e.at) || null, (e && e.text) || null]);
      const swallowed = new Set((memo.card.events || []).map(beatKey));
      for (const s of prev) {
        if (!s || !Array.isArray(s.events)) continue;
        const before = s.events.length;
        s.events = s.events.filter(e => !swallowed.has(beatKey(e)));
        if (s.events.length !== before) { floorEvents(s); if (s.merged) s.merged -= 1; }
      }
      /* Restored with its own timestamps rather than fresh ones. If the story
         has been dead for two hours, reconcile ages it off the board a moment
         later, and that is the truth. Backdating a live position onto it
         would put an hours-old story back at the top of a wall screen. */
      if (!byId.has(memo.card.id)) prev.push(memo.card);
      out.restored = memo.card.id;
      handles = new Set([...handles, ...handlesOf(memo.card)]);

    } else if (memo && memo.kind === 'split-at' && memo.from && byId.has(memo.from) && card) {
      /* The inverse of pulling a beat out is putting it back, and putting it
         back is a merge, so it is done as one rather than reimplemented here
         with its own edge cases. */
      for (const h of handles) { delete links.merge[h]; delete links.split[h]; delete links.at[h]; }
      handles.clear();
      setRule(links, 'merge', handlesOf(card), memo.from, nowIso);
      out.folded = memo.from;
    }

    for (const h of handles) { delete links.merge[h]; delete links.split[h]; delete links.at[h]; }
    delete keep[id];
    if (!out.restored && !out.folded) out.cleared = true;

  } else {
    return fail('action must be merge, split or undo');
  }

  /* Apply it now. Waiting for the next analyst tick would mean a person drags
     one card onto another, nothing happens for up to a minute, and they drag
     it again. An empty fresh list means this reconcile only does what a human
     just asked for, plus the ageing every pass does. */
  const r = reconcile(prev, [], links);
  prune(links, nowIso);
  pruneKeep(keep, nowIso);

  try {
    await kv.raw([
      ['SET', LINKS, JSON.stringify(links), 'EX', String(LINK_TTL_SEC)],
      ['SET', KEEP, JSON.stringify(keep), 'EX', String(LINK_TTL_SEC)],
      /* A plain SET, like every other output key. lib/read-route.js reads
         this through getBig and would handle a chunked write, but the analyst
         reads it with a pipelined GET that would serve the sentinel string
         straight through. Nothing this route does can grow the board: a merge
         removes a card, a split adds one small one, and events are capped at
         forty apiece inside reconcile. */
      ['SET', K.outSituations, JSON.stringify(r.situations), 'EX', String(OUT_TTL)],
    ], 8000);
  } catch (e) {
    return json(res, { ok: false, action, error: 'write failed: ' + String(e.message || e).slice(0, 200) }, { status: 503 });
  }

  out.at = nowIso;
  out.count = r.situations.length;
  // The new board comes back with the answer so the panel can repaint without
  // a second round trip, which is what makes a drag feel like it took.
  out.situations = r.situations;
  return json(res, out);
};
