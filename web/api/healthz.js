// api/healthz.js
// Deliberately open and deliberately boring. It says the deployment is up and
// nothing else: no counts, no config, no evidence of what this thing is.
const { json } = require('../lib/http');
module.exports = async (req, res) => json(res, { ok: true, at: new Date().toISOString() }, { status: 200 });
