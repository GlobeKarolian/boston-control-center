// lib/extractor.js
// Port of scanner-worker/extractor.js for Vercel.
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

const SCHEMA = {
  type: 'object',
  properties: {
    units: { type: 'array', items: { type: 'string' }, description: 'Unit call signs mentioned, e.g. E7, L4, C3, A1. Empty array if none.' },
    call_type: { type: 'string', description: 'Short incident type: fire, medical, mva, alarm, assault, traffic stop, water flow, investigation, etc. Null if unclear.' },
    address: { type: 'string', description: 'Street address if a specific one is spoken, e.g. "123 Main St". Null otherwise. Do not invent.' },
    landmark: { type: 'string', description: 'Named place if spoken, e.g. "Fenway Park", "Mass General". Null otherwise.' },
    cross_street: { type: 'string', description: 'Intersection if spoken, e.g. "Boylston and Mass Ave". Null otherwise.' },
    is_clear: { type: 'boolean', description: 'True if this transmission says a unit or scene is clearing, in service, or available.' },
    is_on_scene: { type: 'boolean', description: 'True if this transmission says a unit has arrived or is on scene.' },
    priority: { type: 'string', enum: ['low', 'normal', 'high'], description: 'high for working fire, shots fired, serious injury, mass casualty. low for routine or administrative.' },
    speaker_role: { type: 'string', enum: ['dispatch', 'field', 'unknown'], description: 'Who is talking.' },
  },
  required: ['units', 'is_clear', 'is_on_scene'],
};

const SYSTEM = [
  'You transcribe-parse public safety radio traffic into structured fields.',
  'The input is an automatic speech transcript of a single short radio transmission. It will contain errors.',
  'Extract only what is actually said. Prefer null over a guess. Never invent an address, a unit, or a call type.',
  'Unit call signs are letters plus digits: E7 (engine), L4 (ladder), C3 (chief), A1 (ambulance), R1 (rescue), squad, tower. Normalize "engine seven" to E7.',
  'If the transmission is a dispatcher assigning a call, speaker_role is dispatch. If it is a unit reporting, it is field.',
].join(' ');

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

function roleFor(text) {
  if (DISPATCH_RE.test(text)) return 'dispatch';
  if (FIELD_RE.test(text)) return 'field';
  return 'unknown';
}

function regexExtract(text) {
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
  let cross = null;
  if (!a) { const c = CROSS_RE.exec(t); if (c) cross = c[1] + ' & ' + c[2]; }
  return {
    units: [...new Set(units)],
    callType,
    address: a ? (a[1] + ' ' + a[2]) : null,
    landmark: null,
    crossStreet: cross,
    isClear: CLEAR_RE.test(t),
    isOnScene: ONSCENE_RE.test(t),
    priority,
    role: roleFor(t),
    _by: 'regex',
  };
}

// ---------------------------------------------------------------- cloud path

function mapFields(o, by) {
  const nn = v => (v === null || v === undefined || v === '' ? null : v);
  return {
    units: Array.isArray(o.units) ? o.units.map(u => String(u).toUpperCase().replace(/[\s-]/g, '')).filter(Boolean) : [],
    callType: nn(o.call_type),
    address: nn(o.address),
    landmark: nn(o.landmark),
    crossStreet: nn(o.cross_street),
    isClear: !!o.is_clear,
    isOnScene: !!o.is_on_scene,
    priority: o.priority || 'normal',
    role: o.speaker_role || 'unknown',
    _by: by,
  };
}

async function callAnthropic(text, timeoutMs) {
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
      messages: [{ role: 'user', content: 'Radio transmission transcript:\n\n' + String(text).slice(0, 4000) }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error('anthropic ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  const use = (j.content || []).find(c => c.type === 'tool_use');
  if (!use || !use.input) throw new Error('anthropic: no tool_use in response');
  return mapFields(use.input, 'cloud');
}

// Extract a whole batch. Runs concurrently, but the first failure trips a
// breaker shared by the rest of THIS batch so a dead API costs one timeout
// instead of one per item.
async function extractBatch(texts, { concurrency = 6, timeoutMs = 20000 } = {}) {
  const out = new Array(texts.length);
  if (!KEY()) {
    for (let i = 0; i < texts.length; i++) out[i] = regexExtract(texts[i]);
    return { results: out, by: 'regex', errors: ['ANTHROPIC_API_KEY not set'] };
  }
  let down = false;
  const errors = [];
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= texts.length) return;
      if (down) { out[i] = regexExtract(texts[i]); continue; }
      try {
        out[i] = await callAnthropic(texts[i], timeoutMs);
      } catch (e) {
        down = true;
        if (errors.length < 3) errors.push(String(e.message || e).slice(0, 200));
        out[i] = regexExtract(texts[i]);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, texts.length) }, worker));
  const cloud = out.filter(o => o && o._by === 'cloud').length;
  return { results: out, by: cloud === out.length ? 'cloud' : (cloud ? 'mixed' : 'regex'), errors };
}

async function extract(text) {
  const { results } = await extractBatch([text]);
  return results[0];
}

module.exports = { extract, extractBatch, regexExtract, roleFor, MODEL };
