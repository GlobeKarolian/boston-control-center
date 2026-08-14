// api/briefing.js
//
//   GET /api/briefing                  the overnight, as JSON
//   GET /api/briefing?format=html      the same thing, printable
//   GET /api/briefing?from=…&to=…      any window
//
// One sheet an editor can carry into the 8am meeting.
//
// The overnight briefing is the oldest artifact in a newsroom and the one this
// system should have been producing from the first week. It is also the format
// with the least room for the failures of the last few days: a page somebody
// reads aloud to their colleagues has to be right, and when it is wrong it is
// wrong in front of everyone.
//
// So three rules shape it.
//
// EVERY ITEM IS LISTENABLE. Each entry carries the transmissions it came from
// and their audio. An editor challenged on a line can play it in the meeting.
// Anything that cannot be traced back to a transmission does not appear.
//
// RANKING IS MECHANICAL. What leads the page is decided by lib/severity.js on
// observed evidence, signals heard, agencies converged, units, duration, and
// how far above its norm the radio was running. The model writes the prose for
// the items the floor selected. It does not choose them, because "what was the
// biggest thing last night" is exactly the judgment it got catastrophically
// wrong at 12:10 this morning.
//
// WHAT WE COULD NOT HEAR IS PART OF THE BRIEFING. A page that lists eight
// incidents and says nothing about the two feeds that were offline invites a
// newsroom to believe it is complete. The coverage section is not a footnote,
// it is the thing that makes the rest of it trustworthy.

const { requireRead, json, harden } = require('../lib/http');
const stream = require('../lib/stream');
const severity = require('../lib/severity');
const trace = require('../lib/trace');
const llm = require('../lib/llm');
const store_io = require('../lib/store-io');

const TZ = 'America/New_York';
const MAX_ITEMS = 8;
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

/* The overnight, meaning the shift a morning meeting is asking about: 6pm
   yesterday to now. Before 6pm it means last night rather than the evening
   that has not happened yet. */
function overnight(now) {
  const t = now ? new Date(now) : new Date();
  const p = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false })
    .formatToParts(t).forEach(x => { p[x.type] = x.value; });
  const hour = (+p.hour) % 24;
  const back = hour >= 18 ? 0 : 1;
  const start = new Date(+t - back * 86400000);
  const sp = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(start).forEach(x => { sp[x.type] = x.value; });
  /* 6pm Eastern on the start day, resolved through UTC by trial so DST is not
     a special case anybody has to remember. */
  const guess = Date.UTC(+sp.year, +sp.month - 1, +sp.day, 22, 0);
  const probe = new Date(guess);
  const off = (() => {
    const q = {};
    new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hour: '2-digit', hour12: false })
      .formatToParts(probe).forEach(x => { q[x.type] = x.value; });
    return ((+q.hour) % 24) - 18;
  })();
  return { from: new Date(guess + off * 3600000), to: t };
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

module.exports = async (req, res) => {
  harden(res);
  if (!(await requireRead(req, res))) return;

  const t0 = Date.now();
  const q = req.query || {};
  const win = (q.from && q.to)
    ? { from: new Date(String(q.from)), to: new Date(String(q.to)) }
    : overnight();
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

  /* Which feeds were quiet, and which were quiet because nobody was
     listening. A silent channel and a dead relay look identical on the page
     unless the page says which it was. */
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
    const out = {
      ok: true,
      window: { from: win.from.toISOString(), to: win.to.toISOString(),
                label: et(win.from, true) + ' to ' + et(win.to, true) },
      lead: rows.length
        ? 'Nothing overnight cleared the bar for a briefing item. ' + rows.length + ' transmissions across ' + Object.keys(heard).length + ' feeds, all of it routine.'
        : 'No transmissions are archived for this window.',
      items: [], heard, offline,
      coverage: { transmissions: rows.length, feeds: Object.keys(heard).length, complete: got.complete, sampled: !!got.sampled },
      ms: Date.now() - t0,
    };
    return q.format === 'html' ? html(res, out) : json(res, out, { priv: 0 });
  }

  /* One call, writing prose for the items the floor already chose. The model
     is told plainly that it is not selecting anything. */
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
    'You are writing the overnight scanner briefing for a Boston Globe morning',
    'news meeting. An editor will read this aloud to colleagues.',
    '',
    'The items have already been selected and ranked by evidence. Do not',
    'reorder them, do not add items, do not drop items. Write each one up.',
    '',
    'The transcripts are machine-made from poor radio and are often wrong.',
    'Never resolve a garbled word into a plausible street or name. Never say',
    'confirmed unless a transmission says it. Where the traffic is ambiguous,',
    'write it as ambiguous: "units responded to what was called in as" is',
    'honest, "a shooting occurred" is not. An editor reading a wrong line',
    'aloud in a meeting is the failure this whole format exists to avoid.',
    '',
    'Reply as JSON:',
    '  lead   : 2-3 sentences. What the night was like overall. If it was quiet,',
    '           say so; most nights are.',
    '  items  : array, SAME LENGTH AND ORDER as the items given, each',
    '           { headline, what, unsure }',
    '           headline: under 70 characters, plain, no clickbait',
    '           what: 1-3 sentences a reporter can act on. Time, place,',
    '                 agencies, current status if the radio said one.',
    '           unsure: one short string naming what a reporter would need to',
    '                   confirm, or "" if the traffic was clear.',
  ].join('\n');

  let written = null;
  let why = null;
  try {
    written = await llm.chatJSON({
      system: SYSTEM,
      user: 'Window: ' + et(win.from, true) + ' to ' + et(win.to, true) + ' Eastern.\n'
        + rows.length + ' transmissions heard across ' + Object.keys(heard).length + ' feeds.\n\n' + blocks,
      maxTokens: 1800,
      timeoutMs: 60000,
      role: 'briefing',
    });
  } catch (e) { why = String(e.message || e).slice(0, 200); }

  const items = top.map((s, i) => {
    const w = (written && Array.isArray(written.items) && written.items[i]) || {};
    const headline = String(w.headline || '').slice(0, 120);
    /* The audio for this item, traced from what was written about it when
       there is prose, and from the scene itself when there is not. */
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
    };
  });

  const out = {
    ok: true,
    window: { from: win.from.toISOString(), to: win.to.toISOString(),
              label: et(win.from, true) + ' to ' + et(win.to, true) },
    lead: (written && String(written.lead || '').slice(0, 700))
      || ('Written summary unavailable' + (why ? ' (' + why + ')' : '') + '. The items and their audio are below.'),
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
  };

  return q.format === 'html' ? html(res, out) : json(res, out, { priv: 0 });
};

/* The printable sheet. Deliberately plain: this gets printed, pasted into
   Slack, and read on a phone at 7:50am, and every one of those wants
   readable text over a designed page. */
function html(res, d) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const et2 = (iso) => new Date(iso).toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });

  const items = (d.items || []).map((it, i) => `
    <li>
      <h2>${i + 1}. ${esc(it.headline)}</h2>
      <p class="meta">${esc(et2(it.from))}–${esc(et2(it.to))} &middot; ${esc(it.feeds.join(', '))}${it.place ? ' &middot; ' + esc(it.place) : ''}${it.units.length ? ' &middot; ' + esc(it.units.join(' ')) : ''} &middot; <b>${esc(it.label)}</b></p>
      ${it.what ? `<p>${esc(it.what)}</p>` : ''}
      ${it.unsure ? `<p class="unsure">Confirm before writing: ${esc(it.unsure)}</p>` : ''}
      <p class="why">Why it is here: ${esc((it.why || []).join('; '))}</p>
      ${it.clips.length ? `<p class="audio">${it.clips.map((u, n) => `<a href="/api/clip-download?u=${encodeURIComponent(u)}">clip ${n + 1}</a>`).join(' ')}</p>` : '<p class="audio none">no audio kept for this one</p>'}
      <details><summary>${it.n} transmission${it.n === 1 ? '' : 's'}</summary>
        <table>${(it.tx || []).map(t => `<tr><td class="t">${esc(et2(t.at))}</td><td class="f">${esc(t.src)}</td><td>${esc(t.text)}</td></tr>`).join('')}</table>
      </details>
    </li>`).join('');

  const body = `<!doctype html><meta charset="utf-8">
<title>Overnight scanner briefing &middot; ${esc(d.window.label)}</title>
<style>
 body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
   max-width:760px;margin:32px auto;padding:0 20px;color:#111}
 h1{font-size:21px;margin:0 0 2px} .win{color:#666;font-size:13px;margin:0 0 18px}
 .lead{font-size:16px;line-height:1.55;border-left:3px solid #111;padding-left:14px;margin:0 0 22px}
 ol{padding-left:0;list-style:none} li{margin:0 0 26px;padding:0 0 20px;border-bottom:1px solid #e6e6e6}
 h2{font-size:16px;margin:0 0 4px}
 .meta{color:#666;font-size:12.5px;margin:0 0 7px}
 .unsure{color:#8a6d00;font-size:13.5px;margin:6px 0 0}
 .why{color:#888;font-size:12px;margin:6px 0 0}
 .audio{margin:8px 0 0;font-size:13px} .audio a{margin-right:9px} .audio.none{color:#999}
 details{margin-top:9px} summary{font-size:12.5px;color:#666;cursor:pointer}
 table{border-collapse:collapse;margin-top:7px;font-size:12.5px;width:100%}
 td{padding:3px 7px 3px 0;vertical-align:top;border-bottom:1px solid #f0f0f0}
 td.t{white-space:nowrap;color:#888;width:64px} td.f{white-space:nowrap;color:#556;width:150px}
 .cov{margin-top:26px;padding-top:16px;border-top:2px solid #111;font-size:13px;color:#444}
 .cov h3{font-size:13px;margin:0 0 6px;text-transform:uppercase;letter-spacing:.06em}
 .warn{color:#8a1f1f}
 .foot{margin-top:20px;font-size:11.5px;color:#999}
 @media print{body{margin:0;max-width:none} details{display:none} .foot{page-break-inside:avoid}}
</style>
<h1>Overnight scanner briefing</h1>
<p class="win">${esc(d.window.label)} &middot; generated ${esc(et2(d.generatedAt || new Date().toISOString()))}</p>
<p class="lead">${esc(d.lead)}</p>
<ol>${items || '<li><p>Nothing cleared the bar overnight.</p></li>'}</ol>
<div class="cov">
  <h3>What this covers</h3>
  <p>${d.coverage.transmissions} transmissions across ${d.coverage.feeds} feeds.${d.coverage.sampled ? ' <span class="warn">The window was too large to read whole, so this is an even sample across it.</span>' : ''}</p>
  ${(d.offline || []).length ? `<p class="warn">Not listening: ${esc(d.offline.join(', '))}. Anything on those channels is missing from this page.</p>` : '<p>All feeds were reporting.</p>'}
  <p>Ranking is mechanical: items are ordered by signals heard, agencies converged, units committed and how long the traffic ran. The write-ups are machine-written from the transcripts shown.</p>
</div>
<p class="foot">Machine-transcribed and machine-summarised from public safety radio. Unverified and not for publication until the desk checks it. Every line above can be played from the archive.</p>`;

  res.statusCode = 200;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'private, max-age=60');
  return res.end(body);
}
