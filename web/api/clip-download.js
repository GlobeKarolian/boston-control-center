// api/clip-download.js
//
//   GET /api/clip-download?u=<clip url>&name=<optional filename>
//
// The same audio, served from this origin with an attachment header so the
// browser saves it instead of playing it.
//
// This exists because the download attribute on an anchor is ignored across
// origins, and the clips live on the blob store's hostname rather than ours.
// A reporter clicking "download" on a cross-origin link gets a new tab with
// audio playing in it, which is not what they asked for and not what they
// can drop into a story folder.
//
// The URL is checked against the same host rule the ingest path uses before
// anything is fetched, because a route that fetches whatever a query string
// says is a proxy for scanning private networks. Same allowlist, same file,
// so the two can never drift apart.

const { requireRead, harden } = require('../lib/http');
const clips = require('../app/clips.js');

module.exports = async (req, res) => {
  harden(res);
  if (!(await requireRead(req, res))) return;

  const u = String((req.query && req.query.u) || '');
  if (!u || !clips.ok(u)) {
    res.statusCode = 400;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    return res.end('that is not a clip this app serves');
  }

  /* A name a person can find later. The blob path already carries the feed
     and an Eastern timestamp, so the default is built from those rather than
     from the random suffix that makes the object unique. */
  let name = String((req.query && req.query.name) || '').replace(/[^A-Za-z0-9._-]/g, '');
  if (!name) {
    const base = u.split('/').pop() || 'clip.m4a';
    const m = base.match(/^(.*?)-(\d{4}-\d{2}-\d{2})-(\d{6})-et-/);
    name = m ? (m[2] + '_' + m[3] + '_' + m[1] + '.m4a') : base.replace(/-et-[A-Za-z0-9]+(?=\.)/, '');
  }
  if (!/\.[a-z0-9]{2,4}$/i.test(name)) name += '.m4a';

  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) {
      res.statusCode = 502;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      return res.end('the clip store answered ' + r.status);
    }
    const buf = Buffer.from(await r.arrayBuffer());
    res.statusCode = 200;
    res.setHeader('content-type', r.headers.get('content-type') || 'audio/mp4');
    res.setHeader('content-length', String(buf.length));
    res.setHeader('content-disposition', 'attachment; filename="' + name + '"');
    res.setHeader('cache-control', 'private, max-age=3600');
    return res.end(buf);
  } catch (e) {
    res.statusCode = 502;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    return res.end('could not fetch that clip: ' + String(e.message || e).slice(0, 120));
  }
};
