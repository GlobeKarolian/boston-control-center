// api/status.js
// Behind the password. The page to open when something looks wrong.
//
// It reports whether each secret is PRESENT, never what it is. That rule is
// absolute: this endpoint exists to answer "did I forget to set a variable",
// and a diagnostics page that prints keys is how keys end up in screenshots.

const { requireRead, json } = require('../lib/http');
const kv = require('../lib/kv');
const users = require('../lib/users');
const store_io = require('../lib/store-io');

const set = name => !!(process.env[name] && String(process.env[name]).trim());

module.exports = async (req, res) => {
  if (!(await requireRead(req, res))) return;
  const t0 = Date.now();
  const out = {
    at: new Date().toISOString(),
    region: process.env.VERCEL_REGION || null,
    env: process.env.VERCEL_ENV || 'development',
    commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null,
    redis: { configured: kv.live, ok: false, ms: null, error: null, quota: false, meter: null },
    config: {
      ANTHROPIC_API_KEY: set('ANTHROPIC_API_KEY'),
      BESTTIME_API_KEY_PRIVATE: set('BESTTIME_API_KEY_PRIVATE'),
      AUTH_USER: set('AUTH_USER'),
      AUTH_PASS: set('AUTH_PASS'),
      AUTH_USERS: set('AUTH_USERS'),
      ADMIN_USERS: set('ADMIN_USERS'),
      INGEST_TOKENS: set('INGEST_TOKENS'),
      INGEST_SECRET: set('INGEST_SECRET'),
      CRON_SECRET: set('CRON_SECRET'),
      BROADCASTIFY_LOGIN: set('BROADCASTIFY_USER') && set('BROADCASTIFY_PASS'),
    },
    warnings: [],
  };
  /* Counts, never names. Everybody holding a viewer login can open this page,
     and who else works here is not theirs to read. The admin page lists names
     and it is behind a different door.

     This block is also why the "the site is open" warning below is no longer a
     question about AUTH_PASS. Once logins live in Redis, an empty AUTH_PASS
     stopped meaning an open site, and a diagnostics page that says the door is
     open when it is shut is worse than one that says nothing. */
  out.logins = { env: 0, stored: null, admins: null, expired: null, error: null };
  out.logins.env = Object.keys(users.envTable()).filter(n => n.trim()).length;
  try {
    const list = await users.list();
    out.logins.stored = list.length;
    out.logins.admins = list.filter(u => u.admin && !u.expired).length;
    out.logins.expired = list.filter(u => u.expired).length;
  } catch (e) {
    out.logins.error = String(e.message || e).slice(0, 160);
  }

  if (out.logins.error) {
    out.warnings.push('Could not read the login store, so only the environment logins are working right now: ' + out.logins.error);
  } else if (!out.logins.env && !out.logins.stored) {
    out.warnings.push('No login is configured anywhere, so the dashboard is open to anyone with the URL.');
  } else if (!out.logins.env) {
    out.warnings.push('No environment login is set, so every way into this site depends on Redis being readable. Keep AUTH_USER and AUTH_PASS set as the way back in.');
  }
  if (out.logins.expired) {
    out.warnings.push(out.logins.expired + ' login(s) have expired and no longer work. Remove them from /admin when convenient.');
  }

  if (!out.config.INGEST_TOKENS && !out.config.INGEST_SECRET) out.warnings.push('No ingest credential set, so no Mac can post transcripts.');
  if (!out.config.ANTHROPIC_API_KEY) out.warnings.push('No ANTHROPIC_API_KEY, so extraction falls back to regex and the analyst pass will not run.');
  if (!out.config.CRON_SECRET) out.warnings.push('No CRON_SECRET, so anyone who guesses a cron URL can trigger a paid sweep.');
  if (!kv.live) out.warnings.push('No Redis configured. Run: vercel install upstash');

  try {
    const r = await kv.raw([['PING']], 5000);
    out.redis.ok = String(r[0] || '').toUpperCase() === 'PONG';
    out.redis.ms = Date.now() - t0;
  } catch (e) {
    out.redis.error = String(e.message || e).slice(0, 200);
    out.redis.quota = kv.isQuota(e && e.message);
  }

  /* A PING that answers is not proof the store works. Upstash counts and caps
     by COMMAND, and when the monthly cap is hit reads can still squeak through
     while a five-SET write pipeline throws. That is exactly what the morning of
     July 31 looked like: the dashboard loaded, said "live", and every scanner
     POST came back 500. So say the quota out loud rather than making somebody
     infer it from a green PING and a red Mac. */
  if (out.redis.quota) {
    out.warnings.push('Upstash has refused a command for exceeding the plan limit. '
      + 'Reads may still work, so the dashboard will look alive while every write fails and '
      + 'Scanner Relay reports the dashboard unreachable. Nothing is lost, the Macs queue to disk. '
      + 'Fix: upgrade the Upstash plan, or wait for the monthly reset. Error: ' + out.redis.error);
  }

  /* Commands spent by THIS container since it woke, and what that rate would
     come to over a month if it were the only one running. It is not: Vercel
     keeps several warm and cold-starts more under load, so read projectedMonthly
     as a floor, never a bill. The number that answers "can this survive on the
     free tier" is `node tools/cron-cost.js`, which measures every cron handler
     against the schedules in vercel.json. This is the live sanity check on it. */
  out.redis.meter = kv.meter();
  if (out.redis.meter.coolingOff) {
    out.warnings.push('The local breaker is open: a quota error came back inside the last minute, '
      + 'so this container is refusing commands rather than spending a round trip per command to be told no again.');
  }

  try {
    out.feeds = (await store_io.getHealth()).map(f => ({
      id: f.id, machine: f.machine || null, status: f.status,
      clips: f.clips, segs: f.segs, gated: f.gated,
      lastTextAt: f.lastTextAt || null, staleSec: f.staleSec || 0,
      lastError: f.lastError ? String(f.lastError).slice(0, 160) : null,
    }));
    out.machines = [...new Set(out.feeds.map(f => f.machine).filter(Boolean))];
    if (!out.feeds.length) out.warnings.push('No Mac has checked in yet.');
    else if (out.feeds.every(f => f.status === 'offline')) out.warnings.push('Every feed is offline. Check the Macs.');
  } catch (e) {
    out.feeds = [];
    out.warnings.push('health read failed: ' + String(e.message || e).slice(0, 160));
  }

  out.ms = Date.now() - t0;
  return json(res, out, { priv: 0 });
};
