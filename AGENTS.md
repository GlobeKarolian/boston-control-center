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

See `HANDOVER.md` beside this file for the traps that look like bugs, the test
contract, and the current open work.

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
