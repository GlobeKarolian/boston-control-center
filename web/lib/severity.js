// lib/severity.js
//
// How big is this, and who gets to say so.
//
// V1 let one model answer that question alone, and on the night this was
// written it turned a single transmission, "I am good to go. All right, Jake
// 201. Sorry. 81 Walden Street.", into "Active Shooter at 81 Walden Street,
// Cambridge - Confirmed by Police". No shooter, no gun, no Cambridge, no
// second source. The model was the sole author of a claim that would have
// moved a newsroom.
//
// So severity gets two layers that answer separately, and the mechanical one
// wins ties.
//
// THE FLOOR is arithmetic over things that were actually observed: which
// threat signals the transcripts contain, how many agencies converged, how
// many units, how long it ran, and whether the radio itself got unusually
// busy. No model is consulted. The floor cannot be talked into anything,
// which is the entire point of having it.
//
// THE JUDGMENT is a model's read, and it arrives as an opinion rather than a
// verdict. It can lower a score freely. It can raise one by a single notch,
// because a good editor hearing a scene can legitimately see more than a
// pattern-matcher does, and it can never carry a story past the evidence.
//
// The floor also raises alarms on its own, which is the part that matters
// most. On August 12 a fatal stabbing at South Station transcribed as a
// disorderly party, and every word-based path missed it. Three feeds going
// hot around one block at rush hour is news before a single word parses, and
// this layer can say so while the transcripts are still nonsense.

'use strict';

/* 0  nothing
   1  routine call
   2  worth a glance
   3  a story: single-victim violence, structure fire, serious crash
   4  a big story: multiple victims, multiple alarms, transit shutdown
   5  the desk stops what it is doing: mass casualty, officer down */
const MAX = 5;

/* Signals whose presence is, by itself, a story. Tier comes from
   lib/threat.js; these are the ids that carry extra weight beyond it. */
const GRAVE = new Set(['mass-casualty', 'officer-emerg', 'responder-down', 'active-shooter', 'hostage', 'explosion', 'abduction', 'civil-unrest']);
const HEAVY = new Set(['alarm-escalate', 'working-fire', 'shots-fired', 'shooting', 'stabbing', 'bomb']);

function clamp(n) { return Math.max(0, Math.min(MAX, n)); }

/* Everything the floor is allowed to look at, gathered by the caller:
     tx        [{ text, feed, units, signals:[{id,tier}], tier }]
     feeds     distinct feed ids that spoke
     units     distinct unit designators
     spanMin   minutes from first transmission to last
     anomaly   { level: 'normal'|'watch'|'high', why } from lib/baseline
     fleet     same shape, for the whole fleet rather than one feed
*/
function floor(ev) {
  const tx = ev.tx || [];
  const reasons = [];
  let s = 0;

  /* 1. What was said. The strongest single signal sets the base, because one
     unambiguous "shots fired" outranks any amount of ordinary busyness. */
  let topTier = 0;
  const ids = new Set();
  for (const t of tx) {
    for (const g of (t.signals || [])) {
      ids.add(g.id);
      topTier = Math.max(topTier, Number(g.tier) || 0);
    }
    topTier = Math.max(topTier, Number(t.tier) || 0);
  }
  const grave = [...ids].filter(i => GRAVE.has(i));
  const heavy = [...ids].filter(i => HEAVY.has(i));

  if (grave.length) { s = 4; reasons.push('heard on the radio: ' + grave.join(', ')); }
  else if (heavy.length) { s = 3; reasons.push('heard on the radio: ' + heavy.join(', ')); }
  else if (topTier >= 3) { s = 3; reasons.push('a tier 3 signal in the transcripts'); }
  else if (topTier === 2) { s = 2; reasons.push('a tier 2 signal in the transcripts'); }
  else if (tx.length) { s = 1; }

  /* 2. Who came. Agencies converging is the most reliable severity tell on a
     scanner, and it survives terrible transcription completely: it is counted
     from which feeds carried traffic, not from what anyone said. */
  const feeds = (ev.feeds || []).filter(Boolean);
  if (feeds.length >= 4) { s += 2; reasons.push(feeds.length + ' agencies on it'); }
  else if (feeds.length === 3) { s += 1; reasons.push('three agencies on it'); }
  else if (feeds.length === 2 && s >= 2) { s += 0.5; reasons.push('two agencies on it'); }

  /* 3. How many, and how long. A scene still generating traffic half an hour
     later is a scene that did not resolve. */
  const units = (ev.units || []).length;
  if (units >= 8) { s += 1; reasons.push(units + ' units'); }
  else if (units >= 5) { s += 0.5; reasons.push(units + ' units'); }
  const span = Number(ev.spanMin) || 0;
  if (span >= 45 && s >= 2) { s += 0.5; reasons.push('running ' + Math.round(span) + ' minutes'); }

  /* 4. The radio itself, with no words involved.

     This is the South Station clause. When transcription fails completely,
     volume is still evidence, and the baseline already knows what this hour
     of this week normally sounds like on this feed. A fleet-wide surge counts
     for more than one channel's, because six feeds each running hot is a
     citywide event no single feed would report. */
  const a = ev.anomaly || {};
  if (a.level === 'high') { s += 1.5; reasons.push('radio traffic well above normal' + (a.why ? ': ' + a.why : '')); }
  else if (a.level === 'watch') { s += 0.75; reasons.push('radio traffic above normal' + (a.why ? ': ' + a.why : '')); }
  const f = ev.fleet || {};
  if (f.level === 'high') { s += 1; reasons.push('the whole fleet is busy: ' + (f.why || 'well above normal')); }
  else if (f.level === 'watch') { s += 0.5; }

  /* A surge with nothing else attached is worth a look rather than an alarm,
     and it is worth exactly the look that keeps a newsroom from finding out
     from a reporter's email the next morning. */
  if (!tx.length && !feeds.length && (a.level === 'high' || f.level === 'high')) {
    s = Math.max(s, 2);
    reasons.push('nothing legible, but the radio is not quiet');
  }

  return { score: clamp(Math.round(s * 2) / 2), reasons, signals: [...ids], agencies: feeds.length };
}

/* The model's read, reconciled with the floor.

   Down is free: a model that listens to a scene and concludes it is smaller
   than the pattern suggests is usually right, and a newsroom is not harmed by
   a quiet card. Up is capped at one notch, because that is the difference
   between an editor's judgment and an editor's imagination, and tonight's
   board is what the second one looks like. */
function settle(fl, model) {
  const f = (fl && typeof fl.score === 'number') ? fl.score : 0;
  const m = (model && typeof model.score === 'number') ? clamp(model.score) : null;
  if (m === null) return { score: f, source: 'floor', capped: false, reasons: (fl && fl.reasons) || [] };

  const ceiling = clamp(f + 1);
  const score = clamp(Math.min(m, ceiling));
  return {
    score,
    source: score === m ? 'model' : 'floor',
    capped: m > ceiling,
    /* Named so a person can see the disagreement rather than infer it. The
       Walden card would have read: model 5, floor 0, published at 1. */
    modelSaid: m,
    floorSaid: f,
    reasons: (fl && fl.reasons) || [],
    why: m > ceiling
      ? 'the model called this a ' + m + ' and the evidence supports ' + f
      : null,
  };
}

/* What the newsroom is allowed to be interrupted for.

   Deliberately stricter than the score: a page needs the floor to agree, not
   merely to have been outvoted. A 4 that exists only because a model said so
   is exactly the alert nobody should get at 3am. */
function pages(settled, fl) {
  const f = (fl && fl.score) || 0;
  return settled.score >= 4 && f >= 3;
}

/* Plain words for a card, so nobody has to learn a scale. */
function label(score) {
  if (score >= 4.5) return 'everything stops';
  if (score >= 3.5) return 'big';
  if (score >= 2.5) return 'a story';
  if (score >= 1.5) return 'worth a glance';
  return 'routine';
}

module.exports = { floor, settle, pages, label, MAX, GRAVE, HEAVY };
