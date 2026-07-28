// api/activity.js
// The composite "where are people right now" snapshot. Written by the activity
// cron, served here untouched.
const { liveRoute } = require('../lib/read-route');
const activity = require('../activity/index.js');
module.exports = liveRoute(activity.K_OUT, { priv: 5, hint: 'the activity cron has not completed a run yet' });
