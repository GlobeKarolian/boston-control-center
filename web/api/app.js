// api/app.js
// Serves the dashboard HTML, behind the same password as the data.
//
// Why the page is not a static file in public/: Vercel serves public/ from
// the CDN before any function runs, so a file there cannot be password
// protected without Routing Middleware. Middleware for a non-framework
// project has to be ESM, and every function in this project is CommonJS, so
// adding it would mean converting the whole codebase or maintaining a second
// auth implementation at the edge. Serving the page through this function
// keeps exactly one door and one lock.
//
// The cost is one function invocation per page load, which for a newsroom is
// nothing. The data endpoints are what get polled, and those are separate.

const fs = require('fs');
const path = require('path');
const { requireRead, harden } = require('../lib/http');

const HTML_PATH = path.join(__dirname, '..', 'app', 'index.html');

let cached = null;   // a warm instance reads the file once
function html() {
  if (cached === null) cached = fs.readFileSync(HTML_PATH, 'utf8');
  return cached;
}

module.exports = async (req, res) => {
  if (!requireRead(req, res)) return;
  harden(res);
  try {
    const body = html();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // Behind auth, so browser-only caching. Short, because a deploy should
    // reach the newsroom without anyone being told to hard-refresh.
    res.setHeader('Cache-Control', 'private, max-age=30');
    res.status(200).send(body);
  } catch (e) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(500).send('dashboard HTML missing: ' + String(e.message || e).slice(0, 200));
  }
};
