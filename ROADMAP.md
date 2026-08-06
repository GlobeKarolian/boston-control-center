# The reset. 5 August 2026.

Called by the editor after three weeks of accretion: too complicated, too
crowded, code all over the place, systems janky. Fair. The map grew eleven
layers and six design directions while the store ran out of commands with
nobody watching the meter.

There is also now a deadline. A big presentation, and the newsroom needs to
use this for about a week beforehand. So the bar is a tool other people rely
on, running unattended, for days at a stretch.

Four rules, set by the editor, in force from today. Every open ticket yields
to them, and new work should be able to say which rule it serves.

## The rules

1. Every update goes to GitHub, so there is always a way back.
2. Scanner traffic first. All of it, from the relay app to the board.
3. Listening to the real transmission of an incident is a founding feature.
4. Notifications follow a designed strategy, not an accretion of chimes.

## Rule 1 in practice

Nothing deploys unless it is committed and pushed first. `npm run deploy`
copies whatever is on disk, so deploying uncommitted work creates a
production state git cannot reproduce. The order is always commit, push,
deploy, and production deploys get a tag. `baseline-2026-08-05` marks the
repo as it stood on the day of the reset.

## The blocker in front of everything: the store

Upstash is at 500,000 of 500,000 commands and refuses every read and write.
Until that clears, no scanner traffic can land, no login table can be read,
and the newsroom week cannot start. Three parts, in order:

1. Move the store to the fixed plan, about ten dollars a month, billed
   through Vercel. That removes the monthly command ceiling. This is a
   purchase, so it is the editor's click, not an agent's.
2. Deploy. The fix for the original burn is already written in
   `api/ingest.js` (an idle Mac used to cost seven commands per heartbeat
   POST, about 302,000 commands a day; two clocks now gate that) but
   production has not been deployed since 28 July, so the live site has
   been running the expensive version the whole time.
3. Gate the per-minute analyst cron the same way, so an idle tick is
   nearly free. Schedules today: analyst every minute, sweep, activity and
   livefield every five, baseline every ten, outages every fifteen.

## Rule 2, scanner traffic

The pipeline, as built: Broadcastify HLS capture on a spare Mac, Whisper
transcription on that Mac, then `Relay.swift` POSTs batches of
`{src, city, scope, text, at, seq}` to `/api/ingest` with a bearer token.
Ingest authenticates, dedupes on `seq`, extracts and geocodes outside the
store lock, then applies to Redis and renders the output keys the browser
polls. The relay queues locally and backs off when the dashboard is
unreachable, so short outages should not lose traffic.

Getting all of it means being able to prove we got all of it. The work is a
ledger, not a rewrite: every stage counts what it accepted and what it
dropped, with a reason. Relay side already tracks queue depth and backoff.
Server side, count per feed: received, deduped, truncated (MAX_ITEMS is
200, MAX_TEXT is 4000), discarded by the extractor's noise flag (this has
eaten real traffic once before), geocode refusals, store failures. Surface
the ledger on Under the Hood and in `/api/healthz` so "are we getting
everything" is a number anyone can read. The display must also distinguish
a silent relay from a refusing store. Today both look like "no feeds",
which is exactly the ambiguity we sat in this week.

## Rule 3, hear the transmission

Today audio dies on the spare Mac seconds after Whisper reads it. Only text
leaves the machine, and the LIVE AUDIO bar in the dashboard is a
speech-to-text console, so nothing anywhere can play a sound. Baking this
in means changing the relay contract, in this order:

1. The relay keeps each transmission's audio segment and uploads it
   alongside the text, same batch, same token.
2. Ingest stores the clip in Vercel Blob (`lib/blob.js` already picked the
   store) and the transmission record carries its clip URL from birth.
3. A play button on every transcript row and situation card. A reporter
   hears the actual radio, then decides.
4. Retention: clips age out after seven days by default. Blob spend stays
   bounded and the presentation demo still has a full week of audio.

## Rule 4, notifications

Two tiers, health before editorial, because a silent system is worse than a
noisy one and this week proved it.

Health first. The relay has not POSTed in five minutes. The store is
refusing writes. A feed the relay covers has gone quiet. These fire to the
people who run the system, and they exist so an empty board is never a
mystery again.

Editorial second, for the desk. A new situation opened. A situation
escalated (more units, higher threat score, more transmissions). A
watchlist word was heard (shooting, entrapment, working fire, an address).
Every editorial notification carries the unverified language, because a
notification travels further than the dashboard chrome around it.

Channels, in build order: Slack webhook first, since the newsroom already
lives there and routing per channel is free. Browser push second, for the
desk editor away from the tab. SMS last, reserved for the severe tier.
Controls from day one: per-person subscriptions, dedupe per situation
(once at open, again only on escalation), quiet hours, and a global rate
cap, because the fastest way to kill a notification system is to let it
cry wolf in week one.

## Parked until the rules stand

Situation circles redesign, phone layout, further design directions, Story
view dead space, `tools/test-deskviews.js`, deleting the two stray
committed files (`index.html.prenip`, `bcc-audiotap`). All real, none of
them rules.

## The runway to the newsroom week

Before anyone in the newsroom is asked to keep this open, all five must be
true. Store accepting writes. Production deployed from a pushed commit, on
a tag. Relay checked in and the ledger green on Under the Hood. Health
notifications firing to Slack. Audio clips landing and playable. The week
of real use then hardens the thing the presentation shows, and every bug
the newsroom hits lands as a commit, so the story of the week is in the
log.

## The bill, and the ceiling

Set by the editor on 6 August at half past midnight: the whole system runs
under $100 a month. Learned an hour earlier: the API account had already
spent its entire credit balance in ten days, mostly on an ungoverned
every-minute Sonnet analyst and an extractor whose 2,440-token prompt is
too short for Haiku to cache and too long to keep re-sending.

The ceiling is now structural, not aspirational. Extraction has a daily
allowance (EXTRACT_DAILY_CAP, default 500 model calls) and falls to the
regex path past it, loudly labelled. The analyst has one too
(ANALYST_DAILY_CAP, default 40 runs) on a five-minute cron, and past it the
board ages without new judgment until midnight UTC. Worst case that is
under three dollars a day of API on top of ten dollars of Redis and pennies
of Blob.

Two things finish the job. In the Anthropic console, a monthly spend limit
around $75, so the platform enforces what the code intends. And the real
cure: extraction moving onto the mini next to Whisper (extract-local.js is
built and waiting; gate it on the recorded corpus, then wire the relay),
which deletes the larger model line outright and buys the analyst room to
breathe inside the same ceiling.
