// lib/vault.js
//
// The archive. Everything the newsroom will one day want to search, written
// once, cheaply, and never touched again.
//
// WHY THIS EXISTS. Until now nothing in this system remembered yesterday. The
// live store keeps a rolling 120 transcripts, which at this volume is about
// twenty minutes of radio; an incident auto-clears after ninety quiet minutes
// and is deleted three hours after that. So a working fire stopped existing
// roughly four and a half hours after its last transmission, and the only
// surviving trace was the audio. "Find me the transmissions from the Back Bay
// fire last night" was not a hard question, it was an impossible one.
//
// WHERE IT GOES, AND WHY NOT REDIS. Upstash is the working set: small, hot,
// and metered on every byte in both directions, which is the meter that has
// been the running cost problem of this project. An append-only archive is
// the exact opposite workload. Blob is object storage, already configured for
// clips, and completely off that meter. Text is also almost free here: about
// 6,700 transmissions a day at a few hundred bytes is under 2MB a day, so a
// year of every word ever heard is smaller than a week of the audio.
//
// SHAPE. One folder per day, so a search for "last night" reads one day and
// never scans the archive:
//
//   vault/2026-08-12/tx/<epoch>-<n>.json    transmissions, as they arrive
//   vault/2026-08-12/incidents/<id>.json    a scene, written when it retires
//   vault/2026-08-12/index.json             the day's summary, for search
//
// The day is Eastern, not UTC. A newsroom saying "last night" means the night
// it lived through, and an archive that splits 8pm from 1am into two folders
// makes the most common question in the building the awkward one.

const blob = require('./blob');
/* The reader owns the path layout. vault.js used to build the tx path itself
   from its own Eastern-day helper, which meant the writer and the reader each
   had an opinion about where an object lives; the day they disagreed, an
   object would be written somewhere nothing lists. One builder now, imported
   by the writer, so the two cannot drift. */
const vaultRead = require('./vault-read');

const TZ = 'America/New_York';

/* The Eastern calendar day a timestamp belongs to. Intl rather than a date
   library because it is the only thing in the standard library that knows
   when Massachusetts changes its clocks. */
function dayOf(at) {
  const d = at ? new Date(at) : new Date();
  if (isNaN(+d)) return null;
  const p = {};
  new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d).forEach(x => { p[x.type] = x.value; });
  return p.year + '-' + p.month + '-' + p.day;
}

/* One transmission, as rich as the pipeline can make it.

   Written flat rather than nested, because the thing reading this back is a
   filter over thousands of rows and every level of nesting is another thing a
   query has to know about. Everything here was already computed to put the
   pin on the map; none of it costs an extra call.

   The provenance fields (by, machine) are here because in six months somebody
   will ask why a transcript reads the way it does, and "which model read this,
   on which Mac" is the answer. A regex-extracted line and one a model judged
   are different kinds of evidence and the archive should say which it was. */
function txRecord(it, { ex, geo, threat, incidentId, by, machine, at }) {
  const e = ex || {};
  const g = geo || {};
  const t = threat || {};
  return {
    at: at || it.at,
    feed: it.src,
    city: it.city || null,
    dept: it.dept || null,
    text: it.text,
    clip: it.clip || null,

    // what was read out of it
    units: e.units && e.units.length ? e.units : undefined,
    callType: e.callType || null,
    role: e.role || null,
    priority: e.priority || null,
    address: e.address || null,
    street: e.street || null,
    crossStreet: e.crossStreet || null,
    landmark: e.landmark || null,
    town: e.town || null,

    // where it landed, and how much to trust that
    lat: g.lat ?? null,
    lon: g.lon ?? null,
    matched: g.matched || null,
    precision: g.precision || null,

    // how alarming it sounded
    tier: t.tier ?? null,
    category: t.category || null,
    signals: t.signals && t.signals.length ? t.signals : undefined,
    alarm: t.alarm ?? null,

    // what it joined, and who read it
    incidentId: incidentId || null,
    by: by || null,
    machine: machine || null,
  };
}

/* A batch of transmissions, one object per ingest POST.

   One object per batch rather than per transmission on purpose. A write is a
   billable operation, and an ingest already arrives holding several
   transmissions, so batching turns roughly 6,700 writes a day into about
   1,500 for identical content. The nightly compaction folds a day's batches
   into one file, which is what makes reading a day cheap later.

   The filename sorts chronologically and carries the count, so a listing
   alone tells you the shape of a night without opening anything. */
async function putBatch(rows, meta) {
  if (!rows || !rows.length) return { ok: true, skipped: 'nothing to archive' };
  const day = dayOf(rows[0].at) || dayOf(new Date().toISOString());
  const stamp = String(+new Date(rows[0].at) || Date.now());
  /* Filed under the hour, not loose in the day.
     A day holds ~30k of these because a batch is one or two transmissions,
     and a flat folder that size costs thirty sequential list round trips to
     read ANY window of it, even twenty minutes. That single fact produced an
     archive that stopped at 6pm, a Shift Change page that timed out, and an
     eighteen-second briefing, all on the same night. Bucketing by hour means
     a twenty-minute read lists one small folder. The filename still leads
     with the epoch stamp, so everything that parses it is unaffected. */
  const path = vaultRead.prefixFor(+new Date(rows[0].at) || Date.now()) + stamp + '-' + rows.length + '.json';
  return blob.putJSON(path, {
    v: 1,
    day,
    writtenAt: new Date().toISOString(),
    machine: (meta && meta.machine) || null,
    by: (meta && meta.by) || null,
    count: rows.length,
    tx: rows,
    /* exact: a degraded-mode caller that may retry the identical batch names
       it deterministically, so the retry overwrites one object rather than
       multiplying copies of the same evening. */
  }, { unique: !(meta && meta.exact) });
}

/* A scene, written once when it retires rather than every time it changes.

   The live store trims an incident's timeline to keep the working set small.
   The vault does not: this is written from the full record at the moment the
   store is about to forget it, so the archive keeps the whole call even
   though the board only ever showed the last few lines of it. That asymmetry
   is the point of having an archive at all. */
async function putIncident(inc) {
  if (!inc || !inc.id) return { ok: false, why: 'no incident' };
  const day = dayOf(inc.firstHeard || inc.lastUpdate) || dayOf(new Date().toISOString());
  const path = 'vault/' + day + '/incidents/' + inc.id + '.json';
  return blob.putJSON(path, { v: 1, day, archivedAt: new Date().toISOString(), incident: inc });
}

module.exports = { dayOf, txRecord, putBatch, putIncident, TZ };
