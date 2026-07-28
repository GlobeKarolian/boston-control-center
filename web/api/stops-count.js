// Two integers: how many cars are out with someone right now, and how many
// stops have been heard in the window. This exists so the Stops tab can carry
// a live number while a viewer sits on the map, without that viewer pulling
// down the whole stops log every poll to render it. See the note next to
// stopsN in store-io.js for why the CDN cannot do this for us.
const { readRoute } = require('../lib/read-route');
const { K } = require('../lib/store-io');
module.exports = readRoute(K.outStopsN, '{"open":0,"total":0}', { priv: 10 });
