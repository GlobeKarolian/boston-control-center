# The Mac agent, packaged

Builds `BCC-Agent-<version>.pkg`, a macOS installer that puts the scanner agent
on a Mac and starts it at login. Audio is pulled, transcribed and discarded on
that machine. Only text goes to the dashboard.

## Build it

```
cd agent/pkg
./build.sh --rebuild-tap
```

Output lands in `build/`. The `--rebuild-tap` flag recompiles `bcc-audiotap` as
a universal binary, which takes about thirty seconds and is worth doing whenever
any Mac in the fleet might be Intel. Without it the build reuses whatever binary
is in `agent/audiotap/`, which today is arm64 only.

`BCC_VERSION=1.1 ./build.sh` overrides the version.

## Install it

Double click the pkg, or run the `installer` command that `build.sh` prints when
it finishes.

Then, in Terminal, as yourself and not as root:

```
bcc-setup
```

That second command is the one that matters. The installer runs as root, and
everything left to do refuses to be done that way: Homebrew will not run as
root, the python environment and the whisper model belong to a user account
rather than to the machine, and someone has to answer which feeds this Mac
should carry. So the pkg lays down files and `bcc-setup` does the rest.

## About signing

The build is unsigned and works unsigned. macOS asks the person installing to
approve it once, under System Settings, Privacy and Security, and that is the
entire cost.

Signing turns itself on when the certificates exist and stays off when they do
not. `build.sh` looks for a Developer ID Application certificate to sign
`bcc-audiotap` with, and a Developer ID Installer certificate to sign the pkg
with. Finding neither, it ad-hoc signs the binary and ships the pkg unsigned,
which is the current state. Set `BCC_NOTARY_PROFILE` to also notarize, which
only works once a real Developer ID exists.

The one visible cost of ad-hoc signing is that the code hash changes on every
build, so macOS asks for audio recording permission again after each update.

## What gets installed

```
/Library/Application Support/BCC/bin/
    bcc-run              launchd entry point, gates on the doctor
    bcc-doctor           reports what is missing, by name, with the fix
    bcc-setup            interactive first run, the user runs this
    bcc-uninstall        removes it
    bcc-agent.js         the supervisor
    stt.py               resident whisper process
    bcc-audiotap         Core Audio process tap, for browser audio
    config.example.json

/Library/LaunchAgents/com.bostonglobe.bcc-agent.plist
/usr/local/bin/          symlinks for bcc-doctor, bcc-setup, bcc-uninstall
~/.bcc/                  config, ingest key, venv, logs, status
```

Nothing else on the machine is touched.

## Two decisions worth knowing

**A LaunchAgent, not a LaunchDaemon.** Core Audio process taps only work inside
a GUI login session, and the permission grant that authorises one is attached to
a user rather than to the machine. A daemon would start at boot with no session,
capture nothing, and report success while doing it.

**`bcc-run` exits 0 when dependencies are missing.** `KeepAlive` is set to
`SuccessfulExit: false`, so launchd restarts the job on failure and leaves it
alone on a clean exit. A Mac with no node installed is a state to report rather
than a crash to recover from, so `bcc-run` logs what is missing and exits
successfully. Exiting non-zero there would spin launchd forever at thirty
seconds a turn, writing the same error until the log filled the disk.

## Checking a machine

```
bcc-doctor                   what works, what does not, and the fix for each
tail -f ~/.bcc/agent.log     watch it run
cat ~/.bcc/status.json       written every five seconds
/tmp/bcc-install-report.txt  the doctor's output from install time
```

`bcc-doctor` exits non-zero when anything required is missing, so it is safe to
use in a script. `--quiet` prints only failures, `--json` prints machine
readable output.

## Feed assignment

Feeds are assigned by hand, one role per machine, chosen during `bcc-setup`:

1. Boston Fire and Boston EMS
2. Cambridge and Mass State Police
3. Boston Police, captured out of a browser tab
4. all four scanner feeds, no browser tap

Role 3 is the one that needs the audio permission prompt answered. Leave the BPD
feed playing in Chrome and say yes when macOS asks.

## Testing without installing

```
node ../supervisor/bcc-agent.js --config /path/to/config.json --dry-run --seconds 45
```

Transcribes live audio, posts nothing, prints what it would have sent, then
exits. A healthy run shows each transmission once and a `would POST` line for
each batch. A feed with no traffic on it will show clips arriving and every one
of them gated, because a silent Broadcastify feed transmits true digital silence
rather than nothing at all.

## Removing it

```
bcc-uninstall          keeps your config and logs
bcc-uninstall --all    removes those too
```

Broadcastify credentials in `~/.boston-control-center/.login` and the cached
whisper model are left alone either way.
