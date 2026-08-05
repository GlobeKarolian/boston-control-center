#!/usr/bin/env node
'use strict';

/* tools/user.js — managing who can log into the control center, from a terminal.
 *
 *   node tools/user.js list
 *   node tools/user.js add RedSox --generate --days 7 --note "Globe guest"
 *   node tools/user.js set newsroom --admin
 *   node tools/user.js expire RedSox --days 30
 *   node tools/user.js admin someone off
 *   node tools/user.js rm RedSox
 *   node tools/user.js unlock
 *   node tools/user.js doctor
 *
 * The secret is never an argument. Arguments end up in ~/.zsh_history and are
 * visible to anybody who runs `ps` while the command is in flight, so this
 * prompts for it with the echo turned off, or generates one here on this
 * machine with --generate and prints it exactly once. What gets stored is a
 * scrypt hash either way; the secret itself is never written to disk.
 *
 * This talks to the same Redis the deployment talks to, so a change made here
 * is live everywhere the moment it is written. That is the point, and it is
 * also the reason to read what it prints. */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ---- the environment ------------------------------------------------------

   Order matters more than it looks: lib/kv.js decides whether it has a real
   Redis at require time, so .env.local has to be in process.env before that
   require happens. Load first, require second, or every write in this tool
   goes into a process Map and disappears when the command exits. */
const ROOT = path.resolve(__dirname, '..');

function loadEnv(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return 0; }
  let n = 0;
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s[0] === '#') continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(s);
    if (!m) continue;
    let v = m[2].trim();
    const q = v[0];
    if ((q === '"' || q === "'") && v.length > 1 && v[v.length - 1] === q) {
      v = v.slice(1, -1);
      if (q === '"') v = v.replace(/\\n/g, '\n');
    }
    /* A real environment variable beats the file. Somebody who exports
       KV_REST_API_URL to point at a scratch Redis means it. */
    if (process.env[m[1]] === undefined) { process.env[m[1]] = v; n++; }
  }
  return n;
}

loadEnv(path.join(ROOT, '.env.local'));
loadEnv(path.join(ROOT, '.env'));

const kv = require(path.join(ROOT, 'lib', 'kv.js'));
const store = require(path.join(ROOT, 'lib', 'users.js'));

/* ---- talking to a terminal ------------------------------------------------ */

const TTY = process.stdout.isTTY;
const ESC = String.fromCharCode(27);
const c = (code, s) => (TTY ? ESC + '[' + code + 'm' + s + ESC + '[0m' : s);
const bold = s => c('1', s);
const dim = s => c('2', s);
const red = s => c('31', s);
const green = s => c('32', s);
const yellow = s => c('33', s);

const say = s => process.stdout.write(s + '\n');
const blank = () => process.stdout.write('\n');

function die(msg) {
  process.stderr.write(red('error: ') + msg + '\n');
  process.exit(1);
}

/* ---- arguments ------------------------------------------------------------

   Flags are pulled out first so the positional arguments stay in the order
   they were typed, which lets `admin someone off` read the way it sounds. */
function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { rest.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = (eq < 0 ? a.slice(2) : a.slice(2, eq));
      let val = eq < 0 ? null : a.slice(eq + 1);
      if (val === null) {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) { val = next; i++; }
        else val = true;
      }
      flags[key] = val;
      continue;
    }
    rest.push(a);
  }
  return { flags, rest };
}

function days(flags) {
  if (flags.days === undefined) return undefined;
  if (flags.days === true) die('--days needs a number, like --days 7');
  const n = Number(flags.days);
  if (!Number.isFinite(n) || n <= 0) die('--days must be a positive number of days');
  return n;
}

/* ---- asking for a secret without showing it -------------------------------

   Raw mode, echo suppressed by simply not writing the keystrokes back. The
   cleanup runs on every exit path, including ctrl-c, because a terminal left
   in raw mode with no echo is a terminal the user has to close. */
function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      return reject(new Error(
        'no terminal to type into. Run this yourself in Terminal; it will not read a secret from a pipe.'));
    }
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const finish = (err, val) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
      if (err) reject(err); else resolve(val);
    };
    const onData = chunk => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish(null, buf);
        if (ch === '\u0003') return finish(new Error('cancelled'));
        if (ch === '\u007f' || ch === '\b') { buf = buf.slice(0, -1); continue; }
        if (ch < ' ') continue;
        buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function askTwice() {
  const a = await askHidden('  new secret (typing is hidden): ');
  if (a.length < store.MIN_SECRET) throw new Error('too short. At least ' + store.MIN_SECRET + ' characters.');
  const b = await askHidden('  again to confirm: ');
  if (a !== b) throw new Error('those did not match. Nothing was changed.');
  return a;
}

/* ---- generating one here --------------------------------------------------

   Made on this machine, shown once, stored only as a hash. Nothing else ever
   sees it. The alphabet drops the characters that get misread out loud or in
   a screenshot, so the thing survives being read over the phone. Rejection
   sampling rather than modulo, because modulo would quietly make the first
   few characters of the alphabet more likely. */
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzACDEFGHJKLMNPQRTUVWXY345679';

function generate(len) {
  const n = len || 16;
  const limit = 256 - (256 % ALPHABET.length);
  let out = '';
  while (out.length < n) {
    for (const b of crypto.randomBytes(n * 2)) {
      if (b >= limit) continue;
      out += ALPHABET[b % ALPHABET.length];
      if (out.length === n) break;
    }
  }
  return out.replace(/(.{4})(?=.)/g, '$1-');
}

/* ---- showing the table ---------------------------------------------------- */

function when(iso) {
  if (!iso) return dim('never');
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return dim('?');
  const mins = Math.round((Date.now() - t) / 60000);
  const ago = Math.abs(mins) < 60 ? Math.abs(mins) + 'm'
    : Math.abs(mins) < 1440 ? Math.round(Math.abs(mins) / 60) + 'h'
    : Math.round(Math.abs(mins) / 1440) + 'd';
  return mins >= 0 ? ago + ' ago' : 'in ' + ago;
}

function row(u) {
  const tags = [];
  if (u.admin) tags.push(green('admin'));
  if (u.expired) tags.push(red('EXPIRED'));
  else if (u.expires) tags.push(yellow('expires ' + when(u.expires)));
  const head = bold(u.name.padEnd(16)) + (tags.length ? tags.join(' ') : dim('viewer'));
  const facts = [];
  facts.push('last seen ' + (u.seen ? when(u.seen) : dim('never')));
  if (u.added) facts.push('added ' + when(u.added));
  if (u.note) facts.push(u.note);
  return head + '\n' + '                ' + dim(facts.join('  ·  '));
}

async function cmdList() {
  const list = await store.list();
  const env = store.envTable();
  const envNames = Object.keys(env).filter(n => n.trim());
  blank();
  if (!list.length) say(dim('  No logins in the store yet.'));
  for (const u of list) say('  ' + row(u));
  if (envNames.length) {
    blank();
    say(dim('  Also set in the environment (change these in Vercel, not here):'));
    for (const n of envNames) {
      const shadowed = list.some(u => u.name === n);
      say('    ' + n + (shadowed ? dim('  overridden by the stored login above') : ''));
    }
  }
  blank();
}

/* ---- what has to be true for a change here to matter out there -------------

   Two ways a change made in this terminal can look successful and do nothing,
   and both are worth a paragraph rather than a shrug.

   Without Redis credentials, lib/kv.js writes to a Map in this process, so the
   record exists for about four milliseconds and is then garbage collected.

   And the deployed site only consults this store once lib/http.js is wired to
   read it. Until then the live door is still the environment variables, and a
   login added here is real, stored, and completely ignored. */
function storeIsWired() {
  try {
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'http.js'), 'utf8');
    return /require\(\s*['"]\.\/users(\.js)?['"]\s*\)/.test(src);
  } catch (e) { return false; }
}

/* Refused before anything happens rather than warned about afterwards. The
   old order printed a freshly generated secret and then admitted it had not
   been stored, which is the sort of thing somebody reads half of and hands to
   a colleague. */
function requireStore() {
  if (kv.live) return;
  blank();
  say(red('  No Redis, so there is nowhere to save this.'));
  say('  Nothing was changed. This command needs KV_REST_API_URL and KV_REST_API_TOKEN,');
  say('  which live in ' + dim(path.join(ROOT, '.env.local')) + '.');
  say('  If that file is missing, ' + bold('vercel env pull .env.local') + ' will fetch it.');
  blank();
  process.exit(1);
}

function afterwards() {
  if (!storeIsWired()) {
    blank();
    say(yellow('  Saved, but the live site cannot see it yet.'));
    say('  lib/http.js still checks only the environment variables, so this login will');
    say('  not open anything until that is wired to the store and you deploy.');
  }
}

const whoami = () => String(process.env.USER || process.env.LOGNAME || 'terminal');

/* ---- add and set ---------------------------------------------------------- */

async function cmdSet(verb, name, flags) {
  if (!name) die(verb + ' needs a username, like: node tools/user.js ' + verb + ' RedSox');
  requireStore();
  let n;
  try { n = store.cleanName(name); } catch (e) { die(e.message); }

  const before = await store.load(true);
  if (before.error) die('cannot reach the user store: ' + before.error);
  const exists = !!before.users[n];
  if (verb === 'add' && exists) die(n + ' already exists. Use `set ' + n + '` to change their secret.');
  if (verb === 'set' && !exists) die('no stored login named ' + n + '. Use `add ' + n + '` to create one.');

  let secret, generated = null;
  if (flags.generate) {
    secret = generate(16);
    generated = secret;
  } else {
    blank();
    say(dim('  Nothing you type below is shown, and none of it is written to disk.'));
    try { secret = await askTwice(); } catch (e) { die(e.message); }
  }

  const opts = { by: whoami() };
  if (flags.admin !== undefined) opts.admin = !(flags.admin === 'off' || flags.admin === 'false');
  if (flags.note !== undefined) opts.note = flags.note === true ? '' : String(flags.note);
  const d = days(flags);
  if (d !== undefined) opts.expires = d;
  else if (flags.forever) opts.expires = null;

  let r;
  try { r = await store.put(n, secret, opts); } catch (e) { die(e.message); }

  blank();
  say('  ' + green(r.created ? 'Created' : 'Updated') + ' ' + bold(n) + (r.user.admin ? ' ' + green('(admin)') : ''));
  if (r.user.expires) say('  ' + yellow('Expires ' + when(r.user.expires)) + dim('  ' + r.user.expires));

  if (generated) {
    blank();
    say('  ' + bold('The secret, shown once and never again:'));
    blank();
    say('      ' + bold(generated));
    blank();
    say(dim('  Only a scrypt hash of that went into the store, so nobody, including this'));
    say(dim('  tool, can read it back. Hand it over by voice or a password manager, and if'));
    say(dim('  it goes astray run `set ' + n + ' --generate` to make the old one worthless.'));
  }

  afterwards();
  blank();
}

/* ---- the smaller changes -------------------------------------------------- */

async function cmdAdmin(name, word) {
  if (!name) die('admin needs a username, like: node tools/user.js admin RedSox off');
  requireStore();
  const on = !(word === 'off' || word === 'no' || word === 'false');
  let u;
  try { u = await store.setAdmin(name, on, whoami()); } catch (e) { die(e.message); }
  blank();
  say('  ' + bold(u.name) + ' is now ' + (u.admin ? green('an admin') : dim('a viewer')));
  afterwards();
  blank();
}

async function cmdExpire(name, word, flags) {
  if (!name) die('expire needs a username, like: node tools/user.js expire RedSox --days 7');
  requireStore();
  const d = days(flags);
  const off = word === 'off' || word === 'never' || flags.forever;
  if (d === undefined && !off) die('say how long: --days 7, or `expire ' + name + ' off` to make it permanent.');
  let u;
  try { u = await store.setExpires(name, off ? null : d, whoami()); } catch (e) { die(e.message); }
  blank();
  if (u.expires) say('  ' + bold(u.name) + ' now expires ' + yellow(when(u.expires)) + dim('  ' + u.expires));
  else say('  ' + bold(u.name) + ' no longer expires');
  afterwards();
  blank();
}

async function cmdRm(name) {
  if (!name) die('rm needs a username, like: node tools/user.js rm RedSox');
  requireStore();
  let r;
  try { r = await store.remove(name); } catch (e) { die(e.message); }
  blank();
  say('  ' + green('Removed') + ' ' + bold(r.removed));
  say(dim('  Their credential stops working within ten seconds everywhere, and sooner'));
  say(dim('  than that on any instance that has not cached the table.'));
  afterwards();
  blank();
}

async function cmdUnlock(ip) {
  if (!ip) die('unlock needs the address to clear, like: node tools/user.js unlock 24.61.0.7');
  await store.clearFails(ip);
  blank();
  say('  ' + green('Cleared') + ' the failed-login count for ' + bold(ip));
  blank();
}

/* ---- doctor ---------------------------------------------------------------

   Answers the question this tool gets asked most, which is never "what is the
   table" but "why did the thing I just did not work". Names only, never
   values: this prints what is configured, not what any of it is. */
async function cmdDoctor() {
  blank();
  say(bold('  Storage'));
  if (kv.live) {
    say('    ' + green('Redis is reachable') + dim('  writes here are live on the site'));
  } else {
    say('    ' + red('No Redis') + '  every write is thrown away when this command exits');
    say('    ' + dim('Looked for KV_REST_API_URL and KV_REST_API_TOKEN in ' + path.join(ROOT, '.env.local')));
  }

  let table = null;
  try {
    const r = await store.load(true);
    if (r.error) say('    ' + red('Store unreadable: ') + r.error);
    else table = r.users;
  } catch (e) { say('    ' + red('Store unreadable: ') + e.message); }

  blank();
  say(bold('  Logins'));
  const env = store.envTable();
  const envNames = Object.keys(env).filter(n => n.trim());
  const names = table ? Object.keys(table) : [];
  say('    ' + names.length + ' in the store, ' + envNames.length + ' in the environment');
  if (table) {
    const admins = names.filter(n => table[n].admin && !store.expired(table[n]));
    const lapsed = names.filter(n => store.expired(table[n]));
    say('    admins: ' + (admins.length ? admins.join(', ') : dim('none in the store')));
    if (lapsed.length) say('    ' + yellow('expired: ') + lapsed.join(', '));
  }
  const envAdmins = store.adminNames();
  say('    ADMIN_USERS: ' + (process.env.ADMIN_USERS
    ? envAdmins.join(', ')
    : dim('unset, so the admin is ' + envAdmins.join(', ') + ' by default')));

  /* Vercel keeps AUTH_USER and friends in its own dashboard, not in
     .env.local, so from this laptop the environment table looks empty even
     when the deployment has one. Saying so out loud stops the next line from
     reading as an emergency when it is only a different vantage point. */
  const blind = !envNames.length && !process.env.VERCEL;
  if (blind) {
    say('    ' + dim('This laptop cannot see AUTH_USER / AUTH_USERS: those live in the Vercel'));
    say('    ' + dim('dashboard, not in .env.local, so the count above is the store only.'));
  }

  if (table && !names.filter(n => table[n].admin && !store.expired(table[n])).length
      && !envAdmins.some(n => env[n]) && !blind) {
    say('    ' + red('Nobody can reach /admin.') + ' Add one: node tools/user.js add ' + envAdmins[0] + ' --admin --generate');
  } else if (table && !names.length) {
    say('    ' + dim('No stored logins yet. The first one: node tools/user.js add ' + envAdmins[0] + ' --admin --generate'));
  }

  blank();
  say(bold('  The live site'));
  if (storeIsWired()) {
    say('    ' + green('lib/http.js reads the store') + dim('  changes here take effect on the next deploy'));
  } else {
    say('    ' + yellow('lib/http.js does not read the store yet.'));
    say('    ' + dim('The deployed door is still AUTH_USER / AUTH_PASS. Logins added here are'));
    say('    ' + dim('stored correctly and ignored completely until that is wired up.'));
  }
  say('    ' + dim('Share https://boston-control-center.vercel.app and nothing else. Any URL'));
  say('    ' + dim('with a hash in it, or -mkarolians-projects, is behind Vercel SSO and will'));
  say('    ' + dim('ask a guest for a Vercel password they do not have.'));
  blank();
}

/* ---- usage ---------------------------------------------------------------- */

function usage() {
  blank();
  say(bold('  node tools/user.js') + ' — who can log into the control center');
  blank();
  say('  ' + bold('list') + '                           everyone, and where they came from');
  say('  ' + bold('add <name>') + ' [--generate]        create a login');
  say('  ' + bold('set <name>') + ' [--generate]        change an existing one');
  say('  ' + bold('admin <name>') + ' [off]             grant or take away the admin page');
  say('  ' + bold('expire <name>') + ' --days N | off   change when a login lapses');
  say('  ' + bold('rm <name>') + '                      delete a login');
  say('  ' + bold('unlock <ip>') + '                    clear a failed-login lockout');
  say('  ' + bold('doctor') + '                         why is this not working');
  blank();
  say('  ' + dim('--generate') + '   make the secret here, show it once, store only its hash');
  say('  ' + dim('--days N') + '     the login stops working in N days');
  say('  ' + dim('--admin') + '      can reach /admin and change other people');
  say('  ' + dim('--note "..."') + ' a reminder of who this is');
  blank();
  say(dim('  There is no flag for passing a secret on the command line, on purpose:'));
  say(dim('  arguments are saved to your shell history and visible to `ps`. Without'));
  say(dim('  --generate you are prompted, with the typing hidden.'));
  blank();
  say('  ' + dim('e.g.') + '  node tools/user.js add RedSox --generate --days 7 --note "Globe guest"');
  blank();
}

/* ---- dispatch -------------------------------------------------------------

   Every command that changes something goes through lib/users.js rather than
   writing to Redis directly, so the last-admin guard and the name rules hold
   here exactly as they do on the admin page. A terminal is not a licence to
   lock yourself out. */
async function main() {
  const { flags, rest } = parseArgs(process.argv.slice(2));
  const cmd = (rest[0] || 'list').toLowerCase();

  if (flags.help || flags.h || cmd === 'help' || cmd === '--help') return usage();

  switch (cmd) {
    case 'list': case 'ls': return cmdList();
    case 'add': case 'new': return cmdSet('add', rest[1], flags);
    case 'set': case 'passwd': case 'reset': return cmdSet('set', rest[1], flags);
    case 'admin': return cmdAdmin(rest[1], rest[2]);
    case 'expire': case 'expires': return cmdExpire(rest[1], rest[2], flags);
    case 'rm': case 'remove': case 'delete': return cmdRm(rest[1]);
    case 'unlock': return cmdUnlock(rest[1]);
    case 'doctor': case 'check': return cmdDoctor();
    default:
      usage();
      die('no command called ' + JSON.stringify(cmd));
  }
}

main().then(
  () => process.exit(0),
  e => {
    /* A cancelled prompt is a decision, not a failure, and should not print a
       stack trace at somebody who pressed ctrl-c on purpose. */
    if (e && e.message === 'cancelled') { process.stdout.write('\n'); process.exit(130); }
    die((e && e.message) || String(e));
  }
);
