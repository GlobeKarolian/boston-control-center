# Boston Newsroom Control Center, cloud half

The Macs do the audio. This does everything else.

A spare Mac pulls the Broadcastify stream, transcribes it locally with Whisper,
and POSTs text to `/api/ingest`. This project extracts units and addresses from
that text, geocodes it, correlates transmissions into scenes, runs the desk
editor pass, sweeps the crowd sources, and serves the map to the newsroom.

The split is not an aesthetic choice. Broadcastify refuses datacenter IPs. A
residential Mac is the only thing that can hold the stream open, so the cut has
to be at the transcript boundary. A few KB per minute per feed crosses the wire
and no audio ever leaves the building.

BestTime, MBTA, Bluebikes and the event feeds have no such objection, so the
whole crowd layer runs here on cron and no Mac is involved in it at all.

## Deploy

```
cd ~/Developer/bcc/web
vercel link              # once, pick or create the project
vercel install upstash   # provisions Redis, injects KV_REST_API_URL and _TOKEN
vercel env add AUTH_PASS production
vercel env add INGEST_SECRET production
vercel env add ANTHROPIC_API_KEY production
vercel env add CRON_SECRET production
vercel env add BESTTIME_API_KEY_PRIVATE production
vercel env add MBTA_API_KEY production
vercel --prod
```

Then open `/api/status` with the viewer password. It reports which secrets are
present, never their values, and it names what is missing.

Per-minute cron needs Pro or Enterprise. On Hobby the schedules in `vercel.json`
fail at deploy time, because Hobby cron fires once a day.

## Environment

| Variable | Required | What it does |
| --- | --- | --- |
| `AUTH_PASS` | yes | Viewer password. HTTP Basic on every page and read route. With this unset the whole site is open, and `/api/status` says so. |
| `AUTH_USER` | no | Viewer username, defaults to `newsroom`. |
| `INGEST_SECRET` | one of | A single bearer token any Mac may use. Fine for the first install. |
| `INGEST_TOKENS` | one of | Per-machine tokens, `{"studio-mac":"abc","spare-air":"def"}` or `studio-mac:abc,spare-air:def`. Use this once you have more than one Mac: a laptop that walks out of the building gets revoked without touching the others. |
| `ANTHROPIC_API_KEY` | yes | Extraction and the analyst pass. Without it extraction silently falls back to regex, which finds units and street addresses but not much else. |
| `CRON_SECRET` | yes | Vercel sends this as a bearer token on cron requests. Without it anyone can trigger the analyst and spend your model budget. |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | yes | Injected by `vercel install upstash`. Without them every write goes to process memory and is lost on the next request, which is a different machine. `UPSTASH_REDIS_REST_*` and `REDIS_REST_*` are accepted as aliases. |
| `BESTTIME_API_KEY_PRIVATE` | crowd layer | The venue forecast and live busyness sweeps. Without it `/api/pulse` and `/api/livefield` stay at 503 forever and the activity layer runs on transit, bikes and events alone. |
| `MBTA_API_KEY` | no | Raises the MBTA rate limit from 20 to 1000 requests a minute. The layer works without it and will start returning 429 under load. |
| `EXTRACT_MODEL` | no | Defaults to `claude-haiku-4-5`. One call per transmission, so this is the cost-sensitive one. |
| `ANALYST_MODEL` | no | Defaults to `claude-sonnet-5`. One call per minute at most, and only when the transcript stream has actually changed. |
| `PULSE_TILES` | no | Grid side length for the venue sweep, default 4, so 16 tiles across greater Boston. |
| `PULSE_LIVE` | no | `0` skips the live pass of the pulse sweep and leaves the forecast pass alone. |
| `NOMINATIM_ENABLED` | no | `0` turns off the OpenStreetMap geocode fallback. |
| `NOMINATIM_QPS` | no | Global rate limit across all instances, default 1. |
| `GEO_USER_AGENT` | no | Sent to Nominatim. Their terms want a real contact address. |

## Layout

```
api/ingest.js        the door the Mac fleet POSTs to
api/incidents.js     pre-rendered reads, one Redis GET each
api/transcripts.js
api/pipeline.js      feed health, counts, event log
api/situations.js    the analyst's editorial view
api/state.js         all four in one MGET, which is what the page should use
api/activity.js      the crowd layer: who is where, and how sure we are
api/livefield.js     the live correction surface over the forecast
api/pulse.js         the forecast field itself, assembled from two keys
api/app.js           serves app/index.html behind the password
api/feed.js          allowlisted proxy for public upstreams (ADS-B, MBTA, 311)
api/status.js        config truth, presence only, never values
api/healthz.js       open, and deliberately boring

api/cron/analyst.js    desk editor pass, every minute, skipped when nothing changed
api/cron/sweep.js      clears stale incidents when the fleet goes quiet
api/cron/activity.js   every minute
api/cron/livefield.js  every 5 minutes
api/cron/pulse.js      every 3 hours

activity/index.js       the snapshot: runs each source on its own cadence, summarises
activity/livefield.js   BestTime live probes plus bike flow, into anchor points
activity/pulse.js       the 3,400 venue forecast sweep
activity/src-mbta.js    vehicle positions and crowding
activity/src-bikes.js   dock deltas, the only source that shows direction
activity/src-events.js  scheduled draws
activity/src-besttime.js  the watched-venue live pass
activity/src-cache.js   one shared record per source, so two crons cannot both sweep
activity/bike-history.js  per-poll snapshots plus a capped index, in Redis
activity/venues.js      the venue list the sweeps walk
activity/contract.js    the shape every source has to return

lib/kv.js            the only place this app talks to Redis
lib/store-io.js      load, mutate under a mutex, save, render
lib/incident-store.js  correlation: transmissions into scenes
lib/extractor.js     transmission text into structured fields
lib/geo.js           Census first, Nominatim second, both cached in Redis
lib/http.js          two doors: Basic for people, Bearer for Macs
lib/read-route.js    readRoute for incidents, liveRoute for the crowd layer
```

## The crowd layer

Three documents, three cadences, three separate reasons.

**`/api/pulse`** is the forecast field, about 3,400 venues with 24 hourly numbers
each. It is swept every three hours, not because the numbers move that fast but
because the page prints "Forecast pulled Nh ago" in warning colour once the age
passes six, and because the swept weekday cannot be refreshed at read time. The
24 hourly numbers were fetched for one specific weekday, so a stale sweep says
the wrong day until the next one lands. `hourLocal` is refreshed on read, since
that is just a clock. `dayInt` is left exactly as swept.

The document is stored as two keys and spliced back together on read: a small
JSON header, and the venue array as a raw string that is concatenated rather
than parsed. Parsing 1.4 MB of JSON on every newsroom page load to change one
integer in the header would be the most expensive thing this app does.

**`/api/livefield`** is the live correction surface. Every five minutes it picks
the venues most worth probing, asks BestTime for live busyness, and turns the
answers into anchor points that pull the forecast field toward what is actually
happening. Sixty percent of each cycle's probe budget goes to a 1,800 m circle
around Fenway. Bike dock deltas are folded in as anchors too, because they are
the only signal on the map that moves faster than the clock hour.

**`/api/activity`** is the per-minute snapshot: transit, bikes, events and the
watched venues, each on its own cadence, with a written basis for every number
and a blind-spot list for everything it cannot see.

### Two crons, one bike poll

`livefield` and the activity index both want dock deltas. On the Mac they each
called `collect()` and each rewrote the whole 1.2 MB history file, so
last-writer-won cost nothing. In Redis the history is a 60-slot capped index and
the baseline picker has to reach 45 minutes back through it, so two writers a
minute would halve that reach to about 30 minutes and quietly switch the flow
numbers off rather than erroring.

`activity/src-cache.js` is the fix. One shared record per source, whoever finds
it stale does the refresh, everyone else reads it.

## The three things worth knowing before you change anything

**Reads never touch the correlation store.** Output keys are rendered on write
and read back whole. A newsroom polling the live store four times a minute per
open tab would move gigabytes a day for no reason.

**Cache headers are load-bearing.** Vercel's CDN keys its cache on the URL and
not on the `Authorization` header. An `s-maxage` on a password-protected route
would let the CDN hand a cached 200 to a stranger who never reached the
function that checks the password. Anything behind the password uses
`private, max-age=N`. Only `/api/feed`, which has no password and carries
public upstream data, uses `s-maxage`.

**The crowd routes answer 503 when they have nothing, and that is the designed
path.** An empty incident list is a true statement, since nothing is burning. An
empty crowd map is not a statement at all, it is the absence of one, and drawing
it as zeros tells an editor the city is empty when what we actually mean is that
nothing has looked yet. So `readRoute` returns an empty shape and `liveRoute`
returns 503. The page is built for it: `loadLiveField()` returns silently on a
non-ok response and leaves the last surface alone, `loadActivity()` keeps its
last good render, and `loadPulse()` prints the status code.

## Test

```
npm test           # preflight + 59 checks, no network beyond the geocoders
npm run preflight  # structural only, sub-second
npm run test:bikes # live, hits the real GBFS feed
```

`npm run preflight` asks whether the deployment described in `vercel.json` is
the one that exists on disk: every cron path has a handler, every cron declares
its own `maxDuration` rather than inheriting the 10 second default, every
rewrite lands somewhere, every module still loads, and every URL the page
fetches is a route that exists. None of that is behaviour, which is exactly why
it needs its own pass. A cron pointing at a renamed file fails no assertion, it
simply never runs, and the only place you would see it is as an absence in
production three hours later.

The main suite runs the real handlers against fake request and response objects:
auth, a five transmission shift, dedupe on replay, correlation of one fire scene
across three transmissions, the cache headers, the status page not leaking
secrets, the feed proxy allowlist, the crowd routes answering 503 rather than an
empty city, the pulse two-key splice including a deliberately truncated payload,
the source cadence table surviving the loss of the process, and the venue
priority rules that decide where the live probe budget goes.

`npm run test:bikes` is separate because it needs the live Bluebikes feed. It
polls, backdates a seeded snapshot 15 minutes into the past, polls again, and
checks that the deltas come back with the right sign, that a five-bike swing
reads as riders while a twelve-bike swing is flagged as a rebalancing van, and
that both still land on the heat layer.
