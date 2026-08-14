// tools/test-severity.js
//
//   node tools/test-severity.js
//
// Three nights, scored by the floor rather than by a model's enthusiasm:
// the fabricated Walden shooter, the real Lancaster Street stabbing, and the
// South Station stabbing whose transcripts were useless.

const sev = require('../lib/severity.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '   ' + detail : '')); }
};

/* --- the card that should never have existed --------------------------- */
/* One unit clearing an address. The model called it a confirmed active
   shooter, which on a 0-5 scale is a 5. */
const WALDEN = {
  tx: [{ text: 'I am good to go. All right, Jake 201. Sorry. 81 Walden Street.', feed: 'boston-police', signals: [] }],
  feeds: ['boston-police'],
  units: ['JAKE201'],
  spanMin: 0,
  anomaly: { level: 'normal' },
};
{
  const f = sev.floor(WALDEN);
  const s = sev.settle(f, { score: 5 });
  ok('the floor sees nothing much', f.score <= 1, 'floor=' + f.score);
  ok('a model calling it a 5 is capped', s.score <= 2, 'settled=' + s.score);
  ok('and the cap is recorded, not hidden', s.capped === true && /model called this a 5/.test(s.why || ''), s.why);
  ok('nobody gets paged', sev.pages(s, f) === false);
}

/* --- the real one ------------------------------------------------------- */
/* Lancaster Street: EMS dispatch, BPD scene traffic, fire on the same block,
   two victims, tape, notifications, running most of an hour. */
const LANCASTER = {
  tx: [
    { text: 'reports of a person being stabbed, 30 Lancaster Street', feed: 'boston-ems', signals: [{ id: 'stabbing', tier: 3 }] },
    { text: 'one stab in the abdomen, she was holding the knife, two victims', feed: 'boston-police', signals: [{ id: 'stabbing', tier: 3 }] },
    { text: 'take me off at the stabbing and make full notifications', feed: 'boston-police', signals: [{ id: 'stabbing', tier: 3 }] },
    { text: 'auto investigator for anyone going with the one ambulance', feed: 'boston-fire-department', signals: [] },
  ],
  feeds: ['boston-ems', 'boston-police', 'boston-fire-department'],
  units: ['P1', 'A15', 'S690', 'A13', 'BRAVO436'],
  spanMin: 58,
  anomaly: { level: 'watch', why: 'busier than usual for a Thursday lunch hour' },
};
{
  const f = sev.floor(LANCASTER);
  const s = sev.settle(f, { score: 4 });
  ok('a real stabbing clears the bar on evidence alone', f.score >= 4, 'floor=' + f.score);
  ok('the model agreeing changes nothing', s.score >= 4 && s.capped === false, 'settled=' + s.score);
  ok('this one pages', sev.pages(s, f) === true);
  ok('and it reads in English', /big|everything stops/.test(sev.label(s.score)), sev.label(s.score));
}

/* --- the one that started all of this ----------------------------------- */
/* South Station, 5:30pm. Transit, BPD and EMS all working a homicide, and
   every transcript came out as garbage: no stabbing, no victim, no address.
   Word-based detection had nothing to find. The radio still got loud. */
const SOUTH_STATION = {
  tx: [
    { text: 'Headwalks crossing on the platform, we got a reporter of a consortally party', feed: 'mbta-transit-police', signals: [] },
    { text: '518 operation, units expiring to Rob Square, caution to disregard', feed: 'mbta-transit-police', signals: [] },
    { text: 'Kilo 981. Put me Oss and Frank and Oss from the room 14.', feed: 'boston-police', signals: [] },
    { text: 'Sixteen sixteen. Ambulance one Boston. Do you have a transporter?', feed: 'boston-ems', signals: [] },
  ],
  feeds: ['mbta-transit-police', 'boston-police', 'boston-ems'],
  units: ['C517', 'C619', 'A1'],
  spanMin: 52,
  anomaly: { level: 'high', why: '31 transmissions against a norm of 9 for a Wednesday 5pm (3.4 sigma)' },
  fleet: { level: 'watch' },
};
{
  const f = sev.floor(SOUTH_STATION);
  ok('unreadable transcripts still raise a flag', f.score >= 3, 'floor=' + f.score);
  ok('and the flag says why, without quoting a word of it',
     f.reasons.some(r => /above normal/.test(r)) && f.reasons.some(r => /agencies/.test(r)),
     JSON.stringify(f.reasons));
  /* The model, reading the same garbage, sees nothing and says so. The floor
     does not let that close the case. */
  const s = sev.settle(f, { score: 1 });
  ok('a model that sees nothing can lower it', s.score === 1);
  ok('but the floor is still on the record for a person to check',
     s.floorSaid >= 3, 'floorSaid=' + s.floorSaid);
}

/* --- the pure-surge case ------------------------------------------------ */
{
  const f = sev.floor({ tx: [], feeds: [], anomaly: { level: 'high', why: 'far above normal' } });
  ok('a surge with no legible traffic is still worth a glance', f.score >= 2, 'floor=' + f.score);
}

/* --- the fireground, which is a single-agency event by nature ------------
 *
 * 14 August, 01:43 to 02:08. A Needham/Brookline box ran for twenty-five
 * minutes with command established and crews clearing ladders, and the board
 * showed zero situations while the desk read called it "a fire line wrapping
 * up" and spent its three watch slots on a sleeping man in a U-Haul.
 *
 * Two things buried it. lib/threat.js can only see a fire when somebody says
 * "working fire" or "fully involved", and firefighters say "command to fire
 * line" and "first stream is 207" instead. And the floor's strongest signal
 * is agencies converging, which is a superb tell for violence and a useless
 * one for fire, because fire does not need police to show up to be a fire.
 */
{
  const T = (t) => ({ text: t, feed: 'needham-brookline-police-fire', units: [], signals: [] });
  const scene = {
    tx: [
      T('For box 1-8, report of carbon monoxide. Attention engine 3, ladder 2. Respond to 108 Harvard Street.'),
      T('Harbor, command to fire line. Fire line, I am answered, have it in command.'),
      T('Ending 3 is going to remain on steam a while longer. I am going to be clearing ladders. First stream is 207.'),
      T('Latitude of fire law. Latitude is returning. 208.'),
    ],
    feeds: ['needham-brookline-police-fire'],
    units: ['E3', 'L2'], spanMin: 25, anomaly: { level: 'normal' },
  };
  const f = sev.floor(scene);
  ok('a fireground on ONE feed still reaches a story', f.score >= 3, 'floor=' + f.score);
  ok('and says why in words a person can check',
     f.reasons.some(r => /fireground/.test(r)), JSON.stringify(f.reasons));
  ok('minutes of work count once there is work',
     f.reasons.some(r => /working it for/.test(r)), JSON.stringify(f.reasons));

  /* The same vocabulary clearing a box that was nothing must not do this. */
  const dud = {
    tx: [
      T('Box 2171, located 850 Cambridge Street. Response is Engine 5, Engine 3, Ladder 1, Division 1.'),
      T('We have nothing at this location. Hold the Division 1 only.'),
      T('Nothing at that location. A juvenile may have pulled that box. You can show all companies available.'),
    ],
    feeds: ['cambridge-ma-fire'], units: ['E5', 'E3', 'L1'], spanMin: 12, anomaly: { level: 'normal' },
  };
  ok('a box that turns out to be nothing stays down', sev.floor(dud).score < 3, 'floor=' + sev.floor(dud).score);

  /* One line is not a fire. Two separate transmissions are required so a
     single garbled sentence cannot conjure a fireground. */
  const one = { tx: [T('Command to fire line, have it in command.')], feeds: ['boston-fire'], units: [], spanMin: 2, anomaly: { level: 'normal' } };
  ok('one operations phrase alone is not a fireground', sev.floor(one).score < 3, 'floor=' + sev.floor(one).score);

  const fg = sev.fireground(scene.tx);
  ok('fireground() counts the operations transmissions', fg.ops >= 2, 'ops=' + fg.ops);
  ok('and flags a scene somebody called nothing', sev.fireground(dud.tx).nothing === true);
}

/* --- the floor has to be a floor --------------------------------------- */
{
  const T = (t, f) => ({ text: t, feed: f, units: [], signals: [{ id: 'stabbing', tier: 3 }], tier: 3 });
  const stabbing = {
    tx: [
      T('Stabbing to Dunkin Donuts, 510 South Hampton Street. 224-21.', 'boston-ems'),
      T('Calling in now, stating that he was stabbed. Can you start EMS?', 'boston-police'),
    ],
    feeds: ['boston-ems', 'boston-police'], units: ['A21', 'C112'],
    spanMin: 4, anomaly: { level: 'normal' },
  };
  const f = sev.floor(stabbing);
  ok('a stabbing said out loud is marked as heard, not merely scored',
     f.heard >= 3, 'heard=' + f.heard);

  /* settle() took Math.min alone, and the analyst hands in 4 for a
     high-priority card and 2 for everything else. So a stabbing with an EMS
     unit and a BPD unit on it scored 5 on the floor, was filed normal, and
     settled at 2: below the bar, never verified, never in Situations. The
     floor named it perfectly and had no power. */
  ok('a model calling it ordinary cannot take it under a story',
     sev.settle(f, { score: 2 }).score >= 3, 'settled=' + sev.settle(f, { score: 2 }).score);
  ok('nor can a model calling it nothing',
     sev.settle(f, { score: 1 }).score >= 3);
  ok('and the disagreement is on the record rather than inferred',
     sev.settle(f, { score: 1 }).held === true);
  ok('a model that agrees is left alone', sev.settle(f, { score: 4 }).score === 4);

  /* Down stays free for inference. Convergence, volume and duration are
     patterns, and a model that reads the words and concludes a busy block was
     nothing is usually right. That is the Walden protection and it must not
     have been weakened by any of this. */
  const pattern = {
    tx: [{ text: 'units checking the area, nothing further', feed: 'boston-police', units: [], signals: [] }],
    feeds: ['boston-police', 'boston-ems', 'boston-fire'], units: ['A', 'B', 'C', 'D', 'E'],
    spanMin: 50, anomaly: { level: 'high' },
  };
  const g = sev.floor(pattern);
  ok('a floor built only from patterns records nothing as heard', g.heard === 0, 'heard=' + g.heard);
  ok('so a model can still talk a pattern all the way down',
     sev.settle(g, { score: 1 }).score === 1, 'settled=' + sev.settle(g, { score: 1 }).score);
  ok('and the Walden cap still holds in the other direction',
     sev.settle({ score: 0, heard: 0, reasons: [] }, { score: 5 }).score <= 1);

  /* A fireground is something that was heard too. */
  const fire = {
    tx: [
      { text: 'command to fire line, have it in command', feed: 'boston-fire', units: [], signals: [] },
      { text: 'clearing ladders, first stream is 207', feed: 'boston-fire', units: [], signals: [] },
    ],
    feeds: ['boston-fire'], units: ['E3'], spanMin: 25, anomaly: { level: 'normal' },
  };
  ok('crews working a fire counts as heard, not inferred', sev.floor(fire).heard >= 3);
  ok('so a fire cannot be talked down either', sev.settle(sev.floor(fire), { score: 2 }).score >= 3);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
