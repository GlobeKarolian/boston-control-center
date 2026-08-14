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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
