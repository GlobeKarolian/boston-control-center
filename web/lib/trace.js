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

const STOP = new Set(('a an the at in on of to for and or with but that this there'
  + ' is are was were be been being it its his her their they them he she we you'
  + ' i as by from into out up down over under about after before while during'
  + ' possible reported report call caller unclear meaning going off location'
  + ' street st ave avenue road rd square block area unit units officer officers'
  + ' police fire ems transmission transmissions further information heard said'
  + ' no not there also then than what which who when where why how one two three'
  + ' four five six seven eight nine ten').split(/\s+/));

/* Every HH:MM in a string, however it was written: 05:12Z, 05:12, 1:22 AM. */
function times(s) {
  const out = new Set();
  const re = /\b(\d{1,2}):(\d{2})\b/g;
  let m;
  while ((m = re.exec(String(s || ''))) !== null) {
    out.add(String(m[1]).padStart(2, '0') + ':' + m[2]);
  }
  return out;
}

function tokens(s) {
  const nums = new Set();
  const words = new Set();
  for (const w of String(s || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (!w) continue;
    if (/^\d{2,}$/.test(w)) nums.add(w);
    else if (w.length > 3 && !STOP.has(w)) words.add(w);
  }
  return { nums, words };
}

/* Which of `rows` a piece of prose is talking about.
 *
 * Returns the matching transmissions in the order they were said, capped, and
 * empty when nothing clears the bar. `rows` are vault records or the listener
 * shape; both carry `at` and `text`.
 */
function toTransmissions(prose, rows, opts) {
  const cap = (opts && opts.cap) || 12;
  const t = tokens(prose);
  const clocks = times(prose);
  /* Clock times inside the prose are usually citations, but a transmission
     that merely contains a number like "05" should not match one. Compare
     against the row's own timestamp only. */
  if (!clocks.size && !t.nums.size && t.words.size < 2) return [];

  const hits = [];
  for (const r of (rows || [])) {
    const at = String(r.at || '');
    const clock = at.length >= 16 ? at.slice(11, 16) : '';
    const hay = String(r.text || '').toLowerCase();
    const where = String(r.where || r.matched || r.address || '').toLowerCase();

    let score = 0;
    if (clock && clocks.has(clock)) score += 8;
    for (const n of t.nums) if (hay.includes(n) || where.includes(n)) score += 5;
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
