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
   ========================================================================== */

const ADDRESS_MATCH_WINDOW_MS = 120 * 60 * 1000; // correlate to a scene up to 2h old
const STALE_AUTOCLEAR_MS      = 90 * 60 * 1000;  // no chatter for 90m -> auto-clear
const ARCHIVE_AFTER_CLEAR_MS  = 3  * 60 * 60 * 1000; // drop 3h after clearing

const CLEAR_RE   = /\b(clear(ed)?|clearing|in service|back in service|available|resuming patrol|cancel(l?ed)?|call complete|complete|no further|unfounded|returning|all set|scene is clear|all units clear|10-?8)\b/i;
const ONSCENE_RE = /\b(on scene|arriv(ed|ing)|on location|out at|10-?23|staging)\b/i;

// Who is talking? Inferred from radio phraseology, not voiceprints.
// DISPATCH assigns and directs calls; FIELD is a unit acknowledging, reporting
// status, requesting resources, updating the scene, or clearing.
const DISPATCH_RE = /\b(respond(ing)? to|take the (call|run|assignment)|you(?:'| a)?re (?:going to|responding|clear to)|you have (?:a|an) (?:call|run)|report(?:s|ed)? of|reports? a|caller (?:states|reports|says|advises)|reporting party|complainant|received a call|we got a call|all units|any (?:unit|car|available)|do you copy|per (?:the )?caller|priority (?:one|two|three|1|2|3)|for (?:a|an) [a-z])\b/i;
const FIELD_RE    = /\b(on scene|on location|arriv(ed|ing)|out at|show (?:me|us) out|in service|back in service|resuming patrol|clear(?:ed|ing)?|en ?route|responding|received|copy(?: that)?|10-?4|10-?8|10-?23|in custody|start (?:me|us) (?:another|a second)|requesting|we (?:need|have|'ve got|'re)|i'?m out|nothing showing|smoke showing|working fire|fully involved|checks (?:ok|okay|out)|negative contact|be advised we|go ahead)\b/i;

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

function createStore(geocode, extractFn) {
  extractFn = extractFn || (async (t) => extract(t)); // default: regex
  const incidents = {};       // id -> incident
  const unitToIncident = {};  // "engine 7" -> incident id
  let transcripts = [];       // rolling raw feed for the live console
  let events = [];            // rolling per-transmission pipeline trace for the backend "under the hood" tab
  const stats = { transmissions: 0, geocoded: 0, dispatch: 0, field: 0 };
  let seq = 0;
  const iso = d => (d instanceof Date ? d : new Date(d)).toISOString();

  function pushTranscript(source, text, time, incidentId, tags, role) {
    transcripts.unshift({ id: 't' + (seq++), source, text, time: iso(time), incidentId: incidentId || null, role: role || null, tags: tags || {} });
    if (transcripts.length > 120) transcripts.length = 120;
  }
  function pushEvent(ev) { events.unshift(ev); if (events.length > 150) events.length = 150; }

  function releaseUnits(inc) { (inc.units || []).forEach(u => { if (unitToIncident[u.toLowerCase()] === inc.id) delete unitToIncident[u.toLowerCase()]; }); }

  async function ingest({ source, city, text, time, pre }) {
    time = time ? new Date(time) : new Date();
    text = (text || '').trim();
    if (text.length < 4) return null;
    const ex = (pre && pre.ex) ? pre.ex : await extractFn(text);
    const role = ex.role || roleFor(text); // LLM role if given, else infer from phraseology

    // 1) match an existing active incident by unit
    let inc = null;
    for (const u of ex.units) { const id = unitToIncident[u.toLowerCase()]; if (id && incidents[id] && incidents[id].status !== 'archived') { inc = incidents[id]; break; } }

    // geocode via cascade (address -> landmark -> cross street)
    let geo = null;
    if (pre && pre.geo !== undefined) geo = pre.geo;                  // already resolved outside the lock
    else { try { geo = await geocode(ex, city); } catch (e) {} }

    // 2) else match an active scene at the same address inside the window
    if (!inc && geo) {
      for (const id in incidents) {
        const c = incidents[id];
        if (c.status === 'active' && c.matched === geo.matched && (time - new Date(c.lastUpdate)) < ADDRESS_MATCH_WINDOW_MS) { inc = c; break; }
      }
    }

    // record a full pipeline trace (audio -> transcript -> extract -> geocode -> incident)
    const recordEvent = (action, incident) => {
      stats.transmissions++;
      if (geo) stats.geocoded++;
      if (role === 'dispatch') stats.dispatch++; else if (role === 'field') stats.field++;
      pushEvent({
        id: 'e' + (seq++), t: iso(time), feed: source, role: role || null,
        transcript: text, by: ex._by || 'regex',
        units: ex.units || [], callType: ex.callType || null,
        address: ex.address || null, landmark: ex.landmark || null, crossStreet: ex.crossStreet || null,
        priority: ex.priority || 'normal',
        geo: geo ? { ok: true, lat: geo.lat, lon: geo.lon, matched: geo.matched } : { ok: false },
        incident: incident ? { action, id: incident.id, type: incident.type, location: incident.location, status: incident.status } : { action: 'none' },
      });
    };

    if (inc) {
      inc.timeline.push({ t: iso(time), source, text, onScene: ex.isOnScene, clear: ex.isClear, role });
      inc.lastUpdate = iso(time);
      if (ex.priority === 'high') inc.priority = 'high';
      ex.units.forEach(u => { if (!inc.units.includes(u)) inc.units.push(u); unitToIncident[u.toLowerCase()] = inc.id; });
      if (ex.callType && (!inc.type || inc.type === 'unclassified')) inc.type = ex.callType;
      if (!inc.lat && geo) { inc.lat = geo.lat; inc.lon = geo.lon; inc.location = geo.matched; inc.matched = geo.matched; inc.located = true; } // a later transmission placed it
      if (ex.isClear) { inc.status = 'cleared'; inc.clearedAt = iso(time); releaseUnits(inc); }
      pushTranscript(source, text, time, inc.id, { clear: ex.isClear, onScene: ex.isOnScene }, role);
      recordEvent(ex.isClear ? 'cleared' : 'append', inc);
      return inc;
    }

    // 3) brand-new scene: either we can map it now, OR it is a clear dispatch
    //    (a unit is being sent to a call type) that we will place when a later
    //    transmission gives the address. The second case is what keeps overnight
    //    calls visible in the feed instead of vanishing when geocoding misses.
    const dispatchNoLoc = !geo && ex.units.length && ex.callType && ex.callType !== 'unclassified' && role !== 'field' && !ex.isClear;
    if (geo || dispatchNoLoc) {
      const id = 'inc-' + Date.now().toString(36) + '-' + (seq++);
      inc = {
        id, source: 'Scanner (' + city + ')', cat: 'scanner', city,
        type: ex.callType || 'unclassified',
        title: ex.units.length ? ex.units.join(', ') : 'Unit dispatched',
        location: geo ? geo.matched : null, matched: geo ? geo.matched : null,
        lat: geo ? geo.lat : null, lon: geo ? geo.lon : null, located: !!geo,
        status: ex.isClear ? 'cleared' : 'active', priority: ex.priority, verified: false,
        firstHeard: iso(time), lastUpdate: iso(time), clearedAt: ex.isClear ? iso(time) : null,
        units: [...ex.units], timeline: [{ t: iso(time), source, text, onScene: ex.isOnScene, clear: ex.isClear, role }],
      };
      incidents[id] = inc;
      ex.units.forEach(u => { unitToIncident[u.toLowerCase()] = id; });
      pushTranscript(source, text, time, id, { isNew: true }, role);
      recordEvent(ex.isClear ? 'cleared' : 'new', inc);
      return inc;
    }

    // 4) orphan chatter (no address, no known unit) -> live feed only
    pushTranscript(source, text, time, null, { clear: ex.isClear }, role);
    recordEvent('none', null);
    return null;
  }

  function sweep(now) {
    now = now ? new Date(now) : new Date();
    for (const id in incidents) {
      const c = incidents[id];
      if (c.status === 'active' && (now - new Date(c.lastUpdate)) > STALE_AUTOCLEAR_MS) {
        c.status = 'cleared'; c.clearedAt = c.clearedAt || iso(new Date(new Date(c.lastUpdate).getTime() + STALE_AUTOCLEAR_MS)); c.autoCleared = true; releaseUnits(c);
      }
      if (c.status === 'cleared' && c.clearedAt && (now - new Date(c.clearedAt)) > ARCHIVE_AFTER_CLEAR_MS) {
        releaseUnits(c);
        delete incidents[id];
      }
    }
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
    // seq only has to be unique within this store, and it is part of every id
    // already handed to the browser, so it must never go backwards.
    seq = Math.max(Number(state.seq) || 0, seq);
  }
  function dump() {
    return { v: 1, incidents, unitToIncident, transcripts, events, stats, seq };
  }

  function snapshotIncidents() {
    return Object.values(incidents)
      .filter(c => c.status !== 'archived')
      .sort((a, b) => (a.status === b.status ? new Date(b.lastUpdate) - new Date(a.lastUpdate) : a.status === 'active' ? -1 : 1));
  }
  function snapshotTranscripts() { return transcripts; }
  function snapshotEvents() { return events; }
  function snapshotStats() { return { ...stats }; }

  return { ingest, sweep, hydrate, dump, snapshotIncidents, snapshotTranscripts, snapshotEvents, snapshotStats, _incidents: incidents };
}

module.exports = { createStore, extract, roleFor };
