// Stops and field contacts. Written by renderOutputs on every ingest, so this
// is a read of one key. Fallback is the empty shape rather than [], because the
// browser destructures open/closed and an array would throw before it could
// render the empty state.
const { readRoute } = require('../lib/read-route');
const { K } = require('../lib/store-io');
module.exports = readRoute(K.outStops, '{"open":[],"closed":[],"summary":null}');
