// api/feed.js
// Outbound proxy for the dashboard: RSS, the aircraft feeds, and 311.
// The browser cannot fetch these directly (CORS), so this fetches them
// server-side.
//
// Ported from the Mac's server.js proxy, which is the stricter of the two
// versions that existed. Three things carried over on purpose:
//   - an explicit domain ALLOWLIST, so this is never an open proxy
//   - a per-IP rate limit, so a leaked URL cannot be used as someone else's
//     fetch service
//   - a response size cap, so a huge upstream cannot blow the function
//
// Note the rate limiter is per-instance, not global. On Vercel that means a
// determined abuser spread across instances gets a higher effective ceiling.
// It is a speed bump, not a wall; the allowlist is the wall.

const { harden } = require('../lib/http');

const ALLOW = [
  'news.google.com',
  'www.reddit.com', 'reddit.com', 'old.reddit.com',
  'www.boston.com', 'boston.com',
  'www.bostonglobe.com', 'bostonglobe.com',
  'www.bostonherald.com', 'bostonherald.com',
  'www.wbur.org', 'wbur.org',
  'www.wgbh.org', 'wgbh.org', 'www.gbh.org', 'gbh.org',
  'www.masslive.com', 'masslive.com',
  'www.universalhub.com', 'universalhub.com',
  'commonwealthbeacon.org', 'www.commonwealthbeacon.org',
  'www.bizjournals.com', 'bizjournals.com',
  'www.axios.com', 'axios.com',
  'feeds.feedburner.com',
  'events.massdot.evbg.net',   // MassDOT live highway incidents (HTTP only)
  'api.airplanes.live',        // helicopter / aircraft tracking
  'opendata.adsb.fi',
  'api.adsbdb.com',
  '311.boston.gov',
];

const allowed = h => { h = (h || '').toLowerCase(); return ALLOW.some(d => h === d || h.endsWith('.' + d)); };

const MAX_BYTES = 8 * 1024 * 1024;
const RL = new Map();
const RL_MAX = 240, RL_WINDOW = 60000;
function rateLimited(ip) {
  const now = Date.now();
  let e = RL.get(ip);
  if (!e || now > e.resetAt) { e = { n: 0, resetAt: now + RL_WINDOW }; RL.set(ip, e); }
  e.n++;
  if (RL.size > 5000) RL.clear();     // a warm instance must not grow forever
  return e.n > RL_MAX;
}

module.exports = async (req, res) => {
  harden(res);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (rateLimited(ip)) { res.status(429).send('slow down'); return; }

  const raw = (req.query && req.query.url) || '';
  let target;
  try { target = new URL(raw); } catch (e) { res.status(400).send('bad url'); return; }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') { res.status(400).send('bad protocol'); return; }
  if (!allowed(target.hostname)) { res.status(403).send('domain not allowed: ' + target.hostname); return; }

  try {
    const upstream = await fetch(target.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BostonNewsroomControlCenter/1.0; +newsroom-monitor)',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, application/json, */*',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    const len = Number(upstream.headers.get('content-length') || 0);
    if (len > MAX_BYTES) { res.status(413).send('upstream too large'); return; }
    const body = await upstream.text();
    if (body.length > MAX_BYTES) { res.status(413).send('upstream too large'); return; }
    const ct = upstream.headers.get('content-type') || 'application/xml; charset=utf-8';
    res.setHeader('Content-Type', ct);
    // Public data from public feeds, so the shared CDN cache is correct here
    // and is what keeps a newsroom of viewers from hammering the upstreams.
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    res.status(upstream.ok ? 200 : upstream.status).send(body);
  } catch (e) {
    res.status(502).send('upstream fetch failed');
  }
};
