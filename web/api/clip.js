// api/clip.js
// The door audio comes through. The relay POSTs one clip here, gets a URL
// back, and puts that URL on the transcript item it sends to /api/ingest a
// moment later. The transmission record is therefore born with its clip
// rather than joined to it afterwards.
//
// That ordering is the whole design. The alternative was an attach step,
// where audio arrives second and the server finds the matching row by
// machine and sequence. That means taking the store mutex and paying two
// Redis round trips per clip, on a store that has already been run out of
// commands once. This file touches no Redis at all. It cannot hold the
// lock, cannot lose a race, and cannot contribute a single command to the
// bill. If it fails, the relay sends the transcript without a clip and the
// newsroom loses a play button, not a transmission.
//
// Same bearer token as ingest, because it is the same fleet: a machine
// trusted to put words on the board is trusted to put audio behind them.
//
// The metadata rides in headers because the body is the audio itself:
//   x-bcc-src   feed slug, names the folder
//   x-bcc-at    ISO time of the transmission, names the file
//   content-type audio/mp4

const { ingestAuth, json, harden } = require('../lib/http');
const blob = require('../lib/blob');

/* Read the raw body with the cap enforced during the read, not after it.
   A client that keeps sending past the limit is cut off mid-stream, so the
   worst a runaway upload can cost is one megabyte of buffer, not a
   function-sized one. */
function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let n = 0, done = false;
    req.on('data', (c) => {
      if (done) return;
      n += c.length;
      if (n > cap) { done = true; resolve(null); try { req.destroy(); } catch (e) {} return; }
      parts.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(parts)); } });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

module.exports = async (req, res) => {
  harden(res);
  if (req.method !== 'POST') return json(res, { ok: false, why: 'POST only' }, { status: 405 });

  const auth = ingestAuth(req);
  if (!auth.ok) return json(res, { ok: false, why: auth.why }, { status: 401 });

  /* Answer the disabled state honestly and cheaply. The relay treats any
     failure the same way, but the difference matters to whoever is reading
     the response in a terminal at 2am: "no store attached" is a Vercel
     dashboard problem, "upload failed" is not. */
  if (!blob.enabled()) return json(res, { ok: false, why: blob.reason() }, { status: 503 });

  const row = {
    src: String(req.headers['x-bcc-src'] || '').slice(0, 40),
    at: String(req.headers['x-bcc-at'] || '').slice(0, 40),
  };

  let bytes;
  try { bytes = await readBody(req, blob.MAX_BYTES); }
  catch (e) { return json(res, { ok: false, why: 'body read failed' }, { status: 400 }); }
  if (bytes === null) {
    return json(res, { ok: false, why: 'audio over the ' + blob.MAX_BYTES + ' byte cap' }, { status: 413 });
  }

  const out = await blob.putClip(bytes, row, {
    contentType: String(req.headers['content-type'] || 'audio/mp4').slice(0, 60),
  });
  if (!out.ok) return json(res, { ok: false, why: out.why }, { status: 502 });

  /* The relay carries this URL onto the transcript item it sends next.
     Nothing else needs remembering here, which is the point. */
  return json(res, { ok: true, url: out.url, bytes: out.bytes, ms: out.ms });
};
