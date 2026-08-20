// lib/scenes.js
//
// One idea of what a scene is, for everything that reads the archive.
//
// Three surfaces group archived transmissions back into the calls they came
// from: the Archive search (api/vault-search.js), the desk's ask box
// (api/desk-ask.js) and Shift Change (api/shift-change.js). Each had its own
// grouper, and each grouper did the same two things: trust the incidentId the
// live store stamped on the row, and sweep whatever had no incidentId into a
// burst per feed. Both halves of that are too weak, in opposite directions,
// and the newsroom saw both on the Archive tab on 19 August: "it is very bad
// at accurately grouping events".
//
// TOO WEAK ONE WAY. The store threads a scene live, under a lock, from what
// it has heard so far, and a fire that Boston Fire, Boston EMS and Boston
// Police all worked arrives in the archive as two or three incidentIds,
// because the EMS dispatch named the street before the engine did, or the
// police line shut a road and named no unit the fire side knew. The archive
// then shows one fire as three cards, and the reporter reads the smallest one
// because it sorted first.
//
// TOO WEAK THE OTHER WAY. A line with no incidentId is a line the store could
// not place, and "same feed inside fifteen minutes" is the only thing that
// held those together. On a citywide police channel that is three different
// calls, and the card reads like one.
//
// So this does the grouping in three passes, offline, with the whole window
// in hand, which is something the live store never has:
//
//   1. SEED on incidentId, exactly as before. The store's decision is the
//      best evidence there is about which lines were one call; nothing here
//      undoes it.
//   2. ATTACH each loose line to a seeded scene it plainly belongs to: near
//      in time, and either a unit the scene already has, or the scene's own
//      street or place named in the line. What is left forms bursts per feed,
//      with the gap kept short.
//   3. MERGE scenes that are one event seen from two radios: close in time
//      and standing on the same place. Not by a shared unit, on purpose. An
//      ambulance clears one call and takes the next inside ten minutes, so a
//      unit thread between seeded scenes chains the whole night together,
//      each merge widening the net for the next: on a synthetic busy window
//      nine thousand lines became one scene. That is the 117-unit card again
//      (see tools/test-grouping.js), and the store already joins by unit,
//      live, with a window and a cap; two scenes it kept apart despite a
//      shared unit were kept apart for a reason. Nothing merges across towns.
//
// TWO LESSONS FROM THE FIRST REAL SLICE (48h, 16,075 rows, 20 August), both
// invisible in fixtures:
//
// ATTACH MUST NOT SELF-FEED. The first cut let an attached line widen the
// scene: its units joined the unit set, its timestamp stretched the span, and
// both fed the test for the next line. On boston-police, where "A1" is said
// sixty-seven times in two days, an 11-row state police scene grew to 3,099
// transmissions across six feeds. That is the store's 117-unit card, again,
// in offline clothes. So every attach and every merge is now tested against
// the SEED: the rows that actually carried the incidentId, snapshotted before
// any attaching starts. Absorbed content is shown on the card; it never
// qualifies more.
//
// A BUSY CHANNEL HAS NO QUIET. A burst ended at twelve minutes of silence,
// and boston-police transmits every twenty-five seconds all day, so one
// "burst" held eighteen hours. A burst now also ends at twenty minutes of
// age, which is the shape of one call's radio; a channel that never stops
// talking becomes honest twenty-minute chunks instead of a bag with a
// morning domestic and an evening homicide in it.
//
// Every threshold here is a distance or a number of minutes that can be
// measured against a real night, and tools/archive-replay.js --scenes is how
// it was. The merge is deliberately conservative: a scene wrongly split is
// two cards the reporter can read; a scene wrongly merged is a card that
// reads as a single event that never happened.

'use strict';

const BURST_MS = 12 * 60 * 1000;       // a loose line joins the previous loose line on its feed inside this
const BURST_MAX_MS = 20 * 60 * 1000;   // and a burst never spans longer than this, quiet or not
const ATTACH_MS = 15 * 60 * 1000;      // a loose line may attach to a seeded scene this far from its SEED span
const MERGE_PLACE_MS = 40 * 60 * 1000; // two scenes at one place, this close, are one event
const SAME_PLACE_M = 150;              // standing on the same place

const NOT_A_THREAD = new Set(['street', 'st', 'road', 'rd', 'avenue', 'ave', 'drive', 'dr', 'place', 'pl',
  'court', 'ct', 'lane', 'ln', 'way', 'terrace', 'ter', 'boulevard', 'blvd', 'parkway', 'pkwy',
  'highway', 'hwy', 'route', 'rte', 'square', 'sq', 'circle', 'park', 'north', 'south', 'east', 'west',
  'the', 'and', 'house', 'building', 'apartment', 'apt', 'floor', 'unit', 'suite', 'rear', 'front',
  'usa', 'boston', 'cambridge', 'somerville', 'brookline', 'quincy', 'newton', 'chelsea', 'revere',
  'everett', 'malden', 'medford', 'lowell', 'waltham', 'needham', 'melrose', 'winthrop', 'massachusetts', 'ma',
  /* Destinations and generic building words. Every transport of the hour
     says the hospital's name, so {mass, general} or {medical, center} as a
     word pair fuses unrelated runs the same way the hospital's coordinates
     did; and {city, hall} is a centroid wearing words. A pair has to name a
     place a call HAPPENED. */
  'hospital', 'hospitals', 'mgh', 'general', 'brigham', 'tufts', 'faulkner', 'sinai', 'shattuck',
  'clinic', 'medical', 'center', 'health', 'emergency', 'room', 'infirmary', 'city', 'hall',
  /* The streets every town has. Two scenes both saying "Washington" are not
     at the same place; there are forty Washington Streets in the coverage
     area and one in every municipality. A ubiquitous name can ride in a
     numbered address (the addrs path keys on "60 washington st" whole); as a
     bare word pair it fuses strangers. */
  'washington', 'main', 'broadway', 'pleasant', 'highland', 'school', 'church',
  'prospect', 'spring', 'walnut', 'chestnut', 'maple', 'oak', 'grove', 'cedar', 'summer', 'winter']);

/* The words that name WHERE a line was: the street, the landmark, the place
   the geocoder answered with (before its first comma, so the town and the
   zip do not become threads). Numbers are not threads; 1426 is a house, a
   unit or a time. */
function placeWords(tx) {
  const src = [tx.address, tx.street, tx.landmark, String(tx.matched || '').split(',')[0]]
    .filter(Boolean).join(' ').toLowerCase();
  const out = new Set();
  for (const w of src.split(/[^a-z0-9]+/)) {
    if (w.length < 3 || /^\d+$/.test(w) || NOT_A_THREAD.has(w)) continue;
    out.add(w);
  }
  return out;
}

function metres(aLat, aLon, bLat, bLon) {
  if (![aLat, aLon, bLat, bLon].every(Number.isFinite)) return Infinity;
  if ((aLat === 0 && aLon === 0) || (bLat === 0 && bLon === 0)) return Infinity;
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (bLat - aLat) * toR, dLon = (bLon - aLon) * toR, mLat = ((aLat + bLat) / 2) * toR;
  const x = dLon * Math.cos(mLat);
  return Math.sqrt(dLat * dLat + x * x) * R;
}

/* A pin the pipeline vouched for places things; anything vaguer places
   nothing. A whitelist, not a blacklist: the slice carried fifty-three rows
   with coordinates and NO precision field at all, and most of them were town
   centroids wearing "Boston" as their match, which is City Hall pretending to
   be an anchor. */
function pointOf(tx) {
  if (!tx) return null;
  if (tx.precision !== 'exact' && tx.precision !== 'approx') return null;
  const lat = Number(tx.lat), lon = Number(tx.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;
  return [lat, lon];
}

/* WHERE THE AMBULANCES ALL GO. A transport is geocoded to the hospital it
   names, because "transport to MGH" is the only place-shaped thing in the
   line, and lib/venues.js already says why that pin is a destination and not
   a scene. For grouping it is worse than wrong: every run of the hour shares
   the hospital's coordinates, so on the first real slice three unrelated
   transports fused into one nine-feed "scene" anchored at Mass General. An
   anchor standing on a hospital is therefore no thread at all; the call's
   street, if anybody said it, still is. */
const HOSPITALS = [
  [42.3632, -71.0686], // Mass General
  [42.3612, -71.0706], // Charles/MGH station, where "route to Charles" lands
  [42.3362, -71.1065], // Brigham
  [42.3348, -71.0730], // Boston Medical Center
  [42.3497, -71.0632], // Tufts
  [42.3388, -71.1063], // Beth Israel
  [42.3735, -71.1355], // Mount Auburn
];
const HOSPITAL_M = 200;
function hospitalish(p) {
  if (!p) return false;
  for (const h of HOSPITALS) if (metres(p[0], p[1], h[0], h[1]) <= HOSPITAL_M) return true;
  return false;
}

/* A unit worth threading on. "21" and "35" are as often a time, a street
   number or a misheard word as a callsign, and a two-digit wildcard on a
   channel that says numbers all day attaches everything to everything. A
   letter, or three digits, is a callsign somebody meant. */
const threadUnit = (u) => /[a-z]/i.test(u) || String(u).replace(/[^0-9]/g, '').length >= 3;

const townOf = (tx) => String((tx && (tx.town || tx.city)) || '').toLowerCase();
const ms = (iso) => +new Date(iso);

function newScene(id, loose) {
  return { id, loose: !!loose, tx: [], units: new Set(), feeds: new Set(), incidentIds: new Set(),
           words: new Set(), addrs: new Set(), points: [], anchor: null, towns: new Set(), from: null, to: null };
}
function add(s, tx) {
  s.tx.push(tx);
  for (const u of (tx.units || [])) s.units.add(String(u).toUpperCase());
  if (tx.feed) s.feeds.add(tx.feed);
  if (tx.incidentId) s.incidentIds.add(tx.incidentId);
  for (const w of placeWords(tx)) s.words.add(w);
  const k = addressKey(tx); if (k) s.addrs.add(k);
  const p = pointOf(tx); if (p) { s.points.push(p); if (!s.anchor) s.anchor = p; }
  const t = townOf(tx); if (t) s.towns.add(t);
  const at = ms(tx.at);
  if (s.from === null || at < s.from) s.from = at;
  if (s.to === null || at > s.to) s.to = at;
}
function absorb(into, other) {
  for (const tx of other.tx) add(into, tx);
}

/* How far apart in time two spans are; 0 when they overlap. */
function gapBetween(a, b) {
  if (a.to < b.from) return b.from - a.to;
  if (b.to < a.from) return a.from - b.to;
  return 0;
}
function gapToPoint(s, at) {
  if (at < s.from) return s.from - at;
  if (at > s.to) return at - s.to;
  return 0;
}
function sameTownSeed(a, b) {
  if (!a.towns.size || !b.towns.size) return true;    // unknown is not a disagreement
  for (const t of a.towns) if (b.towns.has(t)) return true;
  return false;
}
/* "14 jfk st": a house number and a street, lower-cased, suffix folded. The
   one textual thread strong enough on its own: two lines that both say the
   same numbered address are at the same door. */
const SFX = { street: 'st', road: 'rd', avenue: 'ave', boulevard: 'blvd', drive: 'dr', place: 'pl', court: 'ct', lane: 'ln', terrace: 'ter', parkway: 'pkwy', square: 'sq' };
function addressKey(tx) {
  const a = String((tx && (tx.address || (tx.matched && /^\d/.test(tx.matched) ? String(tx.matched).split(',')[0] : ''))) || '').toLowerCase().trim();
  const m = /^(\d+[a-z]?)\s+(.+)$/.exec(a);
  if (!m) return null;
  const street = m[2].split(/\s+/).map(w => SFX[w] || w).join(' ').replace(/[^a-z0-9 ]/g, '').trim();
  return street ? m[1] + ' ' + street : null;
}
function sharedWords(a, b) {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}
/* Standing on the same place: the two scenes' ANCHORS, the first point each
   was placed at, within 150 m. Anchors and not any-point-to-any-point,
   because a scene that has absorbed another carries the other's points, and
   any-to-any lets a footprint walk: forty medicals at addresses a hundred
   metres apart down one street, six minutes apart, became one scene that
   way on a synthetic night. An anchor keeps the footprint a disc around the
   first placed line, which is what a scene is. */
function samePlaceSeed(a, b) {
  if (a.anchor && b.anchor && metres(a.anchor[0], a.anchor[1], b.anchor[0], b.anchor[1]) <= SAME_PLACE_M) return true;
  for (const k of a.addrs) if (b.addrs.has(k)) return true;
  /* Words alone are the weakest thread. One shared word is a street, and a
     street is two miles long; two shared words is a place. And words only
     decide when coordinates could not, because the pipeline worked for those
     coordinates and a street midpoint a kilometre from the fire is the
     geocoder saying "not here", not the words saying "here". */
  if ((!a.anchor || !b.anchor) && sharedWords(a.words, b.words) >= 2) return true;
  return false;
}

/* The rows, grouped. Returns scenes in time order, each with plain arrays. */
function assemble(rows, opts) {
  const o = opts || {};
  const burstMs = o.burstMs || BURST_MS;
  const burstMaxMs = o.burstMaxMs || BURST_MAX_MS;
  const attachMs = o.attachMs || ATTACH_MS;
  const mergePlaceMs = o.mergePlaceMs || MERGE_PLACE_MS;

  const sorted = (rows || []).filter(Boolean).slice().sort((a, b) => String(a.at).localeCompare(String(b.at)));

  /* 1. Seed. */
  const byInc = new Map();
  const loose = [];
  for (const tx of sorted) {
    if (tx.incidentId) {
      let s = byInc.get(tx.incidentId);
      if (!s) { s = newScene(tx.incidentId, false); byInc.set(tx.incidentId, s); }
      add(s, tx);
    } else loose.push(tx);
  }
  const seeded = [...byInc.values()];

  /* The seed, frozen: what the rows carrying the incidentId established, and
     the only thing attaches and merges may test against. Absorbed lines are
     shown; they never qualify more. */
  const snap = (sc) => ({
    units: new Set([...sc.units].filter(threadUnit)),
    words: new Set(sc.words), addrs: new Set(sc.addrs),
    anchor: hospitalish(sc.anchor) ? null : sc.anchor,
    towns: new Set(sc.towns),
    from: sc.from, to: sc.to,
  });
  for (const sc of seeded) sc.seed = snap(sc);

  /* 2. Attach, or burst. A loose line attaches to the nearest seeded scene in
     its town that is close in time and tied by a unit or a place word. The
     scenes are few and the loose lines many, so this is a scan per line over
     a short list, not a join. */
  const bursts = [];
  const lastBurst = new Map();       // feed -> scene
  for (const tx of loose) {
    const at = ms(tx.at);
    const units = new Set((tx.units || []).filter(threadUnit).map(u => String(u).toUpperCase()));
    const feed = tx.feed || 'unknown';
    const words = placeWords(tx);
    const addr = addressKey(tx);
    const pt = pointOf(tx);
    const town = townOf(tx);
    let best = null, bestGap = Infinity;
    if (units.size || words.size || addr || pt) {
      for (const s of seeded) {
        const gap = gapToPoint(s.seed, at);
        if (gap > attachMs) continue;
        if (town && s.seed.towns.size && !s.seed.towns.has(town)) continue;
        let tied = false;
        /* A unit ties a line to a scene only on a radio the scene was heard
           on. Every fire department in the coverage area has an Engine 5 and
           a Ladder 1, so "L1 clear" on melrose-fire is not the L1 working a
           Cambridge box, and a cross-feed unit match welded exactly that on
           the first real slice. A scene's follow-up on a NEW radio arrives
           with a place, and the address, anchor and word threads still take
           it. */
        if (s.feeds.has(feed)) for (const u of units) if (s.seed.units.has(u)) { tied = true; break; }
        if (!tied && addr && s.seed.addrs.has(addr)) tied = true;
        if (!tied && pt && !hospitalish(pt) && s.seed.anchor && metres(pt[0], pt[1], s.seed.anchor[0], s.seed.anchor[1]) <= SAME_PLACE_M) tied = true;
        if (!tied && words.size >= 2 && (!pt || !s.seed.anchor)) tied = sharedWords(words, s.seed.words) >= 2;
        if (!tied) continue;
        if (gap < bestGap) { best = s; bestGap = gap; }
      }
    }
    if (best) { add(best, tx); continue; }
    const prev = lastBurst.get(feed);
    if (prev && at - prev.to <= burstMs && at - prev.from <= burstMaxMs) { add(prev, tx); continue; }
    const s = newScene('loose:' + feed + ':' + tx.at, true);
    add(s, tx);
    bursts.push(s);
    lastBurst.set(feed, s);
  }
  /* Bursts merge and compare on what they are; a burst has no seed but the
     shape is the same and the merge below reads one field. */
  for (const b of bursts) b.seed = snap(b);

  /* 3. Merge seeded scenes that are one event from two radios. Pairwise over
     the seeded list, in time order, folding forward; a window holds a few
     hundred scenes at most, and the gap test ends most pairs at once. */
  const alive = seeded.concat(bursts).sort((a, b) => a.from - b.from);
  for (let i = 0; i < alive.length; i++) {
    const a = alive[i];
    if (!a) continue;
    let j = i + 1;
    while (j < alive.length) {
      const b = alive[j];
      if (!b) { j++; continue; }
      if (b.seed.from - a.seed.to > mergePlaceMs) break;   // everything after is further still
      /* Two loose bursts never merge with each other: neither has a place or
         a unit the store vouched for, and feed-and-time was all that made
         either a group. A burst may fold into a seeded scene, though, when it
         stands where the scene stands. */
      if (a.loose && b.loose) { j++; continue; }
      const gap = gapBetween(a.seed, b.seed);
      const one = sameTownSeed(a.seed, b.seed) && gap <= mergePlaceMs && samePlaceSeed(a.seed, b.seed);
      if (!one) { j++; continue; }
      /* Fold b into a. The card gets b's lines; a's SEED stays a's, so what a
         can reach next is what its own incident rows established, and a chain
         of near neighbours cannot walk down a street one absorption at a
         time. The rescan exists only because a null slot may now sit between
         still-live scenes. A seeded id names the card, whichever side brought
         it. */
      if (a.loose && !b.loose) { a.id = b.id; a.seed = b.seed; }
      absorb(a, b);
      a.loose = false;
      alive[j] = null;
      j = i + 1;
    }
  }

  const out = alive.filter(Boolean).sort((a, b) => a.from - b.from).map(s => {
    s.tx.sort((x, y) => String(x.at).localeCompare(String(y.at)));
    const typeCount = {};
    const placeCount = {};
    for (const t of s.tx) {
      if (t.callType) typeCount[t.callType] = (typeCount[t.callType] || 0) + 1;
      const p = t.matched || t.address || t.landmark || t.street || null;
      if (p) placeCount[p] = (placeCount[p] || 0) + 1;
    }
    const top = (m) => { let best = null, n = 0; for (const k in m) if (m[k] > n) { best = k; n = m[k]; } return best; };
    return {
      id: s.id,
      loose: s.loose,
      tx: s.tx,
      feeds: [...s.feeds],
      units: [...s.units],
      incidentIds: [...s.incidentIds],
      from: new Date(s.from).toISOString(),
      to: new Date(s.to).toISOString(),
      type: top(typeCount),
      place: top(placeCount),
      town: [...s.towns][0] || null,
      n: s.tx.length,
    };
  });
  return out;
}

/* A map from row to the scene it landed in, for callers that score rows
   first and group afterwards. */
function index(scenes) {
  const m = new Map();
  for (const s of scenes) for (const tx of s.tx) m.set(tx, s);
  return m;
}

module.exports = { assemble, index, placeWords, pointOf, metres, addressKey, hospitalish,
  BURST_MS, ATTACH_MS, MERGE_PLACE_MS, SAME_PLACE_M };
