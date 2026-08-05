/* ============================================================================
   lib/cameras.js - where the roadside cameras come from.

   Massachusetts has about 306 public traffic cameras and no documented API for
   them. MassDOT does not publish a camera feed; the CCTV layer on
   geo-massdot.opendata.arcgis.com does not exist, gis.massdot.state.ma.us is
   robots-disallowed, and cameras.massdot.evbg.net does not resolve. What does
   exist is mass511.com, which is a Castle Rock "OneApp" single page app with a
   public, unauthenticated GraphQL endpoint behind it. That is what this reads.

   The query document and the MapFeaturesArgs input shape below were lifted out
   of the site's own shipped bundle (shared-*.js), so this is the same call the
   public map makes, with the same arguments, asking for a superset of one
   layer. Two things about it are worth writing down because they cost an hour
   each to find:

     1. The layer slug for cameras is "normalCameras", not "cameras". There are
        three merged slug enums in the bundle and the one containing the string
        "cameras" is a dashboard *category* enum, not a layer enum. Passing
        "cameras" returns an empty array with no error, which reads exactly
        like a region with no cameras in it.

     2. The client fires one request per slug and merges. Passing several slugs
        in one array does work, and is what this does, but that is not what the
        site does, so treat a future empty result for one slug as a reason to
        split them rather than a reason to assume the endpoint broke.

   The catalog is fetched here and cached. The IMAGES are not proxied and never
   touch this server. Each camera carries a plain https JPEG URL on
   public.carsprogram.org, which the browser loads directly in an <img> tag.
   Measured on a live camera: 6.1 KB, last-modified 52 seconds before the
   request, so the pictures refresh at roughly one a minute at the source. An
   <img> is not subject to CORS, there is nothing to sign, and a newsroom with
   nine screens open costs this deployment nothing to run.
   ========================================================================== */

const kv = require('./kv');

const KEY = 'bcc:cams';

/* Six hours of grace on a job that runs hourly. A camera catalog that is five
   hours stale is still a correct map of where the cameras are, and showing the
   last good one beats blanking the layer because one fetch timed out. */
const TTL = 6 * 3600;

const ENDPOINT = 'https://mass511.com/api/graphql';

/* Statewide, with margin. Cameras cluster hard on the metro highways but the
   Pike, 495 and the Cape all carry them, and a reporter chasing a storm west
   should not find the layer stops at Worcester. 306 cameras is small enough
   that trimming the box buys nothing. */
const BOX = { north: 43.10, south: 41.10, east: -69.80, west: -73.60 };

/* zoom is required by the schema and is what decides clustering. At a low zoom
   the server returns Cluster objects instead of Cameras and the individual
   locations are gone. 20 is past the clustering threshold at every layer, so
   everything comes back as a leaf. */
const ZOOM = 20;

/* hotCameras are the ones the operators have flagged as currently interesting.
   They are the same Camera type on the same host and there is no reason to
   surface them separately, so both slugs go in and the result is one list. */
const SLUGS = ['normalCameras', 'hotCameras'];

const QUERY = `query MapFeatures($input: MapFeaturesArgs!) {
  mapFeaturesQuery(input: $input) {
    mapFeatures {
      __typename
      uri
      title
      bbox
      features { id geometry properties type }
      ... on Camera {
        active
        views(limit: 5) { uri ... on CameraView { url } category }
      }
    }
    error { message type }
  }
}`;

/* Castle Rock's edge returns 403 to a bare fetch. A browser user-agent is
   enough; nothing here is authenticated or rate limited beyond that. */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* ---- naming --------------------------------------------------------------- */

/* Camera titles arrive in MassDOT's internal operator format, which packs the
   route, the segment, the direction, the mile marker, the town and the
   landmark into one hyphenated string. Measured over all 306 statewide titles,
   there are two families and they disagree about where the direction goes:

     "I-93: I-93-SB-MM19.8-Charlestown-Ex 18 Leverett Cir"     249 titles
     "I-290: 290-MM018.2WB-Worcester-Ex 20 Onramp"              the rest

   In the first, direction is its own hyphen part. In the second it is glued to
   the tail of the mile marker. Splitting naively on the hyphen also breaks the
   route itself apart, because I-93 and RT-3 contain one.

   What holds across both, and is the only thing that does, is that the mile
   marker is the pivot: the part right after it is the town, and everything
   after that is the landmark. So the mile marker is the anchor, the direction
   is read wherever it happens to sit, and the parts before the anchor are
   ignored because the route prefix ahead of the colon already says the same
   thing more cleanly.

   57 titles carry no mile marker at all. Those are ramps and service roads,
   and there the last direction part does the same job as the anchor.

   This exists because the layer answers one question, "what am I looking at",
   and the raw string answers it slowly. The raw string is kept underneath the
   parsed line, so a reporter who reads these fluently loses nothing. */
const DIRS = {
  NB: 'northbound', SB: 'southbound', EB: 'eastbound', WB: 'westbound',
  CN: 'connector',
  /* MassDOT's own codes for the pieces of road that have no compass answer.
     ME is the express/median barrel on I-93 through Boston. E&W is a camera
     pointed across both barrels. Neither is a typo. */
  ME: 'express lanes', 'E&W': 'both directions', 'N&S': 'both directions',
};

/* The same direction shows up as "E & W" spaced and "E&W" unspaced in titles
   two cameras apart on the same road, so every lookup goes through this. */
const dirKey = p => String(p || '').toUpperCase().replace(/\s+/g, '');
const isDir = p => !!DIRS[dirKey(p)];

/* MM4.3, MM018.2, MM018.2WB, MM0A. Trailing letters are a direction when they
   spell one and part of the marker when they do not, which is why the numeric
   run and the letters are captured separately and sorted out afterwards rather
   than guessed at inside the pattern. Keep the letter class out of the first
   group: an optional [A-Z] there is greedy enough to eat the E off EB, which
   left "B" as the direction and dropped it on 29 of 306 cameras, all of them
   the glued Worcester and Lowell format. */
const MM_RE = /^MM([\d.]+)([A-Z&\s]*)$/i;

/* Things that land in the town slot and are not towns, each of them measured
   in the live catalog rather than imagined:

     digits only   a route number carried as an extra segment part, on a
                   handful of 495 cameras ("495-MM040.9ME-82-Franklin-...")
     a direction   the tail of a title that has no town in it at all
     all capitals  a device or segment code. VMSC on the Braintree camera is
                   the sign controller, not a place. Every real town in the
                   catalog is title case, including S. Boston and Fall River,
                   so case alone separates them cleanly.

   Each means the same thing: look one part further along. */
const NOT_A_TOWN = p => !p || /^\d+$/.test(p) || isDir(p) || p.length < 2 || (p === p.toUpperCase() && /[A-Z]/.test(p));

function parseTitle(raw) {
  const s = String(raw || '').trim();
  const colon = s.indexOf(':');
  const route = colon > 0 ? s.slice(0, colon).trim() : '';
  const rest = (colon > 0 ? s.slice(colon + 1) : s).trim();
  const parts = rest.split('-').map(x => x.trim()).filter(Boolean);

  let dir = '', mm = '', anchor = -1;

  /* Pass one: find the mile marker and take the direction off its tail if it
     is carrying one. First match wins rather than last, because the extra
     segment parts that confuse this always come after the marker. */
  for (let i = 0; i < parts.length; i++) {
    const m = MM_RE.exec(parts[i]);
    if (!m) continue;
    const glued = dirKey(m[2]);
    /* Letters that do not spell a direction belong to the marker. MM0A is a
       real mile marker on Beach Road and dropping the A would move it. */
    mm = 'MM' + m[1].toUpperCase() + (DIRS[glued] ? '' : glued);
    if (DIRS[glued]) dir = glued;
    anchor = i;
    break;
  }

  /* Pass two: a standalone direction part. Runs whether or not the marker
     already supplied one, because the standalone form is the more specific of
     the two when both appear. When there is no marker this is the anchor. */
  for (let i = 0; i < parts.length; i++) {
    if (!isDir(parts[i])) continue;
    dir = dirKey(parts[i]);
    if (anchor < 0) anchor = i;
  }

  let town = '', place = '';
  const tail = parts.slice(anchor + 1);
  let t = 0;
  while (t < tail.length && NOT_A_TOWN(tail[t])) t++;
  if (t < tail.length) { town = tail[t]; place = tail.slice(t + 1).join(' - '); }

  return {
    route,
    dir,
    dirWord: DIRS[dir] || '',
    mm,
    town,
    place,
    /* One line a desk can read at a glance, which is what heads the popup and
       what the layer filter matches against. "Charlestown, I-93 southbound". */
    label: [town, [route, DIRS[dir] || ''].filter(Boolean).join(' ')].filter(Boolean).join(', ') || s,
  };
}

/* ---- fetch ---------------------------------------------------------------- */

async function query(slugs) {
  const body = JSON.stringify({
    query: QUERY,
    variables: {
      input: {
        north: BOX.north, south: BOX.south, east: BOX.east, west: BOX.west,
        zoom: ZOOM,
        layerSlugs: slugs,
        nonClusterableUris: [],
      },
    },
  });

  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': UA },
    body,
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error('mass511 http ' + r.status);

  const j = await r.json();
  if (j.errors && j.errors.length) throw new Error('mass511 graphql: ' + String(j.errors[0].message).slice(0, 160));

  const q = j.data && j.data.mapFeaturesQuery;
  if (!q) throw new Error('mass511: no mapFeaturesQuery in response');
  if (q.error) throw new Error('mass511: ' + String(q.error.message || q.error.type).slice(0, 160));

  return Array.isArray(q.mapFeatures) ? q.mapFeatures : [];
}

/* ---- normalize ------------------------------------------------------------ */

function normalize(features) {
  const out = [];
  const seen = new Set();

  for (const f of features) {
    /* At ZOOM 20 nothing should cluster, but the schema can still hand back a
       Cluster and a Cluster has no coordinates. Dropping it silently would
       quietly lose a whole region, so it is counted by the caller instead. */
    if (f.__typename !== 'Camera') continue;

    const view = (f.views || []).find(v => v && v.url);
    if (!view) continue;                       // a camera with no picture is not a camera here

    const geo = (f.features || [])
      .map(x => x && x.geometry)
      .find(g => g && g.type === 'Point' && Array.isArray(g.coordinates));

    /* bbox is [w, s, e, n] and for a point camera all four corners are the
       same pair, so it is a usable fallback when features[] comes back thin. */
    let lon, lat;
    if (geo) { lon = Number(geo.coordinates[0]); lat = Number(geo.coordinates[1]); }
    else if (Array.isArray(f.bbox) && f.bbox.length === 4) { lon = Number(f.bbox[0]); lat = Number(f.bbox[1]); }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    /* Both slugs are queried in one call and a camera flagged hot is also a
       normal camera, so the uri is what keeps it from landing twice. */
    const id = String(f.uri || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const t = parseTitle(f.title);
    out.push({
      id,
      lat: Math.round(lat * 1e5) / 1e5,
      lon: Math.round(lon * 1e5) / 1e5,
      label: t.label,
      town: t.town,
      route: t.route,
      dir: t.dir,
      dirWord: t.dirWord,
      mm: t.mm,
      place: t.place,
      raw: String(f.title || ''),
      url: view.url,
      /* VIDEO and IMAGE both deliver a JPEG. The difference upstream is refresh
         rate, and the browser polls on its own schedule anyway, so this is kept
         only so a future faster refresh for VIDEO has something to key on. */
      kind: view.category === 'VIDEO' ? 'video' : 'image',
      active: f.active !== false,
    });
  }

  /* Stable order so a re-render does not reshuffle the DOM and so two runs of
     this file diff cleanly when someone is debugging it. */
  out.sort((a, b) => (a.town || '').localeCompare(b.town || '') || a.id.localeCompare(b.id));
  return out;
}

/* ---- the sweep ------------------------------------------------------------ */

async function once() {
  const t0 = Date.now();
  const raw = await query(SLUGS);
  const clusters = raw.filter(f => f.__typename === 'Cluster').length;
  const cams = normalize(raw);

  /* A run that comes back with a handful of cameras is far more likely to be a
     bad bbox or a throttled edge than a state that dismantled its camera
     network, and overwriting a good catalog with a broken one is the failure
     that is hard to notice from the map. Measured floor is 306 statewide; 120
     is low enough to never trip on a normal day and high enough to catch a
     response that came back mostly empty. */
  if (cams.length < 120) {
    const prev = await kv.getJSON(KEY, null);
    if (prev && Array.isArray(prev.cams) && prev.cams.length > cams.length) {
      return { ok: false, kept: prev.cams.length, got: cams.length, clusters, ms: Date.now() - t0, note: 'thin response, kept previous catalog' };
    }
  }

  const doc = { at: Date.now(), source: 'mass511', cams };
  await kv.setJSON(KEY, doc, TTL);

  return {
    ok: true,
    cams: cams.length,
    active: cams.filter(c => c.active).length,
    towns: new Set(cams.map(c => c.town).filter(Boolean)).size,
    clusters,
    ms: Date.now() - t0,
  };
}

module.exports = { once, normalize, parseTitle, query, KEY, TTL, BOX, SLUGS };
