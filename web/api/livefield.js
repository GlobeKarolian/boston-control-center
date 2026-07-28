// api/livefield.js
// The live correction anchors. Absent means "we have measured nothing live",
// which the map must render as the plain forecast rather than as a flat city.
const { liveRoute } = require('../lib/read-route');
const livefield = require('../activity/livefield.js');
module.exports = liveRoute(livefield.K_OUT, { priv: 5, hint: 'the livefield cron has not completed a cycle yet, or BESTTIME_API_KEY_PRIVATE is unset' });
