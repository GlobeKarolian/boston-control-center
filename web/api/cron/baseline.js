// api/cron/baseline.js
// The metronome behind lib/baseline.js. Runs every minute and does two jobs.
//
// Every minute it samples liveness: it asks store-io which feeds are reporting
// themselves live and stamps them into the current hour's liveness hash. That
// is the only thing standing between an honest quiet hour and a relay that
// fell over, and the two are indistinguishable after the fact, so the sample
// has to be taken while it is happening.
//
// Once an hour, in a short window a few minutes past the top, it seals the
// hour that just ended into the rolling profiles. The delay is deliberate:
// Scanner Relay keeps a disk queue and retries, so a transmission spoken at
// 10:59 can arrive at 11:02, and sealing at 11:00 sharp would drop it. Sealing
// is idempotent anyway, so firing across a five minute window costs nothing
// and the first tick to win does the work.
//
// Why one per-minute cron rather than a per-minute sampler bolted onto ingest:
// ingest only runs when a Mac has something to say. A feed that goes silent
// stops POSTing, which is precisely the moment its liveness needs recording.
// A cron ticks whether or not anyone is talking, which is the whole point.

const { cronAuth, json } = require('../../lib/http');
const store_io = require('../../lib/store-io');
const baseline = require('../../lib/baseline');

// Sealed a few minutes late so a retried disk queue can still land in the hour
// it belongs to. Wide enough that a missed tick does not cost the hour.
const SEAL_FROM = 4;
const SEAL_TO   = 9;

module.exports = async (req, res) => {
  if (!cronAuth(req)) return json(res, { error: 'unauthorized' }, { status: 401 });
  const t0 = Date.now();
  const warnings = [];

  try {
    // A feed is evidence of its own hour only while it is genuinely pulling
    // audio. 'live' is the state Scanner Relay sets once the HLS follow loop
    // is running, which is true whether or not anybody has keyed a mic, and
    // that distinction is the entire reason this sampler exists. 'connecting',
    // 'error', 'idle' and 'off' are all excluded, as is anything store-io has
    // relabelled 'offline' for having gone quiet on us.
    const health = await store_io.getHealth().catch(e => {
      warnings.push('health: ' + String(e.message || e).slice(0, 120));
      return [];
    });
    const live = health
      .filter(h => h && h.status === 'live')
      .map(h => String(h.src || h.id || h.label || '').slice(0, 40))
      .filter(Boolean);

    const marked = live.length ? await baseline.beat(live) : { marked: 0 };

    // The hour that just ended, named by a moment safely inside it rather than
    // by arithmetic on the hour number. Subtracting an hour from the clock is
    // correct across midnight, across month ends and across the March and
    // November daylight saving jumps in a way that hour-1 is not.
    const now = Date.now();
    const { minute } = baseline.localParts(now);
    if (minute < SEAL_FROM || minute > SEAL_TO) {
      return json(res, {
        ok: true, sampled: marked.marked, live, sealed: null,
        ms: Date.now() - t0, warnings,
      });
    }

    const prevHour = now - 60 * 60 * 1000;
    const sealed = await baseline.sealHour(prevHour);

    return json(res, {
      ok: true, sampled: marked.marked, live, sealed,
      ms: Date.now() - t0, warnings,
    });
  } catch (e) {
    // A failed tick costs one minute of liveness resolution out of sixty, and
    // the seal window is five minutes wide, so nothing here is worth a retry
    // storm. Report and move on.
    return json(res, {
      error: 'baseline tick failed',
      detail: String(e.message || e).slice(0, 300),
      ms: Date.now() - t0,
    }, { status: 500 });
  }
};
