// tools/test-judge.js
//
// The two roads onto the board, and the guardrail that was only on one of them.
//
// A situation reaches the newsroom's screen by one of two paths.
// api/cron/analyst.js runs in the cloud every minute. api/analyst-report.js
// takes a report from the model on the Mac mini, and accepting one makes the
// cron stand down for ten minutes.
//
// The header of api/analyst-report.js says, and said for weeks, that every
// guardrail the cloud path has runs there identically. The severity floor and
// the second-opinion verifier were written into the cron only. So a local
// report put the raw model's word on the board with nothing checking it and
// nothing scheduled to come along behind it. That is the exact failure the
// floor and the verifier were built for, running unopposed on the road nobody
// was watching.
//
// lib/judge.js is the one implementation now. These tests are about the seam,
// not the scoring: that both callers use it, that its output survives onto the
// board, and that nobody quietly grows a third copy.

'use strict';

const path = require('path');
const fs = require('fs');
const verify = require('../lib/verify');
const { judge } = require('../lib/judge');
const { reconcile } = require('../lib/threads');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fail++;
  console.log('  FAIL ' + name + (extra ? '  ' + extra : ''));
}

/* No network. The verifier is replaced by a stand-in that records what it was
   asked and answers however the test needs. */
const realCheck = verify.check;
let asked = [];
function stubVerifier(answer) {
  asked = [];
  verify.check = async (claim, batch) => {
    asked.push({ claim, lines: (batch || []).length });
    return answer;
  };
}
const SUPPORTED = { ran: true, supported: true, model: 'stub/verifier', quote: 'shots fired, Blue Hill Ave' };
const REFUTED = { ran: true, supported: false, model: 'stub/verifier', refutes: 'no transcript says that' };

const tx = (over) => Object.assign({
  at: '2026-08-17T02:24:10.000Z',
  feed: 'boston-police',
  text: 'Shots fired, Blue Hill Ave and Talbot. Two units responding.',
  units: ['C11'],
  tier: 3,
  signals: [{ id: 'shots-fired', tier: 3, effective: 3, label: 'shots fired' }],
}, over || {});

const sit = (over) => Object.assign({
  id: 'sit-1',
  headline: 'Shots fired in Dorchester',
  summary: 'Police responding to reported gunfire at Blue Hill Ave and Talbot.',
  type: 'police', priority: 'high', confidence: 'reported',
  feeds: ['boston-police', 'boston-ems'],
  location: 'Blue Hill Ave and Talbot Ave',
}, over || {});

async function run() {
  /* --- the floor runs, and can talk a model down --------------------------- */

  stubVerifier(SUPPORTED);
  {
    /* A model shouting "high" over a single routine transmission. The floor is
       the reason this cannot reach the board. */
    const quiet = [{ at: '2026-08-17T02:24:10.000Z', feed: 'boston-police',
                     text: 'Car 11 clearing that address, nothing showing.', units: ['C11'], signals: [] }];
    const [f] = await judge([sit({ headline: 'Active shooter downtown' })], { batch: quiet });
    ok('a high-priority claim over one quiet transmission does not reach the bar',
       f.severity < 3, 'severity=' + f.severity + ' ' + JSON.stringify(f.severityWhy));
    ok('and is not major', f.major !== true);
    ok('and its priority is walked back so the UI agrees with the score',
       f.priority === 'normal', f.priority);
    ok('the verifier is not asked about something already below the bar',
       asked.length === 0, JSON.stringify(asked));
  }

  /* --- a real one gets through -------------------------------------------- */

  stubVerifier(SUPPORTED);
  {
    const rows = [tx(), tx({ feed: 'boston-ems', at: '2026-08-17T02:25:30.000Z',
                             text: 'EMS 4 responding, one party down, Blue Hill Ave.' })];
    const [f] = await judge([sit()], { batch: rows });
    ok('a corroborated shots-fired call reaches the bar', f.severity >= 3, 'severity=' + f.severity);
    ok('the second opinion is asked', asked.length === 1, JSON.stringify(asked));
    ok('and it is shown the situation\'s own transmissions, not the whole batch',
       asked[0] && asked[0].lines === 2, JSON.stringify(asked));
    ok('a stood-up claim is major', f.major === true,
       JSON.stringify({ held: f.held, verified: f.verified, sev: f.severity }));
    ok('and says who stood it up', f.verifiedBy === 'stub/verifier');
  }

  /* --- silence is not consent --------------------------------------------- */

  stubVerifier(REFUTED);
  {
    const rows = [tx(), tx({ feed: 'boston-ems', at: '2026-08-17T02:25:30.000Z' })];
    const [f] = await judge([sit()], { batch: rows });
    ok('a claim a second model cannot stand up is held', f.held === true, f.heldWhy);
    ok('and held is never major, whatever it scored', f.major !== true, 'severity=' + f.severity);
    ok('and it says what failed, rather than vanishing',
       typeof f.heldWhy === 'string' && f.heldWhy.length > 10, f.heldWhy);
  }

  /* --- the seam: the verdict has to survive onto the board ----------------- */
  /* reconcile() built the board object from a fixed field list that did not
     include any of these, so a verified priority-high stabbing landed on the
     board with no `major` and Situations Mode read "Nothing has cleared the
     bar" for an entire night. */

  stubVerifier(SUPPORTED);
  {
    const rows = [tx(), tx({ feed: 'boston-ems', at: '2026-08-17T02:25:30.000Z' })];
    const judged = await judge([sit()], { batch: rows });
    const board = reconcile([], judged, {}).situations;
    ok('a judged situation reaches the board at all', board.length === 1);
    ok('major survives reconcile', board[0].major === true, JSON.stringify(Object.keys(board[0])));
    ok('so does the score the desk shows', board[0].severity >= 3, String(board[0].severity));
    ok('and the reason line, which is the whole of why anyone trusts it',
       Array.isArray(board[0].severityWhy) && board[0].severityWhy.length > 0,
       JSON.stringify(board[0].severityWhy));

    /* And an update of the same situation must not drop them either. */
    const again = reconcile(board, judged, {}).situations;
    ok('and they survive the update branch too, not just the new-situation one',
       again[0] && again[0].major === true, JSON.stringify(again[0] && again[0].major));
  }

  /* --- both roads, enforced ------------------------------------------------ */
  /*
     A structural assertion, because the behavioural ones only cover the path
     someone remembered to wire. If a third writer of `major` appears, or if
     either endpoint stops calling judge(), this fails. */
  {
    const root = path.join(__dirname, '..');
    const endpoints = ['api/cron/analyst.js', 'api/analyst-report.js'];
    for (const rel of endpoints) {
      const src = fs.readFileSync(path.join(root, rel), 'utf8');
      ok(rel + ' runs the shared judgment', /\bjudge\s*\(/.test(src));
      ok(rel + ' does not score severity itself', !/severity\.(floor|settle)\s*\(/.test(src));
      ok(rel + ' does not call the verifier itself', !/verify\.check\s*\(/.test(src));
      ok(rel + ' does not decide major itself', !/\.major\s*=/.test(src));
    }
    /* Nothing else anywhere may set it either. */
    const offenders = [];
    for (const dir of ['lib', 'api', path.join('api', 'cron')]) {
      const full = path.join(root, dir);
      if (!fs.existsSync(full)) continue;
      for (const name of fs.readdirSync(full)) {
        if (!name.endsWith('.js')) continue;
        const rel = path.join(dir, name);
        if (rel === path.join('lib', 'judge.js') || rel === path.join('lib', 'threads.js')) continue;
        if (/\.major\s*=/.test(fs.readFileSync(path.join(root, rel), 'utf8'))) offenders.push(rel);
      }
    }
    ok('only lib/judge.js decides what is major', offenders.length === 0, offenders.join(', '));
  }

  /* --- the fleet reading, which was computed nowhere ----------------------- */
  /* lib/severity.js has a clause for the citywide surge: several feeds each
     running well above normal is an event no single feed would report, and it
     is the one signal that survives transcription failing completely. Nothing
     ever passed `fleet`, so the clause was dead. */
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'judge.js'), 'utf8');
    ok('the fleet reading is computed and passed to the floor',
       /fleet/.test(src) && /severity\.floor\([^)]*fleet/.test(src.replace(/\s+/g, ' ')));
  }

  verify.check = realCheck;
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
}

run().catch(e => { verify.check = realCheck; console.log('  THREW ' + (e && e.stack || e)); process.exit(1); });
