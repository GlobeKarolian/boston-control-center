# AGENTS.md

Context for any coding agent working in this repo. Codex reads this file
automatically from the repo root. Cursor, Copilot, Aider and Claude Code all
either read it or can be pointed at it.

It exists because the expensive knowledge in this project is not in the code.
It is in the handful of traps that look like bugs and are load-bearing, and in
the reasons behind decisions that look arbitrary. That is what follows.

## What this is

Boston Control Center. A newsroom tool that listens to Boston public safety
radio, transcribes and geolocates it, and puts live incidents on a map for a
desk editor. Three halves in one git repo:

| Path | What it is |
| --- | --- |
| `web/` | Vercel app. Ingest, extraction, storage, API, and the dashboard. |
| `scanner/` | Swift. On-device audio capture and relay from a spare Mac. |
| `agent/` | Packaged installer for the scanner half (`pkg/build/`). |

`LAUNCH.md` at the repo root is the runbook for bringing both halves up. Read
it before touching deployment.

**Correction, 4 August 2026.** This file used to say "Neither half has ever been
live." That is no longer true. `boston-control-center.vercel.app` was serving
real transcribed radio with 83 open situations on the board and audio arriving
about once a minute. Treat anything you change in `web/` as production.

## Read this before you write anything

**Both of the warnings that used to sit here are resolved.** This file said
there was no git remote and a large uncommitted pile. On 4 August 2026 the repo
got a remote and everything was committed:

```
https://github.com/GlobeKarolian/boston-control-center     private
```

Private on purpose. It carries feed URLs, the auth design and a deploy target.
History is grouped by subsystem rather than squashed, so `git log --oneline`
reads as a map of the codebase. Nothing is uncommitted.

**A GitHub push does not deploy.** `web/.vercel/project.json` is a CLI link, not
a git integration. Production only changes when someone runs `npm run deploy`
from the laptop. Merging a PR changes nothing that a user can see.

See `HANDOVER.md` beside this file for the traps that look like bugs and the
test contract. `ROADMAP.md` is the order of work, reset by the editor on
5 August 2026, and it outranks the open-work lists in both other files.

## House style, and it is not optional

Match the surrounding code. This codebase has a specific voice and breaking it
makes the diff louder than the change.

- **Comments explain why, not what.** They are prose, often several sentences,
  and they name the specific thing that went wrong. Look at the header of
  `web/lib/threat.js` for the standard: it argues from a measured corpus rather
  than asserting a design. When a rule exists because of an exact pixel width
  or an exact failure, the comment says which one.
- **Zero npm dependencies in `web/`, on purpose.** CommonJS, Node built-ins,
  Vercel serverless functions. Do not add a package without a real argument.
- **No build step for the dashboard.** `web/app/index.html` is one
  self-contained file, about 1700 lines, Leaflet from cdnjs. Do not introduce a
  bundler or a framework.
- **Tests are plain Node.** `web/test/`, run with `npm test`. No test runner.
- **A failing assertion against this code has so far always been the
  assertion's fault.** Two separate cases proved it: a whitespace-rejecting XSS
  payload, and a wrong expectation about password recovery after an outage.
  When a test disagrees with the code here, suspect the test first.

## web/app/index.html: the landmines

This file is where the time goes. All of the following are real and were
learned the hard way.

**Source order beats media queries.** `.rail{top:58px}` is restated in the
SITUATIONS section *after* the 820px media block. Both rules weigh the same and
a media query adds nothing to specificity, so the later one wins. Any new
responsive rule must go at the very end of the stylesheet or it silently does
nothing. The file's own comments call this out. Believe them.

**Panels share one vertical remainder.** Under `max-width:820px` the body
declares `--nres`, `--ntop` and `--nbot`, and the rail, detail and layers panels
all derive their height from `calc((100vh - var(--nres)) * .46)` or `.44`. A
second set of values applies under `body:has(.big-alert.show)`. Changing one
panel's height in isolation will break the other two. Change the variables.

**`:has()` is the established idiom for conditional layout here.** See
`body:has(.big-alert.show)`, `body:has(.detail.show)`,
`body:has(.pulsebar.show)`. Extending that pattern is consistent. Adding a
JavaScript resize listener to do the same job is not.

**Every list is redrawn wholesale via `innerHTML` on a 1.5 to 2.5 second
poll.** This destroys focus and selection. Lists also reorder, since cleared
calls sink to the bottom. Consequences:

- Do not put a tab stop on a list row. It will be destroyed under the user's
  cursor on the next tick.
- If you restore focus after a redraw, restore it by data key (`data-id`,
  `data-sid`) using `CSS.escape`, never by index.
- The intended pattern is roving tabindex: the container is the single tab
  stop, rows are `tabindex="-1"`, arrow keys move, Enter activates.

**Known dead weight.** `#bezos` is a gag portrait pinned bottom right, hidden
under 820px. It is deliberate. Leave it.

**Every colour is a light-dark() pair, and the second value is the one that
shipped.** The page has two themes, switched by `data-theme` on `<html>` and
remembered under `bcc.theme` (`?theme=light|dark|auto` in the URL pins one).
There is no second stylesheet: every literal in the CSS reads
`light-dark(<light>, <dark>)`, and the dark side of every pair is the value the
board had before the light theme existed, so dark is unchanged by construction.
When you add a colour, add it as a pair; a bare hex is a rule that ignores the
theme, and it will look right on whichever theme you happen to be testing in.
The one place CSS cannot reach is what Leaflet writes into SVG as presentation
attributes, so the vector layers take their colours from `PAL` in the script
and `restyleVectors()` walks them on a switch. `PAL.dark` must agree with the
dark side of the tokens in `:root`. Anything drawn as HTML uses the tokens
directly and needs no help. The Desk and the Story follow the same setting
through `BCCTheme`; `deskviews.js` no longer decides a theme of its own.

## Venue feeds

Some radios never leave one building. Fenway Park's security and operations
channel was the first (18 August 2026), and it inverts the pipeline's usual
job: every call on it is at the ballpark before a word is transcribed, and
reading the transcript for a place only makes things worse. "Section 24"
resolves to nothing and falls to the town centroid, which is City Hall;
"transport to Mass General" is where the patient is going. So `lib/venues.js`
is a table, and four things read it:

- `lib/geo.js` places any transmission from a venue feed at the venue before
  the cascade runs, with `venue`, `detail` ("Section 24", "Gate E") and
  `src: 'venue'` on the fix. `matched` is the venue name alone.
- `lib/incident-store.js` threads venue calls by kind, spot and time instead of
  by distance, because at a venue every call is zero metres from every other.
  Two calls naming different spots are two calls, and that undoes a unit join.
  A venue line with no call type and no unit-at-a-spot is chatter, not a pin.
- `lib/extractor.js` files the feed under the venue's town, not under the
  building's name.
- `lib/analyst-core.js` tells the model which feed tags are venues and what a
  normal night on each one sounds like, from the same table.

A feed becomes a venue feed when the relay's Covers box names the venue, or
when its slug carries the marker and does not name a public agency ("BPD D-4
Fenway/Kenmore" is a district, not the park). The dashboard squares off the
glyph, spreads pins that share one point into a ring, draws the building under
them, and says on the pin that the pin is the building's and not the call's.
`node tools/preview.js 8787 game` puts a game night on the board.
`tools/test-venue.js` is the contract; add a venue by adding a row.

## The archive, the desk and the shift briefing

Three surfaces read the vault back as calls: the Archive tab
(`api/vault-search.js`), the ask box on the desk panel (`api/desk-ask.js`) and
Shift Change (`api/shift-change.js`). On 19 August the editor named all three:
the archive was bad at finding and grouping, the ask box answered poorly, and
the briefing asked day-or-night when nobody arrives on a schedule. What
changed, and the traps behind it:

- **One grouper, `lib/scenes.js`.** Seed on the store's incidentId, attach
  loose lines to the scene they plainly belong to (a unit, the same numbered
  address, coordinates inside 150 m of the scene's first point, two shared
  place words), then fold scenes that are one event on two radios: anchors
  inside 150 m or the same numbered address, inside 40 min, same town. Never
  by a shared unit between seeded scenes (an ambulance takes its next call in
  ten minutes; a unit thread chains a whole night, the 117-unit card again),
  never across towns, and two loose bursts never merge with each other. All
  three surfaces use it. `tools/test-scenes.js` is the contract and
  `node tools/archive-replay.js <dump> --scenes` shows it against real radio.
- **The question parser, `lib/vault-query.js`, spends its own words.** A
  question that names a thing returns only lines carrying one of the named
  things, so every word left over after parsing is a requirement. "Biggest
  calls tonight" used to search for the word "biggest"; "any shootings
  overnight" demanded "overnight" of every shooting; "shots fired" left
  "shots" and "fired" behind. Time phrases, the phrase the type was recognised
  by, the seriousness words and desk filler are consumed now, and `f.named`
  says whether a time was spoken so nothing keeps a second list of time words.
  Also: "last night" at any daytime hour is the night that ended at six, not
  the one that has not started (the 14 August QA searched the future and
  blamed the archive); "tonight" before 6pm is last night and says so.
- **The ask box reads scenes.** `desk-ask` hands the model ranked SCENES
  (whole, with span, radios, place, units), not 150 loose lines; a bare
  question ranks by the severity floor, a named one by the archive scorer;
  it answers on `llm.SCENE_MODEL` with `PRIMARY` behind it (`ASK_MODEL`,
  `ASK_MODEL2` override). `node tools/ask-replay.js <dump> "question"` shows
  the retrieval with no network; `--model` adds the answer.
- **Shift Change is the last ten hours from now.** Three parts: `watch` (the
  board's open situations plus the store's active scenes, deduped by place),
  `major` (scenes over the floor, written up, marked LIVE when still running)
  and `notes` (the rest above routine, no prose). `?hours=` up to 24; no
  day/night. `tools/test-shift.js`; `node tools/preview.js 8787 busy` shows it.
- **Work against real radio.** `node tools/vault-dump.js 48` (needs the Blob
  token and KV vars in `.env.local`, `vercel env pull`) writes a slice of the
  vault plus the live board to `_qa/`, gitignored. Every fix above was, or is
  meant to be, checked with `archive-replay.js` and `ask-replay.js` against
  such a slice. A fixture written by the person who wrote the code shares its
  blind spots.

## Open work

Numbered from the previous session's queue. Nothing here is started.

**#135 Extractor schema.** `web/lib/extractor.js` needs a closed-enum
`category` that always returns a value. Roughly 70% of the stream currently
returns nothing for it, which makes that majority invisible to anomaly
detection. Also add a `descriptions` field for clothing, build, and direction
of travel.

**#136 Recurrence index in `web/lib/entities.js`.** Two known data bugs feed
this: a unit claim that welded a Ladder 2 call onto an unrelated BMC scene, and
an address carry-forward that duplicated the 51 Pleasant Street scene.

**#137 `web/api/incidents.js`.** Expose precision and `geoVia`. Add the
baseline `report()` endpoint. Alerting must consume the exported `HEAT_BAR`
rather than re-hardcoding 55, which is the current bug.

**#138** Corpus verification, then deploy per `LAUNCH.md`.

**#148 Phone layout.** `.hud-top` is a `display:flex` row with default
`nowrap`, carrying masthead, live badge, three tabs, the unverified caveat,
status pill, refresh stamp and clock, all with `white-space:nowrap`. Below
roughly 700px it cannot shrink, so it overflows right, and because
`html,body{overflow:hidden}` the overflow is not scrollable, it is clipped. The
status pill and the clock are silently deleted on every phone. Nothing in the
stylesheet handles anything narrower than 820px. Needs a real breakpoint plus
`env(safe-area-inset-bottom)` so the console clears the home indicator.

**#149 Keyboard reachability.** The file contains zero `tabindex`, zero `aria-`
attributes. The nine layer switches, feed rows, situation cards, stop rows,
console hit lines and both close boxes are plain divs and spans with `onclick`.
No Escape handling anywhere. See the focus warning above before starting.

**#150 Reduced motion.** Six infinite animations run at all times and the
priority alert flashes at roughly 1Hz. There is no
`prefers-reduced-motion` fallback. Keep colour and border, drop movement.

**#152 Layer error states.** Every layer loader's catch block writes a bare
`'!'` into the count element with no explanation. Needs a failed state that
reads as failed rather than as a number.

**#151 and #153 are already written** as a standalone verified patch,
`bcc-ux-patch.js`, delivered outside the repo. It removes a complete dead
ticker stylesheet plus `gnews()`, `cleanG()`, `parseFeedXML()` and
`CONFIG.wireQuery` (each occurs exactly once in the file, meaning defined and
never called), and adds a favicon, `theme-color`, `color-scheme` and
`viewport-fit=cover` while unifying the tab title with the masthead. It
dry-runs by default, proves every anchor before writing, and aborts whole
rather than partially. Every one of its assumptions was checked against the
real `app/index.html` (1730 lines) and holds: all four identifiers occur
exactly once, no element uses `class="wire"`, and there is no existing icon
link. Note that `var(--wire)` has 15 readers, so that custom property stays
even though the ticker goes. If that file is lost, the work is a half hour to
redo.

## Auth

Built and tested, 103 checks green, **never deployed**. The live site still
serves the old single shared password.

Design, and the reasons for it:

- The user table lives in **Redis**, not in environment variables, because the
  code that reads env vars cannot write them, so a login could never be minted
  or revoked without a redeploy.
- `web/lib/users.js` owns the table. `web/api/admin.js` is the admin page.
  `web/tools/user.js` is the CLI. `web/test/auth.js` is the suite.
- Per-user credentials with **individual expiry** and revocation from the
  terminal in one command, with no Vercel change and no redeploy.
- `ADMIN_USERS` unset means `AUTH_USER` is the admin. So after deploying,
  `/admin` opens with the credential that already exists.

The motivating requirement was sharing the dashboard with someone without
handing over a personal Vercel password. A guest login for username `RedSox`
was the specific ask and has not been created. Whoever picks that password, it
should not be written into a file or pasted into a chat.

## Secrets

Runtime secrets are read from files under `~/.boston-control-center/` and from
Vercel environment variables. `web/.env.local` is gitignored. None of these
values belong in this file, in a commit, or in a chat transcript.

`LAUNCH.md` part zero records that **two credentials leaked into a chat
transcript in an earlier session and were still live**: the Anthropic API key
and the BestTime private key. Confirm both were rotated. If any project context
is about to be pasted into another tool, rotate them first and check that the
pasted material carries no key material.

## Verifying a change

```sh
cd web && npm test            # plain Node suite, no runner
```

For dashboard changes, `npm test` proves nothing. Load `app/index.html` in a
browser and check: no console errors, every layer switch toggles, the map draws,
Escape closes the detail panel, and any helper you deleted is genuinely
unreferenced. A headless Chromium pass is worth writing for this and does not
exist yet.

## One standing caution

This project's data is machine-transcribed and machine-located police and fire
radio. The dashboard says "Unverified, not for publication" in the header for a
reason. Anything that makes an inferred value look confirmed, or that drops the
provenance of a geolocation, is a correctness bug in the product sense even when
the code is right.
