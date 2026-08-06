/* ============================================================================
   Incident correlation engine.

   Turns a stream of individual radio transmissions into live INCIDENTS, each
   with a running timeline (the "tick-tock"). Groups follow-up chatter to the
   right scene by address and by unit, detects when a scene clears, and archives
   old scenes.

   Lifecycle:  active  ->  cleared (grayed)  ->  archived (dropped)

   PORTED FOR VERCEL. Three changes from the Mac original:
     1. hydrate()/dump() so the whole store can live in Redis between calls.
     2. ingest() accepts a pre-computed extraction and geocode, so those two
        network calls happen BEFORE the mutex rather than inside it.
     3. sweep() actually deletes archived incidents. On the Mac this ran in a
        process that restarted; here the state is persistent, so anything not
        deleted grows forever and eventually stops fitting in a request.

   CORRELATION REWRITE. Scenes used to join only on a shared unit or on exact
   string equality of the geocoded address. Two transmissions about the same
   fire that resolved to "12 Boylston St" and "Boylston Street, Boston" were
   two incidents on the map, which is how one story became four pins.

     1. Scenes now join by DISTANCE, not by string. Two precise fixes within
        200m inside the window are the same scene.
     2. Only precise fixes correlate. The gazetteer can return a town centroid,
        and matching on those would weld every call in Quincy into one enormous
        incident. Approximate and weak fixes place a pin and nothing more.
     3. Noise never creates an incident. Whisper's "Thank you." is not a call.
     4. Scenes carry a heat score. A working fire pulling six units in four
        minutes and a routine alarm with one engine are both "active", and the
        newsroom needs to see which is which without reading every timeline.
   ========================================================================== */

/* Stops ride alongside incidents rather than inside them. A scene has a place
   and grows; a stop has a place, a unit, a length and an outcome, it correlates
   by callsign rather than by proximity, and it ends when the unit says so.
   Folding one into the other would lose all three of those, so the tracker is
   its own store fed from the same transmission. */
const { createStops, deptOf } = require('./stops.js');
const { read: readSpoken } = require('./spoken.js');
/* Threat assessment runs per transmission and knows nothing about scenes. The
   store is where the two meet: a scene keeps the highest tier anyone reached
   on it, the union of the signals that got it there, and the alarm level,
   because a fire that goes to three alarms says so once and every later
   transmission on that scene is about hydrants. */
const threat = require('./threat.js');

const ADDRESS_MATCH_WINDOW_MS = 120 * 60 * 1000; // correlate to a scene up to 2h old
const STALE_AUTOCLEAR_MS      = 90 * 60 * 1000;  // no chatter for 90m -> auto-clear
const ARCHIVE_AFTER_CLEAR_MS  = 3  * 60 * 60 * 1000; // drop 3h after clearing
const SAME_SCENE_METERS       = 200;             // a city block plus the corner

/* The alerting bar, and the ceiling that makes it safe to have one.

   Heat used to be built entirely out of volume: units, transmissions, and how
   fast they were arriving. Volume is exactly what a busy routine call looks
   like, so a three car disturbance with a lot of chatter scored level with a
   working fire, and the one lever that could tell those apart, the words
   somebody actually said, was worth twelve points out of a hundred.

   Now volume describes intensity and language describes newsworthiness, and
   the second governs the first through a ceiling per threat tier. Whatever
   volume a scene piles up, a scene where nobody has said anything above
   routine cannot reach the bar. That is a structural guarantee rather than a
   tuning result, which is what makes the weights safe to tune at all: getting
   one wrong costs accuracy and cannot cost a false alarm.

   A false alarm in front of a reporter costs far more than a missed one. */
const HEAT_BAR           = 55;                   // at or above this the desk is told
const TIER_CEILING       = [50, 62, 80, 100];    // max heat by peak threat tier
const TYPICAL_SCENE_MINS = 20;                   // past this a scene is running long

const CLEAR_RE   = /\b(clear(ed)?|clearing|in service|back in service|available|resuming patrol|cancel(l?ed)?|call complete|complete|no further|unfounded|returning|all set|scene is clear|all units clear|10-?8)\b/i;
const ONSCENE_RE = /\b(on scene|arriv(ed|ing)|on location|out at|10-?23|staging)\b/i;

// Who is talking? Inferred from radio phraseology, not voiceprints.
// DISPATCH assigns and directs calls; FIELD is a unit acknowledging, reporting
// status, requesting resources, updating the scene, or clearing.
const DISPATCH_RE = /\b(respond(ing)? to|take the (call|run|assignment)|you(?:'| a)?re (?:going to|responding|clear to)|you have (?:a|an) (?:call|run)|report(?:s|ed)? of|reports? a|caller (?:states|reports|says|advises)|reporting party|complainant|received a call|we got a call|all units|any (?:unit|car|available)|do you copy|per (?:the )?caller|priority (?:one|two|three|1|2|3)|for (?:a|an) [a-z])\b/i;
const FIELD_RE    = /\b(on scene|on location|arriv(ed|ing)|out at|show (?:me|us) out|in service|back in service|resuming patrol|clear(?:ed|ing)?|en ?route|responding|received|copy(?: that)?|10-?4|10-?8|10-?23|in custody|start (?:me|us) (?:another|a second)|requesting|we (?:need|have|'ve got|'re)|i'?m out|nothing showing|smoke showing|working fire|fully involved|checks (?:ok|okay|out)|negative contact|be advised we|go ahead)\b/i;

/* Phrases that mean a routine call just became a story. These are what a
   newsroom would want to be told about, so they are scored, not just logged. */
const ESCALATION_RE = /\b(working fire|fully involved|second alarm|2nd alarm|third alarm|3rd alarm|multiple alarm|mayday|man down|officer down|firefighter down|shots fired|active shooter|mass casualty|multiple (?:victims|patients)|start (?:me|us) (?:another|a second)|strike (?:a|the) (?:second|third)|heavy smoke|people trapped|entrapment|extricat|evacuat|command post|stage (?:all|additional))\b/i;

/* An alarm level is the fire service's own severity number, said out loud, and
   it is the only escalation signal on the air that carries a magnitude rather
   than a yes or no. It is read here rather than in threat.js because a scene
   accumulates it and a single transmission cannot: the second alarm and the
   third are struck minutes apart, on lines that mention nothing else. */
const ALARM_RE  = /\b(second|third|fourth|fifth|2nd|3rd|4th|5th|two|three|four|five|multiple)[- ]?alarm\b/i;
const ALARM_NEG = /\b(no|not|negative|disregard|cancel(?:l?ed)?|don'?t|do not|hold (?:off|on)|without|never)\b[^.!?]*$/i;
const ALARM_LEVEL = { second: 2, '2nd': 2, two: 2, multiple: 2, third: 3, '3rd': 3, three: 3, fourth: 4, '4th': 4, four: 4, fifth: 5, '5th': 5, five: 5 };
function alarmLevel(text) {
  const t = String(text || '');
  const m = ALARM_RE.exec(t);
  if (!m) return 0;
  // "we do not need a second alarm" is not a second alarm. Same sentence only,
  // for the same reason the negation window in threat.js is.
  if (ALARM_NEG.test(t.slice(Math.max(0, m.index - 60), m.index))) return 0;
  return ALARM_LEVEL[m[1].toLowerCase()] || 0;
}

/* Set union over small arrays, insertion ordered so the first signal a scene
   showed stays first when it is rendered. */
function union(list, add) {
  const out = Array.isArray(list) ? list.slice() : [];
  for (const v of add || []) if (v && !out.includes(v)) out.push(v);
  return out;
}

function roleFor(text) {
  if (ONSCENE_RE.test(text) || CLEAR_RE.test(text)) return 'field'; // status change = a unit in the field
  const d = DISPATCH_RE.test(text), f = FIELD_RE.test(text);
  if (d && !f) return 'dispatch';
  if (f && !d) return 'field';
  if (d && f) return 'dispatch'; // clip likely opens with the assignment
  return null;
}

const CALL_TYPES = [
  'shoplifting','robbery','armed robbery','breaking and entering','larceny','shots fired',
  'assault','stabbing','shooting','motor vehicle accident','mva','crash','collision','hit and run',
  'structure fire','working fire','fire','medical','cardiac','overdose','difficulty breathing','unresponsive',
  'disturbance','domestic','suspicious','well being','vandalism','theft','burglary','pursuit','fall','seizure',
  'person with a knife','person with a gun','missing person','alarm','wires down','gas leak',
];

/* Which of two classifications for the same scene is the one to show.

   A call gets typed off the first transmission that says anything about it, and
   that first transmission is routinely the weakest thing anyone says all night.
   "Heavy smoke showing" is a smoke investigation until four minutes later, when
   the engine keys up with "we have a working fire, strike a second alarm". A
   map still reading smoke investigation at that point is telling the desk the
   opposite of what is happening.

   So a later type replaces the one on the scene when it outranks it, and never
   when it does not. Rank rather than recency, because a scene collects side
   traffic: an ambulance requested to a shooting must not turn the shooting into
   a medical call. Anything the table has not heard of ranks zero, below every
   named type, so an unfamiliar label can fill an empty slot and cannot displace
   a working fire.

   Strongest first, and rank is position, so this is edited by moving a line
   rather than by re-picking numbers. Both extractors feed it, which is why the
   same idea appears here under more than one name. */
const TYPE_ORDER = [
  'active shooter','mass casualty','structure fire','working fire','shooting','stabbing',
  'shots fired','weapons','person with a gun','person with a knife','armed robbery',
  'medical - serious','cardiac','unresponsive','not breathing','overdose','gas / co','gas leak',
  'pursuit','robbery','hit and run','fire','assault','domestic','breaking and entering','burglary',
  'motor vehicle accident','mva','mvc','crash','collision','missing person','smoke investigation',
  'hazard','wires down','difficulty breathing','seizure','fall','disturbance','medical',
  'suspicious','vandalism','theft','larceny','shoplifting','alarm','water flow',
  'well-being check','well being','traffic stop','pedestrian stop','service call',
];
const TYPE_RANK = {};
TYPE_ORDER.forEach((t, i) => { TYPE_RANK[t] = TYPE_ORDER.length - i; });
const rankOf = t => TYPE_RANK[String(t || '').toLowerCase().trim()] || 0;

function extract(text) {
  const t = ' ' + text.toLowerCase()
    .replace(/sharp lifting|shop lifting/g, 'shoplifting')
    .replace(/[.,]/g, ' ') + ' ';
  const units = [];
  const unitRe = /\b(car|unit|engine|ladder|truck|tac|det|detective|sergeant|sgt|officer|medic|ambulance|ambo|rescue|squad|e|l|m)\s*#?\s*(\d{1,3}[a-z]?)\b/gi;
  let m; while ((m = unitRe.exec(text)) !== null) {
    let u = (m[1] + ' ' + m[2]).replace(/\s+/g, ' ').trim();
    u = u.replace(/^e (\d)/i, 'Engine $1').replace(/^l (\d)/i, 'Ladder $1').replace(/^m (\d)/i, 'Medic $1');
    units.push(u.replace(/\b\w/g, c => c.toUpperCase()));
  }
  const callType = CALL_TYPES.find(c => t.includes(' ' + c + ' ')) || CALL_TYPES.find(c => t.includes(c)) || null;
  const addrRe = /\b(\d{1,5})\s+([A-Z][a-zA-Z.'-]*(?:\s+[A-Z][a-zA-Z.'-]*){0,3})\s+(street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|way|square|sq|place|pl|court|ct|highway|hwy|circle|cir|terrace|ter|row|wharf|park|parkway)\b/i;
  const a = text.match(addrRe);
  const address = a ? (a[1] + ' ' + a[2] + ' ' + a[3]).replace(/\s+/g, ' ') : null;
  const isClear = CLEAR_RE.test(text);
  const isOnScene = ONSCENE_RE.test(text);
  const priority = /priority|shots fired|shooting|stabbing|structure fire|working fire|\bgun\b|weapon|unresponsive|cardiac|not breathing/i.test(text) ? 'high' : 'normal';
  return { units: [...new Set(units)], callType, address, isClear, isOnScene, priority, role: roleFor(text) };
}

/* Metres between two fixes. Equirectangular rather than full haversine: over a
   200m threshold in Boston the difference is centimetres, and this runs inside
   the store mutex against every open incident. */
function metersBetween(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const x = (b.lon - a.lon) * rad * Math.cos((a.lat + b.lat) * rad / 2);
  const y = (b.lat - a.lat) * rad;
  return Math.sqrt(x * x + y * y) * R;
}

/* The ground this newsroom covers. Deliberately generous, roughly Worcester
   across to the ocean and Nashua down to Providence, because a Boston story
   really does run out to Framingham and up to Lawrence and the point is to
   catch pins that landed in another state, not to police the suburbs.

   Same numbers as the geocoder's Nominatim viewbox and Overpass bounding box,
   kept here as well because this is the last gate before a pin reaches a map
   a reporter reads. */
const METRO = { s: 41.85, w: -71.70, n: 42.95, e: -70.55 };
function inMetro(lat, lon) {
  return typeof lat === 'number' && typeof lon === 'number' &&
    lat >= METRO.s && lat <= METRO.n && lon >= METRO.w && lon <= METRO.e;
}

/* How good is this fix? Only "exact" is allowed to merge two scenes together.
   A gazetteer hit on a highway or a town centroid is a pin, not an identity. */
function precisionOf(geo) {
  if (!geo) return null;
  if (geo.weak) return 'weak';
  if (geo.approx) return 'approx';
  return 'exact';
}

function createStore(geocode, extractFn, opt) {
  opt = opt || {};
  extractFn = extractFn || (async (t) => extract(t)); // default: regex
  // The gazetteer, when the caller has one. Officers spell street names exactly
  // the way they spell surnames, so without this "Jette, Juliet Edward Tango
  // Tango Echo" gets filed as the person in the car rather than the road the
  // car is on.
  const isStreet = typeof opt.isStreet === 'function' ? opt.isStreet : undefined;
  // retentionDays is a policy dial, not a code decision. Unset, nothing
  // expires. Set, the identity fields come off a stored stop once it is older
  // than that and the record keeps its shape, its length and its outcome.
  const stops = createStops({ isStreet, retentionDays: opt.retentionDays });
  const incidents = {};       // id -> incident
  const unitToIncident = {};  // "engine 7" -> incident id
  let transcripts = [];       // rolling raw feed for the live console
  let events = [];            // rolling per-transmission pipeline trace for the backend "under the hood" tab
  const stats = { transmissions: 0, geocoded: 0, dispatch: 0, field: 0, noise: 0, bySource: {} };
  let seq = 0;
  const iso = d => (d instanceof Date ? d : new Date(d)).toISOString();

  function pushTranscript(source, text, time, incidentId, tags, role, clip) {
    /* clip is the audio URL this transmission was born with, when the relay
       managed to upload one. Undefined the rest of the time, and undefined
       serialises to nothing, so a board full of clipless rows costs zero
       extra bytes on the wire. */
    transcripts.unshift({ id: 't' + (seq++), source, text, time: iso(time), incidentId: incidentId || null, role: role || null, tags: tags || {}, clip: clip || undefined });
    if (transcripts.length > 120) transcripts.length = 120;
  }
  function pushEvent(ev) { events.unshift(ev); if (events.length > 150) events.length = 150; }

  function releaseUnits(inc) { (inc.units || []).forEach(u => { if (unitToIncident[u.toLowerCase()] === inc.id) delete unitToIncident[u.toLowerCase()]; }); }

  /* Heat: how much this scene looks like a story rather than a call.

     The shape of this score is the comment on HEAT_BAR at the top of the file;
     what follows is only the weights. Read that one first.

     Everything that contributed is written into inc.why, because a desk that
     cannot see why a scene scored 78 has no way to decide whether to believe
     it, and a score nobody believes gets ignored inside a week. */
  function scoreHeat(inc) {
    const first = +new Date(inc.firstHeard);
    const mins = Math.max(1, (+new Date(inc.lastUpdate) - first) / 60000);
    const rate = inc.timeline.length / mins;                  // transmissions per minute
    const tier = inc.tier || 0;
    const why = [];
    let h = 0;

    /* Volume: how busy this is. Capped as a block and well under the bar,
       because every one of these is something a routine call can produce on a
       Friday night without anything being wrong. */
    let vol = 0;
    vol += Math.min(14, Math.max(0, (inc.units || []).length - 1) * 4); // one unit is not a response
    vol += Math.min(10, inc.timeline.length * 1.5);           // sustained chatter
    vol += Math.min(6, rate * 4);                             // and how fast it is coming
    h += Math.min(30, vol);
    if ((inc.units || []).length > 2) why.push((inc.units || []).length + ' units');

    /* Growth. The initial dispatch sends whatever the call type calls for, all
       at once, so how many units are on a scene says less than when they got
       there. What separates a working scene from a busy one is the engine
       special called four minutes in, so only late arrivals score. */
    const late = (inc.unitJoins || []).filter(t => t - first > 90000).length;
    if (late) {
      h += Math.min(14, late * 5);
      why.push(late + (late > 1 ? ' units' : ' unit') + ' added after dispatch');
    }

    /* Two departments correlated to one place means each of them independently
       decided to be there. Hard to fake and cheap to count. */
    const depts = (inc.depts || []).length;
    if (depts > 1) { h += Math.min(12, (depts - 1) * 8); why.push(depts + ' departments'); }

    // The fire service's own severity number, said out loud.
    if (inc.alarm > 1) { h += Math.min(25, (inc.alarm - 1) * 12); why.push(inc.alarm + ' alarms'); }

    if (mins > TYPICAL_SCENE_MINS) {
      h += Math.min(10, (mins - TYPICAL_SCENE_MINS) / 6);
      why.push(Math.round(mins) + ' minutes');
    }

    /* Language: the highest tier anybody reached on this scene. Hedged evidence
       is discounted rather than dropped, because "report of shots fired" is
       worth acting on and is not the same claim as an officer saying it. */
    const TIER_POINTS = [0, 6, 22, 45];
    if (tier) {
      h += TIER_POINTS[tier] * (inc.hedged ? 0.7 : 1);
      why.push((inc.tierName || 'tier ' + tier) + (inc.hedged ? ' (reported)' : '') +
        ((inc.signals || []).length ? ': ' + inc.signals.slice(0, 4).join(', ') : ''));
    }
    /* A named specialist unit is dispatch's own severity assessment, made by
       people with more information than this system will ever have. */
    if ((inc.specialists || []).length) {
      h += Math.min(10, inc.specialists.length * 6);
      why.push(inc.specialists.slice(0, 3).join(', ') + ' assigned');
    }
    if (inc.escalations) h += Math.min(8, inc.escalations * 4);
    if (inc.priority === 'high') h += 8;

    const ceiling = TIER_CEILING[tier] === undefined ? 100 : TIER_CEILING[tier];
    inc.heat = Math.max(0, Math.min(ceiling, Math.round(h)));
    inc.why = why;

    /* The flag worth an alert, making two different claims. Either somebody
       said a tier 3 thing on the air, which is a story on one transmission, or
       the scene is loud and still growing, which is a story because of its
       shape. A cleared scene is neither. */
    inc.escalating = inc.status === 'active' && (tier >= 3 || (inc.heat >= HEAT_BAR && rate >= 0.8));
    return inc.heat;
  }

  async function ingest({ source, city, dept, text, time, pre, clip }) {
    time = time ? new Date(time) : new Date();
    text = (text || '').trim();
    if (text.length < 4) return null;
    const ex = (pre && pre.ex) ? pre.ex : await extractFn(text);
    const role = ex.role || roleFor(text); // LLM role if given, else infer from phraseology

    stats.bySource[source] = (stats.bySource[source] || 0) + 1;

    // Silence artifacts and stuck mics reach the console so the newsroom can
    // see the channel is alive, and go no further. They used to be able to
    // open an incident on a hallucinated landmark.
    if (ex.noise) {
      stats.transmissions++; stats.noise++;
      pushTranscript(source, text, time, null, { noise: true }, role, clip);
      pushEvent({
        id: 'e' + (seq++), t: iso(time), feed: source, role: role || null,
        transcript: text, by: ex._by || 'noise', units: [], callType: null,
        address: null, street: null, town: null, landmark: null, crossStreet: null,
        priority: 'low', noise: true, geo: { ok: false, why: 'noise' }, incident: { action: 'none' },
      });
      return null;
    }

    // 1) match an existing active incident by unit
    let inc = null, joinedBy = null;
    for (const u of ex.units) { const id = unitToIncident[u.toLowerCase()]; if (id && incidents[id] && incidents[id].status !== 'archived') { inc = incidents[id]; joinedBy = 'unit'; break; } }

    // geocode via cascade (address -> landmark -> cross street)
    let geo = null;
    if (pre && pre.geo !== undefined) geo = pre.geo;                  // already resolved outside the lock
    else { try { geo = await geocode(ex, city); } catch (e) {} }
    // The stop tracker sees every non-noise transmission, whether or not it
    // ever becomes an incident, because most of a stop is chatter that would
    // never start a scene on its own. It scopes callsigns by department for the
    // same reason a bare street name is only resolved inside a known town:
    // Boston, Cambridge and Quincy all have a Car 15.
    const department = dept || deptOf(source, city);
    let stop = null;
    try {
      stop = stops.feed({
        dept: department, feed: source, units: ex.units, text, time,
        ex, geo, said: readSpoken(text, { isStreet }),
      });
    } catch (e) {}

    // A stop stops being routine the moment a second car rolls, somebody is
    // searched, or somebody is arrested. When that happens it brings its own
    // fix with it, because the corner was given on the opening transmission and
    // the escalation arrives several minutes later on a line that names no
    // street at all. Without this an arrest reaches the map as nothing.
    const stopIsNews = !!stop && (stop.backup || stop.search ||
      stop.disposition === 'arrest' || stop.disposition === 'summons' || stop.disposition === 'tow');
    if (stopIsNews && !geo && typeof stop.lat === 'number') {
      geo = { lat: stop.lat, lon: stop.lon, matched: stop.place, src: 'stop', approx: stop.precision === 'approx' };
    }

    /* A pin outside eastern Massachusetts is never right for this product, and
       the way it gets there is not a rounding error, it is a name collision
       resolving somewhere else entirely. Overpass took area["name"="Boston"]
       with no bounding box and matched every administrative area on Earth with
       that name, which put a Boston fire on the map at North Boston Avenue in
       Tulsa and a traffic stop at New Boston, New Hampshire. That query is now
       fenced, but the guard belongs here rather than only there: this is the
       one place every fix passes through no matter which of the half dozen
       geocoding paths produced it, and a wrong pin is worse than no pin
       because nothing about it looks wrong on a map.

       Dropped before precisionOf on purpose, so a bad fix cannot pull an
       unrelated call into its scene either. */
    if (geo && !inMetro(geo.lat, geo.lon)) geo = null;

    const precision = precisionOf(geo);

    // 2) else match an active scene at the same PLACE inside the window.
    //    Distance, not string equality: "12 Boylston St" and "Boylston Street,
    //    Boston" used to be two incidents. Exact fixes only, because a town
    //    centroid would swallow every call in the town.
    if (!inc && geo && precision === 'exact') {
      let best = null, bestD = Infinity;
      for (const id in incidents) {
        const c = incidents[id];
        if (c.status !== 'active' || !c.located || c.precision !== 'exact') continue;
        if ((time - new Date(c.lastUpdate)) >= ADDRESS_MATCH_WINDOW_MS) continue;
        if (c.matched && c.matched === geo.matched) { best = c; bestD = 0; break; }
        if (typeof c.lat !== 'number') continue;
        const d = metersBetween(c, geo);
        if (d < SAME_SCENE_METERS && d < bestD) { best = c; bestD = d; }
      }
      if (best) { inc = best; joinedBy = bestD === 0 ? 'address' : 'proximity'; }
    }

    // 3) a follow-up whose location the extractor carried forward from earlier
    //    chatter on the same channel. It belongs to a scene, and it must not
    //    start one, or a single fire becomes a pin for every "we're still here".
    const inherited = !!ex.fromContext;

    const escalated = ESCALATION_RE.test(text);

    /* The per-transmission threat read. api/ingest computes this outside the
       mutex and hands it over on pre.threat, the same way it already does the
       extraction and the geocode. The fallback is not decoration: the analyst
       cron, the test harness and corpus replay all drive the store directly
       and none of them fill pre. */
    const th = (pre && pre.threat) || threat.assess({ text, units: ex.units });
    const alarm = alarmLevel(text);

    // record a full pipeline trace (audio -> transcript -> extract -> geocode -> incident)
    const recordEvent = (action, incident) => {
      stats.transmissions++;
      if (geo) stats.geocoded++;
      if (role === 'dispatch') stats.dispatch++; else if (role === 'field') stats.field++;
      pushEvent({
        id: 'e' + (seq++), t: iso(time), feed: source, role: role || null,
        transcript: text, by: ex._by || 'regex',
        units: ex.units || [], callType: ex.callType || null,
        address: ex.address || null, street: ex.street || null, town: ex.town || null,
        landmark: ex.landmark || null, crossStreet: ex.crossStreet || null,
        priority: ex.priority || 'normal',
        escalation: escalated || undefined,
        inherited: inherited || undefined,
        hallucinated: ex._hallucinated || undefined,
        /* What the threat read made of this one line, sitting next to the
           correlation and the stop, so the "under the hood" tab shows the
           working out for all three rather than only for the parts that were
           cheap to show. Labels, for the same reason as on the incident. */
        threat: {
          tier: th.tier, tierName: th.tierName, category: th.category,
          signals: th.signals.length ? th.signals.map(s => s.label) : undefined,
          units: th.units.length ? th.units.map(u => u.label) : undefined,
          hedged: th.hedged || undefined,
          why: th.why || undefined,
        },
        alarm: alarm || undefined,
        geo: geo
          ? { ok: true, lat: geo.lat, lon: geo.lon, matched: geo.matched, via: geo.src || null, precision, town: geo.town || null }
          : { ok: false, why: ex.address || ex.street || ex.landmark || ex.crossStreet ? 'no match' : 'nothing to geocode' },
        incident: incident
          ? {
              action, id: incident.id, type: incident.type, location: incident.location,
              status: incident.status, heat: incident.heat, joinedBy,
              // Why this scene scores what it scores, beside the correlation
              // that put the transmission on it.
              tier: incident.tier || 0, tierName: incident.tierName || 'routine',
              alarm: incident.alarm || undefined,
              escalating: incident.escalating || undefined,
              why: incident.why && incident.why.length ? incident.why : undefined,
            }
          : { action: 'none' },
        // What the stop tracker made of the same line, so the "under the hood"
        // tab shows a stop opening and closing next to the scene correlation
        // rather than in a surface of its own with no working out.
        stop: stop ? {
          id: stop.id, unit: stop.unitSpoken || stop.unit, dept: stop.dept,
          status: stop.status, kind: stop.kind, seconds: stop.seconds,
          plate: stop.plate || null, names: stop.names && stop.names.length ? stop.names : undefined,
          disposition: stop.disposition || null, repeat: stop.repeat,
        } : undefined,
      });
    };

    if (inc) {
      inc.timeline.push({ t: iso(time), source, text, onScene: ex.isOnScene, clear: ex.isClear, role, clip: clip || undefined });
      inc.lastUpdate = iso(time);
      if (ex.priority === 'high') inc.priority = 'high';
      if (escalated) inc.escalations = (inc.escalations || 0) + 1;

      /* Accumulate the scene's threat picture. Max for the tier and the alarm,
         because a scene does not get better once somebody has said the words;
         union for the signals and the specialists, because they arrive one
         transmission at a time and the desk wants the whole list rather than
         whatever the last line happened to mention.

         Labels rather than ids, because this list is rendered. threat.js
         exports SIGNALS for anything that needs to match on identity. */
      if (th.tier > (inc.tier || 0)) { inc.tier = th.tier; inc.tierName = th.tierName; inc.hedged = !!th.hedged; }
      else if (th.tier && th.tier === inc.tier && !th.hedged) inc.hedged = false;
      inc.signals = union(inc.signals, th.signals.map(s => s.label));
      inc.specialists = union(inc.specialists, th.units.map(u => u.label));
      if (department) inc.depts = union(inc.depts, [department]);
      if (alarm > (inc.alarm || 0)) inc.alarm = alarm;

      /* When each unit arrived, not only how many. A scene that pulled its
         fourth engine six minutes in is a different thing from one dispatched
         four engines at once, and a count cannot tell those apart. */
      ex.units.forEach(u => {
        if (!inc.units.includes(u)) { inc.units.push(u); (inc.unitJoins = inc.unitJoins || []).push(+new Date(time)); }
        unitToIncident[u.toLowerCase()] = inc.id;
      });
      if (ex.callType && (!inc.type || inc.type === 'unclassified' || rankOf(ex.callType) > rankOf(inc.type))) {
        if (inc.type && inc.type !== 'unclassified' && inc.type !== ex.callType) {
          // Worth keeping, because "when did this become a working fire" is the
          // first thing anyone asks about a scene that changed under them.
          inc.timeline.push({ t: iso(time), source, text: 'reclassified: ' + inc.type + ' -> ' + ex.callType, role: 'system' });
          inc.retyped = (inc.retyped || 0) + 1;
        }
        inc.type = ex.callType;
      }
      // A later transmission places a scene that was dispatched blind, and a
      // better fix upgrades a worse one. A town centroid must never overwrite
      // a street address.
      const better = geo && (!inc.located || (precision === 'exact' && inc.precision !== 'exact') || (precision === 'approx' && inc.precision === 'weak'));
      if (better) {
        inc.lat = geo.lat; inc.lon = geo.lon; inc.location = geo.matched; inc.matched = geo.matched;
        inc.located = true; inc.precision = precision; inc.geoVia = geo.src || null;
        if (geo.town && !inc.town) inc.town = geo.town;
      }
      if (ex.isClear) { inc.status = 'cleared'; inc.clearedAt = iso(time); releaseUnits(inc); }
      if (stop) { stop.incidentId = inc.id; inc.stopId = stop.id; }
      scoreHeat(inc);
      pushTranscript(source, text, time, inc.id, { clear: ex.isClear, onScene: ex.isOnScene, escalation: escalated, stop: stop ? stop.id : undefined }, role, clip);
      recordEvent(ex.isClear ? 'cleared' : 'append', inc);
      return inc;
    }

    // 4) brand-new scene: either we can map it now, OR it is a clear dispatch
    //    (a unit is being sent to a call type) that we will place when a later
    //    transmission gives the address. The second case is what keeps overnight
    //    calls visible in the feed instead of vanishing when geocoding misses.
    const dispatchNoLoc = !geo && ex.units.length && ex.callType && ex.callType !== 'unclassified' && role !== 'field' && !ex.isClear;
    // A weak fix is a town centroid. On its own it says "something happened in
    // Quincy", which is not an incident; it needs a unit and a call type behind
    // it to be worth a pin.
    const weakAlone = precision === 'weak' && !(ex.units.length && ex.callType);
    // A routine stop is not a scene. Boston works hundreds of them on a busy
    // night, and a pin for every plate check buries the fire and the shooting
    // under a wall of two-minute nothings. Stops have their own surface, which
    // shows the length and the outcome a pin cannot, so a transmission that
    // only opens a stop does not also open an incident. It comes back to the
    // map the moment it is more than a stop.
    const routineStop = !!stop && !stopIsNews && !escalated && ex.priority !== 'high';
    const startable = ((geo && !weakAlone && !inherited) || dispatchNoLoc) && !routineStop;

    if (startable) {
      const id = 'inc-' + Date.now().toString(36) + '-' + (seq++);
      inc = {
        id, source: 'Scanner (' + city + ')', cat: 'scanner', city,
        feed: source,
        // A stop that got promoted to the map arrived on a line about backup or
        // an exit order, which names no call type at all, so the pin would go up
        // reading "unclassified" when the tracker beside it knows exactly what
        // it is watching. Both stop types sit at the bottom of the rank table,
        // so the first real classification still takes over.
        type: ex.callType || (stop && (stop.kind === 'pedestrian' ? 'pedestrian stop' : 'traffic stop')) || 'unclassified',
        title: ex.units.length ? ex.units.join(', ') : 'Unit dispatched',
        location: geo ? geo.matched : null, matched: geo ? geo.matched : null,
        lat: geo ? geo.lat : null, lon: geo ? geo.lon : null, located: !!geo,
        precision: precision || null, geoVia: geo ? (geo.src || null) : null,
        town: geo ? (geo.town || null) : null,
        status: ex.isClear ? 'cleared' : 'active', priority: ex.priority, verified: false,
        firstHeard: iso(time), lastUpdate: iso(time), clearedAt: ex.isClear ? iso(time) : null,
        escalations: escalated ? 1 : 0,
        // The same fields the append branch accumulates, so a scene that never
        // gets a second transmission still has the shape scoreHeat reads. A
        // shooting is frequently one transmission and then silence.
        tier: th.tier, tierName: th.tierName, hedged: th.tier ? !!th.hedged : false,
        signals: th.signals.map(s => s.label), specialists: th.units.map(u => u.label),
        depts: department ? [department] : [], alarm,
        unitJoins: ex.units.map(() => +new Date(time)),
        units: [...ex.units], timeline: [{ t: iso(time), source, text, onScene: ex.isOnScene, clear: ex.isClear, role, clip: clip || undefined }],
      };
      if (stop) { stop.incidentId = id; inc.stopId = stop.id; }
      scoreHeat(inc);
      incidents[id] = inc;
      ex.units.forEach(u => { unitToIncident[u.toLowerCase()] = id; });
      pushTranscript(source, text, time, id, { isNew: true, escalation: escalated, stop: stop ? stop.id : undefined }, role, clip);
      recordEvent(ex.isClear ? 'cleared' : 'new', inc);
      return inc;
    }

    // 5) orphan chatter (no address, no known unit) -> live feed only.
    //    Most of a stop lands here: a plate read back, a name, a records check.
    //    None of it would ever start a scene, and all of it is already on the
    //    stop record by the time this line runs.
    pushTranscript(source, text, time, null, { clear: ex.isClear, escalation: escalated, stop: stop ? stop.id : undefined }, role, clip);
    recordEvent('none', null);
    return null;
  }

  function sweep(now) {
    now = now ? new Date(now) : new Date();
    for (const id in incidents) {
      const c = incidents[id];
      if (c.status === 'active' && (now - new Date(c.lastUpdate)) > STALE_AUTOCLEAR_MS) {
        c.status = 'cleared'; c.clearedAt = c.clearedAt || iso(new Date(new Date(c.lastUpdate).getTime() + STALE_AUTOCLEAR_MS)); c.autoCleared = true; c.escalating = false; releaseUnits(c);
      }
      if (c.status === 'cleared' && c.clearedAt && (now - new Date(c.clearedAt)) > ARCHIVE_AFTER_CLEAR_MS) {
        releaseUnits(c);
        delete incidents[id];
      }
    }
    // A stop nobody was heard clearing has to retire on its own, and the sweep
    // is the only thing running when the desk is not looking at the stop
    // surface. list() sweeps too, so this only matters on a quiet night, which
    // is exactly when a stop gets left open.
    stops.list(now);
    // A unit can outlive the scene it was claimed by if a write raced a sweep.
    // Left alone, that stale claim silently glues a brand-new call to a scene
    // that no longer exists.
    for (const u in unitToIncident) if (!incidents[unitToIncident[u]]) delete unitToIncident[u];
  }

  /* ---- persistence ------------------------------------------------------
     The Mac kept all of this in one long-lived process. Vercel gives every
     request a fresh one, so the store is loaded, mutated and written back on
     each ingest batch under a mutex. Everything below is plain JSON on
     purpose: no Dates, no Maps, nothing that needs a reviver. */
  function hydrate(state) {
    if (!state || typeof state !== 'object') return;
    for (const k in incidents) delete incidents[k];
    Object.assign(incidents, state.incidents || {});
    for (const k in unitToIncident) delete unitToIncident[k];
    Object.assign(unitToIncident, state.unitToIncident || {});
    transcripts = Array.isArray(state.transcripts) ? state.transcripts : [];
    events = Array.isArray(state.events) ? state.events : [];
    Object.assign(stats, state.stats || {});
    if (!stats.bySource || typeof stats.bySource !== 'object') stats.bySource = {};
    // seq only has to be unique within this store, and it is part of every id
    // already handed to the browser, so it must never go backwards.
    seq = Math.max(Number(state.seq) || 0, seq);
    stops.hydrate(state.stops);

    /* Pins written before the fence existed are still in here, and the store
       is rehydrated on every request, so this is what actually clears them off
       the map rather than waiting for them to age out. Cheap: it is a bounds
       check over a few dozen records.

       The call keeps everything else it knows and simply stops claiming to
       know where it happened, which is the honest state for a call whose only
       location evidence resolved to Oklahoma. */
    for (const id in incidents) {
      const c = incidents[id];
      if (!c || !c.located) continue;
      if (inMetro(c.lat, c.lon)) continue;
      c.lat = null; c.lon = null; c.located = false;
      c.precision = null; c.geoVia = null;
      c.location = null; c.matched = null;
    }
  }
  function dump() {
    return { v: 1, incidents, unitToIncident, transcripts, events, stats, seq, stops: stops.dump() };
  }

  function snapshotIncidents() {
    return Object.values(incidents)
      .filter(c => c.status !== 'archived')
      .sort((a, b) => (a.status === b.status ? new Date(b.lastUpdate) - new Date(a.lastUpdate) : a.status === 'active' ? -1 : 1));
  }
  /* What is happening on the street right now and what happened tonight.
     Open stops first, because a car that has been out with someone for forty
     minutes is the thing worth walking over to the editor about. The log is
     capped for the wire; the tracker keeps more than this. */
  function snapshotStops(now, windowMs) {
    const t = now ? +new Date(now) : Date.now();
    const l = stops.list(t);
    return { open: l.open, closed: l.closed.slice(0, 150), summary: stops.summary(t, windowMs) };
  }
  function snapshotTranscripts() { return transcripts; }
  function snapshotEvents() { return events; }
  function snapshotStats() { return { ...stats }; }

  /* The last few transmissions per channel, oldest first. The extractor uses
     this so a follow-up can find the call it belongs to. Read from the console
     ring, which already holds exactly this and costs nothing to walk. */
  function recentBySource(n = 3) {
    const out = {};
    for (const t of transcripts) {                 // newest first
      const s = t.source;
      if (!s) continue;
      if (!out[s]) out[s] = [];
      if (out[s].length < n) out[s].unshift(t.text);
    }
    return out;
  }

  return {
    ingest, sweep, hydrate, dump,
    snapshotIncidents, snapshotTranscripts, snapshotEvents, snapshotStats, snapshotStops,
    stopsForPlate: p => stops.forPlate(p),
    recentBySource, _incidents: incidents, _stops: stops,
  };
}

module.exports = {
  createStore, extract, roleFor, metersBetween, deptOf, ESCALATION_RE,
  // The alerting bar and the ceiling belong to the score, so anything that
  // decides whether to tell somebody reads them from here rather than
  // hard-coding 55 a second time and drifting away from it.
  alarmLevel, HEAT_BAR, TIER_CEILING,
};
