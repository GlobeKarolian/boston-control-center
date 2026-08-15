// api/shift-change.js
//
//   GET /api/shift-change                    the current shift, as JSON
//   GET /api/shift-change?shift=day|night    pick a shift
//   GET /api/shift-change?from=…&to=…        any window
//
// The handoff briefing: what happened on the shift that's ending, ranked by
// news value, with audio. Built on the same severity floor as the overnight
// briefing, grouped by the sections a desk editor would use.
//
// The overnight briefing asks "what happened last night." Shift Change asks
// "what do I need to know walking in." Same floor, same evidence, different
// window and a different grouping.

const { requireRead, json, harden } = require('../lib/http');
const stream = require('../lib/stream');
const severity = require('../lib/severity');
const trace = require('../lib/trace');
const llm = require('../lib/llm');
const store_io = require('../lib/store-io');

const TZ = 'America/New_York';
const MAX_ITEMS = 12;
const MAX_LINES_PER_ITEM = 14;
const ASK_ROWS = 9000;
const ASK_OBJECTS = 2600;

function et(iso, withDate) {
  const d = new Date(iso);
  if (isNaN(+d)) return '';
  return d.toLocaleString('en-US', Object.assign(
    { timeZone: TZ, hour: 'numeric', minute: '2-digit' },
    withDate ? { month: 'short', day: 'numeric' } : {}));
}

function etParts(iso) {
  const p = {};
  new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false,
  }).formatToParts(new Date(iso)).forEach(x => { p[x.type] = x.value; });
  return p;
}

/* The shift window. Day is 6am-6pm, night is 6pm-6am. Before 6am, "night" is
   the night that is still happening. Before 6pm, "day" is today. */
function shiftWindow(shift, now) {
  const t = now ? new Date(now) : new Date();
  const p = etParts(t);
  const hour = (+p.hour) % 24;
  const dayMs = 86400000;

  function easternAt(y, m, d, hh, mm, near) {
    const guess = Date.UTC(y, m - 1, d, hh, mm);
    const probe = new Date(guess);
    const q = {};
    new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hour: '2-digit', hour12: false })
      .formatToParts(probe).forEach(x => { q[x.type] = x.value; });
    const off = ((+q.hour) % 24) - hh;
    return new Date(guess + off * 3600000);
  }

  let from, to, label;
  if (shift === 'night') {
    /* 6pm to 6am. Before 6am it is the night that is still happening. */
    const back = hour < 6 ? 1 : 0;
    const start = new Date(+t - back * dayMs);
    const sp = etParts(start);
    from = easternAt(+sp.year, +sp.month, +sp.day, 18, 0, start);
    to = new Date(+from + 12 * 3600000);
    label = 'Night · ' + et(from, true) + ' to ' + et(to, true);
  } else {
    /* 6am to 6pm. Before 6am it has not happened yet, so use yesterday. */
    const back = hour < 6 ? 1 : 0;
    const start = new Date(+t - back * dayMs);
    const sp = etParts(start);
    from = easternAt(+sp.year, +sp.month, +sp.day, 6, 0, start);
    to = new Date(+from + 12 * 3600000);
    label = 'Day · ' + et(from, true) + ' to ' + et(to, true);
  }
  /* If the window is in the future, clamp to now. */
  if (to > t) to = t;
  return { from, to, label, shift: shift || (hour >= 6 && hour < 18 ? 'day' : 'night') };
}

/* Transmissions grouped into the scenes they belonged to. The pipeline's own
   incidentId does most of it; everything else clusters by feed and a quiet
   gap, which is roughly the shape of one call's radio. */
function scenes(rows) {
  const GAP = 12 * 60000;
  const byId = new Map();
  const lastLoose = new Map();
  for (const t of rows) {
    let key = t.incidentId;
    if (!key) {
      const feed = t.feed || 'unknown';
      const at = +new Date(t.at);
      const prev = lastLoose.get(feed);
      key = (prev && at - prev.at <= GAP) ? prev.key : ('loose:' + feed + ':' + t.at);
      lastLoose.set(feed, { at, key });
    }
    if (!byId.has(key)) byId.set(key, []);
    byId.get(key).push(t);
  }
  return [...byId.values()];
}

/* Which section does this scene belong to? The desk editor's sections, not
   the extractor's call types. A scene can be both a fire and an oddball; the
   first match wins, in the order a desk would ask about them. */
const SECTIONS = [
  { id: 'crimes', label: 'Crimes', types: new Set(['shooting', 'stabbing', 'robbery', 'death', 'assault']),
    test: (s) => s.floor.signals.some(i => ['shooting', 'stabbing', 'shots-fired', 'homicide', 'assault'].includes(i)) },
  { id: 'fires', label: 'Fires', types: new Set(['fire', 'working-fire', 'structure-fire']),
    test: (s) => s.floor.signals.some(i => ['working-fire', 'alarm-escalate', 'fire'].includes(i)) },
  { id: 'chases', label: 'Chases', types: new Set(['pursuit', 'chase']),
    test: (s) => s.floor.signals.some(i => ['pursuit', 'chase', 'fleeing'].includes(i)) },
  { id: 'oddball', label: 'Oddball', types: new Set([]),
    test: () => true },  /* everything else that cleared the bar */
];

function sectionOf(scene) {
  for (const s of SECTIONS) {
    if (s.test(scene)) return s.id;
  }
  return 'oddball';
}

module.exports = async (req, res) => {
  harden(res);
  if (!(await requireRead(req, res))) return;

  const t0 = Date.now();
  const q = req.query || {};
  const shift = (q.shift === 'night' || q.shift === 'day') ? q.shift : null;
  const win = (q.from && q.to)
    ? { from: new Date(String(q.from)), to: new Date(String(q.to)), label: et(q.from, true) + ' to ' + et(q.to, true), shift: shift || 'custom' }
    : shiftWindow(shift);
  if (isNaN(+win.from) || isNaN(+win.to)) {
    return json(res, { ok: false, why: 'bad window' }, { status: 400 });
  }

  let got;
  try {
    got = await stream.since(win.from.toISOString(), win.to.toISOString(),
                             { maxRows: ASK_ROWS, maxObjects: ASK_OBJECTS, evenly: true });
  } catch (e) {
    return json(res, { ok: false, why: 'could not read the archive: ' + String(e.message || e).slice(0, 160) }, { status: 503 });
  }
  const rows = got.rows || [];

  let offline = [];
  try {
    offline = (await store_io.getHealth())
      .filter(f => f.status === 'offline' || (f.staleSec || 0) > 600)
      .map(f => f.id);
  } catch (e) { /* health unavailable is itself worth not claiming */ }

  const heard = stream.densityByFeed(rows);

  /* The floor picks what leads. */
  const ranked = scenes(rows).map((tx) => {
    const feeds = [...new Set(tx.map(t => t.feed).filter(Boolean))];
    const units = [...new Set(tx.flatMap(t => t.units || []))];
    const span = tx.length > 1
      ? (+new Date(tx[tx.length - 1].at) - +new Date(tx[0].at)) / 60000 : 0;
    const fl = severity.floor({ tx, feeds, units, spanMin: span, anomaly: { level: 'normal' } });
    return { tx, feeds, units, span, floor: fl };
  }).filter(s => s.floor.score >= 2)
    .sort((a, b) => b.floor.score - a.floor.score);

  const top = ranked.slice(0, MAX_ITEMS);

  if (!rows.length || !top.length) {
    return json(res, {
      ok: true,
      window: { from: win.from.toISOString(), to: win.to.toISOString(), label: win.label, shift: win.shift },
      lead: rows.length
        ? 'Nothing on this shift cleared the bar. ' + rows.length + ' transmissions across ' + Object.keys(heard).length + ' feeds, all of it routine.'
        : 'No transmissions are archived for this window.',
      items: [], heard, offline,
      coverage: { transmissions: rows.length, feeds: Object.keys(heard).length, complete: got.complete, sampled: !!got.sampled },
      generatedAt: new Date().toISOString(),
      ms: Date.now() - t0,
    }, { priv: 0 });
  }

  /* One call, writing prose for the items the floor already chose. */
  const blocks = top.map((s, i) => {
    const lines = s.tx.slice(0, MAX_LINES_PER_ITEM).map(t =>
      et(t.at) + ' [' + t.feed + ']' + (t.matched || t.address ? ' (' + String(t.matched || t.address).slice(0, 60) + ')' : '')
      + ' ' + String(t.text || '').slice(0, 300)).join('\n');
    return 'ITEM ' + (i + 1) + ' — ' + s.feeds.join(', ')
      + ', ' + et(s.tx[0].at) + ' to ' + et(s.tx[s.tx.length - 1].at)
      + (s.units.length ? ', units ' + s.units.slice(0, 8).join(' ') : '')
      + '\n' + lines;
  }).join('\n\n');

  const SYSTEM = [
    'You are writing the shift-change scanner briefing for a Boston Globe',
    'newsroom. An editor walking in reads this to know what the outgoing crew',
    'was working on.',
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
    '  lead   : 2-3 sentences. What the shift was like overall. If it was',
    '           quiet, say so; most are.',
    '  items  : array, SAME LENGTH AND ORDER as the items given, each',
    '           { headline, what, unsure }',
    '           headline: under 70 characters, plain, no clickbait',
    '           what: 1-3 sentences a reporter can act on. Time, place,',
    '                 agencies, current status if the radio said one.',
    '           unsure: one short string naming what a reporter would need',
    '                   to confirm, or "" if the traffic was clear.',
  ].join('\n');

  let written = null;
  let why = null;
  try {
    written = await llm.chatJSON({
      system: SYSTEM,
      user: 'Shift: ' + win.label + ' Eastern.\n'
        + rows.length + ' transmissions heard across ' + Object.keys(heard).length + ' feeds.\n\n' + blocks,
      maxTokens: 2000,
      timeoutMs: 60000,
      role: 'shift-change',
    });
  } catch (e) { why = String(e.message || e).slice(0, 200); }

  const items = top.map((s, i) => {
    const w = (written && Array.isArray(written.items) && written.items[i]) || {};
    const headline = String(w.headline || '').slice(0, 120);
    const cite = headline
      ? trace.cited(headline + ' ' + String(w.what || ''), s.tx, { cap: 12 })
      : { at: [], clips: [], n: 0 };
    const clips = cite.n ? cite.clips : s.tx.filter(t => t.clip).map(t => t.clip).slice(0, 12);
    return {
      headline: headline || (s.feeds[0] || 'call') + ', ' + et(s.tx[0].at),
      what: String(w.what || '').slice(0, 600),
      unsure: String(w.unsure || '').slice(0, 200),
      severity: s.floor.score,
      label: severity.label(s.floor.score),
      why: s.floor.reasons,
      feeds: s.feeds,
      units: s.units.slice(0, 10),
      from: s.tx[0].at,
      to: s.tx[s.tx.length - 1].at,
      place: (s.tx.find(t => t.matched || t.address) || {}).matched
        || (s.tx.find(t => t.address) || {}).address || null,
      n: s.tx.length,
      clips,
      tx: s.tx.slice(0, MAX_LINES_PER_ITEM).map(stream.forListening),
      section: sectionOf(s),
    };
  });

  /* Group by section, preserving the floor's rank order within each. */
  const bySection = {};
  for (const item of items) {
    const sec = item.section || 'oddball';
    if (!bySection[sec]) bySection[sec] = [];
    bySection[sec].push(item);
  }
  /* Re-rank within sections by severity. */
  for (const sec of Object.keys(bySection)) {
    bySection[sec].sort((a, b) => b.severity - a.severity);
  }
  /* Flatten back with section headers. */
  const sections = SECTIONS.filter(s => bySection[s.id]).map(s => ({
    id: s.id,
    label: s.label,
    count: bySection[s.id].length,
    items: bySection[s.id],
  }));

  return json(res, {
    ok: true,
    window: { from: win.from.toISOString(), to: win.to.toISOString(), label: win.label, shift: win.shift },
    lead: (written && String(written.lead || '').slice(0, 700))
      || ('Written summary unavailable' + (why ? ' (' + why + ')' : '') + '. The items and their audio are below.'),
    sections,
    items,
    heard,
    offline,
    coverage: {
      transmissions: rows.length,
      feeds: Object.keys(heard).length,
      complete: got.complete,
      sampled: !!got.sampled,
    },
    generatedAt: new Date().toISOString(),
    ms: Date.now() - t0,
  }, { priv: 0 });
};
