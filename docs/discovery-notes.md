# Discovery Notes: routefinder-mcp

## Context

Interview-prep prototype run as a compressed R&D cycle
(discovery → spec → build → evaluate → proceed/stop).
Timebox: Thu 10/29 – Sun 11/1. Single user (me).

## Discovery log

### 1. Original idea: Strava run classifier (stopped)

- Plan was to rebuild a Strava webhook app that classifies runs with an LLM.
- Strava API Policy (effective June 1, 2026) Section 5.3 prohibits using Strava
  data in any AI application, including ingestion into a context window. There is
  no personal-use exception.
- A Google AI Overview claimed personal use was fine. Verified against the
  primary source; the overview was wrong.
- Decision: Strava API out of scope.

### 2. Pivot: COROS official MCP server

- COROS provides an official MCP server (https://mcp.coros.com/mcp) explicitly
  for AI use of an athlete's own data.
- Connected to Claude: 26 read-only tools, 8 write tools (create/schedule workouts).
- Constraint: detailed FIT file access limited to 50 requests/day.
- Write tools set to "Needs approval" (human in the loop).

### 3. Baseline test (Claude + COROS MCP, no custom code)

- Weekly mileage remaining: correct.
- Daniels 20-min T workout for VDOT 51: correct paces (4:11/km), correct
  400m splits; created and synced to watch successfully.
- Failure: estimated the workout at ~4 mi; actual ~5.5–6 mi (mental arithmetic).
- Gap: COROS stores start points only, so "what are my usual 7-mile routes?"
  cannot be answered with paths or a map.
- Decision: mileage and workout-creation features are adequately served by the
  existing connector. Do not build them.

### 4. FIT access probe (2026-10-29) — resolves open question 1

Probed one real activity end to end. Findings:

- `queryActivityFitFileDownloadUrls` returns plain-text download URLs.
- The URLs are **not pre-signed**. No query string, no signature, no `Expires`,
  no token parameter. Shape is:
  `https://<coros-object-host>/fit/v2/<athlete-id>/<file-id>_<md5-tail>.fit`
- The filename's trailing digest is the tail of the object's own MD5 (verified:
  local md5 of the downloaded bytes matched the `ETag` exactly). The URL is
  therefore **content-addressed** — a pure function of the file bytes, with no
  issue time and nothing to rotate.
- Verified from a client holding **zero COROS credentials**:

  | Probe                                | Result                         |
  |--------------------------------------|--------------------------------|
  | anonymous `HEAD`                     | 200, `Content-Length` 102,200  |
  | anonymous `GET`                      | 200, valid FIT v2.0, 102,200 B |
  | `GET` with a garbage `Authorization` | 200 — header ignored           |
  | repeat `GET`, fresh connection       | 200, identical                 |
  | signature / `Expires` / TTL          | none present                   |

- Object is public-read, CloudFront-fronted. Response headers include
  `Accept-Ranges: bytes`.
- Declared FIT data size + header + CRC matched `Content-Length` exactly; the file
  is intact. ~41 bytes/record over a ~2,470 s run at 1 Hz, consistent with
  positional data being present (a GPS-less record would be ~15–20 B).

**Answer to Q1: yes, the server can fetch FIT bytes directly, and the URLs do
not expire.**

Consequences:

- **The server needs no COROS credentials.** Claude brokers: it calls the COROS
  connector for URLs, passes them to a routefinder tool, and the server fetches
  bytes over anonymous HTTPS. No second OAuth client, no token storage, no
  refresh, no write scopes. The credential boundary stays inside the official
  connector.
- **The daily cap binds on URL discovery, not on bytes.** Per the tool's own
  description, returned URLs count against the same daily FIT limit as downloads.
  Fetching bytes from the object host is free and unmetered. So there is no cheap
  "harvest URLs now, download later" strategy — the harvest is the cost.
- **Once cached, an activity is permanently owned.** Re-parsing costs nothing and
  makes no new requests, satisfying the zero-new-download requirement for repeat
  queries.
- Because the server fetches a URL supplied by a model, the fetch is an SSRF
  surface. Pin the expected host and path prefix, refuse redirects, cap body
  size, and set timeouts.

### 5. Start points are unusable as a route key (2026-10-29)

- Queried the 10.5–12 km band (≈7 mi) over the prior two years: **80 activities**.
  This query costs no FIT quota.
- Start coordinates are quantized to ~3 decimal places (~111 m) and stored at
  float32 precision. The same physical driveway appears under two different
  quantized values across records.
- Of the 80 activities, **64 share one identical start value** (home), 10 start at
  the track, and 6 start elsewhere — about seven buckets with 80% in one.
- This is stronger than "COROS stores start points only": the start point is not
  merely insufficient, it is near-constant. Confirms the premise.
- Distance alone also fails to separate routes: the same ~11.28–11.34 km figure
  recurs across activities labelled "Easy", "Tempo (3 x 10 mins)", and
  "4 mile tempo" — plausibly one loop at different efforts. Recovering that
  distinction is exactly the tool's job.

### 6. Lap data carries no geometry (2026-10-29) — grouping stays on FIT

Tested the idea of grouping routes from `queryActivityLapData` (which costs no FIT
quota) and then downloading only one FIT per distinct route, purely to draw the map.

**Result: no coordinates are available.** The response carries a `columns` array
enumerating every field for the sport type. All 25 are physiological or kinematic:

```
lapIndex  distance  time  totalLength  avgPace  avgSpeedV2  vertSpeed
avgPower  avgHr  maxHr  groundTime  groundBalance  avgCadence  maxCadence
strideRatio  strideHeight  avgStrideLength  formPower  legStiffness
elevGain  totalDescent  bodyTemperature  adjustedPace
groundReactionForce  groundContactAngle
```

No lat/lon/position field appears — absent from the schema, not merely empty.
Because `columns` is the field list for the *sport type* rather than for one
activity, this is a schema-level negative and not a one-activity fluke. The call
itself is free (no FIT quota).

The elevation fallback was also considered and rejected. The only
route-intrinsic signal present is `elevGain`/`totalDescent` per auto-lap.
Elevation-profile matching is a real technique, and the 1-mile auto-laps align
from the activity start, so the same route should yield a comparable sequence.
It is too weak here:

- The terrain is flat. One in-range run (2026-03-12) totals 46 m of gain over
  11.7 km, with per-mile values as integer metres in a 0–14 range. There is very
  little entropy to fingerprint on.
- That run is a loop returning home, yet reports 46 m of gain against 30 m of
  descent. The 16 m gap is unresolved barometric/GPS drift — roughly 35% of the
  entire signal, on a single run. Run to run, that noise is comparable to the
  real differences between routes.

**Decision: grouping stays on FIT geometry.** Signal quality aside, the v1
scoping decision already removes the motive. 30 files clear the daily cap in one
pass and then cache forever, so lap-based grouping would save ~26 metered slots
out of a budget that is not scarce — and would pay for it by putting the weakest
available signal in charge of the product's most important decision. Grouping is
the product ("run 31 times" is a headline number); mis-grouping merges two routes
or splits one, which is the exact failure this tool exists to prevent. A FIT is
needed per distinct route for rendering regardless, so grouping from real
geometry reuses bytes that are already downloaded and parsed, at zero marginal
cost.

Byproducts worth keeping:

- Lap data is free and does provide per-mile splits plus hilliness. Useless for
  route *identity*, but a good later enrichment for a route that already exists
  (e.g. "7.1 mi, 46 m gain, usually ~5:45/km").
- Parser traps, should lap data ever be consumed:
  - The response contains four overlapping `lapGroups` — 1-mile auto-lap, a
    near-duplicate 1-mile variant, 5-mile, and a whole-activity summary. A naive
    reader double-counts.
  - Column labels come back localized (Chinese). Field *names* are the contract;
    never match on label text.
  - Units are non-obvious: distance in cm, `avgPace` in s/km, `avgSpeedV2` in
    km/h × 100, and `totalLength` is cumulative *time*, not distance.

## Problem statement

When I plan a longer run, I spend ~10 minutes digging through Strava to remember
which routes are the right distance. The COROS MCP can find runs by distance but
only knows start points. Build an MCP tool that turns my past runs of a target
distance into a map of my distinct routes (e.g., "Route A: 7.1 mi, run 31
times, last run Mar 12") so I can pick one in seconds from my phone.

## Scope decisions (v1)

- **Corpus: the most recent ~30 in-range runs.** Full historical backfill is out
  of scope. Walking back from newest in the 10.5–12 km band and dropping track
  runs yields 30 activities spanning 2025-10-08 … 2026-03-12 (32 scanned, 2
  excluded). At max 10 files per call that is 3–4 calls, which fits inside one
  day's quota under either reading of the 50/day cap, so the cap is not a v1
  blocker.
- **Track runs excluded.** A lap workout on a 400 m oval lands in the right
  distance band but is not a "route" in the sense above; it would render as a
  dense blob and distort any overlap metric. Exclusion rule: drop COROS
  sportType 103. The rule is imperfect — at least one lap session is recorded as
  sportType 100 but starts at the track. It falls outside the 30-run window, so
  this does not matter for v1.
- Nothing ≥10.5 km has been run since 2026-03-12, so the corpus is ~7 months
  stale. Harmless for route discovery (routes do not move), but the demo's
  "last run" dates will all be historical.

## Constraints

- Data only from the official COROS MCP (fallback: manual FIT export).
- Deterministic processing (parse, trim, simplify, group). No LLM in the data path.
- **FIT download URLs are unauthenticated bearer URLs and must be treated as
  secrets.** Anyone holding one can fetch the full raw activity, including
  complete GPS, with no credentials. They carry no expiry and cannot be revoked
  or rotated, so a leak is permanent. Never commit them, never log them, never
  paste them into issues, tickets, or prompts that get stored. Keep them out of
  any cache key that gets committed, and out of error messages.
- **Persist the parsed track, never the URL.** Treat a FIT URL as transient even
  though it never expires. The temptation runs the other way — re-obtaining a URL
  costs quota, so caching it looks thrifty — but the cheap artifact and the safe
  artifact are the same one: the parsed track. Caching tracks already satisfies
  the zero-new-download requirement, so persisting a permanent, unrevocable
  bearer secret buys nothing and adds a liability.
- Never commit GPS data, coordinates, athlete IDs, or FIT file IDs to the repo.
- **Start/finish trimming is dropped for now** (2026-10-29 decision). The map may
  render the full route, including the start point at home. Reversible — the trim
  can be reinstated as a rendering-time option later.

## Open questions

1. ~~Can my server fetch COROS FIT download URLs directly? Do the URLs expire?~~
   **Resolved 2026-10-29** — yes, anonymously; no expiry. See discovery log §4.
   - 1a. Is the 50/day cap counted in files or in requests? **Not blocking for
     v1** — the 30-run corpus fits either way. Resolve only if backfill returns to
     scope. Prefer finding this in COROS documentation; probing it by brute force
     costs a build day.
   - 1b. ~~Is GPS precision inside the FIT full-resolution, or quantized like the
     summary metadata?~~ **Resolved 2026-10-29 — full resolution.** The spike was
     deliberately skipped and the question was answered for free by the first
     parser, as planned. Measured on the real activity file:
     - Positions decode as integer sint32 semicircles. The **GCD of all
       consecutive coordinate deltas is exactly 1 semicircle**, i.e. 180/2^31
       degrees ≈ **0.93 cm**. Values sit on no coarser grid.
     - Smallest non-zero step between consecutive points: 0.009 m. Median step:
       1.08 m, consistent with 1 Hz running.
     - Had COROS rounded to 3 decimal places inside the file, the quantum would
       have been ~11,930 semicircles (~111 m). It is 1.
     - Conclusion: the ~111 m rounding seen in `querySportRecords` is a
       formatting artifact of that summary API, not a property of the data. A
       ~50 m grouping cell sits roughly 5,400× above the coordinate noise floor,
       so the Q3 threshold is unconstrained by precision.
     - Locked in by a regression test asserting the observed step stays below
       5 cm and that cell size exceeds it by more than 100×.
   - 1c. Are track runs in scope? **Resolved** — excluded. See Scope decisions.
2. Map rendering: Claude artifact from GeoJSON vs. my own hosted map page.
3. Grouping method and threshold (grid-cell overlap ~50m cells, ~80% match?).
   How to handle reversed loops and out-and-backs? Partly gated on Q1b's
   precision answer, which arrives with the first parser. Grouping from lap
   points was evaluated and rejected — see discovery log §6.

## Golden set: known ~7-mile routes

<!-- Nicknames only. No street names near home. -->

1. Apex loop
2. Clubhouse loop
