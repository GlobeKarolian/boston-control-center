// tools/cron-cost.js
//
// What does one tick of each cron actually cost in Redis commands?
//
// Upstash caps and bills per command, not per request, so a pipeline of five
// SETs is five. The free tier is 500,000 a month. Divided by 43,200 minutes
// that is 11.6 commands a minute for the entire system, browsers included.
// On 31 July 2026 that cap ran out and every write started failing, which
// reached the newsroom as an empty board and the relay as
// "could not reach the dashboard (HTTP 500)".
//
//   node tools/cron-cost.js
//
// Measured by handing lib/kv fake credentials and stubbing fetch, NOT by using
// its in-memory fallback. That distinction is why this file can be trusted:
// thirteen helpers in kv.js short-circuit on !LIVE and never reach the
// transport, so a memory-mode count silently reports zero for exactly the
// helpers a cron leans on hardest. An earlier draft did that and scored four
// of the eight crons at zero. With fake credentials every helper takes the
// real path and the stub counts what would have gone to Upstash.
//
// Reads answer empty on purpose. Most ticks have nothing to do, and a tick
// with nothing to do is where a per-minute schedule either costs nothing or
// costs everything.
//
// Why each schedule is what it is. analyst stays per-minute because it is the
// live board and it is the product. The rest are periodic maintenance and were
// never worth per-minute money: sweep closes stale incidents on a 45 to 90
// minute clock, activity is a context layer, baseline is an hourly statistic.
// Four of them ran on * * * * * and spent 28.5 commands a minute between them,
// 1.23M a month against a 500,000 cap, most of it on ticks with nothing to do.
//
// This paragraph used to sit in vercel.json under a _crons_note key. Vercel
// validates that file against a closed schema and refuses to deploy on any key
// it does not recognise, so the note broke the build. Notes about the schedules
// belong here, beside the thing that measures them. tools/check-vercel.js now
// fails on comment-shaped keys so nobody rediscovers this the hard way.

process.env.KV_REST_API_URL = 'https://stub.invalid';
process.env.KV_REST_API_TOKEN = 'stub';

let COMMANDS = [];

global.fetch = async (url, opts) => {
  const cmds = JSON.parse(opts.body);
  for (const c of cmds) COMMANDS.push(String(c[0]).toUpperCase());
  return {
    ok: true,
    status: 200,
    async json() { return cmds.map(c => ({ result: reply(String(c[0]).toUpperCase()) })); },
    async text() { return ''; },
  };
};

/* An empty store, in whatever shape each command expects its emptiness. */
function reply(verb) {
  if (verb === 'SET') return 'OK';
  if (verb === 'HGETALL' || verb === 'LRANGE' || verb === 'MGET') return [];
  if (verb === 'EVAL' || verb === 'DEL' || verb === 'HSET' || verb === 'LPUSH') return 0;
  if (verb === 'PING') return 'PONG';
  return null;                       // GET and friends: nothing there yet
}

const kv = require('../lib/kv');
if (!kv.live) { console.error('kv did not come up live, the stub credentials did not take'); process.exit(1); }

const MIN = 43200;                   // minutes in a 30 day month
const FREE = 500000;

/* What one real ingest costs. Measured against api/ingest.js on a segment that
   carries text: the health hash, the transcript list, the signature, the
   extractor output, the feed roll. Used only for the headroom line at the
   bottom, which is the line that actually decides whether this plan works. */
const PER_INGEST = 13;

/* The schedules are read from vercel.json rather than restated here. This tool
   exists to answer "what does the deployment cost", and a copy of the schedule
   that has to be kept in step by hand answers "what did it cost when somebody
   last remembered to update this file". */
function expand(field, max) {
  const out = new Set();
  for (const part of String(field).split(',')) {
    const [range, stepRaw] = part.split('/');
    const step = stepRaw ? parseInt(stepRaw, 10) : 1;
    let lo = 0, hi = max;
    if (range !== '*') {
      const m = range.split('-');
      lo = parseInt(m[0], 10);
      hi = m.length > 1 ? parseInt(m[1], 10) : (stepRaw ? max : lo);
    }
    for (let v = lo; v <= hi && step > 0; v += step) out.add(v);
  }
  return out.size;
}

function runsPerDay(expr) {
  const f = String(expr).trim().split(/\s+/);
  if (f.length !== 5) return { perDay: null, daily: false };
  const daily = f[2] === '*' && f[3] === '*' && f[4] === '*';
  return { perDay: expand(f[0], 59) * expand(f[1], 23), daily };
}

const CRONS = (require('../vercel.json').crons || []).map(c => {
  const r = runsPerDay(c.schedule);
  return {
    path: String(c.path).replace(/^.*\//, ''),
    note: c.schedule,
    perDay: r.perDay,
    /* A schedule with a day-of-week or day-of-month filter runs fewer times
       than the minute and hour fields alone suggest, so the number below is a
       ceiling for those. Nothing in this deployment uses one today. */
    daily: r.daily,
  };
}).filter(c => c.perDay !== null);

const res = () => ({
  _s: 200, _b: null,
  setHeader() { return this; },
  status(x) { this._s = x; return this; },
  send(b) { this._b = b; return this; },
  json(b) { this._b = b; return this; },
  end(b) { this._b = b; return this; },
});

const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));
const lpad = (s, n) => ' '.repeat(Math.max(0, n - String(s).length)) + String(s);
const tally = (list) => {
  const m = {};
  for (const v of list) m[v] = (m[v] || 0) + 1;
  return Object.keys(m).sort((a, b) => m[b] - m[a]).map(k => k + ' x' + m[k]).join('  ');
};

(async () => {
  console.log('\n  one idle tick, measured on the real transport\n');
  console.log('  ' + pad('cron', 11) + pad('schedule', 13) + lpad('cmds', 5)
    + lpad('per month', 11) + lpad('of free', 9) + '   ' + 'what it spends it on');
  console.log('  ' + '-'.repeat(92));

  let total = 0;
  const rows = [];

  for (const c of CRONS) {
    let handler;
    try { handler = require('../api/cron/' + c.path + '.js'); }
    catch (e) { console.log('  ' + pad(c.path, 11) + 'not loadable: ' + e.message); continue; }

    COMMANDS = [];
    const r = res();
    let why = '';
    try {
      await Promise.race([
        handler({ method: 'GET', headers: {}, query: {}, url: '/api/cron/' + c.path }, r),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), 25000)),
      ]);
      why = tally(COMMANDS) || 'nothing';
    } catch (e) {
      /* A handler that throws still issued whatever it issued before throwing,
         and that is what the counter holds. But a zero has two very different
         meanings, so say which one this is: a cron that is genuinely cheap and
         a cron that died on line one both score zero, and only one of those is
         good news. */
      why = (tally(COMMANDS) || 'nothing') + '  [threw: ' + String(e && e.message).slice(0, 38) + ']';
    }

    const n = COMMANDS.length;
    const perMonth = n * c.perDay * 30;
    total += perMonth;
    rows.push({ ...c, cmds: n, perMonth });

    console.log('  ' + pad(c.path, 11) + pad(c.note, 13) + lpad(n, 5)
      + lpad(perMonth.toLocaleString(), 11)
      + lpad((perMonth / FREE * 100).toFixed(1) + '%', 9)
      + '   ' + why);
  }

  console.log('  ' + '-'.repeat(92));
  console.log('  ' + pad('crons alone', 24) + lpad(total.toLocaleString(), 16)
    + lpad((total / FREE * 100).toFixed(0) + '%', 9));

  console.log('\n  The free tier is ' + FREE.toLocaleString() + ' commands a month, which is '
    + (FREE / MIN).toFixed(1) + ' a minute for everything.');
  console.log('  Crons alone spend ' + (total / MIN).toFixed(1)
    + ' a minute, before one scanner POST or one browser refresh.');

  const perMin = rows.filter(r => r.perDay >= 1440);
  if (perMin.length) {
    const pm = perMin.reduce((a, b) => a + b.perMonth, 0);
    console.log('\n  The ' + perMin.length + ' on a per-minute schedule ('
      + perMin.map(r => r.path).join(', ') + ') '
      + (perMin.length === 1 ? 'accounts' : 'account') + ' for ' + pm.toLocaleString()
      + ',\n  or ' + (pm / FREE * 100).toFixed(0) + '% of the month, and most of those ticks have nothing to do.');
  }

  /* The line the whole tool is for. Everything above is what the deployment
     spends while nobody is using it. What is left over is what the newsroom
     gets to spend on the thing the newsroom is for. */
  const left = FREE - total;
  console.log('\n  ' + '-'.repeat(92));
  if (left <= 0) {
    console.log('  Crons alone are over the free tier by ' + (-left).toLocaleString()
      + ' commands. There is no headroom for ingest or for browsers at all.');
  } else {
    const segs = Math.floor(left / PER_INGEST);
    console.log('  That leaves ' + left.toLocaleString() + ' commands a month for everything else,'
      + '\n  and one scanner segment carrying text costs about ' + PER_INGEST + '.');
    console.log('  So the free tier buys roughly ' + segs.toLocaleString() + ' transmissions a month, '
      + Math.floor(segs / 30).toLocaleString() + ' a day,'
      + '\n  across all feeds, with nothing set aside for a browser refreshing the board.');
    console.log('\n  Six Boston feeds run past that inside a day. Stretching the schedules buys'
      + '\n  headroom, not a solution. The command cap is the wrong shape for this product:'
      + '\n  a paid plan with unmetered commands is what makes it work.');
  }
  console.log('');
  process.exit(0);
})();
