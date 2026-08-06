// api/extract-contract.js
// The extraction contract, served to the fleet. A relay running a local model
// asks this door for the system prompt, the schema its decoder must obey, and
// the sampling options, so the words that define an extraction live in exactly
// one file (lib/extractor.js) no matter which machine runs the model. The day
// the prompt changes, every Mac picks it up on its next fetch, and no app
// rebuild ships a stale idea of what "clear" means.
//
// Same bearer token as ingest: the contract names feed vocabulary and house
// judgment, which is nobody's business but the fleet's.

const crypto = require('crypto');
const { ingestAuth, json, harden } = require('../lib/http');
const { SYSTEM, SCHEMA } = require('../lib/extractor.js');

/* required is dropped exactly as extract-local.js drops it: a forced field on
   a small model invites a fabricated value where an omission would have been
   honest, and mapFields treats missing and null the same. */
const FORMAT = { type: 'object', properties: SCHEMA.properties };
const OPTIONS = { temperature: 0, num_ctx: 4096, num_predict: 400 };
const VERSION = crypto.createHash('sha1')
  .update(JSON.stringify([SYSTEM, FORMAT, OPTIONS])).digest('hex').slice(0, 12);

module.exports = (req, res) => {
  harden(res);
  const auth = ingestAuth(req);
  if (!auth.ok) return json(res, { error: auth.why }, { status: 401 });
  return json(res, { version: VERSION, system: SYSTEM, format: FORMAT, options: OPTIONS });
};
