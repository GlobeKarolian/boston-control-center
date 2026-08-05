// Guards the one attribute that makes the webcam players run.
//
// The whole site sends Referrer-Policy: no-referrer, which is the right default
// and stays. But a no-referrer document tells the YouTube frame nothing about who
// is embedding it, and YouTube answers that with Error 153 rather than guessing.
// The frame therefore has to opt out for itself, at the element level, without
// loosening anything else on the page.
//
// Measured on the deployed origin with four frames side by side: nothing added
// posts onError 153, origin= alone still posts onError 153, referrerpolicy posts
// onReady then infoDelivery, which is a player that is running.
//
// So this file asserts the attribute is present and is not one of the two values
// that would strip the cross-origin Referer again.
//
//   node tools/check-embed.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;

function head(t) { console.log('\n' + t); }
function ok(cond, label) {
  if (cond) { pass++; console.log('  ok    ' + label); }
  else { fail++; console.log('  FAIL  ' + label); }
}

function eq(actual, expected, label) {
  if (actual === expected) { pass++; console.log('  ok    ' + label); }
  else {
    fail++;
    console.log('  FAIL  ' + label);
    console.log('        wanted ' + JSON.stringify(expected));
    console.log('        got    ' + JSON.stringify(actual));
  }
}

head('the site tells every request to send no referrer, which is correct and stays');

// Parsing rather than regexing vercel.json also proves the file is still valid JSON,
// which is worth a line on its own given how easy a trailing comma is to leave behind.
let vercel = null;
try {
  vercel = JSON.parse(read('vercel.json'));
  pass++; console.log('  ok    vercel.json parses');
} catch (e) {
  fail++;
  console.log('  FAIL  vercel.json parses');
  console.log('        ' + e.message);
}

const vercelRefPolicies = [];
if (vercel && Array.isArray(vercel.headers)) {
  vercel.headers.forEach(function (block) {
    (block.headers || []).forEach(function (h) {
      if (h && String(h.key).toLowerCase() === 'referrer-policy') vercelRefPolicies.push(h.value);
    });
  });
}
ok(vercelRefPolicies.length > 0, 'vercel.json sets Referrer-Policy (' + (vercelRefPolicies.join(', ') || 'none found') + ')');
ok(vercelRefPolicies.every(function (v) { return v === 'no-referrer'; }),
   'every vercel.json Referrer-Policy is no-referrer');

// harden() in lib/http.js says the same thing a second time, for the responses
// Vercel's static header block never sees. Both have to agree or the popup would
// behave differently depending on which path served the page.
const httpSrc = read('lib/http.js');
const httpRef = httpSrc.match(/setHeader\(\s*'Referrer-Policy'\s*,\s*'([^']+)'/);
ok(!!httpRef, 'lib/http.js harden() sets Referrer-Policy');
if (httpRef) eq(httpRef[1], 'no-referrer', 'harden() agrees with vercel.json');

head('so the youtube frame has to opt out for itself');

const html = read('app/index.html');

// Slicing the function out rather than searching the whole file means a stray
// iframe somewhere else on the page cannot make these pass by accident. If the
// function is ever renamed this stops loudly instead of quietly passing on nothing.
const start = html.indexOf('function wcPopupHTML');
if (start === -1) {
  console.log('\n  could not find wcPopupHTML in app/index.html.');
  console.log('  If it was renamed or moved, update the anchor in this file.\n');
  process.exit(1);
}
const after = html.indexOf('\nfunction ', start + 1);
const popup = html.slice(start, after === -1 ? html.length : after);

ok(/<iframe/.test(popup), 'the popup still builds an iframe');

const ref = popup.match(/referrerpolicy="([^"]*)"/i);
ok(!!ref, 'the iframe carries a referrerpolicy attribute');

// no-referrer and same-origin are the two values that send nothing at all across
// origins, which is exactly the state that produced Error 153. Any other value
// sends at least the bare origin, which is all YouTube needs.
const MUTE = ['no-referrer', 'same-origin'];
if (ref) {
  ok(MUTE.indexOf(ref[1].toLowerCase()) === -1,
     'referrerpolicy still sends an origin cross-site (' + ref[1] + ')');
  // The origin alone is enough, and a policy that leaked a path or a query string
  // would undo the hardening the rest of the page is careful about.
  ok(!/unsafe-url|^origin-when-cross-origin$|^no-referrer-when-downgrade$/i.test(ref[1]),
     'referrerpolicy never sends a path or a query string');
}

head('and the rest of the popup is unchanged');

ok(/allow="autoplay/.test(popup), 'the iframe still allows autoplay');
ok(/watchURL/.test(popup), 'the watch it there fallback link is still present');
ok(/data-wc="/.test(popup), 'the src is still deferred behind data-wc until the popup opens');

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
