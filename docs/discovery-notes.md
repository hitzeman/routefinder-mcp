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

## Problem statement

When I plan a longer run, I spend ~10 minutes digging through Strava to remember
which routes are the right distance. The COROS MCP can find runs by distance but
only knows start points. Build an MCP tool that turns my past runs of a target
distance into a map of my distinct routes (e.g., "Route A: 7.1 mi, run 31
times, last run Mar 12") so I can pick one in seconds from my phone.

## Constraints

- Data only from the official COROS MCP (fallback: manual FIT export).
- Deterministic processing (parse, trim, simplify, group). No LLM in the data path.
- Privacy: trim ~0.25 mi from start/finish; never commit GPS data or coordinates.
- Cache parsed tracks; repeat requests make zero new FIT downloads.

## Open questions (resolve first)

1. Can my server fetch COROS FIT download URLs directly? Do the URLs expire?
2. Map rendering: Claude artifact from GeoJSON vs. my own hosted map page.
3. Grouping method and threshold (grid-cell overlap ~50m cells, ~80% match?).
   How to handle reversed loops and out-and-backs?

## Golden set: known ~7-mile routes

<!-- Nicknames only. No street names near home. -->

1. Apex loop
2. Clubhouse loop
