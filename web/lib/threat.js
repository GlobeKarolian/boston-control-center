// Threat assessment for scanner traffic.
//
// The corpus is the argument for this file. 150 consecutive transmissions from
// an ordinary day contain zero instances of shots fired, signal 13, working
// fire, hazmat, mass casualty, pursuit, or a dispatcher clearing the air. The
// traffic worth waking a desk editor for is perhaps one in a thousand, and
// until now every transmission was processed identically, so the system spent
// its whole budget describing the routine and had no mechanism at all for the
// exceptional. Threat intelligence is the opposite problem from situational
// awareness: find the rare thing, ignore the rest cheaply.
//
// Everything below matches the raw transcript rather than an extracted field.
// That is deliberate and it is the single most important design decision here.
// A regex over words somebody actually said cannot hallucinate. The measured
// fabrication rate on extracted location fields is about one row in 150, and a
// false "shots fired" in front of a reporter costs far more than a missed one,
// so the high tiers only ever fire on spoken language.

const TIER_NAME = ['routine', 'notable', 'elevated', 'critical'];

// Dispatchers say the dangerous words most often in order to rule them out.
// "No report of shots fired." "Negative on the weapon." "Unfounded." A lexicon
// with no negation handling fires on every one of those and spends its
// credibility inside a week. The window is the same sentence only, because a
// negation two sentences back is about something else.
const NEG = /\b(no|not|negative|without|unfounded|disregard|false|cancel(?:l?ed)?|denies|nothing showing|checks? (?:ok|okay|out)|all set|any sign of)\b[^.!?]*$/i;

// Hedges do not cancel a signal, they lower confidence in it. "Report of shots
// fired" is worth acting on and worth labelling as unconfirmed, because the
// difference between a caller's claim and an officer's observation is the
// difference between a tip and a story.
const HEDGE = /\b(report(?:s|ed)? of|possible|possibly|caller (?:states|reports|says|advises)|third party|unconfirmed|alleged(?:ly)?|might be|sounds like|what appears to be|check(?:ing)? on)\b[^.!?]{0,40}$/i;

function context(text, index) {
  return text.slice(Math.max(0, index - 60), index);
}

// Tier 3 is life safety in progress. Every one of these is rare enough that
// seeing it more than a few times a shift means the pattern is wrong, not that
// the city is on fire. Tune by watching the count, not by reading the code.
const SIGNALS = [
  { id: 'shots-fired',     cls: 'violence', tier: 3, label: 'shots fired',        re: /\b(shots? fired|gun ?shots?|person shot|shot in the|multiple shots)\b/i },
  /* "shooting pain in his chest" and "pain shooting down her arm" are how EMS
     describes a cardiac or neuro complaint, and both scored a tier 3 shooting.
     A multi-car crash in Quincy ran as a BIG STORY reading "heard on the
     radio: shooting" off exactly this. Medical usage is excluded ahead and
     behind, and the range is excluded properly: the old lookahead expected
     "shooting range" but people say "shooting AT the range". */
  { id: 'shooting',        cls: 'violence', tier: 3, label: 'shooting',           re: /(?<!\bpain\s)(?<!\bpains\s)\bshooting\b(?!\s+(?:for|over|up|straight|range|pain|pains|down|through|across|into|sensation|at the range))/i },
  { id: 'active-shooter',  cls: 'violence', tier: 3, label: 'active shooter',     re: /\bactive shooter\b/i },
  { id: 'stabbing',        cls: 'violence', tier: 3, label: 'stabbing',           re: /\b(stabb(?:ing|ed)|person stabbed|cutting victim)\b/i },
  { id: 'armed-person',    cls: 'violence', tier: 3, label: 'armed person',       re: /\b((?:man|male|female|person|party|subject) with a (?:gun|firearm|knife|machete|weapon)|armed (?:subject|suspect|robbery|and dangerous)|brandish)\b/i },
  { id: 'officer-emerg',   cls: 'officer',  tier: 3, label: 'officer emergency',  re: /\b(signal 13|officer (?:down|needs? assistance|in trouble|shot)|10-?33|assist(?: the)? officer|emergency traffic|panic (?:button|alarm))\b/i },
  { id: 'responder-down',  cls: 'officer',  tier: 3, label: 'responder down',     re: /\b(mayday|firefighter down|man down inside|rit team|rapid intervention)\b/i },
  { id: 'working-fire',    cls: 'fire',     tier: 3, label: 'working fire',       re: /\b(working fire|fully involved|heavy fire|people trapped|entrapment|trapped inside|extricat)\b/i },
  { id: 'alarm-escalate',  cls: 'fire',     tier: 3, label: 'multiple alarm',     re: /\b((?:second|third|fourth|2nd|3rd|4th|multiple) alarm|all hands|strike (?:a|the) (?:second|third)|general alarm)\b/i },
  { id: 'explosion',       cls: 'hazard',   tier: 3, label: 'explosion',          re: /\b(explosion|explode(?:d)?|detonat|blast (?:site|area))\b/i },
  { id: 'bomb',            cls: 'hazard',   tier: 3, label: 'bomb threat',        re: /\b(bomb (?:threat|squad|tech)|suspicious (?:package|device|backpack)|improvised explosive|\bied\b)/i },
  { id: 'mass-casualty',   cls: 'medical',  tier: 3, label: 'mass casualty',      re: /\b(mass casualt|\bmci\b|multiple (?:victims|patients|casualties)|triage (?:tag|area))\b/i },
  { id: 'civil-unrest',    cls: 'crowd',    tier: 3, label: 'civil unrest',       re: /\b(riot|civil unrest|crowd control|unruly crowd|mob|looting)\b/i },
  /* `barricaded?` matched the bare word "barricade", which on a scanner is a
     traffic barrier several times an hour: "crash barricade on the median",
     "barricade set up for traffic". Every one of those scored tier 3, which
     GRAVE turns into severity 4 on the spot. On 17 Aug a four-year-old's
     seizure ran as a BIG STORY reading "heard on the radio: hostage".
     A barricade is only a barricade when a person is behind it, so the word
     now needs a subject, or the reflexive "barricaded himself". "refusing to
     come out" likewise needs a standoff context, not a wellness check. */
  { id: 'hostage',         cls: 'violence', tier: 3, label: 'hostage or barricade', re: /\b(hostage|barricaded?\s+(?:subject|suspect|party|person|male|female|individual)|barricaded\s+(?:him|her|them)sel(?:f|ves)|(?:subject|suspect|party|male|female)\s+(?:is\s+)?barricaded|refusing to come out\s+(?:of the (?:house|residence|apartment|building)|and (?:is )?armed))\b/i },
  { id: 'abduction',       cls: 'violence', tier: 3, label: 'abduction',          re: /\b(abduct|kidnapp?(?:ing|ed)|amber alert|attempted luring)\b/i },

  // Tier 2 is significant and worth a look. Several of these are the words that
  // come before a tier 3 event rather than during it, which is the entire point
  // of watching a scanner instead of reading a press release.
  { id: 'pursuit',         cls: 'pursuit',  tier: 2, label: 'pursuit',            re: /\b(in pursuit|foot pursuit|vehicle pursuit|fail(?:ed|ing|ure) to stop|eluding|fleeing on foot|took off on us)\b/i },
  { id: 'air-clearing',    cls: 'officer',  tier: 2, label: 'air being cleared',  re: /\b(hold (?:all )?(?:your |the )?traffic|clear the air|emergency traffic only|priority traffic|stand by (?:all|everyone)|switch(?:ing)? to tac|go to tac)\b/i },
  { id: 'more-units',      cls: 'officer',  tier: 2, label: 'more units wanted',  re: /\b(start (?:me|us) (?:another|a second)|send (?:me |us )?(?:another|more|additional)|additional units?|any available unit|all available|we need (?:more|another)|rapid response)\b/i },
  { id: 'hazmat',          cls: 'hazard',   tier: 2, label: 'hazmat',             re: /\b(haz-?mat|hazardous material|gas leak|chemical (?:spill|odor)|carbon monoxide|\bco alarm|unknown odor|fuel spill|decon)\b/i },
  { id: 'evacuation',      cls: 'hazard',   tier: 2, label: 'evacuation',         re: /\b(evacuat|shelter in place|clear the building|get everybody out)\b/i },
  { id: 'structure-fire',  cls: 'fire',     tier: 2, label: 'structure fire',     re: /\b(structure fire|building fire|smoke showing|heavy smoke|fire in the (?:building|basement|kitchen|walls)|flames? (?:showing|visible))\b/i },
  { id: 'medical-crit',    cls: 'medical',  tier: 2, label: 'critical medical',   re: /\b(cardiac arrest|cpr in progress|not breathing|unresponsive|med ?flight|severe bleeding|arterial|overdose|narcan|opioid)\b/i },
  { id: 'violence-ip',     cls: 'violence', tier: 2, label: 'violence in progress', re: /\b((?:assault|fight|domestic|robbery|break ?in|burglary) in progress|being assaulted|just (?:assaulted|robbed|jumped)|struck (?:her|him|them) (?:in|with))\b/i },
  { id: 'weapon-present',  cls: 'violence', tier: 2, label: 'weapon mentioned',   re: /\b(gun|firearm|handgun|rifle|shotgun|knife|machete|weapon)\b/i },
  { id: 'staging',         cls: 'officer',  tier: 2, label: 'staging or perimeter', re: /\b(stag(?:ed|ing) (?:at|on|near|until)|command post|set(?:ting)? up a perimeter|hold(?:ing)? (?:the )?perimeter|hold(?:ing)? (?:off|back) until|do not approach)\b/i },
  { id: 'mutual-aid',      cls: 'officer',  tier: 2, label: 'mutual aid',         re: /\b(mutual aid|state police (?:respond|assist|en ?route)|calling in (?:the )?(?:state|county)|task force|federal (?:partners|units))\b/i },
  { id: 'missing-person',  cls: 'missing',  tier: 2, label: 'missing person',     re: /\b(missing (?:child|juvenile|person|elderly)|walk(?:ed)? away from|silver alert|last seen wearing)\b/i },
  { id: 'serious-mva',     cls: 'traffic',  tier: 2, label: 'serious crash',      re: /\b(rollover|roll ?over|pinned? (?:in|under)|pedestrian struck|struck by a (?:car|vehicle|train)|ejected|head-?on)\b/i },
  { id: 'transit-emerg',   cls: 'transit',  tier: 2, label: 'transit emergency',  re: /\b(third rail|person (?:on|under) the tracks?|train (?:struck|disabled)|power (?:off|down) (?:on|at) the|tunnel (?:evacuation|smoke))\b/i },

  // Tier 1 is above routine. On its own none of this pages anybody. It changes
  // the shape of a scene score and it makes a pattern visible over a week.
  { id: 'self-harm',       cls: 'wellbeing', tier: 1, label: 'self harm concern', re: /\b(suicidal|suicide|section 12|self ?harm|cutting (?:him|her|them)self|jumper|threatening to jump|wants? to hurt (?:him|her|them)self)\b/i },
  { id: 'combative',       cls: 'violence', tier: 1, label: 'combative subject',  re: /\b(combative|violent|agitated|non ?compliant|resisting|uncooperative|out of control|erratic)\b/i },
  { id: 'crowd-forming',   cls: 'crowd',    tier: 1, label: 'crowd forming',      re: /\b(large (?:crowd|group|gathering)|crowd (?:of|is) |group of (?:\d+|about)|disperse|gathering outside|line (?:around|down) the block)\b/i },
  { id: 'infrastructure',  cls: 'infra',    tier: 1, label: 'infrastructure',     re: /\b(wires? down|power lines? down|transformer|water main|manhole|sinkhole|road (?:closure|closed)|bridge (?:closed|struck))\b/i },
  { id: 'weather',         cls: 'weather',  tier: 1, label: 'weather impact',     re: /\b(flooding|flooded|tree down|storm damage|ice (?:on|conditions)|white ?out|downed limb)\b/i },
  { id: 'urgency',         cls: 'officer',  tier: 1, label: 'urgency',            re: /\b(step it up|expedite|forthwith|rush(?:ing)? (?:it|them)|as soon as possible|right now|hurry)\b/i },
];

// Which unit dispatch sends is dispatch's own severity assessment, made by
// people with more information than this system will ever have, and it arrives
// free of charge in traffic we already transcribe. It is also close to
// impossible to fabricate, because a bomb squad was either named on the air or
// it was not. Highest precision per line of code in the whole build.
//
// Rescue companies are deliberately low. The corpus has Rescue 1 responding to
// a construction worker who clipped his ear at the end of a runway, and a
// gazetteer that pages the desk for that is a gazetteer nobody keeps.
const UNITS = [
  { tier: 3, label: 'bomb squad',        re: /\b(bomb squad|bomb tech|explosive ordnance|\beod\b|render safe)\b/i },
  { tier: 3, label: 'hazmat unit',       re: /\b(haz-?mat (?:unit|team|1|one)|decon(?:tamination)? unit)\b/i },
  { tier: 3, label: 'tactical team',     re: /\b(swat|\bsert\b|stop team|tactical (?:team|unit|operations)|entry team)\b/i },
  { tier: 3, label: 'air ambulance',     re: /\b(med ?flight|air ambulance|life ?flight)\b/i },
  { tier: 3, label: 'mass casualty unit', re: /\b(mass casualty (?:unit|bus)|\bmci\b (?:unit|bus)|triage unit)\b/i },

  { tier: 2, label: 'technical rescue',  re: /\b(technical rescue|collapse (?:unit|rescue)|trench rescue|confined space|high angle)\b/i },
  { tier: 2, label: 'marine or dive',    re: /\b(dive team|marine (?:unit|1|one)|harbor (?:patrol|unit)|fire ?boat)\b/i },
  { tier: 2, label: 'mobile command',    re: /\b(mobile command|command (?:unit|van|post)|field command|incident command)\b/i },
  { tier: 2, label: 'investigative unit', re: /\b(homicide|arson|fire investigation|\bfiu\b|crime scene|evidence response|major case)\b/i },
  { tier: 2, label: 'federal partner',   re: /\b(\bfbi\b|\batf\b|\bdea\b|u\.?s\.? marshals?|secret service|homeland security|\bhsi\b)\b/i },
  { tier: 2, label: 'specialist squad',  re: /\b(drug control|gang unit|youth violence|fugitive (?:unit|team)|warrant (?:unit|team)|special operations)\b/i },

  { tier: 1, label: 'K9',                re: /\b(k-?9|canine)\b/i },
  { tier: 1, label: 'emergency service', re: /\b(\besu\b|emergency service unit|special response)\b/i },
  { tier: 1, label: 'air support',       re: /\b(air ?wing|helicopter|\bhelo\b|state police air|drone (?:unit|team))\b/i },
  { tier: 1, label: 'command staff',     re: /\b((?:district|deputy|division|battalion) chief|duty (?:supervisor|officer)|night command|superintendent)\b/i },
];

// A closed set, because 105 of 150 transmissions currently carry no call type
// at all and an anomaly detector cannot find a deviation in a series that was
// never labelled. Every transmission gets one of these even when the honest
// answer is that somebody was reading a licence plate to a records clerk.
const CATEGORIES = [
  'violent-crime', 'property-crime', 'disorder', 'traffic', 'medical', 'fire',
  'alarm', 'hazard', 'transit', 'missing-person', 'wellbeing', 'assist',
  'investigation', 'unit-status', 'dispatch-admin', 'chatter', 'unintelligible', 'other',
];

// Three signals are broad enough to catch ordinary traffic on their own. A
// records check reads a plate and mentions a gun; a burglar alarm panel has a
// zone called perimeter. Each of these drops a tier when it is the only thing
// that fired, and carries full weight the moment anything else corroborates it.
const SOFT = new Set(['weapon-present', 'staging', 'more-units']);

function signalsIn(text) {
  const t = String(text || '');
  const out = [];
  for (const s of SIGNALS) {
    const m = s.re.exec(t);
    if (!m) continue;
    const before = t.slice(Math.max(0, m.index - 60), m.index);
    if (NEG.test(before)) continue;                 // they said it to rule it out
    out.push({ id: s.id, cls: s.cls, tier: s.tier, label: s.label, hedged: HEDGE.test(before), heard: m[0] });
  }
  return out;
}

function unitsIn(text, units) {
  const hay = String(text || '') + ' ' + (Array.isArray(units) ? units.join(' ') : String(units || ''));
  const out = [];
  for (const u of UNITS) if (u.re.test(hay)) out.push({ tier: u.tier, label: u.label });
  return out;
}

// Coarse category, guaranteed to return something. The model does this better
// when it is asked, and this runs when it is not, so the labelled series never
// has a hole in it.
//
// Two rules govern this table and both were learned the hard way.
//
// First, stems carry an explicit \w* rather than relying on the group's
// trailing \b. A pattern written \b(...|shoplift|...)\b demands a word boundary
// after the stem, so it matches "shoplift" and never "shoplifting", which is
// the only form anybody says on the radio. Eight stems were silently dead that
// way, including injur, stabb, investigat and arriv.
//
// Second, order is severity first rather than specificity first, because the
// first row that matches wins and a transmission about somebody being shot also
// mentions an ambulance. The two deliberate inversions are alarm above fire, so
// a fire alarm is filed as an alarm rather than as a fire, and wellbeing above
// medical, so a section 12 is not filed as a transport.
const CAT = [
  ['violent-crime',  /\b(assault\w*|fight\w*|robber\w*|stabb\w*|shoot\w*|shot (?:at|him|her|them)|\bgun\b|firearm|knife|machete|domestic|threat\w*|punch\w*|struck (?:him|her|them)|beat(?:en|ing) up|strangl\w*|\ba ?& ?b\b)\b/i],
  ['hazard',         /\b(haz-?mat|gas leak|odor of (?!smoke|something burning)|smell of gas|wires? down|pole (?:down|on fire)|flood\w*|spill\w*|carbon monoxide|\bco detector\b|leak\w*|transformer|live wire)\b/i],
  ['alarm',          /\b(alarm|audible|burglar alarm|fire alarm|panel|zone \d|false alarm|master box|trouble signal|holdup button|panic button)\b/i],
  ['fire',           /\b(fire|smoke|engine \d|ladder \d|tower \d|sprinkler|smell of (?:smoke|something burning)|box alarm|burning|flames?)\b/i],
  ['missing-person', /\b(missing|last seen|walk(?:ed)? away|runaway|silver alert|amber alert|wander\w*|did not (?:come|return) home)\b/i],
  ['wellbeing',      /\b(well(?:ness| ?being)? check|section 12|suicid\w*|emotionally disturbed|\bedp\b|check on the|cutting (?:him|her)self|welfare check|harm (?:him|her)self|threatening to jump)\b/i],
  ['property-crime', /\b(break ?in|breaking and entering|burglar\w*|larcen\w*|shoplift\w*|stolen|steal\w*|theft|vandal\w*|trespass\w*|open door|forced entry|smashed|pried|\bb ?& ?e\b)\b/i],
  ['medical',        /\b(medical|\bems\b|ambulance|patient|injur\w*|unresponsive|bleeding|sick|fell|fall(?:en)?|overdose|narcan|cardiac|\bcpr\b|seizure|diabetic|chest pain|difficulty breathing|stroke|conscious\w*|stretcher|transport(?:ing)? to|hospital|\bbls\b|\bals\b|medic \d|clipped (?:his|her))\b/i],
  ['transit',        /\b(train|platform|station|\bmbta\b|commuter ?rail|red line|orange line|green line|blue line|silver line|trolley|bus \d|fare|turnstile|third rail|derail\w*)\b/i],
  ['traffic',        /\b(motor vehicle|\bmva\b|accident|collision|tow(?:ed|ing)?|parking|traffic|roadway|plate|registration|crosswalk|double ?park\w*|blocking the|hit and run|road ?rage)\b/i],
  ['disorder',       /\b(disturbance|noise|loud|unwanted|disorderly|argument|panhandl\w*|loiter\w*|yelling|screaming|intoxicated|refus\w*|removed from|kick(?:ed)? out|eject\w*|unruly|causing a (?:problem|scene))\b/i],
  ['investigation',  /\b(investigat\w*|follow ?up|detective|statement|witness|canvass\w*|surveillance|video|camera|footage|\bbolo\b|report of|stating that|calling part(?:y|ies))\b/i],
  ['assist',         /\b(assist\w*|mutual aid|other agency|escort|stand ?by for|back ?up|cover (?:me|him|her|them)|go by|swing by|take a (?:ride|run|look) by|check the area)\b/i],
  ['dispatch-admin', /\b(records|warrant check|licen[cs]e|\bncic\b|\brmv\b|phone number|call(?: the| back)|voicemail|paperwork|report number|\bcad\b|meal|detail|relief|shift|release|log (?:it|me))\b/i],
  ['unit-status',    /\b(clear(?:ed|ing)?|in service|out at|on scene|arriv\w*|en ?route|responding|copy(?: that)?|10-?4|10-?8|10-?23|received|go ahead|show (?:me|us)|affirmative|negative|all set|standing by|we have it|on the air|back in|mad[ei] contact|make contact|scene (?:is |to be )?secure|no luck|nothing showing)\b/i],
];

// Most radio traffic is a callsign and four words. Labelling that honestly as
// unit status beats dropping it in a catch-all, because a catch-all holding two
// thirds of the stream tells an anomaly detector nothing at all.
const CALLSIGN = /(^\s*\d{1,4}\b)|\b(?:adam|boy|charles|david|edward|frank|george|henry|ida|john|king|lincoln|mary|nora|ocean|paul|queen|robert|sam|tom|union|victor|william|xray|young|zebra|tango|alpha|bravo|delta|echo|engine|ladder|rescue|car|unit|tower|squad|medic) ?-? ?\d{1,4}\b/i;

// A dispatcher reading a case number, a plate or a callback digit by digit
// produces a line that is mostly numerals and hyphens. It carries no incident
// meaning at all, and it is long enough to slip past the chatter cutoff, so it
// gets named for what it is rather than left in the catch-all.
const READBACK = /^[\s\d.,;:\-()]*$/;
function numeric(t) {
  const digits = (t.match(/\d/g) || []).length;
  return digits >= 8 && digits / t.replace(/\s/g, '').length > 0.45;
}

function classify(text) {
  const t = String(text || '').trim();
  if (t.length < 13) return 'unintelligible';
  if (READBACK.test(t) || numeric(t)) return 'dispatch-admin';
  for (const [name, re] of CAT) if (re.test(t)) return name;
  if (CALLSIGN.test(t)) return 'unit-status';
  if (t.length < 70) return 'chatter';
  return 'other';
}

// One transmission, assessed. Deliberately returns its reasoning rather than a
// bare number, because an analyst who cannot see which words fired has no way
// to decide whether to trust the alert, and an alert nobody trusts gets muted.
function assess({ text, units } = {}) {
  const t = String(text || '');
  const signals = signalsIn(t);
  const specialist = unitsIn(t, units);

  // A soft signal carries full weight only once something else agrees with it.
  const corroborated = signals.some(s => !SOFT.has(s.id)) || specialist.length > 0;
  let tier = 0;
  for (const s of signals) {
    const v = (SOFT.has(s.id) && !corroborated) ? Math.max(0, s.tier - 1) : s.tier;
    s.effective = v;
    if (v > tier) tier = v;
  }
  for (const u of specialist) if (u.tier > tier) tier = u.tier;

  const top = signals.filter(s => s.effective === tier);
  const a = {
    tier,
    tierName: TIER_NAME[tier],
    classes: [...new Set(signals.map(s => s.cls))],
    signals,
    units: specialist,
    // Everything that put this at its tier came from a caller rather than a
    // responder. Still worth surfacing, worth labelling as unconfirmed.
    hedged: top.length > 0 && top.every(s => s.hedged),
    // A named specialist unit is self evidencing in a way a phrase is not, so
    // it is the one thing that can carry an alert on a single transmission.
    selfEvident: specialist.length > 0,
    category: classify(t),
  };
  a.why = explain(a);
  return a;
}

function explain(a) {
  if (!a || !a.tier) return '';
  const bits = [];
  const seen = new Set();
  for (const s of a.signals) {
    if (seen.has(s.label)) continue;
    seen.add(s.label);
    bits.push(s.hedged ? s.label + ' (reported)' : s.label);
  }
  for (const u of a.units) bits.push(u.label + ' assigned');
  return bits.join(', ');
}

module.exports = {
  assess, explain, signalsIn, unitsIn, classify,
  SIGNALS, UNITS, CATEGORIES, TIER_NAME, SOFT,
};
