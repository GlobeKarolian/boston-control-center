// lib/venues.js
//
// Radios that never leave one building.
//
// Every other feed on the board covers a town, and the geocoder's whole job is
// to work out WHERE in that town a call is from what somebody said. A venue
// feed is the opposite case: Fenway Park's security radio is Fenway Park's
// security radio, and every call on it is at the ballpark before a word has
// been transcribed. Knowing that is worth more than anything the transcript
// can add, and trusting the transcript instead makes things worse, in a
// specific way. "Section 24" resolves to nothing, so the call goes to the town
// centroid, which is City Hall. "Boylston" resolves to a two-mile street.
// "Mass General" is where the ambulance is going, not where the patient fell.
// So a venue feed is placed at the venue, always, and what the radio said
// about where inside it lives in `detail` beside the pin rather than moving it.
//
// The second thing a venue changes is what counts as one incident. Two calls
// a hundred metres apart on a city feed are the same scene; on a venue feed
// every call is zero metres from every other, so distance can never separate
// them. lib/incident-store.js reads `venue` off the fix and threads venue
// calls by what they are and when, not by where.
//
// The third is what is routine. Thirty medicals in a night is an ordinary
// game at Fenway and a mass-casualty event anywhere else. The analyst is
// told which feeds are venues and what a normal shift on each one sounds like.
//
// A feed becomes a venue feed in one of two ways: the coverage the relay
// declared for it names the venue instead of a town ("Fenway Park" typed into
// the Covers box), or its slug carries a marker listed under `feeds` below and
// does not also name a public agency. The second clause is what keeps a
// Boston Police channel somebody labels "BPD D-4 Fenway/Kenmore" on the
// streets where it belongs: the district is named for the neighbourhood, and
// the neighbourhood is named for the ballpark, but the radio covers the
// district. Both ways are things somebody chose on purpose. Add a venue by
// adding a row.

'use strict';

const VENUES = [
  {
    id: 'fenway-park',
    name: 'Fenway Park',
    town: 'Boston',
    /* Home plate, near enough. The park is about 250m across; nothing said on
       its radio is further from this point than that. */
    lat: 42.34655, lon: -71.09731,
    aliases: ['fenway park', 'the ballpark', 'red sox'],
    feeds: ['fenway'],
    routine: 'medicals, ejections, intoxicated patrons, lost children, disturbances in the stands and at the gates',
  },
];

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/* A slug that names one of these is a town's radio, whatever else it says. */
const AGENCY_RE = /\b(police|pd|bpd|fire|bfd|fd|ems|ambulance|sheriff|state|msp|dispatch|district|d ?\d{1,2})\b/;

/* The venue a feed belongs to, or null for the ordinary case. */
function forFeed(feedSrc, declared) {
  const list = Array.isArray(declared) ? declared : (declared ? [declared] : []);
  for (const raw of list) {
    const d = norm(raw);
    if (!d) continue;
    for (const v of VENUES) if (d === norm(v.name) || v.aliases.includes(d)) return v;
  }
  const f = norm(feedSrc);
  if (f && !AGENCY_RE.test(f)) {
    for (const v of VENUES) for (const marker of v.feeds) if (f.includes(marker)) return v;
  }
  return null;
}

/* Where inside the venue, as the radio said it, or null. Best effort and never
   used to move the pin: a section number that came out garbled costs a wrong
   label, not a wrong place. Kept short because it is rendered after the name.

   Each rule carries its own normaliser, because what a person says and what a
   map needs are not the same string. Fenway's gates are called over the air by
   the phonetic alphabet at least as often as by the letter, so "Gate Bravo"
   and "Gate B" are one place and have to come out of here as one label or the
   ballpark view draws the same gate twice. Everything here was read off the
   feed's own transcripts rather than imagined: the vocabulary list is what the
   security radio actually said over a night of baseball. */
const DETAIL_RULES = [
  /* A section with a row is the most precise thing this radio ever says, and
     it says it in one breath: "section 30, row 5". Taken as a pair when the
     pair is there, so the label carries everything that was offered. */
  { re: /\b(?:section|sec\.?|sect\.?)\s*(\d{1,3}[a-z]?)(?:\s*,?\s*row\s*([a-z]|\d{1,3})\b)?/i,
    norm: m => 'Section ' + m[1].toUpperCase() + (m[2] ? ' \u00b7 Row ' + m[2].toUpperCase() : '') },

  /* Gates, spoken either way. The phonetic list is deliberately only the
     letters Fenway has gates for; a stray "delta" elsewhere in a sentence
     needs the word "gate" in front of it to mean anything here. */
  { re: /\bgate\s*(alpha|bravo|charlie|delta|echo|kilo)\b/i,
    norm: m => 'Gate ' + m[1][0].toUpperCase() },
  { re: /\bgate\s*([a-k])\b/i, norm: m => 'Gate ' + m[1].toUpperCase() },
  { re: /\bgate\s*(\d{1,2})\b/i, norm: m => 'Gate ' + m[1] },

  /* The bowl's own vocabulary, from the club's seating chart. Fenway numbers
     its field level in three concentric rings, and the ring a number belongs
     to is decided by the number itself: Right Field Box 1 to 8 and 87 to 97,
     Field Box 9 to 82, Loge Box 98 to 165. So "box 41" and "box 132" are two
     different tiers and the label has to say which, or the drawing puts them
     in the same place. A number spoken with its tier is taken at its word. */
  { re: /\b(right ?field box|field box|loge box|pavilion box|pavilion club|roof deck box|dugout box|grandstand)\s*(\d{1,3})\b/i,
    norm: m => title(m[1]) + ' ' + m[2] },
  { re: /\b(?:box|suite|loge)\s*(\d{1,3}[a-z]?)\b/i,
    norm: m => m[0].replace(/\s+/g, ' ').replace(/^./, c => c.toUpperCase()) },
  /* The Monster's own seats are lettered M1 to M10 on the chart and called
     "monster seats" on the radio; both land in the same place. */
  { re: /\bm\s?(\d{1,2})\b(?=[^.]{0,24}\bmonster\b)|\bmonster\s*(?:seat\s*)?m?\s?(\d{1,2})\b/i,
    norm: m => 'Monster ' + (m[1] || m[2]) },

  /* The named parts of the park. Longest phrases first so "right field box"
     does not come back as "right field". */
  { re: /\b(state street pavilion|right ?field box(?:es)?|left ?field box(?:es)?|field box(?:es)?|loge box(?:es)?|pavilion club|pavilion reserved|pavilion box|right ?field cantina|right ?field roof|roof ?deck|budweiser deck|dell club|dell tech|emc club|press box|green monster|monster seats?|home plate|first base|third base|left ?field|right ?field|cent(?:er|re) ?field|outfield|bleachers?|grandstand|pavilion|terrace|dugout|concourse|club ?house|bullpen|players'? lot|parking (?:lot|garage))\b/i,
    norm: m => title(m[1]) },

  /* "Sam Deck" reaches the transcriber as "sand deck" more often than not.
     There is no sand at Fenway; there is a Sam Adams deck in right field. */
  { re: /\b(?:sam|sand)\s*deck\b/i, norm: () => 'Sam Deck' },

  /* Which floor, when nothing better was said. Weak, so it sits below the
     named places and above the streets. */
  { re: /\b(ground level|street level|level\s*[1-9])\b/i, norm: m => title(m[1]) },

  /* The perimeter. A call on Jersey Street is outside the park and still at
     the ballpark, which is exactly the distinction this label is for. */
  { re: /\b(lansdowne|jersey street|van ness|ipswich|brookline ave(?:nue)?|yawkey|kenmore)\b/i,
    norm: m => title(m[1]) },
];

/* One spelling per place. The radio says "bleacher" and "bleachers" and
   "monster seats" and "the green monster" in the same inning, and a view that
   groups by this label has to see one place, not four. */
const CANON = {
  'Bleacher': 'Bleachers',
  'Monster Seat': 'Green Monster', 'Monster Seats': 'Green Monster',
  'Centre Field': 'Center Field', 'Centrefield': 'Center Field', 'Centerfield': 'Center Field',
  'Leftfield': 'Left Field', 'Rightfield': 'Right Field',
  'Club House': 'Clubhouse',
  'Right Field Boxes': 'Right Field Box', 'Left Field Boxes': 'Left Field Box',
  'Field Boxes': 'Field Box',
  'Roofdeck': 'Roof Deck',
  'Brookline Ave': 'Brookline Avenue',
};
const title = s => {
  const t = String(s).toLowerCase().replace(/\s+/g, ' ')
    .replace(/\b([a-z])/g, c => c.toUpperCase());
  return CANON[t] || t;
};

function detail(text) {
  const t = String(text || '');
  for (const rule of DETAIL_RULES) {
    const m = rule.re.exec(t);
    if (!m) continue;
    const out = String(rule.norm(m) || '').trim();
    if (out) return out.slice(0, 40);
  }
  return null;
}

/* The fix a venue transmission gets. Exact at the scale a map is read at, and
   flagged so the store knows the coordinates are the feed's and not the
   call's. `matched` is the name alone, so archive search and scene matching
   see one place; the sub-location rides in `detail`. */
function fix(venue, text) {
  const d = detail(text);
  return {
    lat: venue.lat, lon: venue.lon,
    matched: venue.name, town: venue.town,
    src: 'venue', kind: 'venue', venue: venue.name, venueId: venue.id,
    detail: d || null,
    confident: true,
  };
}

/* One paragraph for the analyst, built from the table so a new venue teaches
   the model without anybody editing a prompt. */
function analystNote() {
  if (!VENUES.length) return '';
  const rows = VENUES.map(v =>
    'A feed tag containing "' + v.feeds[0] + '" is ' + v.name + '\'s own security and operations radio; ' +
    'every call on it is at ' + v.name + ', ' + v.town + ', and its location is "' + v.name + '" whatever the transcript says. ' +
    'On an event day ' + v.routine + ' are routine there and are not situations. ' +
    'A weapon, a stabbing or shooting, a person unresponsive or a mass-casualty medical, a fire or an evacuation, ' +
    'a suspicious package, a threat, or anything a reporter would go to the ballpark for, is.');
  return 'VENUES. ' + rows.join(' ');
}

module.exports = { VENUES, forFeed, detail, fix, analystNote };
