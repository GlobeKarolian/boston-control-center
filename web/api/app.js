// api/app.js
// Serves the dashboard, behind the same password as the data.
//
// Why the page is not a static file in public/: Vercel serves public/ from
// the CDN before any function runs, so a file there cannot be password
// protected without Routing Middleware. Middleware for a non-framework
// project has to be ESM, and every function in this project is CommonJS, so
// adding it would mean converting the whole codebase or maintaining a second
// auth implementation at the edge. Serving the page through this function
// keeps exactly one door and one lock.
//
// The page is not one file. index.html loads a handful of sibling scripts and
// one stylesheet out of app/, and they have to come through this same door for
// the same reason. A copy in public/ would be readable without the password.
//
// They spent a while shipping as 404s. That does not break the page loudly.
// It leaves every window.BCC* undefined, and every section that checks for
// one before drawing goes quietly empty. The State Police column read zero
// on a board where the classifier was finding cards, the audio alarm never
// armed, the freshness pill never moved, and nothing on screen said why.
//
// The cost is one function invocation per file per cold page load, which for
// a newsroom is nothing. The data endpoints are what get polled, and those
// are separate.

const fs = require('fs');
const path = require('path');
const { requireRead, harden } = require('../lib/http');

const DIR = path.join(__dirname, '..', 'app');

/* A fixed list rather than a path join, because the name arrives from the
   network and a path join would happily walk out of app/. Anything not
   spelled exactly like one of these keys falls back to the page. */
const ASSETS = {
  'index.html': 'text/html; charset=utf-8',
  'alerts.js': 'application/javascript; charset=utf-8',
  'freshness.js': 'application/javascript; charset=utf-8',
  'statepolice.js': 'application/javascript; charset=utf-8',
  'threadui.js': 'application/javascript; charset=utf-8',
  'track.js': 'application/javascript; charset=utf-8',
  'webcams.js': 'application/javascript; charset=utf-8',
  'deskviews.js': 'application/javascript; charset=utf-8',
  /* The first stylesheet to come through here, and the quietest thing on the
     list if it goes missing. A script that 404s leaves a global undefined and
     a column empty. A stylesheet that 404s leaves every rule at its browser
     default, so the Desk still draws, still polls, still updates, and looks
     like a stack of unstyled divs. Note the content type has to be right as
     well as present: wanted() falls back to index.html for anything it does
     not recognise, so a missing entry here would answer a request for CSS
     with the whole page marked text/html, which the browser drops on the
     floor without a word in the console. */
  'deskviews.css': 'text/css; charset=utf-8',
};

const cache = {};   // a warm instance reads each file once
function body(name) {
  if (!Object.prototype.hasOwnProperty.call(cache, name)) {
    cache[name] = fs.readFileSync(path.join(DIR, name), 'utf8');
  }
  return cache[name];
}

/* The rewrite in vercel.json hands the filename over in the query string.
   req.query is populated by the runtime and by vercel dev, but a rewrite is
   exactly the kind of plumbing that changes underneath a project, so the raw
   URL is read as a backstop and the last path segment after that. All three
   answers go through the same whitelist, so a wrong guess costs a page
   instead of a file read. */
function wanted(req) {
  const url = String(req.url || '');
  let q = (req.query && req.query.asset) || '';
  if (Array.isArray(q)) q = q[0] || '';
  if (!q) {
    const m = /[?&]asset=([^&]*)/.exec(url);
    if (m) { try { q = decodeURIComponent(m[1]); } catch (e) { q = m[1]; } }
  }
  if (!q) q = url.split('?')[0].split('/').pop() || '';
  return Object.prototype.hasOwnProperty.call(ASSETS, q) ? q : 'index.html';
}

module.exports = async (req, res) => {
  if (!(await requireRead(req, res))) return;
  harden(res);
  const name = wanted(req);
  try {
    const text = body(name);
    res.setHeader('Content-Type', ASSETS[name]);
    // Behind auth, so browser-only caching. Short, because a deploy should
    // reach the newsroom without anyone being told to hard-refresh, and the
    // scripts carry the same number as the page so a stale one cannot
    // outlive the markup that calls into it.
    res.setHeader('Cache-Control', 'private, max-age=30');
    res.status(200).send(text);
  } catch (e) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(500).send('missing ' + name + ': ' + String(e.message || e).slice(0, 200));
  }
};
