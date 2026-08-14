// lib/trace.js
//
// Tying a sentence back to the radio it came from.
//
// The desk says "at 05:12Z Boston Police reported a footchase down Geneva
// Street" and the only useful next move is to hear it. That means turning
// prose back into a set of transmissions, and it has to be done without
// trusting the model to tell us which ones it used.
//
// WHY NOT ASK THE MODEL. A citation is one more thing it can get confidently
// wrong, and a play button pointed at the wrong audio is worse than no play
// button: it teaches a reporter that the button lies, and after that the whole
// panel is decoration. So the link is computed from what the answer says.
//
// THREE SIGNALS, IN ORDER OF HOW HARD THEY ARE TO INVENT.
//
//   Clock times. The prompts ask for them, they are exact, and a time that
//   matches a transmission in the set is close to proof. Weighted highest.
//
//   Digit runs. "405", "2565", "592" are the most distinctive things on a
//   scanner and the hardest for a model to produce by accident. A street
//   number that appears in the answer and in exactly one transmission is a
//   citation.
//
//   Distinctive words. "Geneva", "Columbia", "footchase". Weak alone, because
//   a model that read a hundred transmissions will echo their vocabulary
//   whether or not it is describing them. Only counted in combination.
//
// Anything that traces to nothing comes back empty rather than approximate,
// which has the useful side effect of making a fabricated answer visibly
// unplayable.

'use strict';

const et = require('./etime');

const STOP = new Set(('a an the at in on of to for and or with but that this there'
  + ' is are was were be been being it its his her their they them he she we you'
  + ' i as by from into out up down over under about after before while during'
  + ' possible reported report call caller unclear meaning going off location'
  + ' street st ave avenue road rd square block area unit units officer officers'
  + ' police fire ems transmission transmissions further information heard said'
  + ' no not there also then than what which who when where why how one two three'
  + ' four five six seven eight nine ten').split(/\s+/));

/* Every HH:MM in a string, however it was written: 05:12Z, 05:12, 1:22 AM.
 *
 * A 12 hour time is expanded to both readings rather than padded to one. "1:22
 * AM" written by the model has to match a row at 01:22, and a bare "1:22" is
 * genuinely ambiguous, so it is allowed to match either 01:22 or 13:22. Padding
 * blindly, which is what this did, quietly cited the wrong half of the day. */
function times(s) {
  const str = String(s || '');
  const out = new Set();
  const re = /\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?/gi;
  let m;
  while ((m = re.exec(str)) !== null) {
    const h = +m[1];
    const mm = m[2];
    const mer = (m[3] || '').toLowerCase()[0];
    if (h > 23) continue;
    const add = (n) => out.add(String(n % 24).padStart(2, '0') + ':' + mm);
    if (mer === 'a') add(h % 12);
    else if (mer === 'p') add((h % 12) + 12);
    else {
      add(h);
      /* Ambiguity is a property of how the time was WRITTEN, not of the hour.
         "1:39" could be either half of the day. "01:39" is zero-padded, which
         is 24 hour notation and means the small hours, and treating it as
         ambiguous made an answer about a 1:39am fire also cite a 1:39pm
         transmission. Only the unpadded form gets both readings. */
      if (m[1].length === 1 && h >= 1 && h <= 12) add(h + 12);
    }
  }
  return out;
}

function tokens(s, opts) {
  let str = String(s || '').toLowerCase();
  /* A clock time is scored as a clock. Left in, its halves come back out as
     digit runs too, so "17:39" also claimed to be the street numbers 17 and
     39 and got paid twice for one piece of evidence. */
  if (opts && opts.dropClocks) str = str.replace(/\b\d{1,2}:\d{2}\s*(a\.?m\.?|p\.?m\.?)?/gi, ' ');
  const nums = new Set();
  const words = new Set();
  for (const w of str.split(/[^a-z0-9]+/)) {
    if (!w) continue;
    if (/^\d{2,}$/.test(w)) nums.add(w);
    else if (w.length > 3 && !STOP.has(w)) words.add(w);
  }
  return { nums, words };
}

/* The digit runs a transmission actually said, as whole tokens.
 *
 * This used to be a substring test, and a substring test says that "17"
 * appears in "2172". It does, and it means nothing: a unit number is not a
 * street number because four characters happen to overlap. That is a citation
 * built out of a coincidence, pointed at audio about something else. */
function numsIn(s) {
  const out = new Set();
  for (const w of String(s || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (/^\d{2,}$/.test(w)) out.add(w);
  }
  return out;
}

/* Which of `rows` a piece of prose is talking about.
 *
 * Returns the matching transmissions in the order they were said, capped, and
 * empty when nothing clears the bar. `rows` are vault records or the listener
 * shape; both carry `at` and `text`.
 */
function toTransmissions(prose, rows, opts) {
  const cap = (opts && opts.cap) || 12;
  const t = tokens(prose, { dropClocks: true });
  const clocks = times(prose);
  /* Clock times inside the prose are usually citations, but a transmission
     that merely contains a number like "05" should not match one. Compare
     against the row's own timestamp only. */
  if (!clocks.size && !t.nums.size && t.words.size < 2) return [];

  const hits = [];
  for (const r of (rows || [])) {
    const at = String(r.at || '');
    /* A row answers to two clocks. The prompts now stamp transmissions in
       Eastern, so that is what an answer will quote, and it is the one that
       matters. UTC is still accepted because rows are stored in it, because
       answers written before the prompts were fixed are still on screen, and
       because a model that ignores the instruction and echoes the stored time
       should not silently cost the reporter a play button. Matching either is
       free; matching only one loses citations for no reason. */
    const clockET = et.clock(at);
    const clockZ = et.utcClock(at);
    const hay = String(r.text || '').toLowerCase();
    const where = String(r.where || r.matched || r.address || '').toLowerCase();

    let score = 0;
    if ((clockET && clocks.has(clockET)) || (clockZ && clocks.has(clockZ))) score += 8;
    const rowNums = numsIn(hay + ' ' + where);
    for (const n of t.nums) if (rowNums.has(n)) score += 5;
    let wordHits = 0;
    for (const w of t.words) if (hay.includes(w) || where.includes(w)) wordHits++;
    score += wordHits;

    /* A cited time, a shared street number, or three words together. A single
       echoed word is vocabulary, not a reference. */
    if (score >= 5 || wordHits >= 3) hits.push({ r, score });
  }

  hits.sort((a, b) => b.score - a.score || String(a.r.at).localeCompare(String(b.r.at)));
  return hits.slice(0, cap).map(h => h.r)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

/* The same thing, shaped for a card: the transmissions plus just their audio,
   ready for a play-in-order control. */
function cited(prose, rows, opts) {
  const found = toTransmissions(prose, rows, opts);
  return {
    at: found.map(r => r.at),
    clips: found.filter(r => r.clip).map(r => r.clip),
    n: found.length,
    tx: found,
  };
}

module.exports = { toTransmissions, cited, times, tokens };
