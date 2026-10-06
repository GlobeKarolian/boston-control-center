// api/about.js
// The public front door: a one-page "man scan" explainer for people who land
// on scan.boston without a login.
//
// Deliberately NOT behind requireRead. It is the only route in this project
// that is, which is why it lives in its own folder (landing/) rather than in
// app/: nothing in app/ may ever be reachable without the password, and
// keeping the public file somewhere else means a careless edit to ASSETS in
// api/app.js cannot expose it, and a careless edit here cannot expose app/.
//
// The page is static and holds no data, no transcripts and no feed names.
// Keep it that way. Anything live belongs behind the door.

const fs = require('fs');
const path = require('path');
const { harden } = require('../lib/http');

const FILE = path.join(__dirname, '..', 'landing', 'about.html');
let cached = null;

module.exports = async (req, res) => {
  harden(res);
  try {
    if (cached === null) cached = fs.readFileSync(FILE, 'utf8');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // No auth on this route, so the CDN may hold it.
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600');
    res.status(200).send(cached);
  } catch (e) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(500).send('missing about page');
  }
};
