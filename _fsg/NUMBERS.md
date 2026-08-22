# Where every number in the deck comes from

All figures are computed from one real pull of the vault: 16,075 transmissions,
Aug 18 04:19 ET to Aug 20 04:19 ET, fetched with `web/tools/vault-dump.js`
against the live archive. Anyone can reproduce them: the scripts live in
`web/tools/`, and the pull itself sits in `_qa/` (kept out of git because it is
raw police radio). Rerun the dump any night and I can refresh the deck in
minutes.

**16,075 transmissions · 107 towns · 99.9% with audio** — row count of the
pull; distinct `town` values; share of rows with a `clip` URL (16,069).

**Feed volumes (slide: it listens)** — rows per `feed`. Boston Police 6,796,
EMS 1,931, State Police 1,712, Cambridge PD 1,555, Needham/Brookline 1,033,
Boston Fire 962, MBTA 948, Cambridge Fire 419, MIT 414, Melrose Fire 264,
fenway-security 41.

**The East Boston row (slide: it writes everything down)** — a verbatim row,
`inc-msyo4wyn-149978`, chosen because it carries a full extraction and an
exact geocode. Nothing on the slide is edited except trimming.

**12,281 weak / 1,783 exact / 537 approx (slide: it figures out where)** —
counts of the `precision` field. Rows with no geo at all (1,470) and `wide`
(4) are omitted from the chips; "somewhere in Boston" describes the weak
grade's meaning, the town centroid.

**The Storrow thread (slide: it threads)** — four verbatim transmissions from
thread `inc-msy45wd4-144685`, timestamps converted to ET. "Zorro" is exactly
what the transcriber wrote; shown on purpose. The full thread holds 30 rows;
this store also welds some unrelated chatter onto busy overnight threads via
shared generic unit names, a known issue on the roadmap, which is why the
slide shows the four beats and not the raw thread.

**Peak 494 · trough 140 (rhythm chart)** — transmissions per hour in ET,
averaged across the two days (each bar = that hour's two-day total ÷ 2).

**r = 0.86 (rhythm chart)** — Pearson correlation between the two days'
24-hour curves, excluding hours 8, 9, and 10 PM, which a relay outage
(Tue 8:16–10:45 PM, 149 minutes, all feeds silent) partially zeroed. With the
outage hours included, r = 0.55; the exclusion and the outage are both stated
on the slide.

**14 minutes (city-says slide)** — the longest gap between any two
consecutive transmissions across all feeds in the whole pull, outside the
outage (841 seconds, around 5 AM).

**Call-type bars (city-says slide)** — counts of the `callType` field.
1,721 of 16,075 rows carry one; the slide's subtitle says so. Medical 682,
alarm 278, investigation 173, MVA 97, traffic stop 71, fire 71, medical-
serious 61, assault 45, disturbance 36, fire alarm 32.

**0.31% tier 3 (city-says slide)** — 50 rows with `tier ≥ 3` out of 16,075.
Tier is the extractor's severity grade (weapons, wounds, working fires,
escalations).

**State St 73× (compounds: recurrence)** — most-repeated `matched` geocode
among exact/approx rows, Fenway excluded. Caveat known and accepted: "State,
Boston" also catches "state police" garbles, which is itself a recurrence
finding; Boston Medical Center is second at 57.

**BOS 7.4 · CAM 5.5 min (compounds: radio gap)** — per incident: first
dispatch-role transmission to first later field-role transmission, medians by
feed family, gaps over 60 min discarded. Boston n=112, Cambridge n=25,
Needham/Brookline 5.5 n=26, State 4.8 n=15, MBTA 8.0 n=11. This is a radio
gap, not an official response time, and the deck says "radio gap."

**BMC 65 mentions (compounds: hospital flows)** — substring count of hospital
names in transmission text: BMC/Boston Medical 65, Brigham 24, Faulkner 17,
MGH/Mass General 15, Mount Auburn 14, Children's 7. 65 > 24+17+15 = 56, hence
"more than the next three combined."

**A1 372 (compounds: workload)** — transmissions carrying unit tag A1. Next:
C3 227, L4 160, R1 129, E3 111.

**Fenway 41 / 34-of-34 (venue slide notes)** — fenway-security rows; every
row with coordinates sits at 42.3466, -71.0973 (the park's anchor), precision
exact; 7 rows said nothing placeable and carry no pin at all.

**~2.9M a year** — 16,075 ÷ 2 × 365, straight-line. Labeled "at today's
pace."
