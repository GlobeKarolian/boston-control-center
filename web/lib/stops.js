// lib/stops.js
// The lifecycle of a stop, from "out with a vehicle" to "clear".
//
// A stop is not shaped like the incidents this system already tracks. A fire
// has a place and grows; a stop has a place, a unit, a length and an outcome,
// and the length is most of the point. Two minutes at a corner is a plate
// check. Forty minutes at the same corner with a second car called in is
// something else, and the only way to tell them apart is to hold the beginning
// until the end arrives.
//
// Correlation is by callsign, not by proximity, which is the opposite of how
// incidents match here. A stop is one car and it names itself every time it
// keys the mic, so the callsign is the strongest handle available. Proximity
// would be actively wrong, because two unrelated stops on the same arterial an
// hour apart are exactly what a reporter wants counted separately.
//
// Scoped by department for the same reason the callsign geography is: Boston,
// Cambridge and Quincy all have a Car 15.

const { looksLikePlate, NAME_CUE_RE } = require('./spoken.js');

const OPEN_RE = /\b(?:out with|off with|out on a?\s*(?:car|mv|motor vehicle|traffic)\s*stop|(?:car|mv|motor vehicle|traffic)\s*stop|stopping a|pulled? over|pulling over|flagged down|initiating a stop|be out with|out at .{0,30}\bwith (?:a|one|two|three)\b)\b/i;
const KIND_VEH = /\b(?:vehicle|car stop|mv stop|motor vehicle|plate|registration|operator|sedan|suv|pickup|van|honda|toyota|nissan|ford|chevy|chevrolet|bmw|audi|jeep|hyundai|kia|subaru|dodge|lexus|acura|mercedes|volkswagen|vw)\b/i;
const KIND_PED = /\b(?:on foot|pedestrian|walking|subject on|male party|female party|group of|juveniles?|individual)\b/i;

// Clearing, in two strengths, because the word "clear" does two jobs on a
// police channel and only one of them ends a stop. "Car 15 clear" is a unit
// going back in service. "That plate comes back clear and valid" is the answer
// to a records check, said while the stop is very much still running, and
// reading it as the end turns a twenty minute arrest into a sixty second
// nothing and throws away everything said after it. So a bare "clear" only
// counts when the line carries no records answer and is not dispatch talking
// at the unit rather than the unit talking back.
const CLEAR_STRONG = /\b(?:in service|back in service|resuming patrol|show(?:ing)? (?:me|you) clear|you'?re clear|clear(?:ing)? the call|we'?re all set|all set here|no further)\b/i;
const CLEAR_WEAK = /\b(?:clear(?:ing|ed)?|all set|available for (?:the next|another|calls))\b/i;
const CLOSE_RE = new RegExp(CLEAR_STRONG.source + '|' + CLEAR_WEAK.source, 'i');
const FROM_DISPATCH = /^\s*[a-z]{0,12}\s*\b(?:control|dispatch|operations|ops)\b[ ,]{0,3}(?:to\b|calling\b)/i;

// How a stop ended. Ordered so the more consequential reading wins when one
// transmission carries two, because "one under" and "clear" arrive together.
const DISPOSITION = [
  [/\b(?:one|two|three|1|2|3)\s+under\b|\bin custody\b|\bplaced under arrest\b|\bunder arrest\b|\btransport(?:ing)? (?:one|him|her|them)\b/i, 'arrest'],
  [/\bsummons(?:ed|ing)?\b|\bcourt summons\b|\bapplication for (?:a )?complaint\b/i, 'summons'],
  [/\bcitation\b|\bcited\b|\bticket(?:ed|ing)?\b|\bwriting (?:him|her|them) (?:a|one)\b/i, 'citation'],
  [/\bwritten warning\b|\bverbal warning\b|\bwarn(?:ed|ing)\b/i, 'warning'],
  [/\btow(?:ed|ing)?\b|\bwrecker\b/i, 'tow'],
  [/\bsent (?:him|her|them|on)\b|\bon (?:his|her|their) way\b|\bno action\b|\bnothing further\b|\ball set\b/i, 'no action'],
];

// The two worth counting separately. An exit order and a search are the
// documented pressure points in stop reporting, and a second car called to a
// routine plate check is the difference between a minute and half an hour.
const BACKUP_RE = /\b(?:start me another|another (?:car|unit)|back-?up|second unit|any (?:car|unit) (?:available|to back)|expedite|step it up|send me a)\b/i;
const SEARCH_RE = /\b(?:exit order|out of the (?:car|vehicle)|search(?:ing|ed)? the (?:car|vehicle|trunk)|consent to search|pat frisk|patted? (?:him|her|them) down|frisk(?:ed|ing)?|k-?9|canine)\b/i;
const RECORD_RE = /\b(?:clear and valid|no warrants?|active warrants?|warrant hit|wanted person|ncic|cjis|cori\b|comes back (?:clear|valid|revoked|suspended)|licen[cs]e is (?:clear|valid|revoked|suspended)|run (?:him|her|them|the plate)|check for warrants)\b/i;

const COLOUR = /\b(silver|black|white|blue|red|gr[ea]y|green|tan|beige|gold|maroon|brown|orange|yellow|purple)\b/i;
const MAKE = /\b(honda|toyota|nissan|ford|chevy|chevrolet|bmw|audi|jeep|hyundai|kia|subaru|dodge|lexus|acura|mercedes|benz|volkswagen|vw|mazda|volvo|infiniti|buick|gmc|ram|tesla|mitsubishi|chrysler|cadillac|lincoln|land rover|range rover|porsche|jaguar)\b/i;
const BODY = /\b(sedan|suv|pick-?up|van|minivan|coupe|wagon|hatchback|convertible|motorcycle|scooter|moped|box truck|dump truck|tractor trailer|u-?haul|livery|taxi|rideshare)\b/i;
const OCC = /\b(?:(one|two|three|four|five|1|2|3|4|5)\s+(?:occupants?|inside|in the (?:car|vehicle)|up|parties))\b/i;
const NUM = { one: 1, two: 2, three: 3, four: 4, five: 5 };

// A stop that never says it is clear. Radios get stepped on and units forget,
// so an open record is retired rather than left running, and its length is
// reported as stale so nobody reads it as a measurement.
// How recently a stop has to have been heard from before an unattributed line
// is allowed to join it. Long enough to cover the quiet middle of a stop, short
// enough that a stop nobody has mentioned in a quarter hour stops collecting
// other people's traffic.
const CONTEXT_MS = 10 * 60 * 1000;

const STALE_MS = 45 * 60 * 1000;
const KEEP_MS = 24 * 60 * 60 * 1000;

const disposition = t => { for (const [re, d] of DISPOSITION) if (re.test(t)) return d; return null; };
const kindOf = t => KIND_VEH.test(t) ? 'vehicle' : KIND_PED.test(t) ? 'pedestrian' : 'unknown';

// A colour word on its own is not a car. Blue Hill Avenue, Brown Street and
// Whitefield Road are real Boston streets and every one of them turns up in the
// middle of a stop location, so "out with a vehicle Blue Hill and Talbot" got
// filed as a blue car. The paint is only taken when a make or a body style is
// there to put it on, and then only the colour nearest to it.
function vehicleOf(t) {
  const s = String(t);
  const m = s.match(MAKE), b = s.match(BODY);
  const anchor = m || b;
  if (!anchor) return null;
  let colour = null, best = 1e9;
  const re = new RegExp(COLOUR.source, 'gi');
  let c;
  while ((c = re.exec(s))) {
    const d = Math.abs(c.index - anchor.index);
    if (d < best && d <= 28) { best = d; colour = c[1].toLowerCase().replace('grey', 'gray'); }
  }
  return [colour, m && m[1].toLowerCase(), (!m && b) ? b[1].toLowerCase() : null].filter(Boolean).join(' ') || null;
}
function occupantsOf(t) {
  const m = String(t).match(OCC);
  if (!m) return null;
  return NUM[m[1].toLowerCase()] || parseInt(m[1], 10) || null;
}

// Only the units that work stops. A ladder company is never out with a vehicle,
// and without this a fire feed opens a stop every time Engine 7 goes out at an
// address.
const PATROL = /^(?:C|CAR|U|UNIT|D|K|S|TPR|MC|A)\d{1,4}$|^[A-E]\d{1,2}$/i;

// The callsign shapes are not enough on their own, because they collide across
// services: Engine 17 is E17 and Boston police district E-13 is E13, Boston
// fire Car 7 is CAR7 and a Boston police car is CAR15. A fire department never
// works a stop, so the service the feed declares is the guard. This is the same
// reason the callsign table is keyed "Boston Fire" and "Boston Police" rather
// than "Boston".
const NOT_PATROL_DEPT = /\b(?:fire|ems|emergency medical)\b/i;

/* The department a feed speaks for, service included.

   NOT_PATROL_DEPT above is strict on purpose, and the feed labels coming off
   the Mac app are not: they arrive as "bostonfire", "bostonems", "cambridge",
   "MSP". A word boundary never matches inside "bostonfire", so a fire channel
   would sail straight past the guard and start opening traffic stops on ladder
   companies. The labels get normalised into "<Town> <Service>" once, here, and
   everything downstream reads the canonical form.

   The looseness is not symmetric, because the failure modes are not. "fire" is
   safe as a bare substring since no Massachusetts town contains it. "ems" is
   not, so it is anchored. That is the whole reason this is a function and not
   one regex. */
function deptOf(label, city) {
  const raw = String(label || '').trim();
  if (!raw && !city) return null;
  const s = (raw || String(city)).toLowerCase().replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (/\bmsp\b|massachusetts state|state police|^statepolice$/.test(s)) return 'Massachusetts State Police';
  if (/\bmbta\b|transit police/.test(s)) return 'MBTA Police';
  const svc =
    /fire|\bfd\b|fd$/.test(s) ? 'Fire' :
    /\bems\b|ems$|^ems|emergency medical|ambulance/.test(s) ? 'EMS' :
    /police|\bpd\b|pd$|sheriff|trooper|constab/.test(s) ? 'Police' : null;
  let town = s
    .replace(/fire|police|emergency medical|ambulance|department|dept|scanner|dispatch|channel|feed|\bems\b|ems$|\bfd\b|fd$|\bpd\b|pd$/g, ' ')
    .replace(/\s+/g, ' ').trim();
  // "bpd" strips down to "b", which is not a town. Anything left too short to
  // be a place name is a initialism the label wrote the service into, so the
  // city the feed is filed under is the better answer.
  if (town.length < 3) town = String(city || '').trim().toLowerCase();
  town = town.replace(/\b[a-z]/g, c => c.toUpperCase());
  if (!svc) return town || raw;
  return town ? town + ' ' + svc : svc;
}

/* One shape per callsign. The extractor says "Car 15" on one transmission and
   a later one may come back "Car-15" or "car 15", and a stop that opens under
   one spelling and closes under another is two stops, one of them permanently
   open. The key and the stored callsign are both stripped to letters and
   digits; what was actually said is kept alongside it for display. */
const signOf = u => String(u || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/* opt.retentionDays, when set, drops the identity fields off a stored record
   once it is older than that. Left unset nothing expires. This is a policy
   dial, so it lives in config and not in the code. */
function createStops(opt) {
  opt = opt || {};
  const RETAIN = opt.retentionDays ? opt.retentionDays * 86400000 : null;
  // The street index, when the caller has one. The model is told that a spelled
  // run introduced as a street is a street, and it mostly obeys, but the
  // gazetteer is the thing that actually knows, so anything it recognises as a
  // road never gets filed as a person.
  const isStreet = opt.isStreet || (() => false);
  const open = new Map();          // dept/unit -> record
  let closed = [];                 // most recent first
  let seq = 0;

  // Plate history, for "this car has been stopped three times tonight".
  const byPlate = new Map();       // PLATE -> [stop ids, most recent first]

  const keyOf = (dept, unit) => (dept || '?') + '/' + signOf(unit);

  function retire(rec, now, why) {
    rec.status = why;
    rec.end = rec.end || now;
    // A stop nobody was heard clearing has no length. What is known is the gap
    // between the first and last time it keyed up, and that gets its own name so
    // it never gets averaged in with the stops that were heard from both ends.
    if (why === 'stale') { rec.seconds = null; rec.heardFor = Math.round((rec.last - rec.start) / 1000); }
    else rec.seconds = Math.round((rec.end - rec.start) / 1000);
    open.delete(keyOf(rec.dept, rec.unit));
    closed.unshift(rec);
    closed.sort((a, b) => b.end - a.end);
    const cut = now - KEEP_MS;
    closed = closed.filter(r => r.end > cut).slice(0, 600);
    if (RETAIN) for (const r of closed) if (now - r.end > RETAIN && r.plate) { r.plate = null; r.names = []; r.people = []; r.dob = null; r.licence = null; r.redacted = true; }
    return rec;
  }

  function sweep(now) {
    for (const [, rec] of open) if (now - rec.last > STALE_MS) retire(rec, rec.last, 'stale');
  }

  function link(rec, plate) {
    if (!plate) return;
    rec.plate = rec.plate || plate;
    const prior = byPlate.get(plate) || [];
    rec.repeat = prior.filter(id => id !== rec.id).length + 1;
    rec.priorStops = prior.filter(id => id !== rec.id).slice(0, 5);
    if (!prior.includes(rec.id)) byPlate.set(plate, [rec.id, ...prior].slice(0, 40));
  }

  /* One transmission. ex is the extractor output, geo the resolved fix, said
     the output of spoken.read() on the same text. Returns the stop this
     transmission belongs to, or null. */
  function feed({ dept, feed: source, units, text, time, ex, geo, said }) {
    const now = +(time || new Date());
    sweep(now);
    const t = String(text || '');
    said = said || {};
    if (dept && NOT_PATROL_DEPT.test(dept)) return null;
    const patrol = (units || []).filter(u => PATROL.test(signOf(u)));

    let rec = null;
    for (const u of patrol) { const r = open.get(keyOf(dept, u)); if (r) { rec = r; break; } }

    const says = ex || {};
    const opens = says.isStop === true || OPEN_RE.test(t);
    const records = RECORD_RE.test(t);
    const closes = CLEAR_STRONG.test(t) ||
      ((says.isClear === true || CLEAR_WEAK.test(t)) && !records && !FROM_DISPATCH.test(t));

    // Two readers of the same line. The decoder handles the spelled runs the
    // model sometimes drops; the model handles the phrasings no regular
    // expression will ever cover. Whichever one saw it, the record gets it.
    const P = (said.plates || [])[0] ||
      (looksLikePlate(String(says.plate || '')) ? { plate: says.plate, state: says.plateState || null, via: 'model' } : null);
    /* Surnames and street names are the same words in an old American city.
       Delgado, Sullivan, Bowdoin and Warren are all people and all roads here,
       so running every name past the street index deletes the operator, which
       is the one field the stop record exists to carry.

       The decoder already settles this the narrow way. It checks a spelled run
       against the gazetteer only when nothing introduced it as a name, so
       "Jette, Juliet Edward Tango Tango Echo" stays a street and "operator is
       Michael Delgado" stays a person. Everything arriving in said.names has
       been through that test and is taken as heard.

       What still needs guarding is the model's list, which carries no
       provenance. A model name is kept when the line actually announced one was
       coming, and checked against the street index when it did not. */
    const cued = NAME_CUE_RE.test(t);
    const NAMES = [...new Set([
      ...(said.names || []).map(n => String(n.name || '').trim()).filter(Boolean),
      ...(says.personNames || []).map(n => String(n || '').trim())
        .filter(n => n && (cued || !isStreet(n))),
    ])];
    /* The same names again, with how each one was come by. "Operator is Michael
       Delgado" and "should be Steven Rodriguez" are both names, and a desk
       about to make a phone call needs to know which is which before it does.
       names stays a plain list of strings so nothing downstream has to change;
       this rides alongside it.

       via: spelled, a phonetic spelling on the air. spoken, said plainly after
       something announced a name. inferred, a weak handover like "should be".
       model, the extractor's own reading, which carries no provenance at all.
       heard, when present, is the words as spoken, e.g. "Slag, Joseph". */
    const byName = new Map();
    for (const n of (said.names || [])) {
      const v = String(n.name || '').trim();
      if (v && !byName.has(v)) byName.set(v, { name: v, via: n.via || 'spoken', part: n.part || null, ...(n.heard ? { heard: n.heard } : {}) });
    }
    for (const raw of (says.personNames || [])) {
      const v = String(raw || '').trim();
      if (v && (cued || !isStreet(v)) && !byName.has(v)) byName.set(v, { name: v, via: 'model', part: null });
    }
    const PEOPLE = [...byName.values()];
    const DOB = ((said.dobs || [])[0] || {}).dob || says.dob || null;

    // The middle of a stop is very often said without the callsign. The officer
    // already has the channel, so "operator is Michael Delgado, DOB three
    // fifteen eighty seven, silver Honda" arrives naming nobody, and a tracker
    // that demands a callsign on every line throws away precisely the part of
    // the stop that was worth keeping.
    //
    // So a line that names no unit may still join a stop, on three conditions
    // that together make the attribution safe: exactly one stop is open on that
    // channel, it was heard from inside the last few minutes, and the line
    // actually carries stop content rather than being any other piece of
    // traffic. Anything looser and an unrelated transmission gets filed as
    // somebody's identity, which is the one error here that really matters.
    let viaContext = false;
    if (!rec && !patrol.length) {
      const here = [...open.values()].filter(r => r.feed === source && now - r.last <= CONTEXT_MS);
      if (here.length === 1 && (P || NAMES.length || DOB || (said.licences || []).length ||
          records || disposition(t) || SEARCH_RE.test(t) || BACKUP_RE.test(t) || occupantsOf(t) != null)) {
        rec = here[0];
        viaContext = true;
      }
    }
    if (!rec && !patrol.length) return null;

    if (!rec && opens) {
      rec = {
        id: 's' + now.toString(36) + (seq++),
        unit: signOf(patrol[0]), unitSpoken: String(patrol[0]),
        dept: dept || null, feed: source || null,
        kind: says.stopKind || kindOf(t),
        start: now, last: now, end: null, seconds: null,
        lat: geo && geo.lat, lon: geo && geo.lon,
        place: (geo && geo.matched) || says.address || says.street || says.crossStreet || null,
        precision: geo ? (geo.approx ? 'approx' : (geo.confident ? 'exact' : 'area')) : null,
        plate: P ? P.plate : null, plateState: P ? P.state : null,
        vehicle: says.vehicle || vehicleOf(t),
        occupants: typeof says.occupants === 'number' ? says.occupants : occupantsOf(t),
        names: NAMES,
        people: PEOPLE,
        dob: DOB,
        licence: (said.licences || [])[0] || null,
        backup: BACKUP_RE.test(t), search: SEARCH_RE.test(t), records: records ? 1 : 0,
        disposition: null, repeat: 1, priorStops: [], transmissions: 1,
        transcript: [{ t: now, text: t, feed: source || null }],
        status: 'open',
      };
      link(rec, rec.plate);
      open.set(keyOf(dept, rec.unit), rec);
      return rec;
    }
    if (!rec) return null;

    // Mid stop. Whatever the opener did not carry gets filled in as it is said.
    // A location arriving late is taken, because the opening call very often
    // gives the unit and a later one gives the corner.
    rec.last = now;
    rec.transmissions++;
    // Which lines were heard on the callsign and which were reasoned onto the
    // stop. A desk checking a name before it goes anywhere near print wants to
    // know that difference without listening to the tape.
    if (viaContext) rec.inferred = (rec.inferred || 0) + 1;
    rec.transcript.push({ t: now, text: t, feed: source || null, via: viaContext ? 'context' : 'callsign' });
    if (rec.transcript.length > 40) rec.transcript.splice(0, rec.transcript.length - 40);
    if (geo && typeof geo.lat === 'number' && typeof rec.lat !== 'number') {
      rec.lat = geo.lat; rec.lon = geo.lon;
      rec.place = geo.matched || rec.place;
      rec.precision = geo.approx ? 'approx' : (geo.confident ? 'exact' : 'area');
    }
    if (P && !rec.plate) { rec.plateState = P.state; link(rec, P.plate); }
    if (!rec.vehicle) rec.vehicle = says.vehicle || vehicleOf(t);
    if (rec.occupants == null) rec.occupants = typeof says.occupants === 'number' ? says.occupants : occupantsOf(t);
    if (rec.kind === 'unknown') rec.kind = says.stopKind || kindOf(t);
    for (const n of NAMES) if (!rec.names.includes(n)) rec.names.push(n);
    // Hydrated records from before this field existed have no people array.
    if (!rec.people) rec.people = rec.names.map(n => ({ name: n, via: 'spoken', part: null }));
    for (const p of PEOPLE) if (!rec.people.some(q => q.name === p.name)) rec.people.push(p);
    if (!rec.dob && DOB) rec.dob = DOB;
    if (!rec.licence && (said.licences || []).length) rec.licence = said.licences[0];
    if (BACKUP_RE.test(t) || says.backupRequested) rec.backup = true;
    if (SEARCH_RE.test(t) || says.searchConducted) rec.search = true;
    if (records) rec.records++;
    const d = says.disposition || disposition(t);
    if (d) rec.disposition = d;

    if (closes) { rec.end = now; return retire(rec, now, 'closed'); }
    return rec;
  }

  function list(now) {
    sweep(+(now || new Date()));
    return { open: [...open.values()].sort((a, b) => b.start - a.start), closed: closed.slice(0, 300) };
  }

  function forPlate(plate) {
    const ids = byPlate.get(String(plate || '').toUpperCase()) || [];
    const all = [...open.values(), ...closed];
    return ids.map(id => all.find(r => r.id === id)).filter(Boolean);
  }

  /* The shape of the night rather than one line at a time, which is what a desk
     actually looks at first. */
  function summary(now, windowMs) {
    now = +(now || new Date());
    const since = now - (windowMs || 12 * 3600000);
    const rows = closed.filter(r => r.end > since);
    // Durations come only from the stops that were heard from both ends. A
    // stale record has a start and no finish, and folding its zero into the
    // median would quietly report every night as shorter than it was.
    const heard = rows.filter(r => r.status === 'closed');
    const secs = heard.map(r => r.seconds).filter(n => typeof n === 'number').sort((a, b) => a - b);
    const by = k => rows.reduce((a, r) => { const v = r[k] || 'unknown'; a[v] = (a[v] || 0) + 1; return a; }, {});
    return {
      window: windowMs || 12 * 3600000,
      total: rows.length, openNow: open.size, stale: rows.length - heard.length,
      medianSeconds: secs.length ? secs[Math.floor(secs.length / 2)] : null,
      p90Seconds: secs.length ? secs[Math.floor(secs.length * 0.9)] : null,
      longest: heard.reduce((a, r) => (r.seconds || 0) > (a ? a.seconds : -1) ? r : a, null),
      byKind: by('kind'),
      byDisposition: rows.reduce((a, r) => { const v = r.disposition || (r.status === 'stale' ? 'never cleared' : 'none given'); a[v] = (a[v] || 0) + 1; return a; }, {}),
      byDept: by('dept'),
      withBackup: rows.filter(r => r.backup).length,
      withSearch: rows.filter(r => r.search).length,
      withPlate: rows.filter(r => r.plate).length,
      repeatVehicles: rows.filter(r => r.repeat > 1).length,
      located: rows.filter(r => typeof r.lat === 'number').length,
    };
  }

  /* ---- persistence ------------------------------------------------------
     The Mac kept this in one long-lived process. Vercel gives every request a
     fresh one, so the whole tracker is loaded, fed and written back each time.
     A stop is the one structure here that has to survive that round trip
     intact, because the only thing that makes it worth anything is that it was
     opened by one request and closed by another twenty minutes later.

     Everything comes out as plain JSON. The two Maps do not survive
     JSON.stringify, so open goes out as a list and is re-keyed on the way back
     in, and the plate index goes out as pairs. */
  function dump() {
    return { v: 1, open: [...open.values()], closed, byPlate: [...byPlate.entries()], seq };
  }
  function hydrate(state) {
    if (!state || typeof state !== 'object') return;
    open.clear();
    for (const rec of (state.open || [])) open.set(keyOf(rec.dept, rec.unit), rec);
    closed = Array.isArray(state.closed) ? state.closed : [];
    byPlate.clear();
    for (const [p, ids] of (state.byPlate || [])) byPlate.set(p, ids);
    // Ids are already in the browser, so the counter can go forward and never
    // back.
    seq = Math.max(Number(state.seq) || 0, seq);
  }

  return { feed, list, summary, forPlate, dump, hydrate, _open: open, _byPlate: byPlate };
}

module.exports = { createStops, deptOf, signOf, OPEN_RE, CLOSE_RE, CLEAR_STRONG, CLEAR_WEAK, FROM_DISPATCH, BACKUP_RE, SEARCH_RE, RECORD_RE, disposition, kindOf, vehicleOf, occupantsOf, PATROL, NOT_PATROL_DEPT };
