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

/* WHAT A FIREGROUND SOUNDS LIKE.
 *
 * lib/threat.js can only find a fire if somebody says the words "working
 * fire", "fully involved", "heavy fire" or "trapped". Firefighters mostly do
 * not say those things. They say "command to fire line", "I'm going to be
 * clearing ladders", "first stream is 207", "companies operating". On the
 * night this was written a Needham/Brookline box ran for twenty-five minutes
 * with ladders up and command established, and every word-based path scored
 * it as an alarm.
 *
 * There is a second reason it was missed, and it is the more important one.
 * The floor's strongest signal is agencies converging, which is a superb tell
 * for violence and a terrible one for fire: a working structure fire is a
 * single-department event by nature. Fire does not need police to show up to
 * be a fire. So this clause has to be able to clear the bar on one feed.
 *
 * These are operations words. They describe things crews DO once there is
 * something to fight, and they do not appear when a box turns out to be
 * nothing. Two separate transmissions are required, so one garbled line
 * cannot conjure a fire on its own.
 */
const FIREGROUND = [
  /\b(?:aerial|tower ladder|ladders? (?:up|raised|to the roof)|clearing ladders|throw(?:ing)? ladders)\b/i,
  /\b(?:charged|second|third|back ?up|hand) line\b|\bline (?:in service|in operation|is charged)\b|\bstretch(?:ed|ing)? (?:a|the|another) line\b/i,
  /\b(?:master stream|deck gun|water supply|supply line|drafting|hydrant|first stream|second stream)\b/i,
  /\b(?:primary|secondary) search\b|\boverhaul\b|\bventilat\w*\b|\bopening up\b/i,
  /\b(?:command (?:is )?established|fire command|incident command|transfer(?:ring)? (?:of )?command|command to (?:fire ?line|the fire)|have it in command)\b/i,
  /\b(?:companies operating|all hands|under control|knock(?:ed)? down|tapp?ed out|working at the box)\b/i,
];

/* And what it sounds like when there is nothing there. A box that turns out
   to be a pulled handle or burnt toast uses half the same vocabulary while
   clearing, so the negative has to be checked before the positives count. */
const FIRE_NOTHING = /\b(nothing showing|nothing at (?:that|this|the) location|nothing at \w+ street|all companies available|companies are in service|companies available|malicious|accidental|unfounded|alarm stop|false alarm|box puller|pulled (?:the )?box|no smoke|no fire|good intent)\b/i;

/* How much fireground is on this scene: the count of transmissions carrying
   an operations phrase, and whether anybody called it nothing. */
function fireground(tx) {
  let ops = 0, nothing = false;
  for (const t of (tx || [])) {
    const txt = String((t && t.text) || '');
    if (!txt) continue;
    if (FIRE_NOTHING.test(txt)) nothing = true;
    for (const re of FIREGROUND) { if (re.test(txt)) { ops++; break; } }
  }
  return { ops, nothing };
}

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

  /* `heard` is the part of the floor that came from words somebody actually
     said, as opposed to the parts inferred from convergence, volume and
     duration. The distinction is the whole of settle()'s new behaviour: a
     model may talk down an inference, and may not talk down a transcript. */
  let heard = 0;
  if (grave.length) { s = 4; heard = 4; reasons.push('heard on the radio: ' + grave.join(', ')); }
  else if (heavy.length) { s = 3; heard = 3; reasons.push('heard on the radio: ' + heavy.join(', ')); }
  else if (topTier >= 3) { s = 3; heard = 3; reasons.push('a tier 3 signal in the transcripts'); }
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

  /* 3b. Fireground. Deliberately allowed to reach 3 on a single feed, because
     requiring converged agencies is exactly what buried a twenty-five minute
     structure fire behind a sleeping man in a U-Haul. */
  const fg = fireground(tx);
  if (fg.ops >= 2 && !fg.nothing) {
    /* Crews working a fire is a thing that was said too, not a pattern. */
    if (heard < 3) heard = 3;
    if (s < 3) { s = 3; reasons.push('fireground operations on ' + fg.ops + ' transmissions'); }
    else { s += 0.5; reasons.push('fireground operations on ' + fg.ops + ' transmissions'); }
    if (span >= 20) { s += 0.5; reasons.push('crews working it for ' + Math.round(span) + ' minutes'); }
  }

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

  /* VOLUME ALONE CANNOT MAKE A BIG STORY.
   *
   * Everything above section 1 is inference: agencies converged, units
   * committed, minutes elapsed, radio busier than usual. Those are good
   * evidence that SOMETHING is happening and poor evidence about WHAT. When
   * nothing in the transcripts was actually said (heard === 0), the score is
   * held at 3, "a story": enough to appear on a board and be looked at, not
   * enough to claim the top of a briefing.
   *
   * Found in live QA on 17 August: an overnight briefing led with "Downtown
   * traffic management, Back Bay" at severity 5, the level reserved for mass
   * casualty and officer down, purely because the scene carried ten units
   * across several feeds. Four of its eight items scored 5. A ranking where
   * everything is maximum is not a ranking, and an editor who reads one
   * briefing like that stops reading briefings.
   *
   * The South Station case is preserved deliberately: a fleet-wide surge with
   * unreadable transcripts still reaches 3 and still shows up, which is the
   * whole point of counting volume. It just cannot outrank a stabbing that
   * somebody said out loud. */
  let out = clamp(Math.round(s * 2) / 2);
  if (heard === 0 && out > 3) {
    out = 3;
    reasons.push('held at a story: busy, but nothing was said that names it');
  }
  return { score: out, heard: clamp(heard), reasons, signals: [...ids], agencies: feeds.length };
}

/* The model's read, reconciled with the floor.

   Down is free: a model that listens to a scene and concludes it is smaller
   than the pattern suggests is usually right, and a newsroom is not harmed by
   a quiet card. Up is capped at one notch, because that is the difference
   between an editor's judgment and an editor's imagination, and tonight's
   board is what the second one looks like. */
function settle(fl, model) {
  const f = (fl && typeof fl.score === 'number') ? fl.score : 0;
  /* What the radio said out loud, as opposed to what the pattern implied. */
  const heard = (fl && typeof fl.heard === 'number') ? fl.heard : 0;
  const m = (model && typeof model.score === 'number') ? clamp(model.score) : null;
  if (m === null) return { score: f, source: 'floor', capped: false, heardSaid: heard, reasons: (fl && fl.reasons) || [] };

  const ceiling = clamp(f + 1);
  /* THE FLOOR HAS TO BE A FLOOR FOR THINGS THAT WERE SAID.
   *
   * This took Math.min alone, so a model calling a card ordinary erased
   * whatever the floor found, and the analyst hands in 4 for a high-priority
   * card and 2 for everything else. A stabbing dispatched to a Dunkin' Donuts
   * with an EMS unit and a BPD unit on it scored 5 on the floor, the writer
   * filed it as normal priority, and it settled at 2. Below the bar, never
   * verified, never in Situations. The floor named it perfectly and had no
   * power.
   *
   * Down stays free for inference. Convergence, volume, duration and the
   * baseline are all patterns, and a model that reads the words and concludes
   * a busy block was nothing is usually right.
   *
   * Down is NOT free for a transcript. When a signal in GRAVE or HEAVY was
   * literally spoken, or crews were plainly working a fire, no read of the
   * same words gets to take it under a story. That is the difference between
   * an opinion about evidence and the evidence. */
  const raw = clamp(Math.min(m, ceiling));
  const score = clamp(Math.max(raw, heard));
  return {
    score,
    source: score === m ? 'model' : 'floor',
    capped: m > ceiling,
    /* True when the model tried to talk down something the radio said. */
    held: score > raw,
    heardSaid: heard,
    /* Named so a person can see the disagreement rather than infer it. The
       Walden card would have read: model 5, floor 0, published at 1. */
    modelSaid: m,
    floorSaid: f,
    reasons: (fl && fl.reasons) || [],
    why: m > ceiling
      ? 'the model called this a ' + m + ' and the evidence supports ' + f
      : (score > raw
        ? 'the model called this a ' + m + ' and the radio plainly said otherwise'
        : null),
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

module.exports = { floor, settle, pages, label, MAX, GRAVE, HEAVY, fireground, FIREGROUND, FIRE_NOTHING };
