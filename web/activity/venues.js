/* ============================================================================
   Boston venue registry.

   Capacities are published figures. Where a venue has different capacities for
   different configurations (TD Garden hockey vs basketball vs concert) each is
   listed separately, because using the wrong one is a 2,000-person error.

   `typicalFill` is the fraction of capacity a normal event actually draws. A
   sellout is rare; modelling every game as a sellout systematically overstates
   the city. These are approximations and are labelled as such in every record
   that uses them. Replace with real attendance history when we have it.

   Tenant note: this file is Boston-specific by content, not by structure. A
   second city supplies its own registry. Nothing here should be imported by
   the connectors as a hardcoded constant.
   ========================================================================== */

const VENUES = {
  fenway: {
    id: 'fenway',
    name: 'Fenway Park',
    lat: 42.3467, lon: -71.0972,
    capacity: 37755,          // published regular-season capacity
    typicalFill: 0.88,
    radiusM: 300,
    // Fenway empties onto Lansdowne, Yawkey, and Brookline Ave and into
    // Kenmore station. The spill is the story more often than the game.
    spillsInto: ['Kenmore', 'Lansdowne', 'Brookline Ave'],
  },
  tdgarden_hockey: {
    id: 'tdgarden_hockey',
    name: 'TD Garden (hockey)',
    lat: 42.3662, lon: -71.0621,
    capacity: 17850,
    typicalFill: 0.95,
    radiusM: 250,
    spillsInto: ['North Station'],
  },
  tdgarden_basketball: {
    id: 'tdgarden_basketball',
    name: 'TD Garden (basketball)',
    lat: 42.3662, lon: -71.0621,
    capacity: 19156,
    typicalFill: 0.95,
    radiusM: 250,
    spillsInto: ['North Station'],
  },
  gillette: {
    id: 'gillette',
    name: 'Gillette Stadium',
    lat: 42.0909, lon: -71.2643,
    capacity: 65878,
    typicalFill: 0.97,
    radiusM: 600,
    // Foxborough, outside the city. Included because a Gillette event is a
    // regional traffic event and the desk cares.
    outsideCity: true,
  },
};

/** Venues we may want BestTime live busyness for, once a key exists.
 *  Deliberately spread beyond downtown. See DEFINITION.md section 5a on
 *  coverage bias: if this list is all Back Bay and Seaport, the map will
 *  imply nothing happens anywhere else. */
const BESTTIME_WATCHLIST = [
  { name: 'Faneuil Hall Marketplace', address: 'Boston, MA' },
  { name: 'Quincy Market', address: 'Boston, MA' },
  { name: 'Boston Public Garden', address: 'Boston, MA' },
  { name: 'Prudential Center', address: 'Boston, MA' },
  { name: 'Assembly Row', address: 'Somerville, MA' },
  { name: 'Harvard Square', address: 'Cambridge, MA' },
  { name: 'Dudley Cafe', address: 'Roxbury, Boston, MA' },
  { name: 'Franklin Park Zoo', address: 'Dorchester, Boston, MA' },
  { name: 'South Bay Center', address: 'Dorchester, Boston, MA' },
  { name: 'Codman Square', address: 'Dorchester, Boston, MA' },
];

module.exports = { VENUES, BESTTIME_WATCHLIST };
