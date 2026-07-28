/* Live test of the bike-history rewrite. Hits the real GBFS feed, so it is not
   part of `npm test` and does not run on a plane. Run it with `npm run test:bikes`.

   What it proves: per-snapshot Redis keys plus a capped index list behave
   exactly like the Mac's single 1.2 MB history file did. That is the one place
   in the whole port where storage semantics genuinely changed, so it is the one
   piece that gets checked against live data rather than fixtures.

   The seeded deltas are chosen against src-bikes.js's own two thresholds, and
   getting them wrong is how the first version of this test read four correct
   behaviours as failures:

     MIN_FLOW = 3           below this a dock is churn and never reaches the
                            incident list
     REBALANCE_SUSPECT = 8  at or above this in one window it is read as a Lyft
                            van, flagged, and kept out of the rider totals

   So riders are seeded at 5, inside that band, and one station is seeded at 12
   to prove the van guard still fires. Seeds go to the fullest docks in the city
   so that subtracting a delta cannot clamp at zero, which is the other way the
   first version lied to itself: a dock holding 4 bikes seeded at minus 9 does
   not hold minus 5, it holds 0, and the delta under test quietly became 4. */

process.chdir(require('path').join(__dirname, '..'));
delete process.env.KV_REST_API_URL;
delete process.env.UPSTASH_REDIS_REST_URL;

const bikes = require('../activity/src-bikes.js');
const hist  = require('../activity/bike-history.js');

const MIN_FLOW = 3;
const SUSPECT  = 8;
const RIDERS   = 5;    // MIN_FLOW <= RIDERS < SUSPECT
const VAN      = 12;   // comfortably >= SUSPECT

let bad = 0;
const ok = (l, c, x) => { console.log((c ? '  PASS  ' : '  FAIL  ') + l + (x ? '   ' + x : '')); if (!c) bad++; };

(async () => {
  const r1 = await bikes.collect();
  ok('first poll warms up rather than inventing flow', r1.coverage.warmingUp === true
     && r1.coverage.windowMin === 0, 'reporting=' + r1.coverage.reporting);

  const idx = await hist.index();
  ok('index has exactly one snapshot after one poll', idx.length === 1, 'n=' + idx.length);
  const snap = await hist.get(idx[0].t);
  ok('the snapshot reads back with its station map', !!snap && Object.keys(snap.b).length > 300,
     'stations=' + (snap ? Object.keys(snap.b).length : 0));

  /* Reach into the store the way a cron run 15 minutes ago would have left it. */
  const ranked = Object.keys(snap.b).sort((x, y) => snap.b[y] - snap.b[x]);
  const seed = ranked.slice(0, 7);
  ok('the seven fullest docks can absorb the seeded deltas without clamping at zero',
     seed.length === 7 && snap.b[seed[6]] >= VAN + MIN_FLOW, 'smallest=' + snap.b[seed[6]]);

  const leaving  = seed.slice(0, 3);   // past held MORE, so bikes have gone out
  const arriving = seed.slice(3, 6);   // past held FEWER, so bikes have come in
  const vanId    = seed[6];

  const past = Date.now() - 15 * 60 * 1000;
  const b2 = { ...snap.b };
  for (const id of leaving)  b2[id] = snap.b[id] + RIDERS;
  for (const id of arriving) b2[id] = snap.b[id] - RIDERS;
  b2[vanId] = snap.b[vanId] - VAN;
  await hist.put(past, b2);

  /* lpushCapped is LPUSH then LTRIM, so the index is in insertion order, not
     time order, and the backdated snapshot was written second. pickBaseline
     reads .t and does its own choosing, so ordering here is not a contract and
     asserting it only tests LPUSH. What matters is that both are reachable. */
  const ts = (await hist.index()).map(x => x.t);
  ok('the index now holds both snapshots and both are reachable by timestamp',
     ts.length === 2 && ts.includes(past) && ts.includes(idx[0].t)
     && Math.abs(ts[0] - ts[1]) > 14 * 60 * 1000, ts.join(','));

  const r2  = await bikes.collect();
  const cov = r2.coverage;
  ok('a baseline 15 minutes back is picked, not the one 0 seconds back',
     cov.windowMin >= 14 && cov.windowMin <= 16, 'windowMin=' + cov.windowMin);
  ok('flow is computed off it', cov.compared > 300, 'compared=' + cov.compared);
  ok('no longer warming up', !cov.warmingUp);

  const byId = new Map(r2.items.map(i => [i.id, i]));
  const get  = id => byId.get('bike-' + id);
  const net  = list => list.map(i => (i ? i.detail.net : 'missing')).join(',');

  /* Ranges, not exact equality. The two polls are about a second apart and a
     real rider at one of these docks in that second would shift a net by one.
     The band is what is actually under test: riders, not churn, not a van. */
  const d = leaving.map(get);
  ok('a dock that lost bikes reads as riders leaving',
     d.every(i => i && i.detail.direction === 'out' && i.phase === 'dispersing'
                  && i.detail.net <= -MIN_FLOW && i.detail.net > -SUSPECT), net(d));

  const a = arriving.map(get);
  ok('a dock that gained bikes reads as riders arriving',
     a.every(i => i && i.detail.direction === 'in' && i.phase === 'building'
                  && i.detail.net >= MIN_FLOW && i.detail.net < SUSPECT), net(a));

  ok('and neither is mistaken for a rebalancing van',
     d.concat(a).every(i => i && i.detail.suspectRebalance === false));

  ok('the rider totals carry them, on the correct side',
     cov.ridersOut >= 3 * RIDERS - 2 && cov.ridersIn >= 3 * RIDERS - 2,
     'out=' + cov.ridersOut + ' in=' + cov.ridersIn);

  const v = get(vanId);
  ok('a ' + VAN + '-bike swing IS flagged as a van',
     !!v && v.detail.suspectRebalance === true && v.detail.net >= SUSPECT,
     v ? 'net=' + v.detail.net : 'missing');
  ok('the flagged van is counted as suspect, not as riders',
     cov.suspectRebalance >= 1 && cov.ridersIn < 3 * RIDERS + SUSPECT,
     'in=' + cov.ridersIn + ' suspect=' + cov.suspectRebalance);
  ok('but it still appears on the map, because a van arriving is worth seeing',
     !!v && Number.isFinite(v.lat) && /van/i.test(v.basis));

  /* flowPoints carry no id, so match on the label the items already proved. */
  const want  = new Set(d.concat(a).concat([v]).filter(Boolean).map(i => i.label));
  const pts   = (cov.flowPoints || []).filter(p => want.has(p.name));
  const found = new Set(pts.map(p => p.name));
  ok('every seeded station is on the heat layer with a name and a location',
     found.size === want.size && pts.every(p => p.name && Number.isFinite(p.lat) && Number.isFinite(p.lon)),
     'n=' + found.size + '/' + want.size);
  ok('the heat layer is at least as wide as the incident list',
     (cov.flowPoints || []).length >= r2.items.length,
     'points=' + (cov.flowPoints || []).length + ' items=' + r2.items.length);

  console.log('\n' + (bad ? '*** ' + bad + ' FAILURE(S) ***' : 'BIKE HISTORY OK') + '\n');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('SMOKE FAILED\n' + (e.stack || e.message)); process.exit(2); });
