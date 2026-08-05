// tools/test-statepolice.js
//
// Drives app/statepolice.js with no browser.
//
// The thing worth testing here is not that the regexes fire. It is the wall
// between the three tiers. A card that lands in this column because it was
// heard on the State Police radio is evidence. A card that lands here because
// somebody on a city channel said "trooper" is reporting. A card that lands
// here because the crash happened on Storrow Drive is a guess this file made,
// and the moment those read the same on screen the section stops being useful
// and starts being a liability.
//
//   node tools/test-statepolice.js

const SP = require('../app/statepolice.js');

let pass = 0, fail = 0;
function head(s) { console.log('\n' + s); }
function ok(label, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + label); return; }
  fail++;
  console.log('  FAIL ' + label + (extra === undefined ? '' : '\n         ' + JSON.stringify(extra)));
}
const eq = (label, got, want) => ok(label + '  =  ' + JSON.stringify(got),
  JSON.stringify(got) === JSON.stringify(want), { got, want });

const T0 = 1800000000000;                       // a fixed clock, no Date.now()
const at = (m) => new Date(T0 - m * 60000).toISOString();

const sit = (o) => Object.assign({
  id: 'x', headline: 'A thing happened', summary: '', location: 'Boston',
  type: 'other', priority: 'normal', confidence: 'reported', updated: at(5),
}, o);

const tier = (o) => { const m = SP.assess(sit(o)); return m && m.tier; };
const why = (o) => { const m = SP.assess(sit(o)); return m && m.why; };
const troop = (o) => { const m = SP.assess(sit(o)); return m && m.troop; };

// ---------------------------------------------------------------------------
head('heard on their own radio, which is the only first-hand evidence there is');
eq('the feed tag, spelled the way the store spells it',
  tier({ feeds: ['mass-state-police'] }), 'feed');
eq('and it comes back readable, because a slug on a card looks like a bug',
  why({ feeds: ['mass-state-police'] }), 'Mass State Police');
eq('a card off their radio with a headline too terse to match anything',
  tier({ headline: 'Signal 9', location: '', feeds: ['mass-state-police'] }), 'feed');
eq('a city feed is not their feed', tier({ feeds: ['boston-police'] }), null);
eq('nor is the T', tier({ feeds: ['mbta-transit-police'] }), null);
eq('one of theirs among several still counts',
  tier({ feeds: ['boston-fire', 'mass-state-police'] }), 'feed');

head('a tag is typed by a person, so it is read differently from speech');
{
  // The lowercase msp veto exists because "msp" loose in a sentence is more
  // often a transcription garble than the department. A feed somebody sat down
  // and named msp is the department, and a tag is not something the machine
  // heard, so the veto does not follow it across.
  eq('msp in prose is still not the department',
    tier({ summary: 'the msp field came back empty' }), null);
  eq('but a feed named msp is', tier({ feeds: ['msp-troop-h'] }), 'feed');
  eq('underscores and dots open out the same as hyphens',
    tier({ feeds: ['ma_state_police.1'] }), 'feed');
  eq('and the pretty version knows the letters are letters',
    why({ feeds: ['msp-troop-h'] }), 'MSP Troop H');
}

head('the tag outranks the words, because the words can be about somebody else');
{
  // A Boston Police dispatcher saying "trooper" is a mention of them. The same
  // sentence carried on the State Police channel is them. Before the feed tier
  // existed both of these read as 'named' and the column could not tell them
  // apart, which is the whole reason John asked for the section.
  eq('a mention on their own feed is first-hand',
    tier({ headline: 'Trooper requesting a tow', feeds: ['mass-state-police'] }), 'feed');
  eq('and the same words on a city feed stay a mention',
    tier({ headline: 'Trooper requesting a tow', feeds: ['boston-police'] }), 'named');
  eq('a road guess on their feed stops being a guess',
    tier({ headline: 'Crash on the Mass Pike', feeds: ['mass-state-police'] }), 'feed');
  eq('and the troop still comes off the words underneath',
    troop({ headline: 'Troop H has the ramp shut', feeds: ['mass-state-police'] }), 'H');
}

head('nothing to say when the analyst said nothing');
eq('no feeds field at all', tier({ headline: 'Crash on Route 30 in Weston' }), null);
eq('an empty list', tier({ headline: 'Crash on Route 30 in Weston', feeds: [] }), null);
eq('a bare string where a list belongs',
  tier({ headline: 'Crash on Route 30 in Weston', feeds: 'mass-state-police' }), null);
eq('holes in the list', tier({ headline: 'Crash on Route 30 in Weston', feeds: [null, '', '-'] }), null);
eq('and the words still work underneath all of it',
  tier({ headline: 'Trooper on scene', feeds: null }), 'named');

// ---------------------------------------------------------------------------
head('somebody said it on the radio');
eq('state police, in as many words',
  tier({ headline: 'State police investigating a fatal on the ramp' }), 'named');
eq('a trooper', tier({ summary: 'Trooper requesting a tow' }), 'named');
eq('a statie', tier({ summary: 'Staties are already there' }), 'named');
eq('the letters, spoken as letters', tier({ headline: 'MSP on scene' }), 'named');
eq('and the phrase comes back so the card can show its work',
  why({ headline: 'State police and Boston police both responding' }), 'state police');

head('and the things that sound like it and are not');
eq('city police are just police',
  tier({ headline: 'Boston police investigating a break-in' }), null);
eq('lowercase msp in prose is not the department',
  tier({ summary: 'the msp field came back empty' }), null);
eq('a fire in a town that happens to have a barracks is a fire',
  tier({ headline: 'Two-alarm house fire', location: 'Milton' }), null);
eq('and so is one in Framingham',
  tier({ headline: 'Working fire, everyone out', location: 'Framingham' }), null);

head('a phrase does not form across the seam between two fields');
{
  // Every pattern in the file spans words with \s+, and textOf used to glue
  // the fields together with a newline, which \s+ happily matches. So this
  // card read as "the state \n Police say" and walked into the named tier on
  // the strength of a join character.
  eq('the state, then Police say, is not the state police',
    tier({ headline: 'Man wanted by the state', summary: 'Police say he ran toward the water' }), null);
  eq('while the real phrase inside one field still lands',
    tier({ summary: 'Man wanted by the state police, last seen running' }), 'named');
}

// ---------------------------------------------------------------------------
head('the road says it when nobody does');
{
  const pike = { headline: 'Rollover in the westbound Mass Pike breakdown lane' };
  eq('the Pike', why(pike), 'the Mass Pike');
  eq('and it is filed as an inference', tier(pike), 'jurisdiction');
}
eq('I-93', why({ headline: 'Debris in the road', location: 'I-93 north at Columbia Road' }), 'I-93');
eq('128', why({ headline: 'Car fire on Route 128 southbound' }), 'I-95 and Route 128');
eq('the tunnels', why({ headline: 'Disabled vehicle in the Ted Williams Tunnel' }), 'the Boston tunnels');
eq('Logan', why({ headline: 'Ground stop', location: 'Logan Airport, Terminal C' }),
  'Logan and Massport property');
eq('Storrow, which is DCR, and DCR roads have been State Police since 1992',
  why({ headline: 'Box truck struck the Storrow Drive overpass' }),
  'Storrow Drive and Soldiers Field Road');

head('a route number is not a prefix of a bigger one');
eq('Route 3 is a state highway', why({ headline: 'Crash on Route 3 north' }), 'a state highway');
eq('Route 30 is a town road and this file says nothing about it',
  tier({ headline: 'Crash on Route 30 in Weston' }), null);

// ---------------------------------------------------------------------------
head('which troop, when the transmission is specific enough to say');
eq('a troop by letter', troop({ summary: 'Troop H units are on the scene' }), 'H');
eq('and that is named, because somebody said it out loud',
  tier({ summary: 'Troop H units are on the scene' }), 'named');
eq('a barracks by name', troop({ summary: 'Two cars from the Milton barracks' }), 'H');
eq('a barracks out west', troop({ summary: 'Northampton barracks notified' }), 'B');
eq('Logan is Troop F', troop({ summary: 'Trooper at the Logan barracks' }), 'F');
eq('no letter when nobody named one', troop({ headline: 'Trooper requesting a tow' }), null);

head('Troop E does not exist any more');
{
  // It was the Turnpike and nothing else, and it was abolished on 2 May 2018
  // after the overtime case. Anything that appears to say it was misheard, and
  // a wrong troop printed beside a headline is worse than no troop at all.
  eq('somebody said troop, so the card is still named',
    tier({ summary: 'Troop E responding' }), 'named');
  eq('but no letter goes on it', troop({ summary: 'Troop E responding' }), null);
  eq('and a barracks in the same breath beats the dead letter',
    troop({ summary: 'Troop E out of the Andover barracks' }), 'A');
}

// ---------------------------------------------------------------------------
head('a thread comes in on a beat that was folded into it');
{
  // The headline is the person in the water. The reason the card belongs in
  // this column is three events down, which is the case threads were built for.
  const m = SP.assess(sit({
    id: 'wr', headline: 'Person in the water', type: 'water rescue', location: 'Tobin Bridge',
    events: [
      { at: at(20), kind: 'opened', text: 'Person in the water', type: 'water rescue' },
      { at: at(6), kind: 'linked', text: 'Bag on the walkway', type: 'suspicious package' },
      { at: at(2), kind: 'linked', text: 'Trooper has the ramp shut', type: 'other' },
    ],
  }));
  eq('named, off the event alone', m && m.tier, 'named');
  eq('and the phrase points at the event that did it', m && m.why, 'trooper');
  eq('the same thread without it belongs to somebody else',
    tier({ headline: 'Person in the water', location: 'Tobin Bridge' }), null);
}

// ---------------------------------------------------------------------------
// Matt's rule, and the one the column now lives by: only transmissions from
// the State Police feed. Everything else is somebody mentioning them.
head('the column takes the feed and nothing else');
{
  const heard = sit({
    id: 'feed-oldest', headline: 'Units on scene', updated: at(240), feeds: ['mass-state-police'],
  });
  const quiet = sit({ id: 'named-quiet', headline: 'Trooper taking a report', updated: at(90) });
  const loud = sit({ id: 'road-loud', headline: 'Fatal on the Mass Pike', priority: 'high', updated: at(1) });
  eq('four hours stale off their own radio, and it is the whole column',
    SP.select([loud, quiet, heard]).map((r) => r.sit.id), ['feed-oldest']);
  // The two that are gone are the two that used to make this section look full.
  // Losing them is the point: a Boston dispatcher saying "trooper" is Boston
  // Police radio, and a crash on the Pike is this file guessing from a road.
  eq('somebody else naming them is not the state police feed', SP.select([quiet]), []);
  eq('and neither is a road they happen to patrol', SP.select([loud]), []);
  eq('a board with nothing first-hand on it is an empty column, not a filled one',
    SP.select([loud, quiet]), []);
}

head('the other two tiers are switched off, not thrown away');
{
  const heard = sit({
    id: 'feed-oldest', headline: 'Units on scene', updated: at(240), feeds: ['mass-state-police'],
  });
  const quiet = sit({ id: 'named-quiet', headline: 'Trooper taking a report', updated: at(90) });
  const loud = sit({ id: 'road-loud', headline: 'Fatal on the Mass Pike', priority: 'high', updated: at(1) });
  // assess() still knows all three, because the tier is a true thing about a
  // card whatever this column chooses to draw.
  eq('assess still grades a mention', SP.assess(quiet).tier, 'named');
  eq('and still grades a road', SP.assess(loud).tier, 'jurisdiction');
  // And the ranking they used to be sorted by still works, so the day somebody
  // wants a "probably theirs" panel the work is here rather than in git history.
  eq('opted in, the order is worth-of-evidence first',
    SP.select([loud, quiet, heard], { include: 'all' }).map((r) => r.sit.id),
    ['feed-oldest', 'named-quiet', 'road-loud']);
  eq('in any order they arrive in',
    SP.select([quiet, heard, loud], { include: 'all' }).map((r) => r.sit.id),
    ['feed-oldest', 'named-quiet', 'road-loud']);
  // An unrecognised opt has to fall to the strict answer. The safe wrong result
  // is a column that under-claims, never one that quietly starts guessing again.
  eq('a wrong opt gets the strict column',
    SP.select([loud, quiet, heard], { include: 'everything' }).map((r) => r.sit.id), ['feed-oldest']);
  eq('and so does a junk opt', SP.select([loud, quiet, heard], 'all').map((r) => r.sit.id), ['feed-oldest']);
}

head('inside the column, the loud one, then the recent one');
{
  const F = ['mass-state-police'];
  const a = sit({ id: 'old-high', headline: 'Crash on I-93', priority: 'high', updated: at(60), feeds: F });
  const b = sit({ id: 'new-normal', headline: 'Disabled car on I-93', updated: at(1), feeds: F });
  const c = sit({ id: 'old-normal', headline: 'Debris on I-93', updated: at(120), feeds: F });
  eq('high first, then newest', SP.select([c, b, a]).map((r) => r.sit.id),
    ['old-high', 'new-normal', 'old-normal']);
  const undated = sit({ id: 'undated', headline: 'Something on I-93', updated: null, firstSeen: null, feeds: F });
  eq('a card with no clock on it sorts last rather than throwing',
    SP.select([undated, b]).map((r) => r.sit.id), ['new-normal', 'undated']);
}

head('junk on the board does not take the column down with it');
{
  const real = sit({ id: 'real', headline: 'Units on scene', feeds: ['mass-state-police'] });
  eq('only the real one is in the column',
    SP.select([null, undefined, {}, { id: 'empty' }, 'nope', real]).map((r) => r.sit.id), ['real']);
  eq('a non-array is survivable', SP.select('nope'), []);
  eq('so is nothing at all', SP.select(null), []);
  eq('and assess says nothing about nothing', SP.assess(null), null);
}

// ---------------------------------------------------------------------------
head('what the chip says, because at four feet it is all anybody reads');
eq('a troop by letter', SP.label(SP.assess(sit({ summary: 'Troop H on the scene' }))), 'Troop H');
eq('named, with no troop given', SP.label(SP.assess(sit({ headline: 'Trooper on scene' }))), 'said on air');
eq('and a guess never borrows that wording',
  SP.label(SP.assess(sit({ headline: 'Crash on the Mass Pike' }))), 'MSP road');
eq('first-hand, with no troop given',
  SP.label(SP.assess(sit({ headline: 'Units on scene', feeds: ['mass-state-police'] }))), 'MSP radio');
eq('and the troop still wins the chip when the words named one',
  SP.label(SP.assess(sit({ headline: 'Troop H has the ramp shut', feeds: ['mass-state-police'] }))),
  'Troop H');
eq('nothing to say about a card that is not here', SP.label(null), '');

head('a tier this file has never heard of degrades toward caution');
{
  // assess cannot produce one today. If somebody adds a fourth tier and forgets
  // this file, the wrong failure is a card that reads as first-hand, so both of
  // these fall back to the guess wording rather than up.
  eq('the chip', SP.label({ tier: 'somethingnew', why: 'x', troop: null }), 'MSP road');
  ok('the tooltip', /^Nobody said state police\./.test(SP.detail({ tier: 'somethingnew', why: 'x' })));
}

head('and the tooltip says the quiet part out loud');
{
  const guess = SP.detail(SP.assess(sit({ headline: 'Crash on the Mass Pike' })));
  ok('it opens by admitting nobody said it', /^Nobody said state police\./.test(guess), guess);
  ok('it names the road it inferred from', guess.indexOf('the Mass Pike') > -1, guess);
  ok('and it ends as a lead rather than a fact', /not a fact\.$/.test(guess), guess);
  const said = SP.detail(SP.assess(sit({ summary: 'Troop H on the scene' })));
  ok('the reported one quotes the radio', said.indexOf('The radio said') === 0, said);
  ok('names the troop', said.indexOf('Troop H was named.') > -1, said);
  ok('and still warns that a machine wrote it down', said.indexOf('machine-transcribed') > -1, said);
  const radio = SP.detail(SP.assess(sit({ headline: 'Units on scene', feeds: ['mass-state-police'] })));
  ok('the first-hand one opens by naming the feed',
    radio.indexOf('Heard on the Mass State Police feed') === 0, radio);
  ok('and draws the line the whole column exists to draw',
    radio.indexOf('rather than somebody else mentioning them') > -1, radio);
  ok('and carries the same warning, because it is the same machine',
    radio.indexOf('machine-transcribed') > -1, radio);
  ok('nothing to say about a card that is not here', SP.detail(null) === '');
}

// ---------------------------------------------------------------------------
// The transmissions themselves, which is what the request literally asked for.
// radio() reads the console log rather than the board, so its rows are the raw
// { time, source, text } shape and not situations.
head('the radio list takes the state police channels and leaves the rest');
{
  const log = [
    { time: at(1), source: 'mass-state-police', text: '820 to H4, side change completed' },
    { time: at(2), source: 'boston-police', text: 'state police are en route' },
    { time: at(3), source: 'msp-troop-h', text: 'H4 copy' },
    { time: at(4), source: 'mbta-transit-police', text: 'transit units on scene' },
    { time: at(5), source: 'ma-state-troopers', text: 'signal ten' },
  ];
  eq('two channels in, and neither of the municipal ones',
    SP.radio(log).map((t) => t.source), ['mass-state-police', 'msp-troop-h', 'ma-state-troopers']);
  // The same matcher the cards use, on purpose. A feed that earns a card has to
  // earn a line, or the section is telling a reporter two different stories
  // about what counts as the State Police.
  ok('a feed that would make a card also makes a line',
    SP.radio([{ time: at(1), source: 'mass-state-police', text: 'x' }]).length === 1);
  eq('a line with no words on it is not a transmission',
    SP.radio([{ time: at(1), source: 'mass-state-police', text: '' }]), []);
  eq('junk in the log does not take the list down',
    SP.radio([null, undefined, {}, 'nope', { source: 'mass-state-police', text: 'ok' }])
      .map((t) => t.text), ['ok']);
  eq('a non-array is survivable', SP.radio('nope'), []);
  eq('so is nothing at all', SP.radio(null), []);
}

// The buffer is the reason this section can show an hour when each poll only
// carries twenty minutes. It is worth more than raising the shared transcript
// cap, which would double the heaviest payload on the page for every viewer.
head('the buffer keeps what the browser has already been sent');
{
  const one = { time: at(30), source: 'mass-state-police', text: 'first' };
  const two = { time: at(20), source: 'mass-state-police', text: 'second' };
  const three = { time: at(10), source: 'mass-state-police', text: 'third' };
  const held = SP.merge([one, two], [three], 10);
  eq('the new one lands and the old ones stay', held.map((t) => t.text), ['third', 'second', 'first']);
  eq('newest first by the clock, not by which list it came out of',
    SP.merge([three], [one, two], 10).map((t) => t.text), ['third', 'second', 'first']);
  // A poll every 1.5 seconds re-sends almost everything it sent last time, so
  // the ordinary case is a merge that adds nothing and must not grow the list.
  eq('the same poll twice adds nothing', SP.merge(held, [one, two, three], 10).length, 3);
  eq('and the same poll ten times still adds nothing',
    SP.merge(SP.merge(SP.merge(held, [one], 10), [two], 10), [three], 10).length, 3);
  // Same second, two channels. Keying the buffer on time alone would silently
  // drop one of these, and the one it dropped would be a State Police line.
  const clash1 = { time: at(5), source: 'mass-state-police', text: 'one' };
  const clash2 = { time: at(5), source: 'msp-troop-h', text: 'two' };
  const clash3 = { time: at(5), source: 'mass-state-police', text: 'split across two clips' };
  eq('a second is not an identity', SP.merge([], [clash1, clash2, clash3], 10).length, 3);
  eq('the cap is a cap', SP.merge([one, two], [three], 2).map((t) => t.text), ['third', 'second']);
  eq('a missing cap still bounds the list', SP.merge([], [one], null).length, 1);
  // A row with no parseable clock must sort to the bottom. Date.parse gives NaN
  // and a NaN comparator does not throw and does not sort, it just leaves the
  // list in whatever order it arrived, which here would be at the top.
  const nostamp = { source: 'mass-state-police', text: 'no clock on it' };
  eq('an undated line sorts last rather than to 1970 at the top',
    SP.merge([], [nostamp, two], 10).map((t) => t.text), ['second', 'no clock on it']);
  eq('junk merges without throwing', SP.merge(null, null, 10), []);
  eq('and a non-array on either side is survivable', SP.merge('nope', 'nope', 10), []);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
