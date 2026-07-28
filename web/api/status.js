// api/status.js
// Behind the password. The page to open when something looks wrong.
//
// It reports whether each secret is PRESENT, never what it is. That rule is
// absolute: this endpoint exists to answer "did I forget to set a variable",
// and a diagnostics page that prints keys is how keys end up in screenshots.

const { requireRead, json } = require('../lib/http');
const kv = require('../lib/kv');
const store_io = require('../lib/store-io');

const set = name => !!(process.env[name] && String(process.env[name]).trim());

module.exports = async (req, res) => {
  if (!requireRead(req, res)) return;
  const t0 = Date.now();
  const out = {
    at: new Date().toISOString(),
    region: process.env.VERCEL_REGION || null,
    env: process.env.VERCEL_ENV || 'development',
    commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null,
    redis: { configured: kv.live, ok: false, ms: null, error: null },
    config: {
      ANTHROPIC_API_KEY: set('ANTHROPIC_API_KEY'),
      BESTTIME_API_KEY_PRIVATE: set('BESTTIME_API_KEY_PRIVATE'),
      AUTH_USER: set('AUTH_USER'),
      AUTH_PASS: set('AUTH_PASS'),
      INGEST_TOKENS: set('INGEST_TOKENS'),
      INGEST_SECRET: set('INGEST_SECRET'),
      CRON_SECRET: set('CRON_SECRET'),
      BROADCASTIFY_LOGIN: set('BROADCASTIFY_USER') && set('BROADCASTIFY_PASS'),
    },
    warnings: [],
  };
  if (!out.config.AUTH_PASS) out.warnings.push('AUTH_PASS is not set, so the dashboard is open to anyone with the URL.');
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
