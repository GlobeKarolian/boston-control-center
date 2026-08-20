// api/shift-change.js
//
//   GET /api/shift-change                 the last ten hours, as JSON
//   GET /api/shift-change?hours=6         a shorter or longer look back (1..24)
//   GET /api/shift-change?from=…&to=…     any window
//
// The handoff briefing. Somebody sits down at the desk and wants to know, in
// one screen, what is running right now and what happened while they were
// not here. It is always the last ten hours from the moment it loads.
//
// It used to ask which shift you meant, day or night, 6am to 6pm or 6pm to
// 6am, and answer for that block. That is how a schedule thinks, and it is
// not how anybody arrives. The person coming on at 3pm got "Day, 6am to 3pm"
// and nothing from the overnight that was still being cleaned up; the one at
// 7pm got one hour. Ten hours back from now covers a full shift plus the
// handover before it, whoever you are and whenever you walked in, and nobody
// has to pick anything.
//
// Three things, in the order a person wants them:
//
//   watch   what is open as you sit down: the situations on the board and the
//           scenes the store still has active. This is the live picture, and
//           it comes first because a fire that is still going matters more
//           than one that went out at noon.
//   major   the calls on the last ten hours that cleared the severity floor,
//           ranked by evidence and written up by the model, each with the
//           transmissions and audio it was built from. A call that is still
//           running is marked so, and sits in both lists on purpose: the
//           first list says it is live, the second says what it was.
//   notes   everything else that was more than routine, as a compact list
//           with no prose. The shape of the shift without the weight of it.
//
// Same floor as the overnight briefing, same grounding rule as everything
// written since 14 August: the model writes only from the lines it is handed,
// never reorders them, never adds to them. The lead paragraph is the one place
// it speaks about the whole, and even that is given the open list to speak
// from rather than a memory of it.

const { requireRead, json, harden } = require('../lib/http');
const stream = require('../lib/stream');
const severity = require('../lib/severity');
const trace = require('../lib/trace');
const llm = require('../lib/llm');
const store_io = require('../lib/store-io');
const sceneLib = require('../lib/scenes');

const TZ = 'America/New_York';
const DEFAULT_HOURS = 10;
const MAX_HOURS = 24;
const MAX_ITEMS = 12;           // major calls the model writes up
const MAX_NOTES = 24;           // the compact list under them
const MAX_WATCH = 10;           // open things, board and store together
const MAX_LINES_PER_ITEM = 14;
const ASK_ROWS = 9000;
const ASK_OBJECTS = 2600;

/* An active scene in the store counts as open if it was talked to this
   recently. The store keeps a scene "active" for longer than that before the
   sweep clears it, and a scene nobody has mentioned in an hour and a half is
   not something to watch, it is something that happened. */
const WATCH_RECENT_MS = 90 * 60 * 1000;
/* A major call is marked live if its last transmission is this fresh, even
   when the store has no matching scene: the archive can run a few minutes
   behind and the radio is the better witness. */
const LIVE_IF_HEARD_WITHIN_MS = 20 * 60 * 1000;
/* A store scene standing on a board situation is the same thing twice. */
const SAME_PLACE_M = 250;

function et(iso, withDate) {
  const d = new Date(iso);
  if (isNaN(+d)) return '';
  return d.toLocaleString('en-US', Object.assign(
    { timeZone: TZ, hour: 'numeric', minute: '2-digit' },
    withDate ? { month: 'short', day: 'numeric' } : {}));
}

/* The window: `hours` back from now, or an explicit from/to. */
function window_(q, now) {
  const t = now ? new Date(now) : new Date();
  if (q.from && q.to) {
    const from = new Date(String(q.from)), to = new Date(String(q.to));
    const hours = (+to - +from) / 3600000;
    return { from, to, hours, label: et(from, true) + ' to ' + et(to, true), custom: true };
  }
  let hours = parseFloat(q.hours);
  if (!Number.isFinite(hours) || hours <= 0) hours = DEFAULT_HOURS;
  hours = Math.min(MAX_HOURS, Math.max(1, hours));
  const from = new Date(+t - hours * 3600000);
  const sameDay = et(from, true).split(',')[0] === et(t, true).split(',')[0];
  const label = 'Last ' + (hours % 1 ? hours.toFixed(1) : hours) + ' hours · '
    + (sameDay ? et(from) : et(from, true)) + ' to ' + et(t);
  return { from, to: t, hours, label, custom: false };
}

/* Transmissions grouped into the scenes they belonged to: lib/scenes.js, the
   same grouping the Archive and the desk use, so a fire three radios worked
   is one item here and one card there. */
function scenes(rows) {
  return sceneLib.assemble(rows).map(s => ({ key: s.id, tx: s.tx, incidentIds: s.incidentIds }));
}

/* Which kind of thing a scene is, for the chip beside it. The desk's words,
   not the extractor's call types; the first match wins. */
function kindOf(s) {
  const sig = (s.floor && s.floor.signals) || [];
  const types = new Set(s.tx.map(t => String(t.callType || '').toLowerCase()));
  if (sig.some(i => ['shooting', 'stabbing', 'shots-fired', 'homicide', 'assault', 'robbery'].includes(i))
      || ['shooting', 'stabbing', 'robbery', 'assault', 'homicide'].some(t => types.has(t))) return 'crime';
  if (sig.some(i => ['working-fire', 'alarm-escalate', 'fire'].includes(i))
      || ['fire', 'working fire', 'structure fire'].some(t => types.has(t))) return 'fire';
  if (sig.some(i => ['pursuit', 'chase', 'fleeing'].includes(i)) || types.has('pursuit')) return 'chase';
  if (['medical', 'overdose', 'cardiac arrest', 'unresponsive'].some(t => types.has(t))) return 'medical';
  if (['crash', 'mva', 'motor vehicle accident', 'pedestrian struck'].some(t => types.has(t))) return 'crash';
  return 'other';
}

function metres(aLat, aLon, bLat, bLon) {
  if (![aLat, aLon, bLat, bLon].every(Number.isFinite)) return Infinity;
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (bLat - aLat) * toR, dLon = (bLon - aLon) * toR;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * toR) * Math.cos(bLat * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/* What is open right now, from the two places that know: the board the analyst
   keeps, and the store of scenes under it. */
async function openNow(now) {
  let sits = [], incs = [];
  try { sits = JSON.parse(await store_io.readOut(store_io.K.outSituations, '[]')); } catch (e) { sits = []; }
  try { incs = JSON.parse(await store_io.readOut(store_io.K.outIncidents, '[]')); } catch (e) { incs = []; }
  if (!Array.isArray(sits)) sits = [];
  if (!Array.isArray(incs)) incs = [];

  const out = [];
  for (const s of sits) {
    if (!s || s.status === 'closed') continue;
    const clips = [];
    for (const e of (s.events || [])) for (const c of (e.clips || [])) if (c && !clips.includes(c)) clips.push(c);
    out.push({
      kind: 'situation', id: s.id,
      headline: String(s.headline || '').slice(0, 160),
      what: String(s.summary || '').slice(0, 600),
      status: s.status || 'developing',
      priority: s.priority || 'normal',
      major: !!s.major, verified: !!s.verified,
      severity: Number(s.severity) || 0,
      label: s.severityLabel || (s.severity ? severity.label(s.severity) : null),
      type: s.type || null, place: s.location || s.matched || null,
      lat: s.lat, lon: s.lon,
      feeds: Array.isArray(s.feeds) ? s.feeds.slice(0, 6) : [],
      units: [],
      since: s.firstSeen || null, updated: s.updated || s.firstSeen || null,
      n: (s.events || []).length,
      clips: clips.slice(0, 12),
      tx: [],
    });
  }
  const sitPlaces = out.filter(x => Number.isFinite(x.lat) && Number.isFinite(x.lon));
  for (const c of incs) {
    if (!c || c.status !== 'active') continue;
    const last = +new Date(c.lastUpdate || c.firstHeard || 0);
    if (!last || now - last > WATCH_RECENT_MS) continue;
    const units = Array.isArray(c.units) ? c.units : [];
    /* Worth half an eye: something was said, or several units are on it, or
       the heat is a real fraction of the alerting bar. A single unit on a
       routine call is not a thing to watch, it is the radio working. */
    const worth = (c.tier || 0) >= 2 || c.priority === 'high' || units.length >= 3 || (c.heat || 0) >= 30 || (c.alarm || 0) >= 2;
    if (!worth) continue;
    /* Standing on a board situation: the card above already says it. */
    if (Number.isFinite(c.lat) && Number.isFinite(c.lon)
        && sitPlaces.some(s => metres(s.lat, s.lon, c.lat, c.lon) < SAME_PLACE_M)) continue;
    const tl = Array.isArray(c.timeline) ? c.timeline : [];
    const clips = tl.map(e => e && e.clip).filter(Boolean);
    const lastLine = [...tl].reverse().find(e => e && e.text && e.role !== 'system');
    out.push({
      kind: 'scene', id: c.id,
      headline: [c.type && c.type !== 'unclassified' ? c.type : 'call', c.location].filter(Boolean).join(' at '),
      what: lastLine ? ('Last heard ' + et(lastLine.t) + ': ' + String(lastLine.text).slice(0, 240)) : '',
      status: 'active', priority: c.priority || 'normal',
      major: false, verified: false,
      severity: c.tier || 0, label: c.tierName || null,
      heat: c.heat || 0,
      type: c.type || null, place: c.location || null,
      lat: c.lat, lon: c.lon,
      feeds: [c.feed].filter(Boolean).concat((c.depts || []).filter(Boolean)).filter((v, i, a) => a.indexOf(v) === i).slice(0, 6),
      units: units.slice(0, 10),
      since: c.firstHeard || null, updated: c.lastUpdate || null,
      n: c.timelineTotal || tl.length,
      why: Array.isArray(c.why) ? c.why.slice(0, 4) : [],
      clips: clips.slice(-12),
      tx: tl.slice(-6).filter(e => e && e.text).map(e => ({ at: e.t, src: e.source, text: e.text, clip: e.clip || null })),
    });
  }
  /* High and major first, then what the evidence says, then the freshest. */
  const rank = x => (x.priority === 'high' ? 100 : 0) + (x.major ? 50 : 0) + (x.severity || 0) * 10 + Math.min(9, (x.heat || 0) / 10);
  out.sort((a, b) => rank(b) - rank(a) || (+new Date(b.updated || 0)) - (+new Date(a.updated || 0)));
  return { watch: out.slice(0, MAX_WATCH), activeIds: new Set(incs.filter(c => c && c.status === 'active').map(c => c.id)) };
}

module.exports = async (req, res) => {
  harden(res);
  if (!(await requireRead(req, res))) return;

  const t0 = Date.now();
  const q = req.query || {};
  const win = window_(q);
  if (isNaN(+win.from) || isNaN(+win.to) || !(win.to > win.from)) {
    return json(res, { ok: false, why: 'bad window' }, { status: 400 });
  }
  const now = +win.to;

  /* The archive and the board, read together: neither waits on the other. */
  const [gotRes, open] = await Promise.all([
    stream.since(win.from.toISOString(), win.to.toISOString(), { maxRows: ASK_ROWS, maxObjects: ASK_OBJECTS, evenly: true })
      .then(g => ({ got: g })).catch(e => ({ err: e })),
    openNow(now).catch(() => ({ watch: [], activeIds: new Set() })),
  ]);
  if (gotRes.err) {
    return json(res, { ok: false, why: 'could not read the archive: ' + String(gotRes.err.message || gotRes.err).slice(0, 160) }, { status: 503 });
  }
  const got = gotRes.got;
  const rows = got.rows || [];
  /* The vault is eventually consistent: a write lands, the list lags a few
     seconds behind it, and for those seconds the archive reads empty while
     the radio is plainly talking. Redis holds the same window in
     bcc:out:transcripts, so when the vault comes back empty on a fresh
     deployment, read the buffer the live board is already reading. */
  if (!rows.length) {
    try {
      const raw = await store_io.readOut(store_io.K.outTranscripts, '[]');
      const list = JSON.parse(raw);
      if (Array.isArray(list) && list.length) {
        const cutoff = win.from.toISOString();
        const fresh = list.filter(t => t && t.at && t.at > cutoff);
        if (fresh.length) {
          rows.push(...fresh.map(t => ({
            at: t.at, feed: t.source || t.src, src: t.source || t.src,
            text: t.text, clip: t.clip, units: t.units || [],
            callType: t.callType || null, town: t.city || t.town || null,
            address: t.address || null, matched: t.matched || null,
            incidentId: t.incidentId || null,
          })));
          got.complete = false;
          got.sampled = true;
        }
      }
    } catch (e) { /* Redis fallback is a convenience, never a failure */ }
  }

  let offline = [];
  try {
    offline = (await store_io.getHealth())
      .filter(f => f.status === 'offline' || (f.staleSec || 0) > 600)
      .map(f => f.id);
  } catch (e) { /* health unavailable is itself worth not claiming */ }

  const heard = stream.densityByFeed(rows);

  /* The floor picks what leads. */
  const scored = scenes(rows).map(({ key, tx, incidentIds }) => {
    const feeds = [...new Set(tx.map(t => t.feed).filter(Boolean))];
    const units = [...new Set(tx.flatMap(t => t.units || []))];
    const span = tx.length > 1
      ? (+new Date(tx[tx.length - 1].at) - +new Date(tx[0].at)) / 60000 : 0;
    const fl = severity.floor({ tx, feeds, units, spanMin: span, anomaly: { level: 'normal' } });
    const lastAt = +new Date(tx[tx.length - 1].at);
    const live = (incidentIds || []).some(id => open.activeIds.has(id)) || (now - lastAt) <= LIVE_IF_HEARD_WITHIN_MS;
    return { key, tx, feeds, units, span, floor: fl, live };
  }).filter(s => s.floor.score >= 2)
    .sort((a, b) => b.floor.score - a.floor.score || (+new Date(b.tx[b.tx.length - 1].at)) - (+new Date(a.tx[a.tx.length - 1].at)));

  const majors = scored.filter(s => s.floor.score >= 3).slice(0, MAX_ITEMS);
  const noteScenes = scored.filter(s => s.floor.score < 3).slice(0, MAX_NOTES);

  const placeOf = (s) => (s.tx.find(t => t.matched || t.address) || {}).matched
    || (s.tx.find(t => t.address) || {}).address || null;

  const base = (s) => ({
    id: s.key,
    severity: s.floor.score,
    label: severity.label(s.floor.score),
    why: s.floor.reasons,
    kind: kindOf(s),
    live: !!s.live,
    feeds: s.feeds,
    units: s.units.slice(0, 10),
    from: s.tx[0].at,
    to: s.tx[s.tx.length - 1].at,
    place: placeOf(s),
    type: (s.tx.find(t => t.callType) || {}).callType || null,
    n: s.tx.length,
    clips: s.tx.filter(t => t.clip).map(t => t.clip).slice(0, 12),
    tx: s.tx.slice(0, MAX_LINES_PER_ITEM).map(stream.forListening),
  });

  const common = {
    window: { from: win.from.toISOString(), to: win.to.toISOString(), label: win.label, hours: Math.round(win.hours * 10) / 10 },
    watch: open.watch,
    heard, offline,
    coverage: { transmissions: rows.length, feeds: Object.keys(heard).length, complete: got.complete, sampled: !!got.sampled },
    generatedAt: new Date().toISOString(),
  };

  /* The compact list needs no model: a type, a place and a clock are enough
     to say "there was also this", and a reporter who wants more presses it. */
  const notes = noteScenes.map(s => {
    const b = base(s);
    const headline = [b.type || 'call', b.place].filter(Boolean).join(' · ') + ' · ' + et(b.from);
    return Object.assign({ headline }, b);
  });

  if (!rows.length || !majors.length) {
    const lead = rows.length
      ? (open.watch.length
          ? open.watch.length + ' thing' + (open.watch.length === 1 ? '' : 's') + ' open right now, below. Nothing in the last '
            + (win.hours % 1 ? win.hours.toFixed(1) : win.hours) + ' hours cleared the bar for a write-up: '
            + rows.length + ' transmissions across ' + Object.keys(heard).length + ' feeds'
            + (notes.length ? ', ' + notes.length + ' of them more than routine and listed below.' : ', all of it routine.')
          : 'Nothing in the last ' + (win.hours % 1 ? win.hours.toFixed(1) : win.hours) + ' hours cleared the bar. '
            + rows.length + ' transmissions across ' + Object.keys(heard).length + ' feeds'
            + (notes.length ? ', ' + notes.length + ' of them more than routine and listed below.' : ', all of it routine.'))
      : 'No transmissions are archived for this window.';
    return json(res, Object.assign({ ok: true, lead, major: [], items: [], notes, ms: Date.now() - t0 }, common), { priv: 0 });
  }

  /* One call, writing prose for the items the floor already chose. */
  const blocks = majors.map((s, i) => {
    const lines = s.tx.slice(0, MAX_LINES_PER_ITEM).map(t =>
      et(t.at) + ' [' + t.feed + ']' + (t.matched || t.address ? ' (' + String(t.matched || t.address).slice(0, 60) + ')' : '')
      + ' ' + String(t.text || '').slice(0, 300)).join('\n');
    return 'ITEM ' + (i + 1) + ' — ' + s.feeds.join(', ')
      + ', ' + et(s.tx[0].at) + ' to ' + et(s.tx[s.tx.length - 1].at)
      + (s.live ? ', STILL RUNNING' : '')
      + (s.units.length ? ', units ' + s.units.slice(0, 8).join(' ') : '')
      + '\n' + lines;
  }).join('\n\n');

  const openBlock = open.watch.length
    ? 'OPEN RIGHT NOW (for the lead only; these are not items):\n' + open.watch.map(w =>
        '- ' + (w.headline || w.type || 'call') + (w.place ? ' at ' + w.place : '') + ' [' + w.status + (w.priority === 'high' ? ', high priority' : '') + ']').join('\n') + '\n\n'
    : 'OPEN RIGHT NOW: nothing on the board.\n\n';

  const SYSTEM = [
    'You are writing the handoff briefing for a Boston Globe newsroom desk.',
    'Somebody is sitting down to start work and reads this to learn what is',
    'running right now and what happened over the last ' + (win.hours % 1 ? win.hours.toFixed(1) : win.hours) + ' hours.',
    '',
    'The items have already been selected and ranked by evidence. Do not',
    'reorder them, do not add items, do not drop items. Write each one up.',
    '',
    'The transcripts are machine-made from poor radio and are often wrong.',
    'Never resolve a garbled word into a plausible street or name. Never say',
    'confirmed unless a transmission says it. Where the traffic is ambiguous,',
    'write it as ambiguous: "units responded to what was called in as" is',
    'honest, "a shooting occurred" is not.',
    '',
    'Reply as JSON:',
    '  lead   : 2-3 sentences for the person sitting down. First what is still',
    '           open (from the OPEN RIGHT NOW list, if anything is), then what',
    '           the stretch was like overall. If it was quiet, say so; most are.',
    '  items  : array, SAME LENGTH AND ORDER as the items given, each',
    '           { headline, what, unsure }',
    '           headline: under 70 characters, plain, no clickbait',
    '           what: 1-3 sentences a reporter can act on. Time, place,',
    '                 agencies, current status if the radio said one. If the',
    '                 item is marked STILL RUNNING, say what it was doing last.',
    '           unsure: one short string naming what a reporter would need',
    '                   to confirm, or "" if the traffic was clear.',
  ].join('\n');

  let written = null;
  let why = null;
  try {
    written = await llm.chatJSON({
      system: SYSTEM,
      user: 'Window: ' + win.label + ' Eastern.\n'
        + rows.length + ' transmissions heard across ' + Object.keys(heard).length + ' feeds.\n\n'
        + openBlock + blocks,
      maxTokens: 2000,
      timeoutMs: 60000,
      role: 'shift-change',
    });
  } catch (e) { why = String(e.message || e).slice(0, 200); }

  const major = majors.map((s, i) => {
    const w = (written && Array.isArray(written.items) && written.items[i]) || {};
    const headline = String(w.headline || '').slice(0, 120);
    const cite = headline
      ? trace.cited(headline + ' ' + String(w.what || ''), s.tx, { cap: 12 })
      : { at: [], clips: [], n: 0 };
    const b = base(s);
    const clips = cite.n ? cite.clips : b.clips;
    return Object.assign({}, b, {
      headline: headline || ((b.type || s.feeds[0] || 'call') + ', ' + et(s.tx[0].at)),
      what: String(w.what || '').slice(0, 600),
      unsure: String(w.unsure || '').slice(0, 200),
      clips,
    });
  });

  return json(res, Object.assign({
    ok: true,
    lead: (written && String(written.lead || '').slice(0, 700))
      || ('Written summary unavailable' + (why ? ' (' + why + ')' : '') + '. The items and their audio are below.'),
    major,
    items: major,          // the name the first build used; kept for anything still reading it
    notes,
    ms: Date.now() - t0,
  }, common), { priv: 0 });
};
