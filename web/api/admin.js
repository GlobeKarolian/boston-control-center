/* ============================================================================
   api/admin.js - the screen where logins are added and taken away.

   This exists because environment variables are the wrong place to keep a list
   of people. A function on Vercel can read the environment it was started with
   and cannot write to it, so an admin page backed by env vars could never save
   anything typed into it. Worse, every change needs a redeploy, so revoking
   somebody is a build away rather than a click away, which in practice means
   nobody is ever revoked. The list lives in Redis instead. This page is a view
   onto it.

   Three properties this file is built around:

     No secret is ever sent back. The store keeps scrypt hashes, this page
     never asks for a plaintext it already has, and a secret only travels one
     way: the browser to the store, once, at the moment it is set.

     No secret is ever logged. Nothing in here console.logs a request body, and
     the mutation handlers pull the fields they need by name rather than
     echoing what came in.

     A read login cannot use this page. requireAdmin is a separate check from
     requireRead, because the ability to hand out logins is the ability to hand
     out everything else.
   ========================================================================== */

const { requireAdmin, json, harden } = require('../lib/http');
const users = require('../lib/users');
const kv = require('../lib/kv');

/* ---- CSRF -----------------------------------------------------------------

   Basic auth is the awkward one here. A browser attaches Basic credentials to
   cross-site requests on its own, without being asked, so a form on any other
   site could post here and arrive fully authenticated. The session cookie
   defences do not apply, because there is no cookie.

   What actually stops it is making the request one a form cannot send. A form
   post can only be urlencoded, multipart or plain text, and it cannot add a
   header. Requiring application/json and a custom header means the browser has
   to ask permission with a CORS preflight first, and the preflight is never
   answered, so the real request is never sent. Sec-Fetch-Site is checked as
   well where the browser supplies it, which is belt and braces rather than the
   load-bearing part. */
function sameOrigin(req) {
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (!ct.startsWith('application/json')) return false;
  if (String(req.headers['x-bcc-admin'] || '') !== '1') return false;
  return true;
}

/* Vercel parses JSON bodies already, but not on every runtime and not when the
   content-type is unexpected, so this reads the stream when it has to. */
async function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 16384) throw new Error('request too large');   // a login is small
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return {}; }
}

/* ---- the JSON side --------------------------------------------------------

   Every mutation goes through here. The reply is always the fresh list, so the
   page never has to guess what the store now looks like, and two people with
   the page open cannot drift apart for longer than one action. */
async function act(req, res, who) {
  if (!sameOrigin(req)) {
    return json(res, { ok: false, error: 'this request did not come from the admin page' }, { status: 403 });
  }
  if (!kv.live) {
    return json(res, {
      ok: false,
      error: 'There is no Redis configured, so there is nowhere to save this. ' +
             'Nothing was changed. Add KV_REST_API_URL and KV_REST_API_TOKEN and redeploy.',
    }, { status: 503 });
  }

  let b;
  try { b = await body(req); } catch (e) { return json(res, { ok: false, error: String(e.message || e) }, { status: 413 }); }

  const action = String(b.action || '');
  const name = String(b.name || '');

  try {
    let note = '';
    switch (action) {
      case 'add':
      case 'set': {
        const r = await users.put(name, String(b.secret || ''), {
          admin: b.admin === undefined ? undefined : !!b.admin,
          note: b.note === undefined ? undefined : String(b.note || ''),
          expires: b.expires === undefined ? undefined : b.expires,
          by: who,
        });
        note = r.created ? 'Added ' + r.user.name + '.' : 'New secret set for ' + r.user.name + '.';
        break;
      }
      case 'admin': {
        const r = await users.setAdmin(name, !!b.admin, who);
        note = r.name + (r.admin ? ' can now manage logins.' : ' can no longer manage logins.');
        break;
      }
      case 'expire': {
        const r = await users.setExpires(name, b.expires === undefined ? null : b.expires, who);
        note = r.expires
          ? r.name + ' now expires ' + new Date(r.expires).toLocaleString('en-US', { timeZone: 'America/New_York' }) + '.'
          : r.name + ' no longer expires.';
        break;
      }
      case 'remove': {
        const r = await users.remove(name);
        note = 'Removed ' + r.removed + '. That login stops working on the next request.';
        break;
      }
      case 'unlock': {
        await users.clearFails(String(b.ip || ''));
        note = 'Cleared the failed-attempt count for that address.';
        break;
      }
      default:
        return json(res, { ok: false, error: 'unknown action' }, { status: 400 });
    }
    return json(res, { ok: true, note, users: await users.list(), env: envNames(), live: kv.live });
  } catch (e) {
    /* The store throws with sentences meant to be read by whoever is standing
       at the screen, so they are passed through rather than flattened into a
       status code nobody can act on. */
    return json(res, { ok: false, error: String(e.message || e) }, { status: 400 });
  }
}

/* Names only. The env table holds plaintext secrets and this page has no
   business moving them anywhere, not even to a browser that is allowed to see
   the list of who exists. */
function envNames() {
  return Object.keys(users.envTable()).filter(n => n.trim());
}

module.exports = async (req, res) => {
  harden(res);
  if (!(await requireAdmin(req, res))) return;

  /* Who is doing this gets written into the record, so a login that appears
     out of nowhere has a name attached to it. Cheap to record, and the only
     thing that makes the audit fields worth having. requireAdmin left the name
     on the request, so this costs nothing beyond the check already made. */
  const who = req.bccUser || 'admin';

  if (req.method === 'POST') return act(req, res, who);

  if (req.method === 'GET' && String((req.query && req.query.format) || '') === 'json') {
    return json(res, { ok: true, users: await users.list(), env: envNames(), live: kv.live });
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST');
    return json(res, { ok: false, error: 'method not allowed' }, { status: 405 });
  }

  let list = [], error = '';
  try { list = await users.list(); } catch (e) { error = String(e.message || e); }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  /* no-store, not private. This page names everybody who can reach the site. */
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(page({ who, list, env: envNames(), live: kv.live, error, min: users.MIN_SECRET }));
};

/* ---- the page -------------------------------------------------------------

   Server-rendered shell, client-rendered table. The table is drawn from JSON
   with textContent rather than innerHTML, so a note somebody types cannot
   become markup, and the same drawing code runs for the first paint and for
   every update. One code path, one place for that bug to not be.

   Embedded data has its angle brackets escaped, because a string containing
   </script> inside a script tag ends the script tag, and a username is a
   string somebody else chooses. */
function embed(obj) {
  return JSON.stringify(obj).replace(/</g, "\\u003c");
}

function page({ who, list, env, live, error, min }) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>Logins - Boston Control Center</title>
<style>
:root{
  --bg:#05070b;--panel:#0e121a;--border:#232c3b;--border-soft:#1a2230;
  --text:#e9edf4;--dim:#9aa4b6;--faint:#5f6a7e;
  --ok:#34d399;--warn:#ffb020;--bad:#ff4d4d;--admin:#c07cff;--link:#4da3ff;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--sans);font-size:15px;line-height:1.5}
.wrap{max-width:980px;margin:0 auto;padding:28px 20px 90px}
h1{font-size:22px;margin:0 0 2px;letter-spacing:.2px}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.9px;color:var(--faint);margin:34px 0 10px;font-weight:600}
a{color:var(--link)}
.sub{color:var(--dim);font-size:13px;margin:0 0 4px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:16px}
.note{border-radius:8px;padding:11px 13px;margin:14px 0;font-size:14px;border:1px solid}
.note.bad{background:rgba(255,77,77,.09);border-color:rgba(255,77,77,.42);color:#ffd2d2}
.note.warn{background:rgba(255,176,32,.09);border-color:rgba(255,176,32,.42);color:#ffe4b8}
.note.ok{background:rgba(52,211,153,.09);border-color:rgba(52,211,153,.42);color:#c7f5e4}
.note b{display:block;margin-bottom:3px}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.7px;color:var(--faint);
   font-weight:600;padding:0 10px 8px 0;border-bottom:1px solid var(--border-soft)}
td{padding:11px 10px 11px 0;border-bottom:1px solid var(--border-soft);vertical-align:top}
tr:last-child td{border-bottom:0}
.name{font-family:var(--mono);font-size:14px}
.tag{display:inline-block;font-size:10px;text-transform:uppercase;letter-spacing:.6px;
     padding:2px 6px;border-radius:4px;margin-left:6px;vertical-align:1px}
.tag.admin{background:rgba(192,124,255,.16);color:var(--admin);border:1px solid rgba(192,124,255,.4)}
.tag.gone{background:rgba(255,77,77,.14);color:var(--bad);border:1px solid rgba(255,77,77,.4)}
.tag.env{background:rgba(255,176,32,.13);color:var(--warn);border:1px solid rgba(255,176,32,.36)}
.meta{color:var(--faint);font-size:12px;margin-top:3px}
.acts{white-space:nowrap;text-align:right}
button{font:inherit;font-size:13px;padding:6px 11px;border-radius:7px;cursor:pointer;
       background:#151b26;color:var(--text);border:1px solid var(--border)}
button:hover:not(:disabled){border-color:#3a475e;background:#1a2130}
button:disabled{opacity:.45;cursor:default}
button.primary{background:#1d4ed8;border-color:#2563eb;color:#fff}
button.primary:hover:not(:disabled){background:#2563eb}
button.danger{color:#ff9a9a;border-color:rgba(255,77,77,.34)}
button.danger:hover:not(:disabled){background:rgba(255,77,77,.12);border-color:rgba(255,77,77,.6)}
button.mini{font-size:12px;padding:4px 8px;margin-left:6px}
label{display:block;font-size:12px;color:var(--dim);margin-bottom:5px}
input[type=text],input[type=password],input[type=number]{
  width:100%;font:inherit;padding:9px 11px;border-radius:7px;background:#0a0e15;
  color:var(--text);border:1px solid var(--border)}
input:focus{outline:none;border-color:#3b82f6}
.row{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:13px}
.row>div{flex:1;min-width:170px}
.check{display:flex;align-items:center;gap:8px;color:var(--dim);font-size:14px;margin:2px 0 15px}
.check input{width:16px;height:16px;accent-color:#2563eb}
.secretbox{font-family:var(--mono);font-size:17px;letter-spacing:.5px;background:#0a0e15;
  border:1px dashed rgba(52,211,153,.5);border-radius:8px;padding:13px;margin:11px 0;
  word-break:break-all;color:var(--ok)}
.foot{color:var(--faint);font-size:12px;margin-top:36px;border-top:1px solid var(--border-soft);padding-top:14px}
.empty{color:var(--faint);font-size:14px;padding:14px 0}
</style>
</head><body><div class="wrap">

<h1>Logins</h1>
<p class="sub">Boston Control Center &middot; signed in as <span class="name">${escText(who)}</span> &middot; <a href="/">back to the map</a></p>

${live ? '' : `<div class="note bad"><b>Nothing on this page can be saved.</b>
There is no Redis configured, so there is nowhere to write a login to. Add
KV_REST_API_URL and KV_REST_API_TOKEN in the Vercel project and redeploy. Until
then the buttons below will refuse rather than pretend.</div>`}

${error ? `<div class="note bad"><b>The stored list could not be read.</b>${escText(error)}</div>` : ''}

<div id="flash"></div>

<h2>Stored logins</h2>
<div class="card"><div id="table"></div></div>

<h2>Add a login</h2>
<div class="card">
  <div class="row">
    <div><label for="n">Username</label><input type="text" id="n" autocomplete="off" spellcheck="false" placeholder="RedSox"></div>
    <div><label for="s">Password</label><input type="password" id="s" autocomplete="new-password" placeholder="at least ${min} characters"></div>
  </div>
  <div class="row">
    <div><label for="d">Expires after (days)</label><input type="number" id="d" min="1" max="3650" placeholder="blank for never"></div>
    <div><label for="t">Note</label><input type="text" id="t" maxlength="120" autocomplete="off" placeholder="who this is for"></div>
  </div>
  <div class="check"><input type="checkbox" id="a"><label for="a" style="margin:0">Can manage logins too</label></div>
  <div id="gen"></div>
  <button class="primary" id="save">Add login</button>
  <button id="make">Generate a password</button>
</div>

${env.length ? `<h2>Set in Vercel</h2>
<div class="card">
  <p class="sub" style="margin:0 0 10px">These come from AUTH_USER and AUTH_USERS. They cannot be changed here,
  because a running function cannot write to its own environment. Change them in the Vercel project and redeploy,
  or add the same name above and the stored one takes over.</p>
  <div id="envlist"></div>
</div>` : ''}

<p class="foot">Passwords are stored as scrypt hashes and are never shown again after they are set,
here or anywhere else. Removing a login takes effect on the next request, with no redeploy.</p>

<script>
var DATA = ${embed({ users: list, env, live, min })};

var $ = function (id) { return document.getElementById(id); };
var busy = false;

function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
}

function when(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function flash(kind, text) {
  var box = $('flash');
  box.innerHTML = '';
  if (!text) return;
  box.appendChild(el('div', 'note ' + kind, text));
  box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/* Every mutation carries a JSON content-type and a header a form cannot set,
   which is what makes a cross-site post impossible rather than merely
   unlikely. See the CSRF note at the top of this file. */
function post(payload) {
  if (busy) return Promise.resolve(null);
  busy = true;
  return fetch(location.pathname + location.search, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-BCC-Admin': '1' },
    body: JSON.stringify(payload),
  }).then(function (r) {
    return r.json().catch(function () { return { ok: false, error: 'the server replied with ' + r.status }; });
  }).then(function (out) {
    busy = false;
    if (out && out.ok) {
      DATA.users = out.users; DATA.env = out.env || DATA.env;
      draw();
      flash('ok', out.note || 'Saved.');
    } else {
      flash('bad', (out && out.error) || 'That did not work.');
    }
    return out;
  }).catch(function (e) {
    busy = false;
    flash('bad', 'Could not reach the server: ' + e.message);
    return null;
  });
}

/* The whole table is rebuilt from DATA every time. It is at most a few dozen
   rows, and rebuilding is how the first paint and every later update stay the
   same code rather than two versions of nearly the same code. */
function draw() {
  var host = $('table');
  host.innerHTML = '';

  if (!DATA.users.length) {
    var e = el('div', 'empty', 'No stored logins yet. Anyone signing in right now is using a password set in Vercel.');
    host.appendChild(e);
  } else {
    var t = el('table'), head = el('tr');
    ['Name', 'Note', 'Added', 'Last seen', 'Expires', ''].forEach(function (h) { head.appendChild(el('th', null, h)); });
    t.appendChild(head);
    DATA.users.forEach(function (u) { t.appendChild(row(u)); });
    host.appendChild(t);
  }

  var envHost = $('envlist');
  if (envHost) {
    envHost.innerHTML = '';
    var shadowed = {};
    DATA.users.forEach(function (u) { shadowed[u.name] = true; });
    DATA.env.forEach(function (n) {
      var line = el('div');
      line.style.padding = '5px 0';
      line.appendChild(el('span', 'name', n));
      line.appendChild(el('span', 'tag env', shadowed[n] ? 'overridden above' : 'in use'));
      envHost.appendChild(line);
    });
  }
}

function row(u) {
  var tr = el('tr');

  var c1 = el('td');
  c1.appendChild(el('span', 'name', u.name));
  if (u.admin) c1.appendChild(el('span', 'tag admin', 'admin'));
  if (u.expired) c1.appendChild(el('span', 'tag gone', 'expired'));
  if (u.by) c1.appendChild(el('div', 'meta', 'added by ' + u.by));
  tr.appendChild(c1);

  tr.appendChild(el('td', null, u.note || ''));
  tr.appendChild(el('td', 'meta', when(u.added)));
  tr.appendChild(el('td', 'meta', u.seen ? when(u.seen) : 'never'));

  var c5 = el('td', 'meta', u.expires ? when(u.expires) : 'never');
  tr.appendChild(c5);

  var acts = el('td', 'acts');
  acts.appendChild(mini('New password', function () { reset(u.name); }));
  acts.appendChild(mini(u.admin ? 'Drop admin' : 'Make admin', function () {
    post({ action: 'admin', name: u.name, admin: !u.admin });
  }));
  acts.appendChild(mini(u.expires ? 'Never expire' : 'Expire in 7 days', function () {
    post({ action: 'expire', name: u.name, expires: u.expires ? null : 7 });
  }));
  var rm = mini('Remove', function (e) { remove(u.name, e.currentTarget); });
  rm.className += ' danger';
  acts.appendChild(rm);
  tr.appendChild(acts);
  return tr;
}

function mini(label, fn) {
  var b = el('button', 'mini', label);
  b.onclick = fn;
  return b;
}

/* Two clicks, no dialog. A browser confirm() blocks the page and is the first
   thing anybody learns to click through without reading, so the second click
   is on a button that has changed its own label to say what it will do. */
function remove(name, b) {
  if (b.dataset.armed === '1') { post({ action: 'remove', name: name }); return; }
  b.dataset.armed = '1';
  b.textContent = 'Really remove ' + name + '?';
  setTimeout(function () {
    if (!b.parentNode) return;
    b.dataset.armed = '0';
    b.textContent = 'Remove';
  }, 4000);
}

/* Setting a new password reuses the form below rather than growing a second
   one, so there is one field in this page that ever holds a plaintext. */
function reset(name) {
  $('n').value = name;
  $('n').readOnly = true;
  $('s').value = '';
  $('gen').innerHTML = '';
  $('save').textContent = 'Set new password for ' + name;
  $('save').dataset.mode = 'set';
  $('n').scrollIntoView({ block: 'center', behavior: 'smooth' });
  $('s').focus();
  flash('warn', 'Type or generate a new password for ' + name + '. Their old one stops working the moment you save.');
}

function clearForm() {
  $('n').value = ''; $('n').readOnly = false;
  $('s').value = ''; $('d').value = ''; $('t').value = '';
  $('a').checked = false;
  $('save').textContent = 'Add login';
  $('save').dataset.mode = 'add';
}

/* Generated here, in this browser, by the operating system's own randomness.
   It is never requested from the server and the server never invents one, so
   the only machine that has seen it before you do is yours.

   The alphabet drops the characters people misread out loud, because these get
   read down a phone more often than anyone admits. */
function makeSecret() {
  var A = 'abcdefghijkmnpqrstuvwxyzACDEFGHJKLMNPQRTUVWXY345679';
  var limit = 256 - (256 % A.length), out = '';
  while (out.length < 16) {
    var buf = new Uint8Array(32);
    crypto.getRandomValues(buf);
    for (var i = 0; i < buf.length && out.length < 16; i++) {
      if (buf[i] >= limit) continue;
      out += A.charAt(buf[i] % A.length);
    }
  }
  return out.replace(/(.{4})(?=.)/g, '$1-');
}

$('make').onclick = function () {
  var s = makeSecret();
  $('s').value = s;
  var box = $('gen');
  box.innerHTML = '';
  var w = el('div', 'note warn');
  w.appendChild(el('b', null, 'Copy this now. It is not shown again.'));
  var sb = el('div', 'secretbox', s);
  w.appendChild(sb);
  var copy = el('button', 'mini', 'Copy');
  copy.onclick = function () {
    navigator.clipboard.writeText(s).then(function () { copy.textContent = 'Copied'; },
      function () { copy.textContent = 'Select it by hand'; });
  };
  w.appendChild(copy);
  w.appendChild(el('span', null, '  Save the login before you close this page, or it is only a string on a screen.'));
  box.appendChild(w);
};

$('save').onclick = function () {
  var name = $('n').value.trim();
  var secret = $('s').value;
  var days = parseInt($('d').value, 10);
  if (!name) return flash('bad', 'A username is needed.');
  if (secret.length < DATA.min) return flash('bad', 'The password needs at least ' + DATA.min + ' characters.');
  var mode = $('save').dataset.mode === 'set' ? 'set' : 'add';
  var payload = { action: mode, name: name, secret: secret, admin: $('a').checked, note: $('t').value.trim() };
  /* An expiry is only sent when one was typed. Leaving it out is how the store
     is told to keep whatever the login already had, so setting a new password
     for a guest does not quietly make them permanent. */
  if (days > 0) payload.expires = days;
  else if (mode === 'add') payload.expires = null;
  post(payload).then(function (out) { if (out && out.ok) { clearForm(); $('gen').innerHTML = ''; } });
};

/* A password field left sitting in a form is a password field somebody walks
   away from. Cleared on the way out, which does nothing against a real
   attacker and quite a lot against an ordinary Tuesday. */
window.addEventListener('pagehide', function () { $('s').value = ''; });

clearForm();
draw();
</script>
</div></body></html>`;
}

/* Only for the few values rendered into the shell rather than into the table.
   Everything a person types goes through the table, which uses textContent and
   never touches this. */
function escText(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
