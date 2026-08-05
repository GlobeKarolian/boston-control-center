// api/state.js
// All four dashboard payloads in one response, one Redis round trip.
//
// The page can poll this instead of hitting /incidents.json, /pipeline.json,
// /situations.json and /transcripts.json separately. Two reasons that is
// better than four polls: it cuts request volume by four across a newsroom
// of viewers, and everything in the response comes from the same instant, so
// the incident count in the header can never disagree with the pins on the
// map.
//
// The crowd layer is deliberately not in here, for three separate reasons.
// Pulse is 1.4 MB and would be re-sent on every poll to carry a payload that
// changes every three hours. Activity and livefield answer 503 when they have
// nothing, and folding them into a bundle would force this route to serve
// zeros in their place, which is the one thing that layer exists not to do.
// And their cadences are 1, 5 and 180 minutes, so bundling them with a
// per-poll read would refetch unchanged bytes most of the time.

const { requireRead, json } = require('../lib/http');
const kv = require('../lib/kv');
const { K } = require('../lib/store-io');

module.exports = async (req, res) => {
  if (!(await requireRead(req, res))) return;
  const fallbacks = ['[]', '[]', '{}', '[]'];
  let vals = fallbacks;
  let error = null;
  try {
    vals = await kv.mget([K.outIncidents, K.outTranscripts, K.outPipeline, K.outSituations]);
  } catch (e) {
    error = String(e.message || e).slice(0, 200);
  }
  const at = i => {
    const v = vals && vals[i];
    return (v === null || v === undefined || v === '') ? fallbacks[i] : v;
  };
  // Assembled by hand so the four payloads are never parsed and re-stringified.
  const body = '{"incidents":' + at(0) +
               ',"transcripts":' + at(1) +
               ',"pipeline":' + at(2) +
               ',"situations":' + at(3) +
               ',"servedAt":' + JSON.stringify(new Date().toISOString()) +
               (error ? ',"error":' + JSON.stringify(error) : '') +
               '}';
  return json(res, body, { priv: error ? 0 : 2 });
};
