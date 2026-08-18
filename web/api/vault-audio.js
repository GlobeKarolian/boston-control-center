// api/vault-audio.js
//
//   GET /api/vault-audio?day=2026-08-17         all clips from a day
//   GET /api/vault-audio?day=2026-08-17&feed=boston-police   one feed
//
// The audio archive. Every clip the radio kept from a day, in order, with the
// transcript it came from. Not a search — a browse. A reporter who says "play
// me the overnight" gets the overnight, not a matched subset.
//
// The vault records carry clip URLs on every transmission that produced one.
// The archive search already returns them on matched calls. This is the rest:
// every clip from a day, with nothing left out because a reporter might want
// to hear the silence as well as the calls.

const { requireRead, json, harden } = require('../lib/http');
const vaultRead = require('../lib/vault-read');
const vq = require('../lib/vault-query');

const MAX_OBJECTS = 6000;

module.exports = async (req, res) => {
  harden(res);
  if (!(await requireRead(req, res))) return;

  const q = req.query || {};
  if (!q.day || !/^\d{4}-\d{2}-\d{2}$/.test(q.day)) {
    return json(res, { ok: false, why: 'a YYYY-MM-DD day is required' }, { status: 400 });
  }
  const feed = q.feed ? String(q.feed).slice(0, 60) : null;

  const t0 = Date.now();
  const from = new Date(q.day + 'T00:00:00-04:00');
  const to = new Date(+from + 86400000);
  if (isNaN(+from)) return json(res, { ok: false, why: 'bad day' }, { status: 400 });

  let read;
  try {
    read = await vaultRead.readWindow(+from, +to, { slackMs: 30 * 60000, max: MAX_OBJECTS, concurrency: 48 });
  } catch (e) {
    return json(res, { ok: false, why: 'could not read the archive: ' + String(e.message || e).slice(0, 160) }, { status: 503 });
  }

  const rows = (read.rows || []).filter(t => {
    if (!t || !t.clip) return false;
    if (feed && String(t.feed || t.src || '') !== feed) return false;
    return true;
  });

  /* Group by feed, oldest first within each. */
  const byFeed = new Map();
  for (const r of rows) {
    const f = String(r.feed || r.src || 'unknown');
    if (!byFeed.has(f)) byFeed.set(f, []);
    byFeed.get(f).push(r);
  }
  for (const list of byFeed.values()) list.sort((a, b) => String(a.at).localeCompare(String(b.at)));

  const feeds = [...byFeed.entries()].map(([id, list]) => ({
    id,
    count: list.length,
    clips: list.map(t => ({
      at: t.at,
      clip: t.clip,
      text: String(t.text || '').slice(0, 300),
      units: (t.units || []).slice(0, 6),
      callType: t.callType || null,
      address: t.address || null,
      town: t.town || t.city || null,
    })),
  }));

  return json(res, {
    ok: true,
    day: q.day,
    feed,
    clips: rows.length,
    feeds,
    truncated: !!read.truncated,
    ms: Date.now() - t0,
  }, { priv: 0 });
};
