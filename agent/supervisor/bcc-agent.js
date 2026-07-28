#!/usr/bin/env node
/* ============================================================================
   BCC agent - the half of the Boston Newsroom Control Center that has to stay
   on a Mac.

     capture -> ffmpeg segments -> silence gate -> local Whisper -> POST

   Everything downstream of the transcript (extract, geocode, the analyst pass,
   the map itself) moved to Vercel. This process ships text, never audio, and it
   holds exactly one secret: its own ingest token.

   Two reasons the capture cannot move to the cloud:

     1. Broadcastify refuses datacenter IP ranges. That is what killed the last
        cloud attempt outright. A Mac on a residential connection is not a
        workaround, it is the only thing that works.
     2. A browser playing the BPD feed is a browser on somebody's desk. There is
        no cloud equivalent of tapping Chrome's audio.

   Capture modes, one per source in the config:

     kind "broadcastify"   curl the Premium MP3 stream, pipe to ffmpeg
     kind "audiotap"       bcc-audiotap taps a running app's audio output and
                           writes raw float32 to stdout, pipe that to ffmpeg

   Both land in the same place: 15-second 16 kHz mono WAVs with a voice bandpass
   on them, which is the exact shape faster-whisper wants.

   Usage
     bcc-agent.js                       use the first config found (see below)
     bcc-agent.js --config path.json
     bcc-agent.js --once                run one cycle then exit (for smoke tests)
     bcc-agent.js --dry-run             transcribe but never POST; print instead

   Config search order: --config, $BCC_CONFIG, ~/.bcc/config.json,
   /Library/Application Support/BCC/config.json
   ========================================================================== */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const val = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

const HOME = os.homedir();
const HERE = __dirname;

/* ---------------------------------------------------------------- config -- */

const CONFIG_CANDIDATES = [
  val('--config'),
  process.env.BCC_CONFIG,
  path.join(HOME, '.bcc', 'config.json'),
  '/Library/Application Support/BCC/config.json',
].filter(Boolean);

function loadConfig() {
  for (const p of CONFIG_CANDIDATES) {
    if (!fs.existsSync(p)) continue;
    try {
      const c = JSON.parse(fs.readFileSync(p, 'utf8'));
      c.__path = p;
      return c;
    } catch (e) {
      die('config at ' + p + ' is not valid JSON: ' + e.message);
    }
  }
  die('no config found. Looked at:\n  ' + CONFIG_CANDIDATES.join('\n  ')
    + '\nCopy config.example.json to ~/.bcc/config.json and edit it.');
}

function die(msg) { console.error('bcc-agent: ' + msg); process.exit(2); }

const CFG = loadConfig();

/* A machine id is how the server tells one Mac's feeds from another's, and it is
   what you revoke when a laptop walks out the door. Default to the hostname so a
   fresh install is not immediately broken, but the config should name it. */
const MACHINE = String(CFG.machine || os.hostname().replace(/\.local$/, '')).trim();
const ENDPOINT = String(CFG.endpoint || '').replace(/\/+$/, '');
const DRY = has('--dry-run');
if (!ENDPOINT && !DRY) die('config needs "endpoint", e.g. https://your-app.vercel.app');

const STATE_DIR = CFG.stateDir || path.join(HOME, '.bcc');
fs.mkdirSync(STATE_DIR, { recursive: true });

const SEGMENT_SECONDS = Number(CFG.segmentSeconds) > 0 ? Number(CFG.segmentSeconds) : 15;
/* Peak amplitude, 0 to 1, below which a clip is assumed to be dead air and never
   reaches Whisper. This is the cheapest fix for the oldest bug in the pipeline:
   Whisper hallucinates confident sentences out of hiss, and a scanner channel is
   mostly hiss. Peak rather than RMS because a real transmission is loud in bursts
   and quiet in between, so its RMS can sit close to noise while its peak never
   does. Set to 0 to send everything.

   The default has to differ by capture kind, and measuring the two proved why.
   A Broadcastify feed with nothing on it is not quiet, it is digitally silent:
   Boston Fire at 2am measured -91 dB, which is the 16-bit noise floor, 28
   nonzero bytes in a 480 KB clip. A gate at 0.01 (-40 dB) sits far below any
   real transmission and far above that.

   A tap is a different animal, because its level is whatever the person at the
   keyboard left the tab volume on. A capture made at 5% volume measured a peak
   of 0.0062, which that same 0.01 gate would have thrown away as silence. So
   taps gate an order of magnitude lower, and carry an optional gain. */
const GATE_BROADCASTIFY = CFG.silenceGate === undefined ? 0.01 : Number(CFG.silenceGate);
const GATE_AUDIOTAP = CFG.silenceGateTap === undefined ? 0.0015 : Number(CFG.silenceGateTap);
const BATCH_MAX = 20;
const FLUSH_MS = 2000;
const HEARTBEAT_MS = 30000;
const QUEUE_MAX = 2000;

const SOURCES = (Array.isArray(CFG.sources) ? CFG.sources : []).filter(s => s && s.id);
if (!SOURCES.length) die('config has no "sources". See config.example.json.');
for (const s of SOURCES) {
  if (!/^[a-z0-9-]+$/.test(s.id)) {
    die('source id "' + s.id + '" must be lowercase letters, digits and dashes only. '
      + 'The id becomes part of a filename and is parsed back out of it.');
  }
  s.kind = s.kind || (s.feed ? 'broadcastify' : 'audiotap');
  s.city = s.city || 'Boston';
  s.gate = s.silenceGate === undefined
    ? (s.kind === 'audiotap' ? GATE_AUDIOTAP : GATE_BROADCASTIFY)
    : Number(s.silenceGate);
  /* A linear multiplier applied inside ffmpeg, for a tap that is simply too
     quiet to transcribe well. Whisper tolerates a low level better than it
     tolerates clipping, so this stays off unless a source asks for it. */
  s.gain = Number(s.gain) > 0 ? Number(s.gain) : 0;
}

/* ------------------------------------------------------------- secrets ---- */
/* Read at runtime, never logged, never written anywhere by this process. Every
   error path in here runs through redact() before it reaches a console. */

function readSecretFile(p) {
  try { return fs.readFileSync(p, 'utf8').trim(); } catch (e) { return ''; }
}

const INGEST_SECRET = process.env.BCC_INGEST_SECRET
  || readSecretFile(CFG.ingestSecretFile || path.join(STATE_DIR, '.ingest_secret'));
if (!INGEST_SECRET && !DRY) {
  die('no ingest secret. Write it to ' + path.join(STATE_DIR, '.ingest_secret')
    + ' (chmod 600) or set BCC_INGEST_SECRET.');
}

/* Broadcastify Premium. Falls back to the file layout the old worker used so an
   existing machine needs no new setup: line 1 user, line 2 password. */
let BF_USER = process.env.BROADCASTIFY_USER || '';
let BF_PASS = process.env.BROADCASTIFY_PASS || '';
if (!BF_USER || !BF_PASS) {
  const lf = CFG.broadcastifyLoginFile || path.join(HOME, '.boston-control-center', '.login');
  const lines = readSecretFile(lf).split('\n').map(x => x.trim()).filter(Boolean);
  if (lines.length >= 2) { BF_USER = BF_USER || lines[0]; BF_PASS = BF_PASS || lines[1]; }
}

const SECRETS = [INGEST_SECRET, BF_PASS, BF_USER].filter(x => x && x.length > 3);
const redact = s => {
  let out = String(s == null ? '' : s);
  for (const v of SECRETS) out = out.split(v).join('<redacted>');
  /* Credentials also travel inside stream URLs, so blank any userinfo section
     even if the value itself did not match one we know about. */
  return out.replace(/(https?:\/\/)[^/@\s]*@/gi, '$1<redacted>@');
};
const log = (...a) => console.log(a.map(redact).join(' '));
const warn = (...a) => console.error(a.map(redact).join(' '));

/* --------------------------------------------------------------- paths ---- */

function firstExisting(list) { return list.find(p => p && fs.existsSync(p)) || null; }

const AUDIOTAP = CFG.audiotapPath || firstExisting([
  path.join(HERE, 'bcc-audiotap'),
  path.join(HERE, '..', 'audiotap', 'bcc-audiotap'),
  '/Library/Application Support/BCC/bin/bcc-audiotap',
  '/usr/local/bin/bcc-audiotap',
]);

const STT = CFG.sttPath || firstExisting([
  path.join(HERE, 'stt.py'),
  path.join(HOME, '.boston-control-center', 'scanner-worker', 'stt.py'),
  '/Library/Application Support/BCC/bin/stt.py',
]);
if (!STT) die('cannot find stt.py. Put it next to this script or set "sttPath" in the config.');

const PYTHON = CFG.python || 'python3';
const FFMPEG = CFG.ffmpeg || firstExisting(['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']) || 'ffmpeg';

/* ------------------------------------------------- single instance guard -- */
/* Two supervisors on one Mac means two copies of every transmission arriving at
   the server, each with its own timestamp, which the correlation store has no
   way to tell apart from a genuine repeat call. Replace the old one. */
const LOCK = path.join(STATE_DIR, 'agent.lock');
try {
  const prev = fs.existsSync(LOCK) ? parseInt(fs.readFileSync(LOCK, 'utf8'), 10) : 0;
  if (prev && prev !== process.pid) { try { process.kill(prev, 'SIGTERM'); } catch (e) {} }
  fs.writeFileSync(LOCK, String(process.pid));
} catch (e) {}

/* -------------------------------------------------------------- health ---- */
/* Two facts kept deliberately apart, because collapsing them is what used to
   make a merely quiet channel indistinguishable from a dead one:
     clips / lastAudioAt  audio is arriving at all
     segs  / lastTextAt   somebody spoke and Whisper wrote it down            */
const health = {};
for (const s of SOURCES) {
  health[s.id] = {
    id: s.id, kind: s.kind, city: s.city, feed: s.feed || null, app: s.app || null,
    status: 'starting', clips: 0, segs: 0, gated: 0, attempts: 0,
    lastAudioAt: null, lastTextAt: null, lastError: null,
    /* The loudest and most recent peak this source has produced, so a gate that
       is set wrong is visible in the status file instead of being inferred from
       a suspicious run of zero transcripts. gate is carried here too so the two
       numbers can be compared without opening the config. */
    gate: s.gate, peakMax: 0, peakLast: null,
  };
}
const srcById = {};
for (const s of SOURCES) srcById[s.id] = s;

const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bcc-agent-'));
let nonce = 0;
const children = new Set();
let stopping = false;

function track(child) {
  children.add(child);
  child.on('exit', () => children.delete(child));
  child.on('error', () => {});
  return child;
}

const firstLine = s => (String(s || '').split('\n').map(x => x.trim()).filter(Boolean)[0] || '').slice(0, 120);

/* ffmpeg is identical on both paths past the input. 16 kHz mono with the voice
   band isolated, cut into fixed segments. The bandpass is not cosmetic: scanner
   audio carries a lot of energy outside speech and Whisper reads it as words. */
function ffmpegArgs(inputArgs, tag, gain) {
  const filters = [];
  if (gain > 0) filters.push('volume=' + gain);
  filters.push('highpass=f=250', 'lowpass=f=3500');
  return [
    '-hide_banner', '-loglevel', 'error',
    ...inputArgs,
    '-ac', '1', '-ar', '16000', '-af', filters.join(','),
    '-f', 'segment', '-segment_time', String(SEGMENT_SECONDS), '-reset_timestamps', '1',
    path.join(WORKDIR, tag + '_%05d.wav'),
  ];
}

/* Restart policy shared by both capture kinds. A source that streamed for a
   while and then dropped is a transient network event and comes back in
   seconds. A source that dies immediately is misconfigured, offline, or
   rejecting our credentials, and hammering it every four seconds produces
   nothing but log noise, so it goes dormant and gets rechecked every 5 min. */
function scheduleRestart(src, startedAt, errText, restart) {
  if (stopping) return;
  const st = health[src.id];
  const alive = Date.now() - startedAt;
  st.lastError = firstLine(errText) || st.lastError;
  if (alive > 30000) {
    if (st.attempts > 0 || st.status === 'offline') log('[' + src.id + '] back online');
    st.attempts = 0;
    st.status = 'reconnecting';
    setTimeout(restart, 4000);
    return;
  }
  st.attempts++;
  if (st.attempts >= 5) {
    if (st.status !== 'offline') warn('[' + src.id + '] offline (' + st.lastError + '); rechecking every 5 min');
    st.status = 'offline';
    setTimeout(restart, 300000);
  } else {
    st.status = 'reconnecting';
    const delay = Math.min(60000, 4000 * Math.pow(2, st.attempts - 1));
    if (st.attempts <= 2) warn('[' + src.id + '] no audio (' + st.lastError + '); retry ' + st.attempts + ' in ' + Math.round(delay / 1000) + 's');
    setTimeout(restart, delay);
  }
}

/* ------------------------------------------- capture: Broadcastify feed ---- */
/* curl does the authentication rather than ffmpeg because ffmpeg's own HTTP
   client has been unreliable against Broadcastify's Premium redirect, and this
   split has been running in production for weeks. The password reaches curl
   through argv, which is visible to other processes on this Mac and nowhere
   else, and never touches a log because every error path goes through redact. */
function startBroadcastify(src) {
  const st = health[src.id];
  const tag = src.id + '_' + (nonce++);
  const startedAt = Date.now();
  let errBuf = '';

  if (!BF_USER || !BF_PASS) {
    st.status = 'offline';
    st.lastError = 'no Broadcastify Premium credentials';
    warn('[' + src.id + '] no Broadcastify credentials; this feed will 401');
  }

  const url = 'https://audio.broadcastify.com/' + src.feed + '.mp3';
  const cu = track(spawn('curl', ['-sS', '-A', 'Mozilla/5.0',
    ...(BF_USER && BF_PASS ? ['-u', BF_USER + ':' + BF_PASS] : []), url]));
  const ff = track(spawn(FFMPEG, ffmpegArgs(['-i', 'pipe:0'], tag, src.gain)));

  cu.stdout.pipe(ff.stdin);
  cu.stdout.on('error', () => {});
  ff.stdin.on('error', () => {});   // EPIPE when whichever side dies first
  cu.stderr.on('data', d => { errBuf += d; });
  ff.stderr.on('data', d => { errBuf += d; });

  let done = false;
  const finish = () => {
    if (done) return; done = true;
    try { ff.stdin.end(); } catch (e) {}
    try { cu.kill('SIGKILL'); } catch (e) {}
    try { ff.kill('SIGKILL'); } catch (e) {}
    scheduleRestart(src, startedAt, errBuf, () => startBroadcastify(src));
  };
  cu.on('exit', finish); cu.on('error', finish);
  ff.on('exit', code => { if (code) finish(); }); ff.on('error', finish);
  st.status = st.status === 'offline' ? 'offline' : 'connecting';
}

/* ----------------------------------------------- capture: browser audio ---- */
/* bcc-audiotap announces its sample rate and channel count on stderr before it
   writes a single byte of audio, because a raw float32 stream carries no header
   and guessing wrong turns speech into chipmunks. So: spawn the tap, wait for
   that line, then build ffmpeg's input flags from it and connect the pipe.

   Nothing reads stdout until then. Node leaves a child's stdout paused until it
   is piped or listened to, and the tap holds two seconds of audio internally, so
   the handful of milliseconds this costs are free. */
function startAudiotap(src) {
  const st = health[src.id];
  const tag = src.id + '_' + (nonce++);
  const startedAt = Date.now();
  let errBuf = '';

  if (!AUDIOTAP) {
    st.status = 'offline';
    st.lastError = 'bcc-audiotap binary not found';
    warn('[' + src.id + '] bcc-audiotap not found; set "audiotapPath" in the config');
    return;
  }

  const args = src.system ? ['--system']
    : src.pid ? ['--pid', String(src.pid)]
    : ['--app', String(src.app || '')];
  const tap = track(spawn(AUDIOTAP, args));
  let ff = null, connected = false, done = false, formatTimer = null;

  /* One finish per invocation, guarded by a local rather than a flag on the
     shared health record. A late exit event from the process we just replaced
     must not be able to schedule a second restart on top of the live one. */
  const finish = (why) => {
    if (done) return; done = true;
    if (formatTimer) clearTimeout(formatTimer);
    try { if (ff) { ff.stdin.end(); ff.kill('SIGKILL'); } } catch (e) {}
    try { tap.kill('SIGKILL'); } catch (e) {}
    scheduleRestart(src, startedAt, why || errBuf, () => startAudiotap(src));
  };

  /* If the app is not running, or is running but has not opened an audio device
     yet, the tap exits with a readable message. If it just hangs, this catches
     it. Either way the restart policy handles the waiting. */
  formatTimer = setTimeout(() => {
    if (!connected) finish('tap produced no FORMAT line in 15s');
  }, 15000);

  tap.stderr.on('data', d => {
    errBuf += d;
    if (connected) return;
    const m = /FORMAT\s+f32le\s+(\d+)\s+(\d+)/.exec(errBuf);
    if (!m) return;
    connected = true;
    clearTimeout(formatTimer);
    const rate = m[1], ch = m[2];
    log('[' + src.id + '] tapping ' + (src.system ? 'system audio' : (src.app || 'pid ' + src.pid))
      + ' at ' + rate + ' Hz, ' + ch + ' ch');
    ff = track(spawn(FFMPEG, ffmpegArgs(
      ['-f', 'f32le', '-ar', rate, '-ac', ch, '-i', 'pipe:0'], tag, src.gain)));
    tap.stdout.pipe(ff.stdin);
    tap.stdout.on('error', () => {});
    ff.stdin.on('error', () => {});
    ff.stderr.on('data', x => { errBuf += x; });
    ff.on('exit', code => { if (code) finish(); });
    ff.on('error', () => finish());
    st.status = 'connecting';
  });

  tap.on('exit', () => finish());
  tap.on('error', () => finish());
  st.status = 'connecting';
}

/* --------------------------------------------------------- silence gate --- */
/* Parses the RIFF chunk list rather than assuming a 44-byte header, because
   ffmpeg does not always write one. Returns peak and RMS in the 0..1 range. */
function wavLevel(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) { return null; }
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  let off = 12, dataOff = -1, dataLen = 0, bits = 16;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) bits = buf.readUInt16LE(body + 14);
    else if (id === 'data') { dataOff = body; dataLen = Math.min(size, buf.length - body); break; }
    off = body + size + (size & 1);
  }
  if (dataOff < 0 || bits !== 16 || dataLen < 2) return null;
  let peak = 0, sumsq = 0, n = 0;
  const end = dataOff + dataLen - 1;
  for (let i = dataOff; i < end; i += 2) {
    const v = buf.readInt16LE(i) / 32768;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    sumsq += v * v; n++;
  }
  return { peak, rms: n ? Math.sqrt(sumsq / n) : 0, samples: n };
}

/* ------------------------------------------------------------------ STT --- */
/* One resident python process for the whole machine. Loading the Whisper model
   costs seconds and a few hundred MB, and a Mac running four feeds would
   otherwise pay that on every fifteen-second clip. */
let stt = null;
function startSTT(onResult) {
  const env = { ...process.env };
  if (CFG.whisperModel) env.WHISPER_MODEL = CFG.whisperModel;
  if (CFG.whisperPrompt) env.WHISPER_PROMPT = CFG.whisperPrompt;
  const p = track(spawn(PYTHON, [STT, '--server'], { env }));
  let buf = '';
  p.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch (e) { continue; }
      try { fs.unlinkSync(o.path); } catch (e) {}
      if (o.transcript) onResult(o.transcript, o.path || '');
    }
  });
  p.stderr.on('data', d => process.stderr.write('[stt] ' + redact(d)));
  p.on('exit', code => {
    if (stopping) return;
    warn('[stt] exited (' + code + '); restarting in 3s');
    setTimeout(() => { stt = startSTT(onResult); }, 3000);
  });
  return p;
}

/* --------------------------------------------------------- clip watcher --- */
/* The newest file in the directory is the one ffmpeg is still writing, so it is
   always left alone until a newer one appears behind it. */
const seenClips = new Set();
function drainClips() {
  let files;
  try { files = fs.readdirSync(WORKDIR); } catch (e) { return; }
  files = files.filter(f => f.endsWith('.wav')).sort();
  for (let k = 0; k < files.length - 1; k++) {
    const name = files[k];
    if (seenClips.has(name)) continue;
    seenClips.add(name);
    const full = path.join(WORKDIR, name);
    const st = health[name.split('_')[0]];

    /* The clip existing at all proves audio reached us from that source, whether
       or not a word was spoken on it. That is a different fact from Whisper
       finding speech, and the health panel needs both. */
    if (st) {
      st.clips++;
      st.lastAudioAt = new Date().toISOString();
      st.attempts = 0;
      if (st.status !== 'live') st.status = st.lastTextAt ? 'live' : 'connected';
    }

    const src = srcById[name.split('_')[0]];
    const gate = src ? src.gate : 0;
    const lvl = wavLevel(full);
    if (lvl && st) {
      st.peakLast = Number(lvl.peak.toFixed(5));
      if (lvl.peak > st.peakMax) st.peakMax = st.peakLast;
    }
    if (gate > 0 && lvl && lvl.peak < gate) {
      if (st) st.gated++;
      try { fs.unlinkSync(full); } catch (e) {}
      continue;
    }
    if (stt) stt.stdin.write(full + '\n');
  }
  /* seenClips would grow without bound over a week-long run. Anything no longer
     on disk has been transcribed or gated and will never come back. */
  if (seenClips.size > 4000) {
    const live = new Set(files);
    for (const n of seenClips) if (!live.has(n)) seenClips.delete(n);
  }
}

/* ------------------------------------------------------- upload + queue --- */
/* A dropped connection must not cost transmissions. Everything transcribed goes
   into a queue that survives a restart, and a failed POST leaves it there. The
   cap is generous but real: a Mac that has been offline for a day should come
   back with the last few hours, not replay a day of stale dispatches onto a
   live map. */
const QUEUE_FILE = path.join(STATE_DIR, 'queue.json');
let queue = [];
try {
  const q = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
  if (Array.isArray(q)) queue = q.slice(-QUEUE_MAX);
} catch (e) {}

let queueDirty = false;
function persistQueue() {
  if (!queueDirty) return;
  queueDirty = false;
  try {
    const tmp = QUEUE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(queue));
    fs.renameSync(tmp, QUEUE_FILE);
  } catch (e) {}
}

let seq = 0;
function enqueue(item) {
  queue.push(item);
  if (queue.length > QUEUE_MAX) queue.splice(0, queue.length - QUEUE_MAX);
  queueDirty = true;
}

let sending = false;
let backoff = 0;
let nextSendAt = 0;

async function flush(force) {
  if (sending || stopping) return;
  const now = Date.now();
  if (now < nextSendAt) return;
  if (!queue.length && !force) return;

  const items = queue.slice(0, BATCH_MAX);
  const payload = {
    machine: MACHINE,
    at: new Date().toISOString(),
    items,
    health: SOURCES.map(s => health[s.id]),
  };

  if (DRY) {
    /* Deliberately not reprinting the transcripts. The STT callback already
       logged every one of these the moment whisper returned it, so printing
       them again here produced a dry run where each transmission appeared
       twice, which reads exactly like the pipeline double-sending. What is
       actually worth seeing at this point is the shape of the POST. */
    log(items.length
      ? 'would POST ' + items.length + ' item(s) to ' + ENDPOINT + '/api/ingest'
        + '  [' + items.map(it => it.src).join(' ') + ']'
      : 'would POST a heartbeat (no transcripts, health only)');
    queue.splice(0, items.length);
    queueDirty = true;
    return;
  }

  sending = true;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 20000);
    const r = await fetch(ENDPOINT + '/api/ingest', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + INGEST_SECRET,
        'x-bcc-machine': MACHINE,
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    clearTimeout(to);
    if (r.ok) {
      queue.splice(0, items.length);
      queueDirty = true;
      if (backoff) { log('ingest recovered'); backoff = 0; }
      nextSendAt = 0;
    } else if (r.status === 401 || r.status === 403) {
      /* A rejected token will be rejected again in four seconds and in forty.
         Back all the way off and say so loudly, because this is the one failure
         a human has to fix. */
      backoff = Math.min(300000, Math.max(60000, backoff * 2 || 60000));
      nextSendAt = Date.now() + backoff;
      warn('ingest rejected this machine (HTTP ' + r.status + '). Check the secret in '
        + path.join(STATE_DIR, '.ingest_secret') + '. Retrying in ' + Math.round(backoff / 1000) + 's');
    } else {
      backoff = Math.min(120000, backoff ? backoff * 2 : 5000);
      nextSendAt = Date.now() + backoff;
      warn('ingest HTTP ' + r.status + '; ' + queue.length + ' queued, retry in ' + Math.round(backoff / 1000) + 's');
    }
  } catch (e) {
    backoff = Math.min(120000, backoff ? backoff * 2 : 5000);
    nextSendAt = Date.now() + backoff;
    warn('ingest failed (' + redact(e.message) + '); ' + queue.length + ' queued, retry in ' + Math.round(backoff / 1000) + 's');
  }
  sending = false;
}

/* -------------------------------------------------------------- status ---- */
/* Written locally as well as posted, so that a colleague whose Mac is running
   this can be asked "open this file" and get a straight answer about whether
   their machine is actually contributing. */
const STATUS_FILE = path.join(STATE_DIR, 'status.json');
function writeStatus() {
  try {
    const tmp = STATUS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({
      machine: MACHINE,
      endpoint: DRY ? '(dry run)' : ENDPOINT,
      pid: process.pid,
      startedAt: START_ISO,
      updatedAt: new Date().toISOString(),
      queued: queue.length,
      sources: SOURCES.map(s => health[s.id]),
    }, null, 2));
    fs.renameSync(tmp, STATUS_FILE);
  } catch (e) {}
}

/* ---------------------------------------------------------------- main ---- */
const START_ISO = new Date().toISOString();

function shutdown(sig) {
  if (stopping) return;
  stopping = true;
  log('\nstopping (' + sig + ')');
  persistQueue();
  writeStatus();
  for (const c of children) { try { c.kill('SIGTERM'); } catch (e) {} }
  setTimeout(() => {
    for (const c of children) { try { c.kill('SIGKILL'); } catch (e) {} }
    try { fs.rmSync(WORKDIR, { recursive: true, force: true }); } catch (e) {}
    try { if (String(process.pid) === fs.readFileSync(LOCK, 'utf8')) fs.unlinkSync(LOCK); } catch (e) {}
    process.exit(0);
  }, 800).unref();
}
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => shutdown(s));

function main() {
  log('bcc-agent  machine=' + MACHINE + '  ->  ' + (DRY ? '(dry run, nothing posted)' : ENDPOINT));
  log('config     ' + CFG.__path);
  log('sources    ' + SOURCES.map(s => s.id + ':' + s.kind
    + (s.gate > 0 ? ' gate<' + s.gate : ' gate off') + (s.gain ? ' gain x' + s.gain : '')).join('   '));
  log('whisper    ' + (CFG.whisperModel || 'small.en (stt.py default)')
    + '   segments ' + SEGMENT_SECONDS + 's');
  if (queue.length) log('queue      ' + queue.length + ' transcript(s) carried over from the last run');

  stt = startSTT((text, clipPath) => {
    const id = path.basename(clipPath).split('_')[0];
    const st = health[id];
    if (st) {
      st.segs++;
      st.lastTextAt = new Date().toISOString();
      st.status = 'live';
      st.attempts = 0;
    }
    enqueue({
      src: id,
      city: (SOURCES.find(s => s.id === id) || {}).city || 'Boston',
      text,
      at: new Date().toISOString(),
      seq: seq++,
    });
    log('[' + id + '] ' + text);
  });

  for (const s of SOURCES) {
    if (s.kind === 'broadcastify') startBroadcastify(s);
    else if (s.kind === 'audiotap') startAudiotap(s);
    else warn('[' + s.id + '] unknown kind "' + s.kind + '"; expected broadcastify or audiotap');
  }

  setInterval(drainClips, 2000).unref?.();
  setInterval(() => flush(false), FLUSH_MS);
  /* An idle machine still has to say it is alive, or the server cannot tell a
     quiet night from a laptop that closed its lid. */
  setInterval(() => flush(true), HEARTBEAT_MS);
  setInterval(persistQueue, 5000);
  setInterval(writeStatus, 5000);
  writeStatus();
  flush(true);

  const seconds = Number(val('--seconds') || (has('--once') ? 90 : 0));
  if (seconds > 0) {
    log('running for ' + seconds + 's then exiting (smoke test)');
    setTimeout(() => {
      log('\n--- summary ---');
      for (const s of SOURCES) {
        const h = health[s.id];
        log(String(h.id).padEnd(14) + String(h.status).padEnd(14)
          + 'clips=' + h.clips + ' gated=' + h.gated + ' text=' + h.segs
          + '  peakMax=' + h.peakMax + ' gate=' + h.gate
          + (h.lastError ? '  last error: ' + h.lastError : ''));
      }
      log('queued ' + queue.length);
      shutdown('smoke test complete');
    }, seconds * 1000);
  }
}

main();
