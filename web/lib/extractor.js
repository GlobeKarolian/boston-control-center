// lib/extractor.js
// Turns one short radio transmission into structured fields.
//
// Measured on 150 live transmissions: 114 of them produced no location field
// at all. That is where three quarters of the empty map came from, and this
// file is the half of the fix that lives before the geocoder.
//
// What changed:
//   1. A bare street name is now a field. The old schema only accepted a
//      numbered address, so "we're on Boylston heading up" was thrown away.
//      A street centroid is a real answer when the whole block is the story.
//   2. A town is now a field. A regional feed that says "Braintree" out loud
//      is placeable; before, every transmission on that feed was geocoded
//      against one default city.
//   3. Obvious noise never reaches the model. Whisper fills silence with
//      "Thank you." and "Subtitles by the Amara.org community", and every one
//      of those was a paid API call that came back empty or, worse, invented
//      a landmark out of it.
//   4. A landmark the model returns has to actually appear in the transcript.
//      Live traffic produced "Quantum gardens", "Air Life" and "CPA collection
//      window" as landmarks. Those are transcription noise wearing a place
//      name, and a pin drawn from one is a lie told confidently.
//   5. The literal string "null" no longer passes as a value. It was reaching
//      the geocoder and being searched for.
//   6. The model can see the last few transmissions from the same feed, so a
//      follow-up can carry the address of the call it belongs to. Anything
//      inherited that way is flagged, never silently merged.
//
// Differences from the Mac version:
//   1. The key comes from process.env.ANTHROPIC_API_KEY only. There is no
//      key file to read here.
//   2. The circuit breaker is per-invocation, not per-process. On Vercel a
//      "process" may serve one request or a hundred, so a module-level
//      cooldown would either do nothing or punish a warm container for a
//      failure it never saw. Each extractBatch() call gets its own breaker:
//      if the API is down, the first item in the batch discovers it and the
//      rest of that batch go straight to regex instead of waiting 20s each.

const MODEL = process.env.EXTRACT_MODEL || 'claude-haiku-4-5';
const KEY = () => (process.env.ANTHROPIC_API_KEY || '').trim();

/* OpenRouter is the model layer now. One key, one bill, one dashboard where
   the spend cap lives, and the model behind any role is a config change
   rather than a code change. When OPENROUTER_API_KEY is set it takes
   priority; the Anthropic path below survives untouched as the fallback for
   a key-less deploy, and regex remains the floor under everything.

   Two model slots, because a gateway with one model is a single point of
   wrong: the primary is the cheap flash tier that handles structured
   extraction fine, and the fallback is a different family entirely, so a
   bad slug, a deprecation, or one provider's outage degrades to the second
   opinion instead of to regex. */
const llmlog = require('./llmlog');
const OR_KEY = () => (process.env.OPENROUTER_API_KEY || '').trim();
/* Ling first, DeepSeek second, decided by a stopwatch rather than a brand:
   in live testing DeepSeek's flash burned the whole 20-second budget without
   answering, and extraction is a labeling task a small plain model does fine.
   The order swaps back with two env vars the day the measurements change. */
const OR_MODEL = process.env.EXTRACT_MODEL_OR || 'inclusionai/ling-2.6-flash';
/* The fallback is deliberately a PLAIN model. The whole flash tier went
   reasoning-first in mid-2026, and a reasoner given a small budget spends
   all of it thinking and returns empty content, which is exactly how the
   first live test produced "unparseable reply" twice. The primary gets
   reasoning switched off below; the fallback is one of the few models with
   no reasoning to switch off, so the failure modes stay different, which is
   the entire point of having a fallback. */
const OR_FALLBACK = process.env.EXTRACT_MODEL_OR2 || 'deepseek/deepseek-v4-flash-0731';

/* The daily budget, learned the hard way: the account ran its whole credit
   balance dry in ten days and the board spent an evening on regex without
   anyone deciding that. The editor's ceiling is $100 a month for everything,
   so the model spend gets a hard daily allowance and the fallback ladder gets
   one more rung: over budget goes to regex exactly like the API being down,
   loudly labelled, instead of a silent 400 at the end of the month.

   Counted in Redis so every warm container shares one meter. One INCRBY per
   POST, not per item. Fail-open on a meter error, because Redis being down
   already means the board is down, and a broken meter should not be the thing
   that silences a working radio. */
const EXTRACT_DAILY_CAP = Math.max(0, parseInt(process.env.EXTRACT_DAILY_CAP || '500', 10) || 500);
async function extractAllowance(want) {
  if (!want) return 0;
  try {
    const kv = require('./kv');
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const key = 'bcc:spend:extract:' + day;
    const [n] = await kv.raw([['INCRBY', key, want], ['EXPIRE', key, 172800]], 5000);
    const used = Number(n) || 0;
    return Math.max(0, Math.min(want, EXTRACT_DAILY_CAP - (used - want)));
  } catch (e) {
    return want;
  }
}

// The stop phrasing lives in one place. The regex fallback path uses the same
// patterns the stop tracker does, so a night when the API is down still gets
// stops, and the two never drift apart into two different ideas of what "clear"
// means.
const ST_ = require('./stops.js');
// The spelled-out decoder, used here only to ask whether a line carries a
// plate or a name at all. See carriesFact below.
let SP_ = null;
try { SP_ = require('./spoken.js'); } catch (e) { /* older deploy */ }

const SCHEMA = {
  type: 'object',
  properties: {
    units: { type: 'array', items: { type: 'string' }, description: 'Unit call signs mentioned, e.g. E7, L4, C3, A1. Empty array if none.' },
    call_type: { type: 'string', description: 'Short incident type: fire, medical, mva, alarm, assault, traffic stop, water flow, investigation, etc. Null if unclear.' },
    address: { type: 'string', description: 'Street address WITH a house number, e.g. "123 Main St". Null if no number is spoken.' },
    street: { type: 'string', description: 'Street or road name spoken without a house number, e.g. "Boylston", "Route 9", "Blue Hill Ave". Use this whenever a street is named but no number is given. Null otherwise.' },
    town: { type: 'string', description: 'City, town or Boston neighbourhood named in this transmission, e.g. "Quincy", "Dorchester", "Somerville". Only if actually spoken. Null otherwise.' },
    landmark: { type: 'string', description: 'Named place if spoken, e.g. "Fenway Park", "Mass General", "Harvard Square". It must be a real place a Boston dispatcher would name. Null otherwise.' },
    cross_street: { type: 'string', description: 'Intersection if spoken, e.g. "Boylston and Mass Ave". Null otherwise.' },
    location_from_context: { type: 'boolean', description: 'True only if the location fields were carried over from the earlier transmissions shown as context rather than spoken in this one.' },
    is_clear: { type: 'boolean', description: 'True only if a unit says IT is clearing, in service or available. False when the word "clear" is part of a records answer such as "comes back clear and valid".' },
    is_on_scene: { type: 'boolean', description: 'True if this transmission says a unit has arrived or is on scene.' },

    // A stop is its own kind of event, with a length and an outcome rather than
    // a growing scene, so it gets its own fields rather than being squeezed
    // into call_type. See lib/stops.js for what is done with them.
    is_stop: { type: 'boolean', description: 'True if this transmission is a unit initiating or working a stop of a vehicle or a person: "out with", "off with", car stop, MV stop, traffic stop, pulled over, flagged down.' },
    stop_kind: { type: 'string', enum: ['vehicle', 'pedestrian', 'building', 'unknown'], description: 'What was stopped. Null unless this is a stop.' },
    vehicle: { type: 'string', description: 'Vehicle description as spoken, e.g. "silver Honda Accord", "black pickup", "grey Nissan sedan". Null if no vehicle is described.' },
    occupants: { type: 'integer', description: 'How many people are in the stopped vehicle, if stated, e.g. "two up" is 2. Null if not stated.' },
    disposition: { type: 'string', enum: ['arrest', 'summons', 'citation', 'warning', 'tow', 'no action'], description: 'How the stop ended, if this transmission says. Null otherwise.' },
    backup_requested: { type: 'boolean', description: 'True if this transmission asks for another unit or expedites one.' },
    search_conducted: { type: 'boolean', description: 'True if an exit order, pat frisk, consent search, vehicle or trunk search, or a K9 is mentioned.' },

    // Public information, spoken on a public channel, recorded by a newsroom.
    person_names: { type: 'array', items: { type: 'string' }, description: 'Every person named in this transmission, as spoken. Include names spelled letter by letter, decoded back into the name they spell. Empty array if none.' },
    plate: { type: 'string', description: 'Vehicle registration as letters and digits, with any phonetic spelling decoded: "Adam Boy Charles one two three" is ABC123. Null if no registration is given.' },
    plate_state: { type: 'string', description: 'Two letter state of the registration if one is named, e.g. MA, NH, RI. Null otherwise.' },
    dob: { type: 'string', description: 'Date of birth if one is given, e.g. "3/15/1987". Null otherwise.' },
    priority: { type: 'string', enum: ['low', 'normal', 'high'], description: 'high for working fire, shots fired, serious injury, mass casualty. low for routine or administrative.' },
    speaker_role: { type: 'string', enum: ['dispatch', 'field', 'unknown'], description: 'Who is talking.' },
    noise: { type: 'boolean', description: 'True if this transcript is not real radio traffic: silence artifacts, music, a stray word, or speech too garbled to mean anything.' },
  },
  required: ['units', 'is_clear', 'is_on_scene'],
};

const SYSTEM = [
  'You parse public safety radio traffic into structured fields.',
  'The input is an automatic speech transcript of a single short radio transmission from the Boston area. It will contain transcription errors.',
  'Extract only what is actually said. Prefer null over a guess. Never invent an address, a unit, a place or a call type.',
  'A landmark must be a place that genuinely exists in eastern Massachusetts and must be recognisable in the transcript. If a phrase merely sounds like it could be a place, it is not a landmark, it is a transcription error. Return null.',
  'If a street is named with no house number, put it in street, not address. This is common and useful, so do not discard it.',
  'Unit call signs are letters plus digits: E7 (engine), L4 (ladder), C3 (chief), A1 (ambulance), R1 (rescue), squad, tower. Normalize "engine seven" to E7.',
  'If the transmission is a dispatcher assigning a call, speaker_role is dispatch. If it is a unit reporting, it is field.',
  'Earlier transmissions from the same channel may be shown as context. They are background only. Fields must come from the current transmission, with one exception: if the current transmission is plainly a follow-up on a call named in the context (same unit, or an immediate reply), you may carry that call\'s location forward and must then set location_from_context true.',
  'A stop is a unit out with a vehicle or a person. It opens with "out with", "off with", "car stop", "MV stop", "traffic stop", "pulling over" or "flagged down", and it ends when the same unit says it is clear or back in service. Set is_stop true on the opening transmission and on every later transmission that belongs to the same stop.',
  'The word "clear" does two jobs on a police channel. "Car 15 clear" is a unit going back in service, so is_clear is true. "That plate comes back clear and valid" and "no warrants, he is clear" are answers to a records check and the unit is still working the stop, so is_clear is false.',
  'Letters are spelled on the air in the APCO phonetic alphabet: Adam Boy Charles David Edward Frank George Henry Ida John King Lincoln Mary Nora Ocean Paul Queen Robert Sam Tom Union Victor William Xray Young Zebra. Decode any spelled run back into the letters it spells. "Massachusetts Adam Boy Charles one two three" is plate ABC123 in state MA. "Last name Sam Mary Ida Tom Henry" is the name SMITH.',
  'Officers spell street names exactly the way they spell surnames. If a spelled run is introduced as a street, or is followed by a street type word, or is joined to another street by "and" or "off of", it is a street and belongs in street or cross_street. It is never a person.',
  'Names, registrations and dates of birth spoken on a public safety channel are public information and this is a newsroom system of record. Report them exactly as spoken. Do not omit them, mask them, abbreviate them or replace them with a placeholder.',
].join(' ');

// ---------------------------------------------------------------- noise gate

// Whisper does not return nothing when it hears nothing. It returns the most
// probable thing a human might say, which on a quiet channel is one of these.
// Every one of them used to cost an API call and could come back with an
// invented landmark attached.
const HALLUCINATION = [
  'thank you', 'thanks for watching', 'thank you for watching', 'thanks', 'you', 'bye', 'bye bye',
  'subtitles by the amara org community', 'subtitles by', 'transcription by', 'transcribed by',
  'please subscribe', 'like and subscribe', 'music', 'applause', 'silence', 'blank audio',
  'the end', 'to be continued', 'okay', 'ok', 'yeah', 'yep', 'uh', 'um', 'hmm', 'mm hmm',
  'all right', 'alright', 'hello', 'hi', 'copy', 'copy that', 'go ahead',
];
const HSET = new Set(HALLUCINATION);

const flat = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/* Is this worth a paid call? Cheap, deliberately conservative: anything that
   might be real traffic passes. "copy that" is dropped as a whole utterance
   but never when it carries anything else with it. */
function isNoise(text) {
  const f = flat(text);
  if (!f) return true;
  if (f.length < 6) return true;
  if (HSET.has(f)) return true;
  const words = f.split(' ');
  if (words.length < 3 && !/\d/.test(f)) return true;
  // one word repeated: "go go go go", a stuck transmit key
  if (new Set(words).size === 1 && words.length > 1) return true;
  return false;
}

// ---------------------------------------------------------------- regex path

const UNIT_RE = /\b(?:(?:engine|ladder|tower|rescue|squad|car|unit|ambulance|medic|chief|district|division|truck)\s*(\d{1,3})|([ELCARDMTS])\s?-?\s?(\d{1,3}))\b/gi;
const LETTER_FOR = { engine: 'E', ladder: 'L', tower: 'T', rescue: 'R', squad: 'S', car: 'C', unit: 'U', ambulance: 'A', medic: 'M', chief: 'C', district: 'D', division: 'D', truck: 'L' };

const CLEAR_RE = /\b(clear(?:ing|ed)?|in service|available|back in service|returning|cancel(?:led|ling)?|disregard|no further)\b/i;
const ONSCENE_RE = /\b(on scene|on the scene|arriv(?:ed|ing)|out at|out on|assuming command|(?:est|establish)\w* command)\b/i;
const DISPATCH_RE = /\b(respond(?:ing)?\s+to|proceed to|box \d+|still alarm|(?:engine|ladder|car|unit|ambulance)\s+\d+\s*,?\s*(?:respond|take|handle))\b/i;
const FIELD_RE = /\b(we(?:'re| are)|I(?:'m| am)|show us|put us|we have|we need|advise|be advised)\b/i;

const CALL_TYPES = [
  [/\bworking fire|\bfully involved|\bstructure fire|\b2nd alarm|\bsecond alarm|\bthird alarm/i, 'structure fire', 'high'],
  [/\bshots? fired|\bgun\b|\bshooting|\bstabbing|\barmed\b/i, 'weapons', 'high'],
  [/\bcardiac|\bnot breathing|\bunresponsive|\bCPR\b|\bcode\b/i, 'medical - serious', 'high'],
  [/\bmva\b|\bmvc\b|\bcar (?:accident|crash)|\bcollision|\bstruck by|\bpedestrian struck/i, 'mva', 'normal'],
  [/\bfire alarm|\bmaster box|\bsmoke detector|\balarm (?:sounding|activation)/i, 'alarm', 'low'],
  [/\bwater flow|\bsprinkler/i, 'water flow', 'low'],
  [/\bmedical|\bems\b|\bambulance|\bsick (?:party|person)|\binjur/i, 'medical', 'normal'],
  [/\bsmoke\b|\bodor of smoke|\bburning/i, 'smoke investigation', 'normal'],
  [/\btraffic stop|\bmotor vehicle stop|\bplate\b/i, 'traffic stop', 'low'],
  [/\bassault|\bfight|\bdisturbance|\bdomestic/i, 'disturbance', 'normal'],
  [/\bwires? down|\btree down|\bpole\b/i, 'hazard', 'normal'],
  [/\bgas leak|\bodor of gas|\bcarbon monoxide|\bCO detector/i, 'gas / CO', 'high'],
  [/\bwell.?being|\bcheck (?:the )?welfare/i, 'well-being check', 'low'],
  [/\blockout|\bassist(?:ance)? (?:citizen|invalid)/i, 'service call', 'low'],
];

const ST = '(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|place|pl|court|ct|terrace|ter|way|circle|cir|square|sq|parkway|pkwy|highway|hwy|row|path|park)';
const ADDR_RE = new RegExp('\\b(\\d{1,5})\\s+([A-Z][A-Za-z\'.-]*(?:\\s+[A-Z][A-Za-z\'.-]*){0,3}\\s+' + ST + ')\\b', 'i');
const CROSS_RE = new RegExp('\\b([A-Z][A-Za-z\'.-]*(?:\\s+[A-Z][A-Za-z\'.-]*){0,2}(?:\\s+' + ST + ')?)\\s+(?:and|at|&)\\s+([A-Z][A-Za-z\'.-]*(?:\\s+[A-Z][A-Za-z\'.-]*){0,2}(?:\\s+' + ST + ')?)\\b', 'i');
// A street named with no number in front of it. The negative lookbehind keeps
// this from firing on the tail of a real address the line above already caught.
const STREET_RE = new RegExp('(?:^|[^0-9]\\s)([A-Z][A-Za-z\'.-]{2,}(?:\\s+[A-Z][A-Za-z\'.-]*){0,2}\\s+' + ST + ')\\b');
const ROUTE_RE = /\b((?:route|rt\.?|interstate|i)[\s-]?(\d{1,3})|(\d{1,3})\s*(?:north|south|east|west)bound)\b/i;

function roleFor(text) {
  if (DISPATCH_RE.test(text)) return 'dispatch';
  if (FIELD_RE.test(text)) return 'field';
  return 'unknown';
}

function regexExtract(text, feedSrc) {
  const t = String(text || '');
  const units = [];
  let m;
  UNIT_RE.lastIndex = 0;
  while ((m = UNIT_RE.exec(t))) {
    if (m[1]) {
      const word = m[0].split(/\s+/)[0].toLowerCase();
      const letter = LETTER_FOR[word] || 'U';
      units.push(letter + parseInt(m[1], 10));
    } else if (m[3]) {
      units.push(m[2].toUpperCase() + parseInt(m[3], 10));
    }
  }
  let callType = null, priority = 'normal';
  for (const [re, name, pri] of CALL_TYPES) {
    if (re.test(t)) { callType = name; priority = pri; break; }
  }
  const a = ADDR_RE.exec(t);
  let cross = null, street = null, town = null;
  if (!a) {
    const c = CROSS_RE.exec(t);
    if (c) cross = c[1] + ' & ' + c[2];
    else {
      const s = STREET_RE.exec(t);
      if (s) street = s[1].trim();
      else { const r = ROUTE_RE.exec(t); if (r) street = r[0].trim(); }
    }
  }
  /* Infer the town from the feed when the transmission does not name one.
     A boston-police transmission is in Boston; cambridge-ma-police is in
     Cambridge. This is the single biggest geocoding win: most transmissions
     never say their city, but the feed always knows. */
  if (!town && feedSrc) {
    const src = String(feedSrc).toLowerCase();
    if (src.includes('boston')) town = 'Boston';
    else if (src.includes('cambridge')) town = 'Cambridge';
    else if (src.includes('somerville')) town = 'Somerville';
    else if (src.includes('brookline')) town = 'Brookline';
    else if (src.includes('needham')) town = 'Needham';
    else if (src.includes('melrose')) town = 'Melrose';
    else if (src.includes('lowell')) town = 'Lowell';
    else if (src.includes('quincy')) town = 'Quincy';
    else if (src.includes('newton')) town = 'Newton';
    else if (src.includes('waltham')) town = 'Waltham';
    else if (src.includes('medford')) town = 'Medford';
    else if (src.includes('malden')) town = 'Malden';
    else if (src.includes('everett')) town = 'Everett';
    else if (src.includes('revere')) town = 'Revere';
    else if (src.includes('chelsea')) town = 'Chelsea';
    else if (src.includes('winthrop')) town = 'Winthrop';
    else if (src.includes('mbta') || src.includes('transit')) town = 'Boston';
    else if (src.includes('state') || src.includes('mass')) town = null; // state police could be anywhere
    else if (src.includes('mit')) town = 'Cambridge';
  }
  const isStop = ST_.OPEN_RE.test(t);
  return {
    units: [...new Set(units)],
    callType,
    address: a ? (a[1] + ' ' + a[2]) : null,
    street,
    town,
    landmark: null,
    crossStreet: cross,
    fromContext: false,
    // "Comes back clear and valid" is a records answer, not a unit going back in
    // service, and reading it as one releases the unit from its own call.
    isClear: ST_.CLEAR_STRONG.test(t) || (CLEAR_RE.test(t) && !ST_.RECORD_RE.test(t) && !ST_.FROM_DISPATCH.test(t)),
    isOnScene: ONSCENE_RE.test(t),
    priority,
    role: roleFor(t),
    isStop,
    stopKind: isStop ? ST_.kindOf(t) : null,
    vehicle: ST_.vehicleOf(t),
    occupants: ST_.occupantsOf(t),
    disposition: ST_.disposition(t),
    backupRequested: ST_.BACKUP_RE.test(t),
    searchConducted: ST_.SEARCH_RE.test(t),
    personNames: [],
    plate: null,
    plateState: null,
    dob: null,
    _by: 'regex',
  };
}

// ---------------------------------------------------------------- cloud path

// The model returns the string "null" often enough that live traffic showed
// rows reading "null | null | null" on the map diagnostic. It also returns
// "unknown" and "n/a". None of those are places.
const NOTHING = new Set(['null', 'none', 'n/a', 'na', 'unknown', 'unclear', 'not specified', 'not given', 'undefined']);
function clean(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (NOTHING.has(s.toLowerCase())) return null;
  return s;
}

/* Did the model actually hear this place, or did it decorate a garbled word?
   A real landmark leaves most of its letters in the transcript. "Fenway Park"
   survives "over at Fenway"; "Quantum gardens" survives nothing. The test is
   deliberately loose: any significant word of the name appearing in the text
   is enough, because Whisper mangles the rest. */
function heardIn(name, text) {
  const n = flat(name), t = flat(text);
  if (!n) return false;
  if (t.includes(n)) return true;
  const words = n.split(' ').filter(w => w.length > 3 && !['the', 'and', 'park', 'street', 'square', 'hospital', 'center', 'centre', 'avenue', 'road'].includes(w));
  if (!words.length) return t.includes(n.split(' ')[0]);
  return words.some(w => t.includes(w));
}

/* A house number with a street type behind it. Deliberately narrower than the
   address extractor, because this is asked of lines the model has already
   judged unusable, where a loose pattern would be reading tea leaves. */
const HOUSE_RE = /\b\d{1,5}\s+[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?\s*(?:street|st\b|ave|avenue|road|rd\b|drive|dr\b|boulevard|blvd|way|place|pl\b|square|sq\b|lane|ln\b|court|ct\b|terrace|ter\b|park|highway|hwy)/i;

/* Does this line carry a fact strong enough to stand up on its own, whatever
   the model made of the rest of it?

   Measured on 150 consecutive real transmissions: the model marked 66 of them
   noise, and the cheap gate above would have kept every one. Among the 66 were
   a welfare call naming Slag, Joseph, a plate read as five Julie Harry X-ray
   one two, a dispatch to 202 Harvard Ave and another to 1333 Boylston. Those
   are exactly the facts this newsroom asked to have logged, thrown away one
   step before the code that can read them. The model is not wrong that the
   audio is a mess; it is wrong that a mess with a plate in it is nothing.

   Only facts that carry their own evidence count. A bare callsign match does
   not, because "Hello, I'm 22. I'm 22." reads as unit M22. A bare call type
   does not, because "Code 9, please." reads as a serious medical. The cross
   street regex is worse than either, having offered "in the text and it went
   to" as an intersection. So the test is a spelled plate or name, which the
   decoder already gates hard, a numbered address, a stop opening, a records
   answer, or a callsign and a call type together. On the same 150 that rescues
   4 and leaves 62 as noise, and all four are real. */
function carriesFact(src, feedSrc) {
  try {
    if (SP_ && SP_.read(src).any) return true;
    if (HOUSE_RE.test(src)) return true;
    if (ST_.OPEN_RE.test(src) || ST_.RECORD_RE.test(src)) return true;
    const R = regexExtract(src, feedSrc);
    if (R.address) return true;
    if (R.units && R.units.length && R.callType) return true;
  } catch (e) { /* never let the rescue itself break extraction */ }
  return false;
}

function mapFields(o, by, text, feedSrc) {
  const src = String(text || '');
  let landmark = clean(o.landmark);
  let hallucinated = false;
  // A landmark nobody said is worse than no landmark. It draws a confident pin
  // in a place where nothing happened.
  if (landmark && !heardIn(landmark, src)) { hallucinated = true; landmark = null; }
  /* The model does not know which feed it is reading. The town it names is a
     guess from the transcript alone; the feed source is a fact. When the two
     disagree, the feed wins. */
  let town = clean(o.town);
  if (!town && feedSrc) {
    const f = String(feedSrc).toLowerCase();
    if (f.includes('boston')) town = 'Boston';
    else if (f.includes('cambridge')) town = 'Cambridge';
    else if (f.includes('somerville')) town = 'Somerville';
    else if (f.includes('brookline')) town = 'Brookline';
    else if (f.includes('needham')) town = 'Needham';
    else if (f.includes('melrose')) town = 'Melrose';
    else if (f.includes('lowell')) town = 'Lowell';
    else if (f.includes('quincy')) town = 'Quincy';
    else if (f.includes('newton')) town = 'Newton';
    else if (f.includes('waltham')) town = 'Waltham';
    else if (f.includes('medford')) town = 'Medford';
    else if (f.includes('malden')) town = 'Malden';
    else if (f.includes('everett')) town = 'Everett';
    else if (f.includes('revere')) town = 'Revere';
    else if (f.includes('chelsea')) town = 'Chelsea';
    else if (f.includes('winthrop')) town = 'Winthrop';
    else if (f.includes('mbta') || f.includes('transit')) town = 'Boston';
    else if (f.includes('state') || f.includes('mass')) town = null;
    else if (f.includes('mit')) town = 'Cambridge';
  }
  return {
    units: Array.isArray(o.units) ? o.units.map(u => String(u).toUpperCase().replace(/[\s-]/g, '')).filter(Boolean) : [],
    callType: clean(o.call_type),
    address: clean(o.address),
    street: clean(o.street),
    town,
    landmark,
    crossStreet: clean(o.cross_street),
    fromContext: !!o.location_from_context,
    // Even with the rule spelled out in the system prompt, a records answer
    // sometimes comes back is_clear true. The guard is cheap and the cost of
    // being wrong is a stop that reports one minute instead of twenty.
    isClear: !!o.is_clear && !ST_.RECORD_RE.test(src),
    isOnScene: !!o.is_on_scene,
    priority: o.priority || 'normal',
    role: o.speaker_role || 'unknown',
    // The model's noise call is a judgement about the audio, and it is
    // overruled by anything in the line that speaks for itself.
    noise: !!o.noise && !carriesFact(src, o._feedSrc),
    isStop: !!o.is_stop || ST_.OPEN_RE.test(src),
    stopKind: clean(o.stop_kind),
    vehicle: clean(o.vehicle) || ST_.vehicleOf(src),
    occupants: typeof o.occupants === 'number' ? o.occupants : ST_.occupantsOf(src),
    disposition: clean(o.disposition) || ST_.disposition(src),
    backupRequested: !!o.backup_requested || ST_.BACKUP_RE.test(src),
    searchConducted: !!o.search_conducted || ST_.SEARCH_RE.test(src),
    personNames: Array.isArray(o.person_names) ? o.person_names.map(clean).filter(Boolean) : [],
    plate: clean(o.plate) ? String(clean(o.plate)).toUpperCase().replace(/[^A-Z0-9]/g, '') : null,
    plateState: clean(o.plate_state) ? String(clean(o.plate_state)).toUpperCase().slice(0, 2) : null,
    dob: clean(o.dob),
    _by: by,
    _hallucinated: hallucinated || undefined,
  };
}

// Two or three recent lines from the same channel, oldest first. Enough for a
// follow-up to find its call, short enough not to drag an unrelated incident
// in behind it.
function contextBlock(prior) {
  if (!prior || !prior.length) return '';
  return 'Earlier on this channel (background only, oldest first):\n' +
    prior.slice(-3).map(p => '- ' + String(p).slice(0, 220)).join('\n') + '\n\n';
}

async function callAnthropic(text, timeoutMs, prior, feedSrc) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': KEY(),
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 512,
      system: SYSTEM,
      tools: [{ name: 'record_call', description: 'Record the structured content of one radio transmission.', input_schema: SCHEMA }],
      tool_choice: { type: 'tool', name: 'record_call' },
      messages: [{ role: 'user', content: contextBlock(prior) + 'Current transmission transcript:\n\n' + String(text).slice(0, 4000) }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error('anthropic ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  const use = (j.content || []).find(c => c.type === 'tool_use');
  if (!use || !use.input) throw new Error('anthropic: no tool_use in response');
  return mapFields(use.input, 'cloud', text, feedSrc);
}

/* The same extraction through OpenRouter's OpenAI-shaped endpoint. No tool
   forcing here: the schema rides in the prompt and the reply is constrained
   to a JSON object, which the flash tier honors reliably and mapFields
   validates anyway, so a model that drifts off schema produces a retry and
   then a regex row, never a corrupt one. A failed primary retries once on
   the fallback model before giving up, so one dead slug or one provider
   outage costs latency, not the batch. */
async function callOpenRouter(text, timeoutMs, prior, modelId, priorErr, feedSrc) {
  const model = modelId || OR_MODEL;
  const began = Date.now();
  const fail = (why) => {
    const msg = 'openrouter ' + model + ': ' + why;
    llmlog.record('extract', { model, ms: Date.now() - began, ok: false, why });
    if (!modelId) return callOpenRouter(text, timeoutMs, prior, OR_FALLBACK, msg, feedSrc);
    throw new Error((priorErr ? priorErr + ' ; then ' : '') + msg);
  };
  /* The timeout is a failure like any other. Unwrapped, an AbortError flew
     past the fallback and landed the whole batch on regex, which is how a
     slow primary silently cost the archive its call types. */
  let r;
  try {
    r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + OR_KEY(),
      'http-referer': 'https://www.scan.boston',
      'x-title': 'Boston Newsroom Control Center',
    },
    body: JSON.stringify({
      model,
      /* Room to answer even if the provider reasons anyway, and an explicit
         request not to. exclude keeps any thinking that happens regardless
         out of the content field. */
      max_tokens: 2000,
      temperature: 0,
      reasoning: { enabled: false, exclude: true },
      provider: { sort: 'latency' },
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system',
          content: SYSTEM + '\n\nReply with ONLY one JSON object, no prose, no code fences, '
            + 'matching this JSON Schema:\n' + JSON.stringify(SCHEMA) },
        { role: 'user', content: contextBlock(prior) + 'Current transmission transcript:\n\n' + String(text).slice(0, 4000) },
      ],
    }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return fail(String((e && e.name === 'TimeoutError') ? 'timeout after ' + timeoutMs + 'ms' : (e && e.message) || e));
  }
  if (!r.ok) return fail('http ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  const msg = (((j.choices || [])[0] || {}).message || {});
  let raw = msg.content;
  if (Array.isArray(raw)) raw = raw.map(p => (p && (p.text || p.content)) || '').join('');
  raw = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (!raw) return fail('empty content (finish: ' + ((j.choices || [])[0] || {}).finish_reason + ')');
  let obj;
  try { obj = JSON.parse(raw); } catch (e) { return fail('unparseable reply ' + raw.slice(0, 120)); }
  const u = j.usage || {};
  llmlog.record('extract', { model, ms: Date.now() - began, ok: true,
    inTok: u.prompt_tokens, outTok: u.completion_tokens });
  return mapFields(obj, 'cloud', text, feedSrc);
}

// Extract a whole batch. Runs concurrently, but the first failure trips a
// breaker shared by the rest of THIS batch so a dead API costs one timeout
// instead of one per item.
//
// `items` may be plain strings, or objects { text, src } so each transmission
// can be shown the last few from its own channel. Mixing channels would be
// worse than no context at all.
async function extractBatch(items, { concurrency = 6, timeoutMs = 20000, priorBySrc = {} } = {}) {
  const rows = items.map(it => (typeof it === 'string' ? { text: it, src: '' } : { text: it.text, src: it.src || '' }));
  const texts = rows.map(r => r.text);
  const out = new Array(rows.length);

  // Running context, seeded with whatever the caller knows about each channel
  // and extended as this batch is processed in arrival order.
  const ctx = {};
  for (const k in priorBySrc) ctx[k] = (priorBySrc[k] || []).slice(-3);
  const priorFor = src => (ctx[src] || []).slice();
  const remember = (src, t) => { (ctx[src] = ctx[src] || []).push(String(t).slice(0, 220)); if (ctx[src].length > 3) ctx[src].shift(); };

  let skipped = 0;
  for (let i = 0; i < rows.length; i++) {
    if (isNoise(rows[i].text)) { out[i] = { ...regexExtract(rows[i].text, rows[i].src), noise: true, _by: 'noise' }; skipped++; }
  }

  if (!OR_KEY() && !KEY()) {
    for (let i = 0; i < rows.length; i++) if (!out[i]) out[i] = regexExtract(texts[i], rows[i].src);
    return { results: out, by: 'regex', errors: ['no OPENROUTER_API_KEY or ANTHROPIC_API_KEY set'], skipped };
  }

  /* The budget rung. Ask the meter for this batch's allowance in one round
     trip; items past the allowance take the regex path and say why. Ordering
     means the freshest transmissions in the batch get the model first. */
  const wantApi = rows.filter((r, i) => !out[i]).length;
  let allow = await extractAllowance(wantApi);
  const errors = [];
  if (allow < wantApi) errors.push('daily extraction budget spent: ' + EXTRACT_DAILY_CAP + ' model calls, regex until midnight UTC');

  let down = false;
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= rows.length) return;
      if (out[i]) continue;                                   // noise, already handled
      const { text, src } = rows[i];
      if (down) { out[i] = regexExtract(text, src); continue; }
      if (allow <= 0) { out[i] = regexExtract(text, src); remember(src, text); continue; }
      allow--;
      const prior = priorFor(src);
      try {
        out[i] = OR_KEY()
          ? await callOpenRouter(text, timeoutMs, prior, undefined, undefined, src)
          : await callAnthropic(text, timeoutMs, prior, src);
      } catch (e) {
        down = true;
        if (errors.length < 3) errors.push(String(e.message || e).slice(0, 200));
        out[i] = regexExtract(text, src);
      }
      remember(src, text);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
  const cloud = out.filter(o => o && o._by === 'cloud').length;
  const scored = out.length - skipped;
  return {
    results: out,
    by: scored === 0 ? 'noise' : (cloud === scored ? 'cloud' : (cloud ? 'mixed' : 'regex')),
    errors,
    skipped,
    hallucinated: out.filter(o => o && o._hallucinated).length,
  };
}

async function extract(text) {
  const { results } = await extractBatch([text]);
  return results[0];
}

// mapFields and carriesFact are exported for the test harness only. Nothing in
// the running app calls them from outside this file.
module.exports = { extract, extractBatch, regexExtract, roleFor, isNoise, heardIn, mapFields, carriesFact, SYSTEM, SCHEMA, MODEL };
