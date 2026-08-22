# Handing Boston Control Center to a new agent

Written 22 August 2026. This is the front door. Read it before you touch
anything, then read `AGENTS.md` beside it, which is the deeper file and is what
Codex and Claude Code pick up from the repo root automatically.

`HANDOVER.md` is the version of this file from 4 August and is now history.
`LAUNCH.md` describes bringing a system up that has been up for weeks. Both are
kept because they record why things are the way they are, not because they
describe today.

---

## What this is

A newsroom tool that listens to Boston public safety radio, transcribes it,
works out where each call is, and puts live incidents on a map for a desk
editor. It has been serving real radio since early August. Treat everything in
`web/` as production.

```
https://www.scan.boston                 the product
https://boston-control-center.vercel.app  the same thing, Vercel's own name
https://github.com/GlobeKarolian/boston-control-center   private
```

Four parts, one repo:

| Path | What it is |
| --- | --- |
| `web/` | The Vercel app. Ingest, extraction, storage, API, dashboard. The bulk of it. |
| `scanner/` | **Scanner Relay**, a native macOS app. Captures audio on a Mac, runs whisper locally, posts text and clips. This is the live relay. |
| `ios/` | A SwiftUI iPhone and iPad client for the same authenticated routes. |
| `agent/` | The older Node supervisor and its installer. Superseded by `scanner/`. Do not develop it; see below. |

---

## The first thing that will bite you

**A GitHub push does not deploy.** `web/.vercel/project.json` is a CLI link,
not a git integration. Production changes only when someone runs

```sh
cd web && npm run deploy          # vercel --prod
```

from a laptop that is logged into Vercel. Merging a PR changes nothing a user
can see. And because the deploy copies whatever is on disk rather than whatever
is in git, the order is always **commit, push, then deploy**, or you create a
production state git cannot reproduce.

**Right now production is behind the repo.** As of this writing `main` is at
`89bc2c2` and the deployed page has neither the Fenway tab nor the current
masthead mark, so production is roughly `a70a3b0`. Four commits are pushed and
undeployed. Whoever picks this up should confirm what is live before assuming
a bug is theirs:

```sh
curl -su "$USER:$PASS" https://www.scan.boston/ | grep -c 'data-view="fenway"'
```

Zero means the Fenway work is not deployed.

---

## The shape of the system

Audio never touches the server. A Mac in Matt's home does the expensive part.

```
Broadcastify / a line-in cable / the city's own socket
        |
        |  Scanner Relay (scanner/, native macOS)
        |    demux -> loudness gate -> whisper.cpp, all on the Mac
        v
  POST /api/clip     the 15s of audio, returns a Blob URL
  POST /api/ingest   { machine, at, items:[ {src, city, scope, text, at, seq, clip} ], health:[...] }
        |
        |  web/api/ingest.js
        |    extraction (lib/extractor.js, an LLM or the local model)
        |    geolocation (lib/geo.js, a cascade; lib/venues.js short-circuits it)
        |    threading  (lib/incident-store.js)
        v
  Redis (Upstash) for the live board   +   Vercel Blob for the vault and clips
        |
        +--> /incidents.json /transcripts.json /situations.json /pipeline.json /stops.json
        |      the board, polled every 1.5-2.5s by the dashboard and the iOS app
        |
        +--> /api/vault-search  /api/vault-browse  /api/desk-ask  /api/shift-change
               the archive, which reads the Blob vault rather than the live board
```

Seven Vercel crons keep the slower surfaces fresh; see `crons` in
`web/vercel.json`. The analyst (`api/cron/analyst.js`) is the one that writes
Situations, every five minutes. Nothing else writes them.

### Where the truth lives

- **Live board**: Redis. Small, hot, polled constantly. `lib/kv.js`,
  `lib/store-io.js`. Read routes are all one function, `lib/read-route.js`,
  which shares one payload per warm instance for six seconds because ten open
  screens re-reading the transcript buffer is what once moved 35GB in a month.
- **The vault**: Vercel Blob, one object per batch, foldered by day and feed.
  `lib/vault.js` writes, `lib/vault-read.js` reads. This is the archive.
- **Clips**: Vercel Blob, `api/clip.js`, referenced by URL from a transmission.

---

## Repo map, `web/`

`api/` is 38 files and `lib/` is 37. The ones that carry the most meaning:

| File | Why it matters |
| --- | --- |
| `api/ingest.js` | The front door. Everything the relay says arrives here. |
| `lib/extractor.js` | Turns a transmission into a typed record. Roughly 70% of the stream still returns no `category`; that is open work. |
| `lib/geo.js` | The geocoding cascade. Emits `precision` (`exact`, `approx`, `weak`, `wide`, `none`) and `geoVia`. |
| `lib/venues.js` | Radios that never leave one building. See below. |
| `lib/incident-store.js` | Threads transmissions into incidents. The largest file in `lib/`. |
| `lib/scenes.js` | One grouper, shared by the archive, the ask box and the shift briefing. |
| `lib/vault-query.js` | The question parser. It spends its own words; see AGENTS.md. |
| `lib/threat.js` | Read its header. It is the standard for how comments argue in this codebase. |
| `app/index.html` | The whole dashboard. One self-contained file, now about 6,100 lines. |

`web/tools/` is 58 scripts, mostly one-purpose diagnostics. The ones you will
actually use are listed under **Working against real radio** below.

---

## The dashboard

`web/app/index.html` is one file with no build step and no framework, Leaflet
from cdnjs. It has nine tabs, each of which polls only while it is visible:

`Map`, `Stops`, `Desk`, `Story`, `Archive`, `Audio`, `Shift`, `Fenway`,
`Under the Hood`.

`AGENTS.md` has a section called "web/app/index.html: the landmines" and every
item in it is real: source order beating media queries, three panels sharing
one vertical remainder, `innerHTML` redraws destroying focus, and every colour
being a `light-dark()` pair whose dark half is what shipped. Read it before you
edit the file. The one number in it that has moved is the line count.

### The Fenway tab, as an example of the house reasoning

A venue radio inverts the pipeline's usual job. `lib/venues.js` places every
Fenway transmission at Fenway before a word is transcribed, because "Section
24" resolves to nothing and falls back to the town centroid, which is City
Hall. Correct, and it makes the city map useless for that feed: a night of
ballpark radio lands 250 calls on one dot.

So the Fenway tab draws the inside of the park instead. The drawing is not
generated; it is traced off the club's published seating chart by colour, which
is what makes it trustworthy. Thresholding on the chart's legend colours pulls
each deck out separately and the counts come back exact: grandstand 33,
bleachers 10, Monster seats 10, right field boxes 19. A count landing on the
nose is the check that the segmentation is real.

Naming is the park's own, which is also what the radio speaks: `G1`-`G33`
grandstand, `BL34`-`BL43` bleachers, `M1`-`M10` on the wall, `F9`-`F83` field
boxes, and `B` either side of them, `B1`-`B8` and `B87`-`B97` in right field,
`B98`-`B164` loge. Those ranges do not overlap, so a bare "box 41" is a field
box and a bare "box 132" is a loge box without anyone saying which.

**Known limit, and it is in the commit message too:** inside the two dense box
fans the numbers are ordered rather than read, because the chart carries them
as small rotated text and OCR only recovered a handful. The zone is always
right; the number can be a place or two out in those two decks alone. Fixing
that properly wants the seating map as data (SVG or JSON), not as a picture.

---

## Scanner Relay, the macOS app

`scanner/` is the live relay and the only one worth developing. It is Swift
built by a shell script, not an Xcode project:

```sh
cd scanner && ./build.sh          # -> build/Scanner Relay.app and a .dmg
```

`build.sh` compiles per-architecture with `swiftc`, absorbs every non-system
dylib into the bundle, copies the ggml compute backends and the whisper model,
signs ad hoc, self-tests that the engine runs from inside the bundle, and
writes a DMG. The build number is the count of commits touching `scanner/`, so
it climbs on its own and is the same on any machine at the same commit.

Four kinds of source, in `Model.swift` as `kind`:

| kind | What it reads |
| --- | --- |
| `stream` | A Broadcastify feed or any plain audio URL. |
| `app` | Another application's audio, via ScreenCaptureKit. |
| `device` | **Aux In.** A physical input on the Mac: line-in, a USB capture dongle, a receiver's headphone out. `AuxInput.swift`. |
| `rapidsos` | Boston Police, off the city's own socket. Built because BPD went fully encrypted in August 2025. |

`AuxInput.swift` is deliberately a twin of `SystemAudioTap`: same callbacks,
same 16 kHz mono segments, same WAV framing, so `Capture.swift` arms it the same
way and nothing downstream can tell an aux feed from a tapped one. It also has
a **Listen** button that plays the input through the Mac's speakers, capture
running or not, because a cable in a jack has no other way to prove it carries
anything. That state is never persisted, so a relaunch cannot surprise a quiet
room with a police radio at volume.

### A live defect in the relay's build

The bundled `whisper-cli` loads all three of its ggml compute backends from
`/opt/homebrew/Cellar/ggml/<version>/libexec`, not from the app bundle. The
five backend `.so` files `build.sh` copies into `Resources/bin` are never used
on a machine that has Homebrew's ggml. Two consequences:

1. The DMG is not actually self-contained the way the build log claims.
2. Homebrew's `whisper-cpp` 1.9.1 is linked against ggml 0.15.1 while the
   installed ggml is 0.17.0, and dyld allows it because the compatibility
   version is 0.0.0. That ABI skew is the most likely cause of
   `the speech engine exited 6`, which is not an exit code at all: whisper-cli
   returns only 0, 1, 2, 3, 4 and 10, so 6 is **SIGABRT**.

Two small fixes worth making before chasing anything else in that area:
`Capture.run` should check `terminationReason` so a signal death logs as one,
and whisper's stderr should go to a temp file rather than `nullDevice` so the
abort message survives. Right now the one line that would name the assert is
discarded every time.

### `agent/` is not the relay

`agent/` is an older Node supervisor plus its installer. It predates clip
upload and is text-only. It is kept for reference. If someone asks you to
change "the relay app", they mean `scanner/`. Confirming which one before
editing is worth a question.

---

## Data contracts

**Relay to server**, in order:

```
POST /api/clip     Authorization: Bearer <ingest token>
                   x-bcc-src: <feed slug>   x-bcc-at: <ISO>
                   body: audio/mp4          -> { url }

POST /api/ingest   Authorization: Bearer <ingest token>
{ machine, at,
  items:  [ { src, city, scope, text, at, seq, clip } ],
  health: [ { id, kind, city, scope, label, status, clips, segs, gated,
              failed, lastAudioAt, lastTextAt, lastError, gate, peakLast } ] }
```

**Board routes** answer bare arrays for incidents and transcripts. Situations
may answer a bare array or `{ situations: [...] }` and both shapes are live, so
a client must accept either. `pipeline.json` is an object with `feeds[]`.

**An incident**, the shape the map and the Fenway tab both read, carries
`id, source, cat, city, feed, type, title, location, matched, lat, lon,
located, precision, geoVia, town, venue, detail, status, priority, verified,
firstHeard, lastUpdate, clearedAt, escalations, tier, tierName, hedged,
signals, specialists, depts, alarm, unitJoins, units, timeline, heat, why,
escalating, txCount`.

Two traps in the dashboard's own use of that: `feedItems` holds a cut-down
shape with no `venue`, no `detail`, no `timeline` and no `tier`. The full
records live in `scan.byId`. Anything that needs the real record reads that.
And transcripts arrive newest first.

---

## Secrets

Runtime secrets are Vercel environment variables plus files under
`~/.boston-control-center/`. `web/.env.local` is gitignored and is pulled with
`vercel env pull`. The variable **names** are safe to discuss; the values are
not, and none of them belong in a commit, a document or a chat transcript.

Names in use: `AUTH_USER`, `AUTH_PASS`, `ADMIN_USERS`, `INGEST_TOKENS`,
`KV_REST_API_URL`, `KV_REST_API_TOKEN`, `KV_REST_API_READ_ONLY_TOKEN`,
`KV_URL`, `REDIS_URL`, `BLOB_READ_WRITE_TOKEN`, `BLOB_STORE_ID`,
`BLOB_WEBHOOK_PUBLIC_KEY`, `CRON_SECRET`, `ANTHROPIC_API_KEY`,
`OPENROUTER_API_KEY`, `BESTTIME_API_KEY_PRIVATE`, `EXTRACT_DAILY_CAP`.

`vercel env pull` cannot retrieve the Blob token: it is marked sensitive, so
the pull writes the name with nothing after the equals sign. That is the
platform working as designed, not a broken pull, and the tools that need Blob
fall back to reading through the site with `AUTH_USER` and `AUTH_PASS`.

`LAUNCH.md` part zero records that two credentials once leaked into a chat
transcript. Confirm they were rotated before pasting any project context into
another tool.

---

## Working against real radio

A fixture written by the person who wrote the code shares its blind spots.
Every archive fix in this repo was checked against a slice of the real vault.

```sh
cd web
node tools/vault-dump.js 48                  # 48h of the vault + the live board -> _qa/
node tools/archive-replay.js _qa/<dump>.json "bar fight in harvard square"
node tools/archive-replay.js _qa/<dump>.json --scenes     # what it groups, unasked
node tools/ask-replay.js    _qa/<dump>.json "question"    # the desk ask box, offline
node tools/who-is-feeding.js                 # which Macs are posting, and when last
node tools/peek.js sources                   # what is actually in the live store
node tools/preview.js 8787 game              # a game night on the board, no network
```

**`_qa/` is gitignored and must stay that way.** It is a day of police radio
with names in it. The same rule is why the vault is private and the site
carries `X-Robots-Tag: noindex`.

---

## Running and testing

```sh
cd web
npm test          # preflight + auth + e2e, plain Node, no runner
npm run dev       # vercel dev
npm run deploy    # vercel --prod   <- the only thing that changes production
```

**`npm test` is currently red, 13 failures, and all 13 are the tests' fault.**
Eleven are `test/preflight.js` appending `.js` to rewrite destinations that
carry a query string, so it looks for a file called
`api/app?asset=favicon.svg.js`. The other two assert that `/api/activity` and
`/api/livefield` exist; nothing in the app calls them any more and both 404 in
production. Fixing the suite is worth doing early, because a red suite that is
always red is not a signal, and this codebase has a documented history of the
assertion being wrong rather than the code.

For dashboard changes `npm test` proves nothing. There is a headless harness
worth rebuilding: load `app/index.html` in Chromium with `page.route` stubbing
`incidents.json`, `transcripts.json`, `situations.json`, `pipeline.json` and
`stops.json` from a `vault-dump` slice and Leaflet served from a local copy,
then click every tab and assert no console errors. That is how the Fenway tab
was checked in both themes.

---

## House style

The long version is in `AGENTS.md` and it is not optional. The short version:

- **Comments explain why, not what**, in prose, naming the specific thing that
  went wrong. `lib/threat.js`'s header is the standard.
- **Zero npm dependencies in `web/`** beyond `@vercel/blob`. CommonJS, Node
  built-ins, Vercel functions.
- **No build step and no framework** for the dashboard.
- **Every colour is a `light-dark()` pair.** A bare hex is a rule that ignores
  the theme.
- **Match the surrounding code.** Breaking the voice makes the diff louder than
  the change.
- Commit messages are a sentence that states the insight, not a summary of the
  files touched. `git log --oneline` should read as a map of the codebase.

---

## Open work, in rough order

1. **Deploy.** Four commits are pushed and not live.
2. **Cambridge EMS is not being listened to at all.** Cambridge's 911 ambulance
   service is Pro EMS, and Broadcastify feed **36900** carries its dispatch in
   the clear. The relay carries two Cambridge feeds and neither is EMS, so
   Cambridge ambulance traffic is simply missing. This is the cheapest large
   coverage win available.
3. **`/api/pipeline` returns `feed: null` for every feed.** The relay's
   `pushHealth` in `scanner/src/Controller.swift` never sends the Broadcastify
   feed number, and `normalizeHealth` coerces the missing value to null. The
   consequence is that the LISTEN LIVE wall in the Audio tab builds its stream
   URLs from those numbers and renders empty. A couple of lines to parse the
   digits out of the source URL.
4. **The archive's type filter is a hard gate.** In `lib/vault-query.js`, a
   transmission that does not match the asked-for type returns 0 and dies
   before the named street or address is ever scored. Searching
   "shooting on temple street cambridge" therefore returns unrelated medical
   calls, while the same query without the word "shooting" ranks the right
   cluster first. Two fixes: let a named street survive a type miss with a
   penalty rather than a hard zero, and say on the page when the type matched
   nothing. An archive that can say *the radio never said this* is worth more
   than one that guesses.
5. **Relay diagnostics**, per the SIGABRT note above.
6. **Fenway box numbers** want the seating map as data.
7. The older queue in `AGENTS.md` under "Open work": the extractor's closed-enum
   `category`, the recurrence index, phone layout, keyboard reachability,
   reduced motion, layer error states. Those are still open and still correct.

---

## Two standing cautions

**This data is machine-transcribed and machine-located police and fire radio.**
The header says "Unverified, not for publication" for a reason. Anything that
makes an inferred value look confirmed, or that drops the provenance of a
geolocation, is a correctness bug in the product sense even when the code is
right. The pinning rule follows from this: a weak-precision fix is a town
centroid, and drawing it as a pin is a lie about where a call was, so
`pinnable()` refuses to draw one.

**Encryption is the real ceiling, not the software.** Boston Police went fully
encrypted in August 2025, which is why the RapidSOS source exists. Cambridge
runs one patrol channel in the clear and encrypts everything operational,
including the citywide channel a command post moves to. When a department
moves an incident to an encrypted talkgroup there is nothing to recover, and
the honest product answer is to detect the *shape* of the absence: units
committed citywide, dispatch traffic collapsing to bookkeeping, a neighbouring
department absorbing calls. That pattern is visible in the data and nobody has
built the detector yet.
