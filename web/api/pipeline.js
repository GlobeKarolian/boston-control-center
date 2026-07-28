const { readRoute } = require('../lib/read-route');
const { K } = require('../lib/store-io');
module.exports = readRoute(K.outPipeline, '{"generatedAt":null,"extractor":"idle","feeds":[],"stats":{},"events":[]}');
