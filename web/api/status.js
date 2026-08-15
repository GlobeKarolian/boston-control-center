// api/status.js
// Behind the password. The page to open when something looks wrong.
//
// It reports whether each secret is PRESENT, never what it is. That rule is
// absolute: this endpoint exists to answer "did I forget to set a variable",
// and a diagnostics page that prints keys is how keys end up in screenshots.

const { requireRead, json } = require('../lib/http');
const kv = require('../lib/kv');
const llmlog = require('../lib/llmlog');
const users = require('../lib/users');
const store_io = require('../lib/store-io');
const blob = require('../lib/blob');

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
      OPENROUTER_API_KEY: set('OPENROUTER_API_KEY'),
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
      BLOB_READ_WRITE_TOKEN: set('BLOB_READ_WRITE_TOKEN'),
    },
    /* The vault lives on Blob. With no token the archive is not being written,
       and desk-read, the archive tab, and the briefing all answer from an
       empty room while the live console looks fine. This is the failure that
       sat silently for six hours on 15 August 2026. */
    blob: { on: blob.enabled(), why: blob.enabled() ? '' : blob.reason() },
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
  /* Set is not the same as working, and every surface in this project used to
     report the first as though it were the second.

     A key that has been rotated at OpenRouter and not here is present, non
     empty, and rejected on every call. llm-activity said configured: true,
     status said the same, the board looked healthy, and extraction quietly ran
     on regex for hours. The only honest answer comes from whether calls are
     actually succeeding, so that is what is checked. */
  if (!out.config.OPENROUTER_API_KEY && !out.config.ANTHROPIC_API_KEY) {
    out.warnings.push('No OPENROUTER_API_KEY and no ANTHROPIC_API_KEY, so extraction falls back to regex, nothing is verified, and the desk panel cannot answer.');
  } else if (!out.config.OPENROUTER_API_KEY) {
    out.warnings.push('No OPENROUTER_API_KEY. Extraction, the desk read, the ask box and the verifier all route through OpenRouter.');
  }
  /* Why the editorial layer is empty, which has never had a surface.
     Situations come only from api/cron/analyst.js, and that cron has three
     configuration gates it can fail silently: no ANTHROPIC_API_KEY, a local
     analyst still holding the lease, and ANALYST_CLOUD unset. In every one of
     those cases the board keeps aging, the rail says 'Nothing major right
     now', and nothing anywhere says that nothing is being judged. */
  try {
    const raw = await kv.get('bcc:analyst:last');
    const a = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
    if (a) {
      out.analyst = a;
      const stale = Date.now() - Date.parse(a.at || 0) > 30 * 60000;
      if (a.ran === false && a.why) {
        out.warnings.push('Nothing is judging the radio: the analyst last run was skipped because ' + a.why
          + '. Situations will stay empty until that is fixed.');
      } else if (stale) {
        out.warnings.push('The analyst has not run in over 30 minutes, so the Situations board is only aging.');
      }
    } else {
      out.analyst = null;
      out.warnings.push('The analyst has never reported a run, so nothing is producing Situations.');
    }
  } catch (e) { out.analyst = { error: String(e.message || e).slice(0, 160) }; }

  try {
    const log = await llmlog.recent(40);
    const calls = (log && log.calls) || [];
    const auth = calls.filter(c => !c.ok && /\b401\b|unauthor|user not found|invalid.*key|no auth/i.test(String(c.why || '')));
    if (auth.length) {
      out.llm = { rejecting: true, since: auth[auth.length - 1].at, why: auth[0].why || null, of: calls.length };
      out.warnings.push('The model key is SET and being REJECTED: ' + auth.length + ' of the last '
        + calls.length + ' calls came back unauthorised. Adding the key again will not help until the'
        + ' deployment is rebuilt, because Vercel bakes environment variables in at build time.'
        + ' Set it for Production, then redeploy.');
    } else if (calls.length) {
      const bad = calls.filter(c => !c.ok).length;
      out.llm = { rejecting: false, calls: calls.length, failures: bad, healthy: bad === 0 };
    } else {
      /* Nothing logged reads very differently from everything succeeding. */
      out.llm = { rejecting: false, calls: 0, silent: true };
      if (out.config.OPENROUTER_API_KEY) out.warnings.push('A model key is set but no model call has been logged recently, so nothing is exercising it.');
    }
  } catch (e) { out.llm = { error: String(e.message || e).slice(0, 160) }; }

  if (!out.config.CRON_SECRET) out.warnings.push('No CRON_SECRET, so anyone who guesses a cron URL can trigger a paid sweep.');
  if (!kv.live) out.warnings.push('No Redis configured. Run: vercel install upstash');
  /* The vault failing silently is how "Nothing at all has come across" sat on
     the desk panel for six hours while the live console looked fine. A warning
     here is the difference between noticing in the panel and noticing in the
     newsroom. */
  if (!out.blob.on) out.warnings.push('Blob storage is not configured (' + out.blob.why + '), so the vault is not being written: desk-read, the archive tab and the briefing are all answering from an empty room. Set BLOB_READ_WRITE_TOKEN.');

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
      failed: f.failed || 0,
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
