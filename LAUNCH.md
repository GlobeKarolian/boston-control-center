# Launch runbook

Both halves are built. Neither is live yet. This is the order to bring them up
and the reason the order matters.

| Half | Where | State |
| --- | --- | --- |
| Dashboard, crowd layer, extraction, analyst | `~/Developer/bcc/web` | built, tests green, never deployed |
| Scanner audio, Whisper, browser tap | `~/Developer/bcc/agent/pkg/build/BCC-Agent-1.0.0.pkg` | built, verified, never installed |

**The cloud half goes first.** `bcc-setup` on the spare Mac asks for two things
that do not exist until the deploy is done: the dashboard URL and that machine's
ingest key. Installing the pkg first means running setup twice.

Budget about 40 minutes for part one and 15 for each Mac.

---

## Part zero: rotate two keys, now

Two credentials leaked into a chat transcript in earlier sessions and are still
live. You are about to paste both of them into Vercel, so rotating first costs
nothing and rotating later costs doing this twice.

1. **Anthropic key.** console.anthropic.com, revoke the old one, create a new
   one. Overwrite `~/.boston-control-center/.anthropic_key` with the new value.
2. **BestTime key.** besttime.app, regenerate the private key. Overwrite
   `~/.boston-control-center/.besttime_key`.

Do not paste either value into chat. Both files are read at runtime and are
already mode 600.

The third one is the viewer password in `~/.boston-control-center/.auth_pass`,
which you also pasted once. You are about to set `AUTH_PASS` on Vercel anyway,
so just pick a new one there and treat the old file as dead.

---

## Part one: the cloud half

### 1. Three secrets you invent

`AUTH_PASS`, `INGEST_TOKENS` and `CRON_SECRET` are yours to make up. Generate
them so they are actually random:

```
openssl rand -base64 24        # AUTH_PASS, the newsroom viewer password
openssl rand -hex 32           # CRON_SECRET
openssl rand -hex 32           # one per Mac, for INGEST_TOKENS
```

Run the last one once per machine in the fleet. Keep the output somewhere you
can find it, because you will paste each Mac's token into `bcc-setup` on that
Mac later.

Use `INGEST_TOKENS` rather than `INGEST_SECRET`. With a per-machine table, a
laptop that walks out of the building gets revoked on its own. The value is
either JSON or a comma list:

```
{"studio-mac":"<token1>","spare-air":"<token2>"}
```

or

```
studio-mac:<token1>,spare-air:<token2>
```

One detail worth knowing: the server checks the presented token against every
entry in the table rather than looking up the name the Mac claims. So the name
you type into `bcc-setup` does not have to match the key in `INGEST_TOKENS` for
auth to work. Matching them anyway keeps the dashboard legible when a feed goes
quiet and you want to know which machine to go poke.

### 2. Deploy

```
cd ~/Developer/bcc/web
npm test                 # 128 checks, 69 preflight + 59 e2e, green as of today

vercel link              # once, pick or create the project
vercel install upstash   # provisions Redis, injects KV_REST_API_URL and _TOKEN

vercel env add AUTH_PASS production
vercel env add INGEST_TOKENS production
vercel env add CRON_SECRET production
vercel env add ANTHROPIC_API_KEY production
vercel env add BESTTIME_API_KEY_PRIVATE production
vercel env add MBTA_API_KEY production      # optional, raises the rate limit

vercel --prod
```

`vercel install upstash` matters. Vercel KV was retired at the end of 2024 and
first-party storage is now Blob and Edge Config only, so Redis comes from the
marketplace. Without those two variables every write goes to process memory and
disappears on the next request, which is a different machine.

Per-minute cron needs Pro. You have it. On Hobby the schedules in `vercel.json`
fail at deploy time.

### 3. Verify before touching a Mac

Open `/api/status` with the viewer password. It reports which secrets are
present, never their values, and it names what is missing. Everything should
read present except `MBTA_API_KEY` if you skipped it.

Then open the root URL. The map should draw. Incidents will be empty, because
no Mac is sending yet. The crowd layer should start filling within a few
minutes as the activity and livefield crons fire.

Write down the production URL. That is what you type into `bcc-setup`.

---

## Part two: the first Mac

Do this on a spare machine, not your daily driver. The agent holds a
Broadcastify stream open and runs Whisper continuously.

### 1. Get the package over

The pkg is 83K at `~/Developer/bcc/agent/pkg/build/BCC-Agent-1.0.0.pkg`. AirDrop
it, or copy it over the network. Its sha256 is
`4d0ec45b34dd6fdf87a7ee37c66291755054089469ebfd79481f8fc9295bb094` if you want
to confirm it arrived whole.

### 2. Install it

The build is unsigned, which you decided was fine. Double-clicking it gets a
Gatekeeper block. Right-click the file and choose Open, then Open again in the
dialog. If macOS refuses outright, System Settings, Privacy and Security, scroll
to the bottom, Open Anyway.

The installer lays down files and starts the LaunchAgent. It deliberately does
not install Homebrew, build a Python environment, download a model, or ask you
anything, because a pkg postinstall runs as root with no terminal and would get
all of that wrong.

The agent will start, find no configuration, log that dependencies are missing,
and exit 0 on purpose so launchd stops retrying. That is the expected state
until you run setup.

### 3. Run setup

```
bcc-setup
```

As yourself, not with sudo. It refuses root, because Homebrew refuses root and
the config belongs to your account rather than to the machine.

It walks six sections. What it asks:

- **Name for this machine.** Defaults to the computer name, lowercased.
- **Dashboard URL.** The production URL from part one.
- **Which feeds this Mac carries.** Assigned by hand, so pick a different role
  on each machine:

  ```
  1  Boston Fire + Boston EMS
  2  Cambridge + Mass State Police
  3  Boston Police, captured from a browser tab
  4  all four scanner feeds, no browser tap
  ```

  Start with 1 on the first machine.
- **The ingest key.** Paste that machine's token. Input is hidden and the value
  goes straight to a mode 600 file. It is never printed.
- **Broadcastify login,** if the chosen feeds need it.

The Python step is the slow one. It picks 3.12, 3.11, 3.13 or 3.10 in that
order, rather than whatever `python3` points at, because Homebrew's default is
now 3.14 and ctranslate2 has no wheels for it. A source build of ctranslate2 on
a laptop is an hour of clang and usually fails. If none of those four versions
are installed it brew-installs `python@3.12`.

Then it warms the Whisper model so the first clip is not a 90 second download.

### 4. Confirm it is working

```
bcc-doctor                    # should go all green
tail -f ~/.bcc/agent.log      # transcripts as they land
```

Log out and back in. The agent should come back on its own. That is the whole
point of the LaunchAgent, and it is an Agent rather than a Daemon because Core
Audio process taps only work inside a GUI login session and the microphone
permission is granted per user.

### 5. For role 3 only, the browser tap

macOS will prompt for audio recording permission the first time. Approve it in
System Settings, Privacy and Security, Screen and System Audio Recording.

Play the BPD feed in Chrome, then check the tap sees it:

```
"/Library/Application Support/BCC/bin/bcc-audiotap" --list
```

Tapping by app name takes the whole process family, not just the parent, because
Chrome renders a tab's audio in a helper process and the parent is silent. If a
name match still comes back with nothing, `--system` taps the whole output
device instead.

---

## Part three: prove the loop closed

From the dashboard:

- `/api/pipeline` should show the machine, its feeds, and a clip count that
  climbs.
- `/api/transcripts` should have text within a couple of minutes of the first
  transmission.
- Incidents should appear on the map once a transmission carries an address.

A feed showing clips arriving but `text=0` is usually not broken. A Broadcastify
channel with no traffic transmits true digital silence, measured at -91 dB, and
the gate correctly drops all of it. Boston Fire overnight looks exactly like a
dead feed. Watch it during a weekday afternoon before concluding anything.

---

## The other two Macs

Same package, same steps, two changes: a different role at the feed question,
and that machine's own token at the ingest question. Add the new token to
`INGEST_TOKENS` on Vercel and redeploy before you run setup, or the POSTs come
back 401.

---

## When something is wrong

**Nothing in the log and the agent is not running.** launchd only starts it at
login. `launchctl list | grep bcc` should show it. If it is absent, the
postinstall bootstrap did not take, and re-running the installer fixes it.

**The log says dependencies are missing and it exited.** Setup was never run, or
node is not on PATH. launchd hands a job `/usr/bin:/bin:/usr/sbin:/sbin` and
nothing else, so a Homebrew node at `/opt/homebrew/bin/node` is invisible unless
something prepends it. `bcc-run` does prepend it, so this usually means node is
genuinely not installed. `bcc-setup` will fix it.

**Every POST comes back 401.** The token on the Mac and the table on Vercel
disagree. `/api/status` confirms `INGEST_TOKENS` is present without showing it.
Delete `~/.bcc/.ingest_key` and re-run `bcc-setup` to retype it.

**The crowd layer is stuck at 503.** `BESTTIME_API_KEY_PRIVATE` is missing or
was rotated without updating Vercel. The rest of the map keeps working.

**Removing it all.**

```
bcc-uninstall           # agent, files, launchd job, receipt
bcc-uninstall --all     # also ~/.bcc
```

Both leave `~/.boston-control-center/.login` and the Whisper model cache alone.

---

## Still open after launch

- Kill the Fly app `boston-control-center`. It is still deployed and still
  billing.
- `DEPLOY.md` has a wrong `cd bcc-server` path and stale `bos` region
  references. `DISTRIBUTE.md` line 54 and lines 250 to 273 are also stale.
- Audio caching, so an editor can listen back to a transmission. You have asked
  for this three times and it has never been built.
- The BestTime email at `besttime-live-heatmap-inquiry.md` is written and not
  sent. Question one in it, whether they will expand live coverage for a named
  venue list, is the one that decides whether the Fenway case actually works.
- The `nba` connector in `src-events.js` returns 403 from cdn.nba.com.
- A/B whisper.cpp against faster-whisper on real scanner audio. The shipped
  package uses faster-whisper, so this is now a speed question rather than a
  blocker.
