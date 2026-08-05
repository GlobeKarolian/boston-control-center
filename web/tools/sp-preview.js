#!/usr/bin/env node
// tools/sp-preview.js
//
// What the State Police column would actually show, drawn in the terminal.
//
// test-statepolice.js proves the rules do what they say against sentences I
// wrote, which is worth exactly as much as my guess about how a Boston
// dispatcher talks. This one runs the same classifier over the real board and
// over real transcripts, and prints the hit rate, because the two ways a
// derived section fails are firing on nothing and firing on everything, and
// neither shows up in a unit test.
//
//   node tools/sp-preview.js            live store
//   node tools/sp-preview.js sample     built-in board, no network, no commands
//
// Reads. Never writes. Two GETs against a store whose monthly command budget
// is the reason this whole section runs in the browser in the first place.

const fs = require('fs');
const path = require('path');

const SP = require('../app/statepolice.js');

/* Same loader tools/peek.js uses, and the same rule: names are read, values
   are never printed anywhere in this file. */
function loadEnv() {
  const f = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}

/* A board written the way the extractor writes them, for running this with no
   store at all. Half of it is deliberately not State Police business, because
   a preview that only contains hits tells you nothing about the false ones. */
const SAMPLE = [
  { id: 's1', headline: 'Rollover with entrapment, Pike westbound', type: 'crash', priority: 'high',
    location: 'I-90 westbound at Allston', updated: new Date(Date.now() - 4 * 60000).toISOString(),
    summary: 'Two cars, one on its roof, left lane blocked past the tolls.' },
  { id: 's2', headline: 'Trooper requesting a wrecker', type: 'crash', priority: 'normal',
    location: 'Route 128 southbound, Needham', updated: new Date(Date.now() - 11 * 60000).toISOString(),
    summary: 'State police on scene, one vehicle into the guardrail.' },
  { id: 's3', headline: 'Person in the water off the Tobin', type: 'water rescue', priority: 'high',
    location: 'Tobin Bridge', updated: new Date(Date.now() - 26 * 60000).toISOString(),
    summary: 'Harbormaster and Chelsea fire responding.',
    events: [
      { at: new Date(Date.now() - 26 * 60000).toISOString(), kind: 'opened', text: 'Person in the water off the Tobin', type: 'water rescue' },
      { at: new Date(Date.now() - 9 * 60000).toISOString(), kind: 'linked', text: 'Bag left on the walkway, no owner', type: 'suspicious package' },
      { at: new Date(Date.now() - 3 * 60000).toISOString(), kind: 'linked', text: 'Troopers have the upper deck shut down', type: 'other' },
    ] },
];

SAMPLE.push(
  { id: 's4', headline: 'Two-alarm house fire', type: 'fire', priority: 'high',
    location: 'Milton', updated: new Date(Date.now() - 40 * 60000).toISOString(),
    summary: 'Everyone accounted for, second alarm struck for manpower.' },
  { id: 's5', headline: 'Disabled box truck in the Ted Williams', type: 'traffic', priority: 'normal',
    location: 'Ted Williams Tunnel eastbound', updated: new Date(Date.now() - 55 * 60000).toISOString(),
    summary: 'Right lane blocked, tow en route.' },
  { id: 's6', headline: 'Shots fired call, no victim located', type: 'shooting', priority: 'high',
    location: 'Blue Hill Avenue, Dorchester', updated: new Date(Date.now() - 70 * 60000).toISOString(),
    summary: 'Units checking the area, nothing showing.' }
);

const ageOf = (s) => {
  const t = Date.parse(s.updated || s.firstSeen || '');
  if (isNaN(t)) return '  --';
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  return m < 60 ? String(m).padStart(3) + 'm' : String(Math.round(m / 60)).padStart(3) + 'h';
};

function drawBoard(list) {
  const rows = SP.select(list);
  console.log('\n  STATE POLICE   ' + rows.length + ' of ' + list.length + ' cards on the board');
  console.log('  ' + '-'.repeat(74));
  /* Not an error and not a warning. Under the feed-only rule an empty card list
     means the State Police have not given the desk a scene, which on a quiet
     hour is the right answer. The radio block below is where you look to see
     whether the feed is actually arriving. */
  if (!rows.length) { console.log('  (no state police scenes on the board)'); return rows; }
  rows.forEach((r) => {
    console.log('  [' + SP.label(r.mark).toUpperCase().padEnd(11) + '] '
      + ageOf(r.sit) + '  ' + (r.sit.headline || '').slice(0, 52));
    console.log('  ' + ' '.repeat(13) + '      heard on the ' + r.mark.why + ' feed');
  });
  return rows;
}

/* The half of the section the cards cannot supply. State Police radio is unit
   numbers and side changes far more often than it is a scene, so this is the
   part that is there when the card list is not, and it is the part the request
   literally asked for. Printed here because a column that reads zero needs an
   answer to "is the feed dead or is it quiet", and these two blocks together
   are that answer. */
function drawRadio(tr) {
  const lines = SP.radio(tr);
  const feeds = [...new Set(lines.map((t) => t.source).filter(Boolean))];
  console.log('\n  RADIO   ' + lines.length + ' of ' + tr.length + ' transmissions in the window'
    + (feeds.length ? '   [' + feeds.join(' ') + ']' : ''));
  console.log('  ' + '-'.repeat(74));
  if (!lines.length) {
    console.log('  (no state police transmissions in the last ' + tr.length + ' lines)');
    console.log('  If the relay says the feed is up, this is the thing to look at.');
    return lines;
  }
  const span = (() => {
    const t = lines.map((x) => Date.parse(x.time || '')).filter((x) => !isNaN(x));
    if (t.length < 2) return '';
    return '  covering ' + Math.max(1, Math.round((Math.max(...t) - Math.min(...t)) / 60000)) + ' minutes';
  })();
  lines.slice(0, 14).forEach((t) => {
    const clock = t.time ? new Date(t.time).toISOString().slice(11, 16) : '  :  ';
    console.log('  ' + clock + '  ' + String(t.text || '').replace(/\s+/g, ' ').slice(0, 62));
  });
  if (lines.length > 14) console.log('  ... and ' + (lines.length - 14) + ' more');
  if (span) console.log(' ' + span);
  return lines;
}

/* What the two switched-off tiers would have added, had the rule been looser.
   This used to be the number that decided whether the section was worth having.
   It is not that any more, because Matt settled the question: the column takes
   the State Police feed and nothing else. So read this as a diagnostic rather
   than as a verdict.

   It is still worth printing for one reason. The jurisdiction line is the size
   of the guess the column used to be making, and seeing it next to a RADIO
   count of real transmissions is the clearest way to see what the rule bought.
   Run over raw transmissions rather than over cards, because the cards are
   already filtered by the extractor and the transcripts are the population the
   rules actually meet. */
function rateOverTranscripts(tr) {
  const n = { named: 0, jurisdiction: 0, none: 0 }, why = {}, phrase = {};
  tr.forEach((t) => {
    const m = SP.assess({ headline: t.text || t.transcript || '', location: t.location || '' });
    if (!m) { n.none++; return; }
    n[m.tier]++;
    const bag = m.tier === 'named' ? phrase : why;
    bag[m.why] = (bag[m.why] || 0) + 1;
  });
  const total = tr.length || 1;
  const pc = (x) => (100 * x / total).toFixed(1).padStart(5) + '%';
  console.log('\n  SWITCHED OFF   what the looser rules would have added, over '
    + tr.length + ' transcripts');
  console.log('  ' + '-'.repeat(74));
  console.log('    named          ' + pc(n.named) + '   ' + n.named);
  console.log('    jurisdiction   ' + pc(n.jurisdiction) + '   ' + n.jurisdiction);
  console.log('    neither        ' + pc(n.none) + '   ' + n.none);
  const top = (o, head) => {
    const e = Object.entries(o).sort((a, b) => b[1] - a[1]);
    if (!e.length) return;
    console.log('    ' + head);
    e.slice(0, 8).forEach(([k, v]) => console.log('      ' + String(v).padStart(5) + '  ' + k));
  };
  top(phrase, 'what was said');
  top(why, 'what was inferred');
}

(async () => {
  if (process.argv[2] === 'sample') {
    drawBoard(SAMPLE);
    console.log('\n  (sample board, no store was read)\n');
    return;
  }
  loadEnv();
  const kv = require('../lib/kv');
  const { K } = require('../lib/store-io');
  let sits = [], tr = [];
  try {
    sits = JSON.parse((await kv.get(K.outSituations)) || '[]');
    tr = JSON.parse((await kv.get(K.outTranscripts)) || '[]');
  } catch (e) {
    console.log('\n  could not read the store: ' + (e && e.message));
    console.log('  run  node tools/sp-preview.js sample  to see the column with no network.\n');
    process.exit(1);
  }
  /* Both halves of the section, in the order the page draws them, so what this
     prints is what a reporter sees. The radio block is the important one when
     the card list is empty, which under the feed-only rule it often will be. */
  drawBoard(Array.isArray(sits) ? sits : []);
  if (Array.isArray(tr) && tr.length) { drawRadio(tr); rateOverTranscripts(tr); }
  console.log('');
})();
