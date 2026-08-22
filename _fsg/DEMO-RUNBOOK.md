# FSG demo runbook

## Tonight, in order

**1. Deploy. Nothing in the demo works without this.** The live site is still running pre-rework code, including the City Hall dot rings you flagged.

```
cd ~/Developer/bcc
rm -f .git/index.lock
git add web ios
git commit -m "centroid pin fix, listen live wall, iOS app"
cd web && npm run deploy
```

Then hard-refresh scan.boston (Cmd-Shift-R) and confirm three things: the ring of dots at Court St / Government Center is gone; the AUDIO tab now opens with LISTEN LIVE · THE WALL at the top; the SHIFT tab loads a last-10-hours briefing.

**2. Rehearse the archive searches against live data.** The deck promises English search, so the queries you type tomorrow must be ones you tested tonight. Try these and keep the two that return the best cards:

- `stabbing last night`
- `fires yesterday`
- `pursuit yesterday`
- `anything at fenway park`

Results depend on what was actually on the air in the last two days. If one comes back thin, open the SHIFT tab, see what genuinely happened tonight, and search for that instead. Never type an untested query in the room.

**3. Test the desk.** Ask `what were the biggest calls tonight?` once. It takes 20 to 30 seconds; decide tonight whether you like the answer enough to do it live or would rather talk over the archive instead.

**4. Rebuild the phone.** Open `ios/BCC.xcodeproj`, Run onto your iPhone (v3 has the Listen tab). Sign in, confirm the map draws, then turn OFF wifi and confirm Listen still plays a stream on cellular. Set Do Not Disturb for tomorrow.

**5. Take 4 backup screenshots** in case the room's network dies, and park them at the end of the PowerPoint:

- The map with a real active cluster (MAP tab, whatever is live)
- One archive result card with its matched lines (from your best rehearsed query)
- The SHIFT briefing, top of page
- The AUDIO tab with two feeds ON AIR

## The demo, ~8 minutes, in this order

1. **The wall** (MAP): let it sit for 10 seconds, point at a dot, click it, play one clip. One clip is worth the whole architecture section.
2. **Listen** (AUDIO tab): switch on boston-police, then add fenway-security on top. Two streams at once is the "wall of scanners" moment.
3. **The archive**: type your rehearsed query. Open the top card, show matched lines vs. scene context, hit the chain play button.
4. **Shift change**: scroll it. Say "this is what a security lead would sit down to."
5. **The phone**: hand it to whoever seems most senior, tell them to tap a dot.

## Fallbacks

- Room wifi dies: iPhone hotspot, and the HTML deck (`BCC-for-FSG.html`) is fully self-contained, arrow keys advance, N toggles your notes, F for fullscreen.
- Login prompt appears: your creds, same as the dashboard.
- A search underwhelms live: "it reads about fifty thousand transmissions for a question like this" and move to the next beat. Numbers cover silences.
- Someone asks where the numbers in the deck come from: a real 48-hour pull, Aug 18 to 20, reproducible with `node tools/vault-dump.js` and `tools/archive-replay.js` in the repo.

## Care in the room

Everything on screen is machine-transcribed police radio with real addresses in it, and the UNVERIFIED banner is doing legal work. Keep the raw wire off the projector except in passing, and skip clip playback on anything involving a named person. The Fenway lines in the deck ("I have your water bottle") were picked because they are harmless; stay in that register when improvising.
