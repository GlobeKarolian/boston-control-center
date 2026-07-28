/* Structural check, run before e2e. Nothing here exercises behaviour: it asks
   only whether the deployment described in vercel.json is the one that exists
   on disk, and whether every module still loads.

   This catches the class of mistake that unit tests are blind to, because a
   cron pointing at a file that was renamed does not fail any assertion, it just
   never runs, and a route missing from `functions` silently gets the default
   10-second timeout. Both look fine locally and are only visible in production
   as an absence. */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);

/* Loading every module means loading kv.js, which decides at require time
   whether it is talking to Redis. Clear the credentials so a developer with a
   populated shell gets the same answer as CI. */
delete process.env.KV_REST_API_URL;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.REDIS_REST_URL;
delete process.env.BESTTIME_API_KEY_PRIVATE;

let bad = 0;
const ok = (l, c, x) => { console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x ? '   ' + x : '')); if (!c) bad++; };
const abs = f => path.join(ROOT, f);
const first = e => String(e && e.message || e).split('\n')[0];

const vj = JSON.parse(fs.readFileSync(abs('vercel.json'), 'utf8'));

console.log('\n=== 1. vercel.json describes files that exist ===');
for (const c of vj.crons) {
  const f = 'api' + c.path.replace(/^\/api/, '') + '.js';
  ok('cron ' + c.path + ' has a handler', fs.existsSync(abs(f)), c.schedule);
}
for (const k of Object.keys(vj.functions)) ok('functions entry ' + k, fs.existsSync(abs(k)));
for (const r of vj.rewrites) {
  const f = r.destination.replace(/^\//, '') + '.js';
  ok('rewrite ' + r.source, fs.existsSync(abs(f)), '-> ' + f);
}

/* A cron whose function is not in `functions` runs on the default 10s budget.
   The BestTime sweeps take minutes, so this is the difference between a working
   forecast and a timeout every three hours. */
console.log('\n=== 2. every cron declares its own duration ===');
for (const c of vj.crons) {
  const f = 'api' + c.path.replace(/^\/api/, '') + '.js';
  const d = vj.functions[f] && vj.functions[f].maxDuration;
  ok(c.path + ' has an explicit maxDuration', Number.isFinite(d), d ? d + 's' : 'DEFAULTS TO 10s');
}

console.log('\n=== 3. every module loads ===');
const walk = d => fs.readdirSync(abs(d), { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? walk(path.join(d, e.name)) : (e.name.endsWith('.js') ? [path.join(d, e.name)] : []));

for (const f of walk('api')) {
  let m = null, err = null;
  try { m = require(abs(f)); } catch (e) { err = first(e); }
  ok('exports a handler: ' + f, typeof m === 'function', err || (m === null ? '' : 'exports ' + typeof m));
}
for (const f of walk('lib').concat(walk('activity'))) {
  let err = null;
  try { require(abs(f)); } catch (e) { err = first(e); }
  ok('loads: ' + f, !err, err || '');
}

console.log('\n=== 4. the page and the routes agree ===');
const html = fs.readFileSync(abs('app/index.html'), 'utf8');
for (const r of ['/api/activity', '/api/livefield', '/api/pulse', '/api/feed']) {
  ok('the page calls ' + r + ' and it exists',
     html.includes("'" + r) && fs.existsSync(abs(r.replace(/^\//, '') + '.js')));
}
for (const r of ['./incidents.json', './transcripts.json', './pipeline.json', './situations.json']) {
  const src = r.replace('.', '');
  ok('the page calls ' + r + ' and a rewrite catches it',
     html.includes(r) && vj.rewrites.some(w => w.source === src), src);
}

console.log('\n' + (bad ? '*** ' + bad + ' FAILURE(S) ***' : 'PREFLIGHT OK') + '\n');
process.exit(bad ? 1 : 0);
