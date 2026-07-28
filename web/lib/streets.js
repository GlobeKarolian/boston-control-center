// lib/streets.js
//
// Every named street in the towns the feeds cover, one row per street per town,
// built from OSM. Two jobs.
//
// First, Whisper garbles street names constantly. "Harborview Street" arrives as
// "Hopper View Street" and a geocoder handed that returns nothing at all. With a
// real list in hand the garbled text can be snapped back to the street that
// exists before anything hits the network.
//
// Second, a correction that is wrong is worse than no pin, so the two callers
// get different thresholds on purpose. A lone street name has nothing to check
// against, so it only accepts a near-certain correction. A cross street has the
// other half of the intersection to check against, so it may guess generously
// and then prove the guess by asking whether the two streets actually meet.

const TABLE = require('./streets.json');   // { Town: [[name, lat, lon], ...] }

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

// The type word carries no identity. "Harborview St" and "Harborview Street"
// and "Harborview" are one street, and Whisper picks a different one each time.
const TYPE = new Set(['street', 'st', 'avenue', 'ave', 'av', 'road', 'rd', 'drive', 'dr',
  'place', 'pl', 'court', 'ct', 'lane', 'ln', 'way', 'terrace', 'ter', 'circle', 'cir',
  'square', 'sq', 'boulevard', 'blvd', 'parkway', 'pkwy', 'highway', 'hwy', 'row',
  'path', 'alley', 'crossing', 'extension', 'ext', 'turnpike', 'tpke', 'broadway']);
const DIR = new Set(['north', 'south', 'east', 'west', 'n', 's', 'e', 'w', 'upper', 'lower']);

// Radio shorthand that no amount of string distance will ever reach. Nobody on
// a Boston scanner says "Dorchester Avenue" and no fuzzy matcher gets from
// "Dot Ave" to it, because they share three letters.
const SHORTHAND = {
  'dot ave': 'Dorchester Avenue',
  'dot avenue': 'Dorchester Avenue',
  'the pike': 'Massachusetts Turnpike',
  'mass pike': 'Massachusetts Turnpike',
  'the jway': 'Jamaicaway',
  'the j way': 'Jamaicaway',
  'amer legion': 'American Legion Highway',
  'american legion': 'American Legion Highway',
  'mass ave': 'Massachusetts Avenue',
  'comm ave': 'Commonwealth Avenue',
  'commave': 'Commonwealth Avenue',
  'soldiers field': 'Soldiers Field Road',
  'storrow': 'Storrow Drive',
  'morrissey': 'Morrissey Boulevard',
  'gallivan': 'Gallivan Boulevard',
  'rutherford': 'Rutherford Avenue',
  'vfw': 'VFW Parkway',
  'vfw pkwy': 'VFW Parkway',
  'the fenway': 'Fenway',
  'the riverway': 'Riverway',
  'melnea cass': 'Melnea Cass Boulevard',
  'lower mills': 'Dorchester Avenue',
};
const expand = name => SHORTHAND[norm(name)] || name;

// The type word carries no identity, so it is dropped from the comparison key.
// It is still evidence, though: "Comm Ave" is Commonwealth Avenue and not
// Common Street, and the only thing that says so is the word "Ave".
function typeOf(name) {
  const w = norm(name).split(' ').filter(Boolean);
  const last = w[w.length - 1];
  if (!last || !TYPE.has(last)) return '';
  return ({ st: 'street', ave: 'avenue', av: 'avenue', rd: 'road', dr: 'drive', pl: 'place',
    ct: 'court', ln: 'lane', ter: 'terrace', cir: 'circle', sq: 'square', blvd: 'boulevard',
    pkwy: 'parkway', hwy: 'highway', tpke: 'turnpike', ext: 'extension' })[last] || last;
}

// "Hopper View" and "Harborview" are the same street said twice. Spaces are
// noise in a transcript, so the comparison key drops them along with the type.
function core(name) {
  const w = norm(expand(name)).split(' ').filter(Boolean);
  const keep = w.filter((x, i) => !(TYPE.has(x) && i > 0) && !(DIR.has(x) && w.length > 2));
  const s = (keep.length ? keep : w).join('');
  return s || norm(name).replace(/ /g, '');
}

// Vowels are the first thing a bad transcription loses. The consonant skeleton
// is what survives, and it is the tiebreak when the letter-by-letter distance
// is ambiguous.
function skel(c) { return c[0] + c.slice(1).replace(/[aeiouy]/g, ''); }

function lev(a, b, cap) {
  const n = a.length, m = b.length;
  if (Math.abs(n - m) > cap) return cap + 1;
  let prev = new Array(m + 1), cur = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    let best = cur[0];
    for (let j = 1; j <= m; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + c);
      if (cur[j] < best) best = cur[j];
    }
    if (best > cap) return cap + 1;             // whole row already too far
    const t = prev; prev = cur; cur = t;
  }
  return prev[m];
}

const INDEX = {};                                // Town -> { byCore: Map, rows: [] }
for (const town in TABLE) {
  const rows = TABLE[town].map((r, i) => {
    const c = core(r[0]);
    return { i, name: r[0], lat: r[1], lon: r[2], core: c, skel: skel(c), type: typeOf(r[0]) };
  });
  const byCore = new Map();
  for (const r of rows) {
    if (!byCore.has(r.core)) byCore.set(r.core, []);
    byCore.get(r.core).push(r);
  }
  INDEX[town] = { rows, byCore };
}

// The box each town's own streets occupy. Used to decide whether a street the
// town does not have, but a neighbour does, is close enough to be the one that
// was meant.
for (const town in INDEX) {
  const rows = INDEX[town].rows;
  if (!rows.length) { INDEX[town].box = null; continue; }
  let a = 90, b = -90, c = 180, d = -180;
  for (const r of rows) {
    if (r.lat < a) a = r.lat; if (r.lat > b) b = r.lat;
    if (r.lon < c) c = r.lon; if (r.lon > d) d = r.lon;
  }
  INDEX[town].box = { latMin: a, latMax: b, lonMin: c, lonMax: d };
}

// A street that runs along a town line belongs to both towns and lands in one.
// Beacon Street is the boundary between Cambridge and Somerville for most of
// its length, so the crawl filed it under Somerville and a Cambridge feed
// asking for Beacon Street got Beech Street instead, which is a real road in
// the wrong place. So when a town does not have a name, the neighbours are
// asked, and the answer is only taken if it sits inside the box the asking
// town's own streets occupy. That is true of a road on the line by
// construction, and false of the Main Street two towns over, which is the
// reason this is a geometric test and not a list of neighbours.
function borrow(c, town, qt) {
  const box = INDEX[town] && INDEX[town].box;
  if (!box || !c) return null;
  const pad = 0.004;                             // roughly 400m, a street's width of slack
  let best = null;
  for (const other in INDEX) {
    if (other === town) continue;
    const g = INDEX[other].byCore.get(c);
    if (!g) continue;
    const r = pick(g, qt);
    if (!r) continue;
    if (r.lat < box.latMin - pad || r.lat > box.latMax + pad) continue;
    if (r.lon < box.lonMin - pad || r.lon > box.lonMax + pad) continue;
    // Nearest to the middle of the asking town, when two neighbours both have one.
    const dy = r.lat - (box.latMin + box.latMax) / 2;
    const dx = r.lon - (box.lonMin + box.lonMax) / 2;
    const s = dy * dy + dx * dx;
    if (!best || s < best.s) best = { s, row: r, from: other };
  }
  return best ? { ...best.row, from: best.from } : null;
}

// Several real streets can share one comparison key. Boston has a Washington
// Street and a Washington Street Place, a Commonwealth Avenue and a
// Commonwealth Court, and they are nowhere near each other. Picking whichever
// one the crawler happened to emit first is how "Comm Ave" lands on a cul de
// sac. The type word said out loud decides it, and failing that the shortest,
// plainest name is the one a dispatcher meant.
// Not all type words carry the same weight. Harvard Avenue, Harvard Street and
// Harvard Way are three roads in Boston and a dispatcher saying "Harvard" means
// one of the first two, because the third is a service road behind a parking
// lot. Sorting these by name length, which is what happens without a table like
// this, picks whichever is spelled shortest and that is no signal at all.
const TYPE_RANK = {
  turnpike: 0, highway: 0, boulevard: 0.1, avenue: 0.2, street: 0.2, parkway: 0.2,
  road: 0.4, broadway: 0.2, drive: 0.8, circle: 1.4, way: 1.4, square: 1.4,
  row: 2.0, path: 2.2, lane: 1.8, court: 2.0, place: 2.0, terrace: 2.0,
  park: 2.2, alley: 2.6, crossing: 2.2, extension: 2.6,
};
const typeWeight = t => (t && TYPE_RANK[t] !== undefined) ? TYPE_RANK[t] : 0.5;
function rank(r, qt) {
  let s = 0;
  if (qt && r.type === qt) s -= 3;
  else if (qt && r.type) s += 1;
  s += typeWeight(r.type);
  s += norm(r.name).split(' ').length * 0.5;
  s += r.name.length / 100;
  return s;
}
function pick(group, qt) {
  if (!group || !group.length) return null;
  if (group.length === 1) return group[0];
  return group.slice().sort((a, b) => rank(a, qt) - rank(b, qt))[0];
}
const TOWNS = Object.keys(INDEX);
const COUNT = TOWNS.reduce((a, t) => a + INDEX[t].rows.length, 0);

function has(town) { return !!INDEX[town]; }

// Straight-line metres. Two streets in the same town whose midpoints are miles
// apart are not going to intersect, and checking that here costs nothing while
// an Overpass round trip costs a second.
function apart(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const x = (b.lon - a.lon) * rad * Math.cos((a.lat + b.lat) * rad / 2);
  const y = (b.lat - a.lat) * rad;
  return Math.sqrt(x * x + y * y) * R;
}

// Ranked guesses, best first. Used for cross streets, where the intersection
// check downstream throws out anything wrong, and as the raw material for the
// single-answer decision below.
function candidates(name, town, k = 3) {
  const idx = INDEX[town];
  if (!idx) return [];
  const c = core(name);
  if (!c) return [];

  // The type word is the tiebreak, applied before anything is discarded. "Comm
  // Ave" and "Common Street" are an equally good prefix match on the letters
  // and only one of them was said out loud.
  const qt = typeOf(expand(name));
  const typeAdj = r => (!qt || !r.type) ? 0 : (r.type === qt ? -0.20 : 0.15);

  const exact = pick(idx.byCore.get(c), qt);
  if (exact) return [{ ...exact, dist: 0, skelDist: 0, score: 0, exact: true, via: 'exact' }];

  const lent = borrow(c, town, qt);
  if (lent) return [{ ...lent, dist: 0, skelDist: 0, score: 0, exact: true, via: 'exact-adjacent' }];

  // Under four letters there is nothing left to be sure with. Every three
  // letter word in the language is one edit from a street name somewhere in a
  // city of four thousand roads, so "Ox" comes back as O Street Place and means
  // nothing by it. A short name is either a street this town has or it is not.
  if (c.length < 4) return [];

  const sk = skel(c);
  const cap = Math.max(3, Math.round(c.length * 0.45));

  // Two rows with the same core are the same street said differently. Harbor
  // View Street and Harborview Lane both reduce to "harborview", and letting
  // both compete makes a certain answer look like a coin flip.
  const best = new Map();
  const push = r => { const p = best.get(r.core); if (!p || r.score < p.score) best.set(r.core, r); };

  // Radio traffic truncates. "Mass Ave" is Massachusetts Avenue and "Comm Ave"
  // is Commonwealth Avenue. A query that is a clean prefix of a real street
  // name is an abbreviation, not damage, and should not be scored as damage.
  if (c.length >= 4) {
    for (const r of idx.rows) {
      if (r.core.length <= c.length || !r.core.startsWith(c)) continue;
      push({ ...r, dist: 0, skelDist: 0, via: 'prefix',
             score: 0.12 + Math.min(0.25, (r.core.length - c.length) / 40) + typeAdj(r) });
    }
  }

  // Half a name. A street is signed "William T Morrissey Boulevard" and called
  // Morrissey. Requiring the query to be a distinctive whole chunk of the real
  // name keeps this from firing on "Park" or "Hill".
  if (c.length >= 6) {
    for (const r of idx.rows) {
      if (r.core.length <= c.length || !r.core.includes(c) || r.core.startsWith(c)) continue;
      push({ ...r, dist: 0, skelDist: 0, via: 'contains',
             score: 0.30 + Math.min(0.20, (r.core.length - c.length) / 60) + typeAdj(r) });
    }
  }

  for (const r of idx.rows) {
    if (Math.abs(r.core.length - c.length) > cap) continue;
    if (r.core[0] !== c[0] && r.skel[0] !== sk[0]) continue;   // first sound must survive
    const d = lev(c, r.core, cap);
    if (d > cap) continue;
    const ds = lev(sk, r.skel, cap);
    // Score blends the letters, the consonant skeleton, the length gap and the
    // type word. The skeleton is weighted highest because it is the part a bad
    // transcription tends to keep.
    push({ ...r, dist: d, skelDist: ds, via: 'fuzzy',
           score: d / c.length + 1.4 * (ds / Math.max(1, sk.length)) +
                  0.6 * Math.abs(r.core.length - c.length) / c.length + typeAdj(r) });
  }

  return [...best.values()].sort((a, b) => a.score - b.score).slice(0, k);
}

// One answer, or nothing, for a street name that arrived alone with no second
// fact to check it against. Four ways to be sure, in descending order of
// certainty, and silence when none of them holds. A wrong street is worse than
// an empty map, so anything short of exact is flagged for the caller to demote.
function correct(name, town) {
  const c = core(name);
  if (!c || c.length < 4) return null;
  if (!INDEX[town]) return null;

  const cs = candidates(name, town, 4);
  if (!cs.length) return null;
  const b = cs[0], runner = cs[1];
  const hit = (via, extra) => ({ name: b.name, lat: b.lat, lon: b.lon, dist: b.dist, via, ...extra });

  // 1. The name came through intact. A street on a town line is filed under one
  // of the two towns it divides, so a hit borrowed from the neighbour is the
  // same street and counts as intact, with the town it came from carried along
  // so the caller can label it honestly.
  if (b.via === 'exact') return hit('exact', { exact: true });
  if (b.via === 'exact-adjacent') return hit('exact', { exact: true, from: b.from });

  // 2. An abbreviation or a half name that resolves to one street in this town.
  if ((b.via === 'prefix' || b.via === 'contains') &&
      (!runner || runner.via === 'fuzzy' || runner.score >= b.score * 1.6)) {
    return hit(b.via, { exact: false });
  }

  // 3. Light damage, consonants intact, nothing else close.
  if (b.via === 'fuzzy' && b.dist <= Math.max(1, Math.floor(c.length * 0.3)) &&
      b.skelDist <= 1 && (!runner || runner.score >= b.score * 1.5)) {
    return hit('fuzzy', { exact: false });
  }

  // 4. Heavy damage, but only one street in the whole town is anywhere near it.
  //    "Hopper View Street" is four letters off Harbor View Street and nothing
  //    else in Boston is close. Real, and not certain enough to call precise.
  //
  //    Having no runner up is not on its own a reason to believe the winner.
  //    With 4,000 streets in Boston there is always a nearest row, so the
  //    winner also has to be good in absolute terms: most of its consonants
  //    intact, and a total score that a genuine match would produce.
  const sk = skel(c);
  if (b.via === 'fuzzy' && b.dist <= Math.max(2, Math.round(c.length * 0.45)) &&
      b.score <= 1.0 && b.skelDist <= Math.max(1, Math.floor(sk.length * 0.34)) &&
      (!runner || runner.score >= b.score * 1.4)) {
    return hit('fuzzy-loose', { exact: false, loose: true });
  }

  // 5. Several answers are still in contention and they are all on the same few
  //    blocks. The name is undecided and the pin is not.
  const pool = cs.filter(x => x.score <= b.score * 1.35);
  if (pool.length >= 2 && pool.every(x => apart(b, x) <= 700)) {
    return {
      name: b.name, dist: b.dist, via: 'cluster', exact: false, loose: true,
      lat: pool.reduce((s, x) => s + x.lat, 0) / pool.length,
      lon: pool.reduce((s, x) => s + x.lon, 0) / pool.length,
    };
  }
  return null;
}

// The pairs most likely to be a real intersection, best first. Generous on each
// half, then ranked, because the caller proves or discards each guess by asking
// OSM whether the two streets share a node. Returning a ranked list rather than
// one answer costs nothing and lets a second-place pair win when the first turns
// out not to meet.
//
// Distance ranks, it does not veto. Each street is stored as one point, the mean
// of its segments, which is a fine handle on Jette Court and a poor one on
// Summer Street, a road that runs four kilometres from downtown to the harbour.
// Throwing out a pair because two averaged points sit far apart discards real
// intersections on long roads, and the node check downstream is the honest
// answer anyway. What does veto is quality: a half that matched badly is noise,
// and pairing noise with a good match only produces a confident wrong corner.
const PAIR_MAX_SCORE = 0.9;

function pairsFor(a, b, town, maxApartM = 9000, limit = 3) {
  const A = candidates(a, town, 3).filter(x => (x.score || 0) <= PAIR_MAX_SCORE);
  const B = candidates(b, town, 3).filter(x => (x.score || 0) <= PAIR_MAX_SCORE);
  if (!A.length || !B.length) return [];
  const out = [];
  for (const x of A) for (const y of B) {
    if (x.name === y.name) continue;
    const d = apart(x, y);
    if (d > maxApartM) continue;
    const s = (x.score || 0) + (y.score || 0) + d / 60000;
    out.push({ s, a: x, b: y, apart: Math.round(d) });
  }
  out.sort((p, q) => p.s - q.s);
  return out.slice(0, limit);
}

function pairFor(a, b, town, maxApartM = 9000) {
  return pairsFor(a, b, town, maxApartM, 1)[0] || null;
}

// The streets a confident half of an intersection could be paired with, for the
// caller that has asked OSM which streets actually meet the anchor. Matching
// "Oxnard" against every road in Boston finds Oswald Street and means nothing.
// Matching it against the eleven roads that genuinely cross Chestnut Avenue is a
// different question with a real answer, so the threshold here is deliberately
// looser than anywhere else in this file.
function bestOf(name, names) {
  const c = core(name);
  if (!c) return null;
  const sk = skel(c), cap = Math.max(3, Math.round(c.length * 0.7));
  let best = null;
  for (const n of names) {
    const rc = core(n);
    if (!rc) continue;
    if (rc === c) return { name: n, score: 0, exact: true };
    // Same rule as the citywide search: a fragment this short carries no
    // evidence, and a short list is still long enough to find a stray match in.
    if (c.length < 4) continue;
    const d = lev(c, rc, cap);
    if (d > cap) continue;
    const ds = lev(sk, skel(rc), cap);
    const score = d / Math.max(c.length, rc.length) + 0.8 * (ds / Math.max(1, sk.length));
    if (!best || score < best.score) best = { name: n, score, exact: false };
  }
  if (!best) return null;
  const second = names.length > 1;
  return best.score <= (second ? 0.85 : 0.7) ? best : null;
}

// Does this town know a street by roughly this name at all? Cheap gate before
// spending a network call on a name that does not exist here.
function knows(name, town) {
  const idx = INDEX[town];
  if (!idx) return false;
  const c = core(name);
  if (!c) return false;
  return idx.byCore.has(c) || candidates(name, town, 1).length > 0;
}

// ------------------------------------------------------------------ corners
//
// Where every pair of named roads in these towns actually meets, crawled once
// from OSM and shipped alongside the street list. This used to be a live
// Overpass query per corner. Measured against the public instances over an
// hour, that call took under a second warm, twenty five seconds loaded, and
// failed outright often enough that half a test batch came back empty, which is
// not something a live map can be built on.
//
// Having the corners in hand also changes what the matcher is allowed to do.
// Guessing at a garbled street name across four thousand roads is dangerous
// because the nearest spelling is usually wrong. Guessing at a pair is safe,
// because a pair that does not appear in this table never gets returned. So the
// candidate lists here are deliberately wider than anywhere else in this file.

let CROSS = null;
try { CROSS = require('./crossings.json'); } catch (e) { CROSS = null; }

// Parsed on first use for a town rather than at load, because a lambda that
// cold starts to answer one call in Somerville should not pay for Boston.
const XCACHE = {};
function crossIndex(town) {
  if (XCACHE[town] !== undefined) return XCACHE[town];
  const raw = CROSS && CROSS[town];
  if (!raw || !raw.x || !Array.isArray(raw.c)) { XCACHE[town] = null; return null; }
  const at = new Map(), adj = new Map();
  for (const part of raw.x.split(';')) {
    const f = part.split(':');
    if (f.length !== 4) continue;
    const a = raw.c[+f[0]], b = raw.c[+f[1]];
    if (!a || !b) continue;
    at.set(a + '|' + b, [+f[2] / 1e5, +f[3] / 1e5]);
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push(b);
    adj.get(b).push(a);
  }
  XCACHE[town] = { at, adj };
  return XCACHE[town];
}

function meetAt(a, b, town) {
  const X = crossIndex(town);
  if (!X || !a || !b || a === b) return null;
  return X.at.get(a < b ? a + '|' + b : b + '|' + a) || null;
}

/* The corner two spoken street names meant, or nothing. Both halves are matched
   generously and every combination is tested against the table, so the answer
   is only ever a pair of roads that genuinely meet. "Ox and Summer" is safe to
   repair this way and "Chestnut and Oxnard" comes back empty, which is the
   right answer, because nothing crossing Chestnut Avenue is called that. */
function cornerFor(a, b, town, width = 6) {
  const A = candidates(a, town, width).filter(x => (x.score || 0) <= 1.4);
  const B = candidates(b, town, width).filter(x => (x.score || 0) <= 1.4);
  if (!A.length || !B.length) return null;

  // A corner on a town line is filed under whichever town the crawl gave the
  // road to, so the neighbour a name was borrowed from gets asked as well. The
  // box check afterwards is what keeps that from reaching across a whole
  // county for a pair of common names.
  const where = [town];
  for (const r of A.concat(B)) if (r.from && !where.includes(r.from)) where.push(r.from);
  if (!where.some(t => crossIndex(t))) return null;

  const box = INDEX[town] && INDEX[town].box;
  const near = p => !box || (p[0] > box.latMin - 0.01 && p[0] < box.latMax + 0.01 &&
                             p[1] > box.lonMin - 0.01 && p[1] < box.lonMax + 0.01);

  let best = null;
  for (const x of A) for (const y of B) {
    if (x.core === y.core) continue;
    for (const t of where) {
      const p = meetAt(x.core, y.core, t);
      if (!p || !near(p)) continue;
      const s = (x.score || 0) + (y.score || 0) + (t === town ? 0 : 0.05);
      if (!best || s < best.s) best = { s, lat: p[0], lon: p[1], a: x, b: y, town: t };
      break;
    }
  }
  if (!best) return null;
  return {
    lat: best.lat, lon: best.lon,
    a: nameAt(best.a, best.town, best.lat, best.lon, a),
    b: nameAt(best.b, best.town, best.lat, best.lon, b),
    exact: best.s === 0, score: best.s,
    town: best.town === town ? undefined : best.town,
  };
}

// Which of the same-named roads to call this one. The table is keyed by the
// reduced name, so a corner found under "harvard" could be reported as Harvard
// Way when the road at that spot is Harvard Avenue. The point is right either
// way, the label is not, and a reporter reading Harvard Way in Allston has been
// told something false.
//
// Nearness alone gets this wrong in a way worth naming: each road is stored as
// the mean of its segments, so a fifty metre cul de sac sits right on top of
// the corner while an arterial that runs the length of the city averages out a
// mile away. Sorted by distance, the terrace wins every time. So the type word
// leads and distance only breaks ties inside it.
function nameAt(row, town, lat, lon, spoken) {
  const idx = INDEX[town];
  const g = idx && idx.byCore.get(row.core);
  if (!g || g.length < 2) return row.name;
  // The type word as it was said, not as the matched row happens to be spelled.
  // Reading it off the row makes the choice argue for itself.
  const qt = typeOf(expand(spoken || ''));
  let best = null;
  for (const r of g) {
    const d = apart(r, { lat, lon });
    const s = typeWeight(r.type) + Math.min(d, 4000) / 4000 - (r.type === qt ? 1.5 : 0);
    if (!best || s < best.s) best = { s, name: r.name };
  }
  return best ? best.name : row.name;
}

/* Every road that crosses this one, by name. The candidate pool for a name too
   damaged to place across a whole city, and small enough that a loose match
   against it still means something. */
function crossingNames(name, town) {
  const X = crossIndex(town);
  const row = exactRow(name, town);
  if (!X || !row) return null;
  const list = X.adj.get(row.core);
  if (!list || !list.length) return null;
  const idx = INDEX[town];
  const names = [];
  for (const c of new Set(list)) {
    const g = idx.byCore.get(c);
    if (g && g.length) names.push(g[0].name);
  }
  return names.length ? { row, names } : null;
}

/* The corner of a street that came through clean and one that did not. Matching
   "Oxnard" against all of Boston finds Oswald Street two kilometres away and
   means nothing by it. Matching it against the thirty one roads that actually
   cross Chestnut Avenue either finds the road that was meant or finds nothing,
   and both of those are correct answers. */
function anchoredCorner(anchorName, otherName, town) {
  const c = crossingNames(anchorName, town);
  if (!c) return null;
  const hit = bestOf(otherName, c.names);
  if (!hit) return null;
  const p = meetAt(c.row.core, core(hit.name), town);
  if (!p) return null;
  return { lat: p[0], lon: p[1], a: c.row.name, b: hit.name, exact: false, score: hit.score };
}

function hasCorners(town) { return !!crossIndex(town); }

// The one row this town has under exactly this name, when the name arrived
// intact. Used to turn a confident half of an intersection back into a point.
function exactRow(name, town) {
  const idx = INDEX[town];
  if (!idx) return null;
  const c = core(name);
  if (!c) return null;
  return pick(idx.byCore.get(c), typeOf(expand(name))) || null;
}

const CORNER_COUNT = CROSS
  ? Object.values(CROSS).reduce((a, v) => a + (v && v.x ? v.x.split(';').length : 0), 0)
  : 0;

module.exports = {
  correct, candidates, pairFor, pairsFor, knows, has, core, bestOf, exactRow,
  cornerFor, anchoredCorner, crossingNames, hasCorners,
  towns: TOWNS, count: COUNT, corners: CORNER_COUNT,
};
