// tools/check-vercel.js
//
// vercel.json is checked against a closed schema at deploy time, and a key
// Vercel does not recognise is a hard stop rather than a warning. JSON has
// nowhere to put a comment, so the tempting move is to invent a key like
// "_crons_note" and write the explanation into it. That move cost a deploy.
//
// Running this in the sweep puts the failure in a test run instead of in the
// terminal at the moment somebody is trying to ship.
//
//   node tools/check-vercel.js

var fs = require('fs');
var PATH = process.argv[2] || 'vercel.json';
var fails = [];
var warns = [];
var raw, doc;

try {
  raw = fs.readFileSync(PATH, 'utf8');
} catch (e) {
  console.log('FAIL  cannot read ' + PATH + ': ' + e.message);
  process.exit(1);
}

try {
  doc = JSON.parse(raw);
} catch (e) {
  console.log('FAIL  ' + PATH + ' is not valid JSON: ' + e.message);
  process.exit(1);
}

/* Vercel keeps adding properties, so this list goes stale on its own and an
   unrecognised key is only a warning. The hard failure below is reserved for
   the one shape that is wrong no matter what Vercel does next. */
var KNOWN = [
  '$schema', 'buildCommand', 'builds', 'cleanUrls', 'crons', 'devCommand',
  'env', 'framework', 'functionFailoverRegions', 'functions', 'git', 'headers',
  'ignoreCommand', 'images', 'installCommand', 'outputDirectory', 'public',
  'redirects', 'regions', 'rewrites', 'routes', 'trailingSlash',
];

function isComment(k) {
  return /^[_\/]/.test(k) || /^(comment|note|notes|readme|why|todo)$/i.test(k);
}

Object.keys(doc).forEach(function (k) {
  if (isComment(k)) {
    fails.push(k + ' is a comment, and vercel.json has no room for one. Put the prose in the file it describes.');
  } else if (KNOWN.indexOf(k) === -1) {
    warns.push(k + ' is not on the known list. If Vercel added it, add it here too.');
  }
});

/* A cron pointed at a route that does not exist still gets scheduled. It just
   spends its tick on a 404, which is the expensive kind of quiet. */
(doc.crons || []).forEach(function (c) {
  var f = String(c.path || '').replace(/^\//, '') + '.js';
  if (!fs.existsSync(f)) fails.push('cron ' + c.path + ' has no handler at ' + f);
});

(doc.rewrites || []).forEach(function (r) {
  var d = String(r.destination || '');
  if (d.indexOf('/api/') !== 0) return;
  /* A destination may carry a query string, which is how the page function is
     told which of its files to hand back. That part is not on disk. */
  var f = d.split('?')[0].replace(/^\//, '') + '.js';
  if (!fs.existsSync(f)) fails.push('rewrite ' + r.source + ' points at ' + d + ', which has no file at ' + f);
});

/* The one that actually bit. index.html loads its modules with a relative
   src, which from a page served at / resolves to a path at the root, and
   nothing at the root is served unless a rewrite says so. A missing rewrite
   here does not fail a deploy and does not throw in the console loudly
   enough to notice. It leaves window.BCCStatePolice undefined, and the
   column that checks for it before drawing renders its empty state forever
   on a board that is full. Every script tag and every stylesheet link gets a
   door or this fails. */
var HTML = 'app/index.html';
var seen = {};

/* The whitelist in api/app.js is a third door behind the rewrite and the
   file on disk, and the only one of the three that fails without a 404. A
   name it does not recognise does not error: wanted() falls back to the
   page, so the browser is handed index.html marked text/html where it asked
   for a script or a stylesheet, and drops it without a word. The keys are
   read out of the source rather than by requiring the module, because
   requiring it drags in the auth layer and a redis client to answer a
   question about a list of strings. */
function whitelist() {
  var src;
  try { src = fs.readFileSync('api/app.js', 'utf8'); } catch (e) { return null; }
  var block = /const ASSETS\s*=\s*\{([\s\S]*?)\n\};/.exec(src);
  if (!block) return null;
  var inner = block[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  var keys = {}, k, kre = /['"]([^'"]+)['"]\s*:/g;
  while ((k = kre.exec(inner))) keys[k[1]] = 1;
  return keys;
}

if (fs.existsSync(HTML)) {
  var page = fs.readFileSync(HTML, 'utf8');
  var sources = (doc.rewrites || []).map(function (r) { return String(r.source || ''); });
  var allow = whitelist();
  if (!allow) warns.push('could not read the ASSETS list out of api/app.js, so nothing was checked against it');

  /* Both kinds of sibling file, because they fail the same way and the
     stylesheet fails more quietly. A script that never arrives leaves a
     global undefined and a column visibly empty. A stylesheet that never
     arrives leaves a view that still draws, still polls and still updates,
     wearing browser defaults. Nobody reads that as a routing problem. */
  var REFS = [
    { what: 'script', re: /<script[^>]+src\s*=\s*["']([^"']+)["']/gi },
    { what: 'stylesheet', re: /<link[^>]+href\s*=\s*["']([^"']+)["'][^>]*>/gi, need: /stylesheet/i },
  ];

  REFS.forEach(function (ref) {
    var m;
    while ((m = ref.re.exec(page))) {
      if (ref.need && !ref.need.test(m[0])) continue;   // a preload or an icon is not this
      var src = m[1];
      if (/^(https?:)?\/\//.test(src) || /^data:/.test(src)) continue;   // a CDN is somebody else's problem
      var route = '/' + src.replace(/^\.?\//, '').split('?')[0];
      if (seen[route]) continue;
      seen[route] = 1;
      var name = route.replace(/^\//, '');
      if (!fs.existsSync('app/' + name)) {
        fails.push(HTML + ' loads ' + src + ', which is not on disk at app' + route);
      } else if (sources.indexOf(route) === -1) {
        fails.push(HTML + ' loads ' + src + ', and no rewrite serves ' + route +
          '. It will 404 in production and the ' + ref.what + ' will never arrive in the browser.');
      } else if (allow && !allow[name]) {
        fails.push(HTML + ' loads ' + src + ' and a rewrite serves it, but ' + name +
          ' is not in the ASSETS list in api/app.js. The request will quietly answer with the page instead of the ' + ref.what + '.');
      }
    }
  });
}

Object.keys(doc.functions || {}).forEach(function (f) {
  if (!fs.existsSync(f)) fails.push('functions lists ' + f + ', which does not exist');
});

warns.forEach(function (w) { console.log('  warn  ' + w); });
fails.forEach(function (f) { console.log('  FAIL  ' + f); });

if (fails.length) {
  console.log('');
  console.log(fails.length + ' problem(s) in ' + PATH + '. This will not deploy.');
  process.exit(1);
}
console.log('ok    vercel.json  ' + Object.keys(doc).length + ' keys, ' +
  (doc.crons || []).length + ' crons, ' + (doc.rewrites || []).length + ' rewrites, ' +
  Object.keys(seen).length + ' local assets, all routed and whitelisted');
