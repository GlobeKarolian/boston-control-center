// lib/spoken.js
// Reads the things that get spelled out loud on the air.
//
// Nobody says a registration as letters and digits. They say "Massachusetts
// Adam Boy Charles one two three", and Whisper writes that out as ordinary
// English words, so a plate arrives in the transcript as six words that look
// like a sentence. Surnames get spelled the same way, letter by letter, every
// time one is passed to a dispatcher. A regular expression over letters and
// digits finds none of this.
//
// So this file is the decoder. A run of phonetic alphabet words and spoken
// digits is read back as the string it spells, and the result is normalised,
// which is the part that makes counting possible: the same plate said once as
// "eight Charles Victor four one nine" and once as "8CV419" has to land on the
// same string or a repeat is invisible.
//
// It also pulls the fields that come through in plain speech and need no
// decoding: dates of birth, licence numbers, phone numbers, and names given
// without spelling.

// -------------------------------------------------------------- phonetics

// APCO, which is what Massachusetts departments use, plus the NATO words that
// turn up when someone learned them in the service, plus the handful of
// mishearings Whisper produces reliably.
const PHON = {
  adam: 'A', alpha: 'A', alfa: 'A', atom: 'A', atoms: 'A', adams: 'A',
  boy: 'B', bravo: 'B', buoy: 'B', boys: 'B',
  charles: 'C', charlie: 'C', chuck: 'C', charlies: 'C',
  david: 'D', delta: 'D', davids: 'D',
  edward: 'E', echo: 'E', eddie: 'E', edwards: 'E', eduardo: 'E',
  frank: 'F', foxtrot: 'F', franks: 'F', franc: 'F',
  george: 'G', golf: 'G', georgia: 'G', georges: 'G',
  henry: 'H', hotel: 'H', harry: 'H', henri: 'H', hendry: 'H', henrys: 'H',
  ida: 'I', india: 'I', idaho: 'I',
  john: 'J', juliet: 'J', juliett: 'J', julie: 'J', julia: 'J', juliette: 'J', johnny: 'J',
  king: 'K', kilo: 'K', kings: 'K',
  lincoln: 'L', lima: 'L',
  mary: 'M', mike: 'M', marry: 'M', merry: 'M', maria: 'M',
  nora: 'N', november: 'N', norah: 'N',
  ocean: 'O', oscar: 'O', oceans: 'O',
  paul: 'P', papa: 'P', pauls: 'P',
  queen: 'Q', quebec: 'Q', queens: 'Q',
  robert: 'R', romeo: 'R', roberts: 'R', bobby: 'R',
  sam: 'S', sierra: 'S', sammy: 'S',
  tom: 'T', tango: 'T', thomas: 'T', tommy: 'T',
  union: 'U', uniform: 'U', onion: 'U', unions: 'U',
  victor: 'V', victoria: 'V', victors: 'V',
  william: 'W', whiskey: 'W', williams: 'W', willie: 'W',
  xray: 'X', 'x-ray': 'X', exray: 'X', 'ex-ray': 'X',
  young: 'Y', yankee: 'Y',
  zebra: 'Z', zulu: 'Z', zebras: 'Z',
};

const DIGIT = {
  zero: '0', oh: '0', one: '1', two: '2', to: '2', too: '2', three: '3', tree: '3',
  four: '4', for: '4', five: '5', fife: '5', six: '6', seven: '7', eight: '8', ate: '8',
  nine: '9', niner: '9',
};

/* "X-ray" survives as one token, but Whisper writes it "X ray" about as often,
   and two tokens break the run in the middle of a plate. Joined before
   tokenising so the phonetic table sees one word either way. */
const tok = s => String(s || '').toLowerCase()
  .replace(/\bx[\s.]+ray\b/g, 'x-ray')
  .replace(/[^a-z0-9\- ]+/g, ' ').split(/\s+/).filter(Boolean);

/* A run of phonetic words and spoken digits, read back as what it spells.

   Four kinds of token can join a run and they are emphatically not equally
   trustworthy, which is why the run reports what it was made of rather than
   only what it spells. A phonetic word is somebody deliberately spelling. A
   spoken digit is too. A bare single letter is usually the letter "I" out of
   a contraction Whisper punctuated away, and a bare numeral is usually a unit
   number or a street number that happens to sit next to one.

   Reading only `text`, "Hello, I'm 22. I'm 22" spells IM22IM22 and passes for
   a plate. Reading `phon` and `bare`, it is what it sounds like: nothing. */
function spellRun(words, i) {
  let out = '', n = 0, phon = 0, spoken = 0, bare = 0, blob = 0;
  while (i + n < words.length) {
    const w = words[i + n];
    let c = null;
    if (PHON[w] !== undefined) { c = PHON[w]; phon++; spoken++; }
    else if (DIGIT[w] !== undefined) { c = DIGIT[w]; spoken++; }
    else if (/^[a-z]$/.test(w)) { c = w.toUpperCase(); bare++; }
    else if (/^\d{1,4}$/.test(w)) { c = w; blob++; }
    else break;
    out += c; n++;
  }
  return { text: out, used: n, phon, spoken, bare, blob };
}

// Every spelled run in a transcript, with the words it came from so the caller
// can cut it back out or point at it.
function runs(text, min) {
  min = min || 3;
  const words = tok(text);
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const r = spellRun(words, i);
    if (r.used < min) continue;
    out.push({
      at: i, used: r.used, text: r.text,
      // What the run was made of, not only what it spells. Callers that care
      // about being right rather than eager read these. See spellRun.
      phon: r.phon, spoken: r.spoken, bare: r.bare, blob: r.blob,
      words: words.slice(i, i + r.used),
      before: words.slice(Math.max(0, i - 6), i).join(' '),
      after: words.slice(i + r.used, i + r.used + 6).join(' '),
    });
    i += r.used - 1;
  }
  return out;
}

// -------------------------------------------------------------- plates

const PLATE_CUE = /\b(?:plate|plates|registration|reg\b|tag|marker|mass(?:achusetts)?\s+(?:reg\w*|plate)|running|run me|check me|comes back|off of|rmv|vehicle is)\b/i;

// Massachusetts passenger registrations run 1ABC23, 123ABC, ABC123 and some
// older all-digit forms; commercial, livery and vanity plates vary. Rather than
// enumerate the formats, the test is a run of five to eight characters mixing
// letters and digits, or six or more digits, which is what a plate looks like
// out loud and what very little else in radio traffic looks like.
function looksLikePlate(s) {
  if (!s || s.length < 5 || s.length > 8) return false;
  const L = (s.match(/[A-Z]/g) || []).length;
  const D = (s.match(/\d/g) || []).length;
  return (L > 0 && D > 0) || D >= 6;
}

/* Two regexes rather than one, because "me" is the state of Maine about once
   for every thousand times it is the word me. Nobody on a radio says a state
   as two letters, they say Mass or New Hampshire, so the spoken forms are what
   gets matched against speech. The two-letter abbreviations are kept for text
   that Whisper actually capitalised, and are tried case-sensitively against
   the raw transcript only, never against the lowercased run context. Without
   that split, "Answer me, white Honda CR-V, five Julie Harry X-ray one two"
   comes back as a Maine plate. */
const STATE = /\b(mass(?:achusetts)?|new hampshire|n\.?h\.?|rhode island|r\.?i\.?|connecticut|conn|vermont|maine|new york|n\.?y\.?|jersey|florida|fla)\b/i;
const STATE_ABBR = /\b(MA|ME|NH|RI|CT|VT|NY|NJ|FL)\b/;
const ST_NORM = {
  mass: 'MA', massachusetts: 'MA', ma: 'MA', 'new hampshire': 'NH', nh: 'NH',
  'rhode island': 'RI', ri: 'RI', connecticut: 'CT', conn: 'CT', ct: 'CT',
  vermont: 'VT', vt: 'VT', maine: 'ME', me: 'ME', 'new york': 'NY', ny: 'NY',
  jersey: 'NJ', nj: 'NJ', florida: 'FL', fla: 'FL', fl: 'FL',
};

function plates(text) {
  const out = [];
  const seen = new Set();
  const add = (p, st, how) => {
    const v = String(p).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!looksLikePlate(v) || seen.has(v)) return;
    seen.add(v);
    out.push({ plate: v, state: st || null, via: how });
  };

  for (const r of runs(text)) {
    if (!looksLikePlate(r.text)) continue;
    /* A plate that was never on the air, sitting in front of a reporter with a
       time and a channel next to it, is far worse than a plate we missed. So
       the run has to look like somebody spelling, not merely like something
       that spells.

       Uncued, with nothing in the six words before it announcing a plate, the
       only honest evidence is the phonetic alphabet itself: three or more
       deliberate phonetic words, no bare single letters (those are almost
       always the "I" of a contraction Whisper punctuated away), and at most
       one multi-digit blob (those are unit and street numbers). That kills
       IM22IM22 out of "Hello, I'm 22. I'm 22", C11114 out of "Charlie, 111,
       14", and 60290I out of "from 60 to 90. I'll".

       Cued, somebody has already said the word plate or registration, so one
       phonetic word or three spoken characters is enough to trust the read. */
    const cued = PLATE_CUE.test(r.before);
    const ok = cued
      ? (r.phon >= 1 || r.spoken >= 3)
      : (r.phon >= 3 && r.bare === 0 && r.blob <= 1);
    if (!ok) continue;
    const m = r.before.match(STATE);
    add(r.text, m && ST_NORM[m[1].toLowerCase().replace(/\./g, '')], 'spelled');
  }

  // Written straight out, when something introduces it.
  const s = String(text || '');
  const re = /\b([A-Z0-9][A-Z0-9\- ]{3,10}[A-Z0-9])\b/g;
  let m;
  while ((m = re.exec(s))) {
    const ctx = s.slice(Math.max(0, m.index - 45), m.index);
    if (!PLATE_CUE.test(ctx)) continue;
    /* "MA 8CV419" is all caps and digits with a space in the middle, so the
       run above swallows the state along with the plate and hands back
       MA8CV419. Peel it off the front and use it, rather than letting two
       characters of Massachusetts ride around as part of a registration. */
    let raw = m[1];
    let pre = null;
    const lead = raw.match(/^(MA|ME|NH|RI|CT|VT|NY|NJ|FL)[ \-]+(.+)$/);
    if (lead) { pre = lead[1]; raw = lead[2]; }
    const st = ctx.match(STATE) || ctx.match(STATE_ABBR);
    add(raw, pre || (st && ST_NORM[st[1].toLowerCase().replace(/\./g, '')]), 'written');
  }
  return out;
}

// -------------------------------------------------------------- names

const NAME_CUES = ['last name', 'first name', 'name of', 'goes by', 'operator is', 'party is',
  'subject is', 'suspect is', 'one under', 'rp is', 'victim is', 'caller is', 'identified as',
  'operator comes back', 'comes back to', 'registered to', 'listed to', 'his name is', 'her name is'];
const NAME_CUE_RE = new RegExp('\\b(?:' + NAME_CUES.join('|') + ')\\b', 'i');

// A capitalised word or two immediately after a cue. Narrow on purpose: a
// looser rule eats street names, and the street is the most valuable field in
// the transmission.
const eitherCase = w => w.replace(/^([a-z])/, (c) => '[' + c + c.toUpperCase() + ']');
// The article is optional and common: "comes back to a John Smith", "registered
// to a Maria Santos". Without it those two lines lose the name entirely.
const NAME_AFTER = new RegExp(
  '\\b(?:' + NAME_CUES.map(eitherCase).join('|') + ')[,: ]+\\s*(?:an?\\s+)?' +
  "((?:[A-Z][a-z'\\-]{1,15})(?:\\s+[A-Z][a-z'\\-]{1,15}){0,2})", 'g');

/* A records check comes back the way a records system prints it, surname
   first. Heard live on Boston Police: "by the name of Slag, Joseph". The pass
   above stops dead at the comma and files half a person, which is worse than
   filing none, because a reporter reading "Slag" has no way to know a first
   name was said. Read the pair, hand it back the way a human would write it,
   and keep what was actually spoken alongside. */
const NAME_INVERTED = new RegExp(
  '\\b(?:' + NAME_CUES.map(eitherCase).join('|') + ')[,: ]+\\s*(?:an?\\s+)?' +
  "([A-Z][a-z'\\-]{1,15}),\\s*([A-Z][a-z'\\-]{1,15})\\b", 'g');

/* Weak cues, kept apart from the strong ones deliberately. "Should be Steven
   Rodriguez" is how a dispatcher hands over a name nobody has confirmed yet,
   and on a live channel that is most of them, so throwing it away costs real
   reporting. It is also how somebody says "should be Boylston and Tremont" or
   "should be Engine Seven". So a weak cue only counts for a two word person
   shaped name, never a street the index recognises, never a unit, and the
   record carries via 'inferred' so the desk can see which is which. */
const NAME_CUES_WEAK = ['should be', 'appears to be', 'comes back as', 'believed to be'];
const NAME_AFTER_WEAK = new RegExp(
  '\\b(?:' + NAME_CUES_WEAK.map(eitherCase).join('|') + ')[,: ]+\\s*(?:an?\\s+)?' +
  "([A-Z][a-z'\\-]{1,15}\\s+[A-Z][a-z'\\-]{1,15})", 'g');
const NOT_A_PERSON = /^(?:engine|ladder|tower|rescue|squad|medic|car|unit|district|sector|cruiser|box|street|avenue|road|drive|court|square|park|place|lane|terrace|way|boulevard|north|south|east|west|upper|lower|old|new)\b/i;
const STREET_TAIL = /\b(?:street|st|avenue|ave|road|rd|drive|dr|court|ct|square|sq|place|pl|lane|ln|terrace|ter|way|boulevard|blvd|park|circle|cir|highway|hwy)$/i;

// opt.isStreet lets the caller pass in the street index. Officers spell street
// names on the air exactly the way they spell surnames ("Jette, Juliet Edward
// Tango Tango Echo"), and without this the gazetteer's own street list gets
// filed as a person.
function names(text, opt) {
  const isStreet = (opt && opt.isStreet) || (() => false);
  const out = [];
  const seen = new Set();
  const add = (v, how, part, heard) => {
    const n = String(v).trim().replace(/\s+/g, ' ');
    if (!n || seen.has(n.toUpperCase())) return;
    /* "Slag, Joseph" has already gone in as "Joseph Slag". The plain cue pass
       runs afterwards, sees the surname sitting on its own, and would file the
       same person a second time under half his name. */
    if (!/\s/.test(n) && out.some(o => o.name.split(/\s+/).some(w => w.toUpperCase() === n.toUpperCase()))) return;
    seen.add(n.toUpperCase());
    const rec = { name: n, via: how, part: part || null };
    if (heard) rec.heard = heard;
    out.push(rec);
  };

  for (const r of runs(text)) {
    if (!/^[A-Z]{3,}$/.test(r.text)) continue;       // letters only; a plate has digits
    const cued = NAME_CUE_RE.test(r.before);
    /* Same trap the plate gate walks around, and it bites harder here, because
       a name is a person. "I don't know. I'm Robert. I know. Okay. Kevin."
       tokenises to i / m / robert / i and spells IMRI, which is nobody. A bare
       single letter in a run is Whisper's leftover from a contraction it
       punctuated away, so a spelled name has to be made of phonetic words:
       three of them with nothing announcing a name, two once something has. */
    if (r.bare > 0) continue;
    if (r.phon < (cued ? 2 : 3)) continue;
    if (!cued && isStreet(r.text)) continue;
    if (!cued && r.text.length < 4) continue;
    const part = /last name/i.test(r.before) ? 'last' : /first name/i.test(r.before) ? 'first' : null;
    add(r.text, 'spelled', part);
  }

  let m;
  const s = String(text || '');

  // Surname first, before the plain pass, so the comma cannot truncate it.
  NAME_INVERTED.lastIndex = 0;
  while ((m = NAME_INVERTED.exec(s))) add(m[2] + ' ' + m[1], 'spoken', null, m[1] + ', ' + m[2]);

  NAME_AFTER.lastIndex = 0;
  while ((m = NAME_AFTER.exec(s))) {
    // "Last name Sam Mary Ida Tom Henry" satisfies both passes, and the spelled
    // pass is the one that read it correctly. Three capitalised phonetic words
    // are the spelling of a name, never a name.
    // Three or more, because plenty of real first names are also phonetic
    // words. "first name John" is a name; "Sam Mary Ida" is the letters S M I.
    const w = tok(m[1]);
    if (w.length >= 3 && w.every(x => PHON[x] !== undefined)) continue;
    const cue = m[0].slice(0, m[0].length - m[1].length);
    const part = /last name/i.test(cue) ? 'last' : /first name/i.test(cue) ? 'first' : null;
    add(m[1], 'spoken', part);
  }

  // Weak cues last, and only what survives the street index and the apparatus.
  NAME_AFTER_WEAK.lastIndex = 0;
  while ((m = NAME_AFTER_WEAK.exec(s))) {
    const v = m[1];
    if (NOT_A_PERSON.test(v) || STREET_TAIL.test(v) || isStreet(v)) continue;
    const w = tok(v);
    if (w.every(x => PHON[x] !== undefined)) continue;
    add(v, 'inferred', null);
  }
  return out;
}

// -------------------------------------------------------------- other fields

const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

// "DOB three fifteen eighty seven", "date of birth 3/15/87", "born 15 March 1987"
function dobs(text) {
  const s = String(text || '');
  const out = [];
  const re = /\b(?:dob|d\.o\.b\.?|date of birth|born)\b[:, ]{0,3}([^.;]{0,40})/gi;
  let m;
  while ((m = re.exec(s))) {
    const tail = m[1];
    let d = null;
    const slash = tail.match(/\b(\d{1,2})\s*[\/\-. ]\s*(\d{1,2})\s*[\/\-. ]\s*(\d{2,4})\b/);
    if (slash) d = slash[1] + '/' + slash[2] + '/' + slash[3];
    if (!d) {
      const mon = tail.match(new RegExp('\\b(' + Object.keys(MONTHS).join('|') + ')\\b[ ,]*(\\d{1,2})\\b[ ,]*(\\d{2,4})?', 'i'));
      if (mon) d = MONTHS[mon[1].toLowerCase()] + '/' + mon[2] + (mon[3] ? '/' + mon[3] : '');
    }
    if (!d) {
      const words = tok(tail);
      const nums = [];
      for (const w of words) { if (DIGIT[w] !== undefined) nums.push(DIGIT[w]); else if (/^\d{1,4}$/.test(w)) nums.push(w); else if (nums.length) break; }
      if (nums.length >= 3) d = nums.join(' ');
    }
    out.push({ dob: d, heard: tail.trim() });
  }
  return out;
}

const LIC_RE = /\b(?:licen[cs]e|lic\.?|oln|operator'?s? number|permit)\s*(?:number|no\.?|#)?\s*[:# ]?\s*([A-Z]{0,2}\d{6,10})\b/gi;
const PHONE_RE = /\b(?:\+?1[- .])?\(?(\d{3})\)?[- .]?(\d{3})[- .](\d{4})\b/g;
const SSN_RE = /\b(\d{3}[- ]\d{2}[- ]\d{4})\b/g;

const all = (re, s, f) => { const o = []; let m; re.lastIndex = 0; while ((m = re.exec(String(s || '')))) o.push(f(m)); return o; };

// -------------------------------------------------------------- optional mask

// Off by default. If a retention policy ever needs the identity fields out of
// the transcript itself rather than only out of the store, this puts them back
// behind a token without touching anything else in the line.
function mask(text, found) {
  let s = String(text || '');
  const hide = (v, tag) => {
    if (!v) return;
    const pat = new RegExp(String(v).split('').map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^A-Za-z0-9]{0,3}'), 'i');
    s = s.replace(pat, tag);
  };
  for (const p of (found.plates || [])) hide(p.plate, '[plate]');
  for (const n of (found.names || [])) s = s.split(n.name).join('[name]');
  return s;
}

/* Everything in one pass. */
function read(text, opt) {
  const P = plates(text), N = names(text, opt), D = dobs(text);
  return {
    plates: P, names: N, dobs: D,
    licences: all(LIC_RE, text, m => m[1].toUpperCase()),
    phones: all(PHONE_RE, text, m => m[1] + '-' + m[2] + '-' + m[3]),
    ids: all(SSN_RE, text, m => m[1]),
    any: !!(P.length || N.length || D.length),
  };
}

module.exports = { read, plates, names, dobs, runs, spellRun, looksLikePlate, mask, NAME_CUE_RE, PHON, DIGIT };
