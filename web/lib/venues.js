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
   label, not a wrong place. Kept short because it is rendered after the name. */
const DETAIL_RES = [
  /\b(?:section|sec\.?|sect\.?)\s*(\d{1,3}[a-z]?)\b/i,
  /\b(?:gate)\s*([a-k]|\d{1,2})\b/i,
  /\b(?:box|suite|loge)\s*(\d{1,3}[a-z]?)\b/i,
  /\b(bleachers?|grandstand|pavilion|roof\s?deck|green monster|monster seats?|dugout|home plate|first base|third base|left field|right field|center ?field|outfield|concourse|press box|club(?:house)?|parking (?:lot|garage)|players'? lot)\b/i,
  /\b(lansdowne|jersey street|van ness|ipswich|brookline ave(?:nue)?|yawkey|kenmore)\b/i,
];
function detail(text) {
  const t = String(text || '');
  for (const re of DETAIL_RES) {
    const m = re.exec(t);
    if (!m) continue;
    const word = m[0].trim();
    /* "Section 24", "Gate E", "Bleachers": title case the phrase, keep the number. */
    return word.replace(/\b([a-z])/gi, (c) => c.toUpperCase()).replace(/\bSec\.?\b/i, 'Section').replace(/\bSect\.?\b/i, 'Section').slice(0, 40);
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
