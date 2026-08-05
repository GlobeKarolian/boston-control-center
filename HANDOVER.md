# Handing Boston Control Center to a new agent

Read this first. `AGENTS.md` beside it is the deeper file, 207 lines of
architecture and reasoning, and Codex reads it from the repo root automatically.
This one is shorter and covers what a fresh agent cannot learn by reading code.

Written 4 August 2026, on the day the project first got a git remote.

---

## What this is

A newsroom tool that listens to Boston public safety radio, transcribes it,
works out where each call is, and puts live incidents on a map for a desk
editor. Three halves in one repo.

| Path | What it is |
| --- | --- |
| `web/` | Vercel app. Ingest, extraction, storage, API, dashboard. The bulk of it. |
| `scanner/` | Swift. On-device audio capture and relay, runs on a spare Mac. |
| `agent/` | Packaged installer for the scanner half. |

## Two corrections to AGENTS.md

**It is live.** `AGENTS.md` says "Neither half has ever been live." That stopped
being true. `boston-control-center.vercel.app` was serving real transcribed
radio on 4 August with 83 open situations on the board and audio landing about
once a minute. Treat anything in `web/` as production.

**The uncommitted pile is gone.** `AGENTS.md` says 14 tracked files were
modified and 8 paths untracked. The real figure on 4 August was 17 and 55, and
it is now zero. Everything is committed and pushed. Ignore that paragraph.

## Where the code lives

```
https://github.com/GlobeKarolian/boston-control-center     private
```

Private on purpose. The repo carries feed URLs, the auth design and a deploy
target. Do not make it public to simplify a tool integration.

History is grouped rather than one giant commit, so `git log --oneline` reads as
a map of the codebase: lib, api, app, tools and tests, config, docs, scanner.

## The one thing that will bite you first

A GitHub push does not deploy. `web/.vercel/project.json` is a CLI link, so
production only updates when someone runs `npm run deploy` from the laptop that
holds the credentials. There is no git integration and no CI. An agent that
merges a PR and assumes the live site changed will be wrong, and so will anyone
who reads the live site to check whether a fix landed.

## Traps that look like bugs and are load-bearing

**Every file in `app/` has to pass three doors.** It must exist on disk in
`app/`, it must have a rewrite in `vercel.json`, and it must have an entry in
the `ASSETS` map in `api/app.js`. Miss either of the first two and you get a 404
you can see. Miss the third and the request answers with the whole HTML page
marked `text/html`, because `wanted()` falls back to `index.html` for anything
it does not recognise. A missing stylesheet entry therefore produces a dashboard
that draws, polls and updates correctly while wearing browser defaults, with
nothing in the console to explain why. `tools/check-vercel.js` enforces all
three. Do not weaken it.

**`let` at the top level of a classic script does not create a `window`
property.** `app/index.html` is a classic script, not a module. Probing the page
from a console or an automation tool with `window.feedItems` or `window.PIPE`
returns `undefined`, and that says nothing about whether the code works. Read
the DOM, or add a deliberate export, instead of concluding the state is empty.

**The situation circles are sized in metres, not pixels.** `L.circle` takes 1600
for a normal situation and 2600 for a high priority one, which is 8.0 km² and
21.2 km² of ground each. Because the radius is fixed in metres the circles grow
on screen as you zoom in, so at zoom 16 one high priority circle is wider than
the viewport. The radius encodes only `priority === 'high'`, while the real
geocode confidence sits unread in the `matched` field. Known, unfixed, and
discussed at length. Do not tidy it up without reading that discussion.

**Redis commands are the cost ceiling.** Storage is Upstash and the per-command
quota binds long before disk does. Several crons run every minute. Before adding
a poll, a cron or a per-item read, work out the commands per day it costs.
There is metering in `lib/kv.js` for exactly this.

**Situations persist for 90 minutes after the last word.** `lib/threads.js:30-31`
sets `QUIET_MS` to 45 minutes and `DROP_MS` to 90. Anything that looks like a
stuck or duplicated incident is usually this lifecycle rather than a bug.

## The contract

```
cd web
npm run sweep      # 13 checks, unit tests through route wiring
npm test           # the test suites alone
npm run deploy     # the only thing that changes production
node tools/preview.js [port] [busy|quiet|dark]
```

`npm run sweep` is the gate. It was 13 of 13 green on 4 August and it has
already caught a bug that would otherwise have shipped, so a red sweep means
stop rather than adjust the test. `tools/preview.js` serves the dashboard at
localhost:8787 against fabricated feeds, which lets you look at a view without
deploying and without the password. Three moods: `busy` is a normal shift,
`quiet` is an empty board, `dark` pushes every clock past the staleness cutoff.

New test suites follow the house pattern rather than a framework:
`let pass = 0, fail = 0`, `head()`, `ok()` and `eq()` helpers, lowercase
editorial headings, `process.exit(fail ? 1 : 0)`, and an entry in the `STEPS`
array in `tools/sweep.js`.

## Environment

`web/.env.local` holds the live values and is gitignored, correctly. The names
are recorded in `web/.env.example` with empty values. All six are Upstash Redis
credentials issued by the Vercel integration:

```
KV_REST_API_READ_ONLY_TOKEN   KV_REST_API_TOKEN   KV_REST_API_URL
KV_URL                        REDIS_URL           VERCEL_OIDC_TOKEN
```

Never paste the real values into a chat window, an issue, or a commit. An agent
that needs to reason about storage can do it from the names and `lib/kv.js`.

## Where the work actually is

`web/` breaks down as:

- `api/` route handlers, including `api/cron/*` for the scheduled jobs and
  `api/app.js`, which serves the dashboard's sibling assets
- `lib/` the substance. Extraction, geocoding, threading, threat scoring,
  baselines, users and auth, storage
- `app/` the browser. `index.html` is about 3,700 lines and carries the map, the
  board, the Desk and Story tabs, and the shell. Beside it sit `alerts.js`,
  `freshness.js`, `statepolice.js`, `threadui.js`, `track.js`, `webcams.js`, and
  `deskviews.js` with `deskviews.css`
- `tools/` the sweep, the per-module test suites, the preview server, and
  operational scripts
- `vercel.json` rewrites and cron schedules. Read it before adding a route

Geocoding is where the difficulty lives. There is a local gazetteer, an OSM
path, a Census path, and a cascade with demotion logic in `lib/geo.js`. Several
open problems are about precision. Anyone starting there should read the
existing test corpus first, because most obvious improvements have already been
tried and rejected for reasons recorded in the tests.

## Open work, roughly in order of value

1. The situation circles. Size the radius from geocode confidence rather than
   priority, fade opacity toward `DROP_MS` so a call that closed 44 minutes ago
   does not draw like one from ten seconds ago, cap the drawn radius in pixels,
   and give `sitLayer` a row in the Layers panel so it can be switched off.
2. Phone layout. The dashboard is desktop only, and the Story view has visible
   dead space even at 1680px.
3. Audio clips on transcript rows. Storage is picked and `lib/blob.js` exists.
   The upload endpoint and the player do not.
4. Reduce Redis command spend. Gate the per-minute crons so an idle tick is
   nearly free.
5. A test suite for the Desk and Story views. `tools/test-deskviews.js` does not
   exist yet and belongs in the `STEPS` array.

Two small known-wrong things: a comment at `app/index.html:3559` says the pulse
worker refreshes every 15 minutes when the cron at `vercel.json:44` is 3-hourly,
and `PULSE-LANDMARKS.md` is referenced from the tooltip code at
`app/index.html:2617-2621` and does not exist anywhere in the repo.

Two files were committed that arguably should not have been:
`web/app/index.html.prenip`, an 80 KB manual backup, and
`agent/audiotap/bcc-audiotap`, a 180 KB compiled binary. Getting the work safe
mattered more than a clean tree. Delete them when convenient.

## What is not verified here

The file counts, the sweep result and the live-site observation were checked
directly on 4 August 2026. The architecture notes and the open work list come
from working sessions rather than a fresh audit of every file, so treat line
numbers as approximate and confirm them before quoting. `git log` and the test
suites are the two sources that do not go stale.
