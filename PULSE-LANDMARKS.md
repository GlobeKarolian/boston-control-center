# Pulse Landmarks

The crowd heatmap layer (Pulse) shows typical venue occupancy from BestTime,
not live data. This file records the known gaps in that dataset.

## Missing venues

BestTime's venue index does not contain Fenway Park or TD Garden. The sweep
asked for every venue in the metro box ordered by reviews and they simply are
not there. What the layer shows on a game night is the bars and restaurants
AROUND the ballpark, not the ballpark itself.

## Why this matters

A reporter looking at the heatmap during a Red Sox game sees the bars on
Lansdowne Street lit up, but not the stadium. The stadium is the story, not
the bars. The layer is labelled "typical" rather than "live" for this reason.

## Workaround

None. The gap is in the source data. A live heatmap would require a different
provider (e.g., Google Popular Times, Foursquare, or direct camera feeds).
