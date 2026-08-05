# Ten design refreshes for the Boston Control Center

Written for newsrooms that are not yours. Everything below is ranked, and the ranking is by how hard a second desk would feel it on their first shift.

Before writing this I read the shipped code rather than working from memory, so where I describe what the dashboard does today, that is what the file does right now. References are to `app/index.html` and `api/cron/analyst.js` as they currently stand.

---

## 1. Story threads, so a jumper and the bag found afterward are one card

**Today.** The analyst returns a flat array of situations once a minute and the dashboard renders one card per entry. Nothing in the schema at `api/cron/analyst.js:20` lets one situation point at another. When somebody went into the water and their bag turned up on the walkway twenty minutes later, the model had two options and both were bad: fold the bag into the jumper card and lose the fact that a bag was found, or emit a second situation. It emitted a second situation, typed it as a suspicious package, and because that type is high priority, the red banner fired across the whole screen.

The schema is what failed there, before the model ever had a chance. There was no shape available for "related to, and downstream of."

**Build.** Give a situation an optional `thread` id and render a thread as one card with its events stacked underneath in time order, most recent on top. The card headline stays the story ("Person in the water off the Charles, search underway"), and the bag becomes a line inside it at 11px with its own timestamp. A producer reading the wall sees one story with three beats instead of three stories.

Two controls matter more than the automation: a human has to be able to drag one card onto another to merge them, and split a thread back apart when the analyst strung together two things that only sounded alike. Newsrooms will trust an imperfect thread they can fix. They will not trust a perfect one they cannot.

**Cost.** A day for the render and the merge control. The analyst side is a prompt change plus one field, and it gets much easier once item 2 is done.

---

## 2. Stable identity, which kills the duplicate cards and the repeat banner

**Today.** The analyst is asked to invent "a stable short id slug" for each situation, and falls back to `sit-<index>` when the model omits one (`api/cron/analyst.js:82`). A language model asked to reinvent a stable slug every sixty seconds will produce `tobin-jumper` on one pass and `jumper-tobin-bridge` on the next. The dashboard keys everything off that id. `sitState.byId` is rebuilt from it, and `sitState.seenHigh` is a Set of ids used to decide whether the full-screen banner has already fired for a story.

That is the mechanism behind both things you saw in that screenshot. The duplicate card is one story that arrived under two names. The banner firing again on something you had already read and dismissed is the same drift, hitting a Set that had no idea it was looking at a story it had already announced.

**Build.** Stop asking the model for identity. Derive it: hash the type, the geocoded cell and the hour, then match a new situation against the open ones by type plus distance plus time before deciding it is new. Anything within, say, 400 metres and 45 minutes of an open situation of the same type is an update to that situation and inherits its id.

**Cost.** Half a day, entirely server side, and it is the single highest ratio of newsroom pain removed to code written on this list. It also makes item 1 tractable, because threads need identities that hold still.

---

## 3. Confidence on the face of the card

**Today.** Every situation is rendered at identical visual weight. A working fire with three units confirming on tape and a half-heard "possible shots" from one garbled transmission produce the same card in the same type at the same size. The only gradient the design has is `priority`, which measures how bad it would be if true, and says nothing about whether it is.

For a desk that is deciding whether to send a truck, those are two different questions and only one of them is on screen.

**Build.** Add a `confidence` enum to the schema with three values: confirmed on tape, reported once, unclear. Render it as a small state on the card, and make the weakest tier visually quieter, dimmer text, no colour bar. Then make the rule explicit in the interface: an unclear situation never triggers the full-screen banner no matter how high its priority. Right now `pollSituations` fires the banner on any unseen high-priority item, and half-heard violence is exactly the category that is both high priority and most often wrong.

**Cost.** A few hours. One schema field, one prompt paragraph, one CSS class, one condition in the banner check.

---

## 4. A correction control that teaches, rather than only hides

**Today.** When the analyst gets one wrong, the only move available is Escape, which dismisses the banner for 22 seconds until the timer clears it anyway. The mistake stays on the board, the wrong classification stays in the payload, and the next pass has no idea a human disagreed.

**Build.** Three controls in the corner of every situation card: merge into another story, downgrade the priority, dismiss as noise. Write each action to a small KV log with the situation, the transcript window it came from, and who pressed it.

That log is worth more than the immediate fix. Feed the last twenty corrections into the analyst prompt as examples and the model stops making the same class of mistake on that scanner in that neighbourhood. It is the cheapest possible fine-tune, and it means every desk that uses the tool makes it better for the next one.

**Cost.** A day for the controls and the log. The feedback loop into the prompt is another half day and can come later.

---

## 5. Shift handoff, because nobody is watching the whole time

**Today.** The dashboard renders the present tense and nothing else. Someone coming back from lunch, or starting a shift at six, or opening the tab after a meeting, has to reconstruct the last two hours by scrolling the scanner feed. In practice they do not do that. They ask the person next to them, and in a small newsroom at 3am there is no person next to them.

**Build.** A marker for "I last looked at 09:14" held in memory for the session, and a compact panel that answers one question: what opened, escalated, or closed since then. Four or five lines, each a story rather than a transmission, each clickable to the thread. Put a small count on it so it announces itself the way the layer counts do.

This is the feature a second newsroom would notice first, because your desk has you watching it continuously and theirs will not.

**Cost.** A day. It needs the stable ids from item 2 to be honest about what actually opened.

---

## 6. One button that gets the story out of the tool

**Today.** Everything the dashboard knows dies inside the browser tab. To tell a reporter where to go, somebody retypes the address into Slack by hand, and the caveat does not survive the retyping, because the caveat was never text. It was a colour on a card.

For a single desk that is a small friction. For newsrooms plural it is the whole problem, because the value of the tool is what it causes people outside the room to do.

**Build.** A copy control on every situation and every thread that produces clean plain text: the headline, the location as geocoded, the time first heard, the source, and the confidence caveat attached in words rather than in colour. Something a producer can paste straight into Slack or a text message without editing, and without accidentally dropping the caveat on the way. Later this becomes a webhook per desk, but the clipboard version is worth shipping first and covers most of the value.

**Cost.** Two hours for the clipboard version.

---

## 7. Coverage area, so a Worcester desk is not reading Boston chatter

**Today.** The map filters by layer and never by geography. Every desk sees every situation in the feed, and situation cards are not filtered at all.

**Build.** Let a desk draw a box once, or pick towns from a list, and persist it. Everything then respects it: cards, banner, counts, and the outage layer that just went in. Something outside the area still draws on the map in a muted state, so a big fire two towns over is visible without shouting.

This is the change that turns one newsroom's dashboard into a product several newsrooms can run. It is also what makes the full-screen banner tolerable outside Boston, because a banner that fires for events 50 miles away gets ignored within a week, and a banner people ignore is worse than no banner.

**Cost.** A day and a half. The filter itself is easy; making every count and every panel respect it consistently is the work.

---

## 8. Three densities: wall, desk, phone

**Today.** One layout is doing three jobs. On the wall it is read from twelve feet, where the 10 and 11 pixel type in the feed rail is decoration. On a laptop it is a working tool. On a phone the banner kicker and headline are measurably clipped: at phone width the kicker renders 13 of the 26 it wants and the headline 42 of its 84. Both recover their full text through a `title` attribute, which is to say both recover only for someone holding a mouse.

**Build.** A three-way density control that changes real decisions rather than only font size. Wall drops the transcript feed entirely, shows four situation cards at large type, and keeps the map and the banner. Desk is today's layout. Phone drops the map to a strip, stacks the cards full width so nothing clips, and puts the whole headline on screen in place of a hover that a finger cannot reach.

**Cost.** Two days, and it retires a category of bug rather than fixing instances of it.

---

## 9. The layers panel as a status board

**Today.** Eleven rows, each with a count. It is honest and complete, and it asks the reader to notice on their own that 311 went from 40 to 400, or that the transit count has been zero for six minutes because the feed is stale. Nobody reads eleven numbers on a wall screen. They read the shape of the thing and look away.

**Build.** Keep the rows and add one line above them that says only what is abnormal, in words. "Power outages climbing, 9 communities" or "Transit feed stale 6 min" or, most of the time, "All feeds normal." Compute abnormal against the last hour of the same layer, so the threshold adapts instead of being a constant somebody has to tune per newsroom.

Give the line a colour only when something is wrong. A panel that is grey nearly all the time is a panel people believe when it turns amber.

**Cost.** Half a day, given that every count already flows through `layerCount`.

---

## 10. Cameras attached to the incident, not only to the map

**Today.** As of this build there are 306 MassDOT cameras on the map, clickable, refreshing every 20 seconds. Finding the right one still means knowing the geography well enough to hunt for the nearest pin, and the layer ships off by default precisely because 306 pins would bury the incidents.

**Build.** When a situation has coordinates, put the nearest two or three cameras in the card as small thumbnails with the distance under each. A producer hears about a crash on 93 and sees 93 without touching the map. That is the actual newsroom motion, and it is the difference between a camera layer people turn on once and a camera layer people use.

Distance alone is a rough proxy for usefulness, since a camera 200 metres away pointed the other direction shows nothing. Sort by distance to start, let people click through, and if it turns out to matter, add a bearing field later.

**Cost.** Half a day. The catalog is already in KV with coordinates on every entry, so this is a nearest-neighbour lookup and some markup.

---

## If you only do three

Do 2, then 1, then 5.

Item 2 is half a day and removes the duplicate cards and the repeat banner, which are the two failures most likely to make a new desk stop trusting the tool in week one. Item 1 is the thing you asked about directly, and it needs item 2 underneath it to work. Item 5 is the one that matters most for a newsroom that is not staffed the way yours is, because it assumes nobody was watching, which is true most of the hours of most days.

Items 3 and 4 are the cheapest pair on the list and they compound: confidence makes the analyst's uncertainty visible, corrections make it improvable, and together they turn the model from something a desk endures into something the desk trains.
