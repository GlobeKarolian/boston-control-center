// lib/etime.js
//
// One clock, and it is the newsroom's.
//
// Everything in the vault is stored in UTC, which is correct, and everything
// shown to a person has to be Eastern, which is also correct. The bug is the
// hop between them, and it is the kind that survives review because both ends
// look right on their own.
//
// WHAT HAPPENED. The desk panel printed a transmission at "05:22" at two in
// the morning. The stored timestamp was 05:22Z, the UI sliced the characters
// straight out of the ISO string, and nobody converted anything. Worse, the
// same UTC clock was handed to the model under a prompt that ended "Use
// Eastern times in the answer", so the model was told the times were Eastern
// and given times that were not. Whichever way it resolved that, it was
// wrong: echo the number and an editor reads a 1:22am fire as a 5:22am fire,
// or convert it honestly and lib/trace.js can no longer match the answer back
// to the transmission, so the play button goes dead.
//
// So: a timestamp is never sliced. It is formatted, here, by something that
// knows what a timezone is. DST is Intl's problem rather than a comment
// somebody has to remember in March.
//
// The formatter is built once at module load. This runs inside a loop over
// several thousand rows on every desk question, and constructing an
// Intl.DateTimeFormat per row is the difference between a fast endpoint and a
// slow one.

'use strict';

const TZ = 'America/New_York';

const HM24 = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
});
const HM12 = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hour: 'numeric', minute: '2-digit',
});
const FULL = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

/* Eastern HH:MM on a 24 hour clock, zero padded.
 *
 * Some ICU builds render midnight as "24:00" under hour12:false rather than
 * "00:00", which is valid ISO 8601 and completely useless as a key to match
 * on, so it is normalised here rather than discovered again at 12:15am. */
/* new Date(null) is not an invalid date, it is 1 January 1970, which formats
   perfectly happily as "19:00" and would have put a plausible wrong time next
   to any row with a missing timestamp. Absent input is rejected before it
   reaches the Date constructor. */
function bad(iso) {
  return iso === null || iso === undefined || iso === '' || typeof iso === 'boolean';
}

function clock(iso) {
  if (bad(iso)) return '';
  const d = new Date(iso);
  if (isNaN(+d)) return '';
  const m = /(\d{1,2}):(\d{2})/.exec(HM24.format(d));
  if (!m) return '';
  return String((+m[1]) % 24).padStart(2, '0') + ':' + m[2];
}

/* Eastern clock the way a person says it: "1:22 AM". */
function stamp(iso) {
  if (bad(iso)) return '';
  const d = new Date(iso);
  return isNaN(+d) ? '' : HM12.format(d);
}

/* With the date, for windows that cross midnight: "Aug 13, 6:00 PM". */
function full(iso) {
  if (bad(iso)) return '';
  const d = new Date(iso);
  return isNaN(+d) ? '' : FULL.format(d);
}

/* The UTC clock, kept only so lib/trace.js can still match answers written
   before this existed, and answers from a model that ignored the instruction
   and echoed the stored time anyway. */
function utcClock(iso) {
  const s = String(iso || '');
  return s.length >= 16 ? s.slice(11, 16) : '';
}

module.exports = { clock, stamp, full, utcClock, TZ };
