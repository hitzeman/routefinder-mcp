# routefinder-mcp

An MCP server that turns past COROS activities into a map of the distinct routes you
actually repeat — "Route A: 7.1 mi, run 31 times, last run Mar 12" — so you can pick one
in seconds instead of digging through activity history.

COROS can already find activities by distance, but it exposes only a start point per
activity, and for a runner who leaves from the same door every day that start point is
effectively constant. The route information lives in the FIT file. This server reads it.

## How it fits together

The server holds **no COROS credentials**. COROS activity file URLs are anonymously
fetchable and never expire, so the credential boundary stays inside the official COROS
connector and Claude brokers the hand-off:

```
  Claude --> querySportRecords                      (free)      --> labelIds in band
  Claude --> queryActivityFitFileDownloadUrls x N   [METERED]   --> download URLs
  Claude --> ingest_activities(fitUrls)  --> this server --> object host (free bytes)
  Claude --> find_routes(targetMiles)    --> this server --> GeoJSON (no network)
  Claude --> renders the GeoJSON as a map artifact
```

## Setup

```bash
npm install
npm run build
npm test
```

Register the built server with your MCP client as a stdio server running
`node dist/src/index.js`.

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ROUTEFINDER_CACHE_DIR` | `.cache` in the repo | Where raw bytes and parsed tracks live |

## Claude-side orchestration

This is the part that is easy to get wrong and expensive to get wrong.

### Request URLs one `labelId` at a time

`queryActivityFitFileDownloadUrls` accepts either a single `labelId` + `sportType`, or a
date range. **Use the `labelId` form.** The date-range form has no distance filter, so it
returns whatever activities fall in the range and spends metered slots on activities you
do not want. One call per wanted activity is the only way to spend exactly N slots for N
activities.

### Exclude track-oval activities at the query layer

When selecting candidates with `querySportRecords`, pass only the outdoor and trail run
sport types and omit the track sport type:

```
sportTypeCodes: [100, 102]     // outdoor run, trail run - NOT 103 (track run)
minDistanceKm: 10.5
maxDistanceKm: 12.0
```

A lap workout on a 400 m oval lands in the right distance band but is not a route: it
would render as a dense blob and distort the overlap metric. Excluding it here costs
nothing. The server still guards against one reaching it, because this exclusion lives in
the caller and cannot be relied upon.

### The quota binds on URL discovery, not on bytes

Obtaining a download URL counts against the COROS daily FIT cap. Fetching the bytes from
the object host does not — it is free and unmetered. Two consequences:

- There is no cheap "collect URLs now, download later" strategy. The collection *is* the
  cost.
- Once an activity is cached, it is yours permanently. Re-parsing and re-querying issue
  zero requests, so iterate freely.

Spend the quota early in a working session. The cap is daily, and everything downstream
of a populated cache is free.

### URLs are secrets

A COROS activity URL is an unauthenticated bearer URL with no expiry and no revocation
path, so a leak is permanent. This server holds one in memory only for the duration of an
`ingest_activities` call: it is never written to the cache, to a cache filename, to a log,
or to an error message. Do not paste them into issues, commits, or anywhere retained.

## Tools

### `ingest_activities(fitUrls: string[])`

The only tool that makes network requests. Fetches, caches, and parses activity files.

- Validates every URL against an HTTPS + host + path-prefix allowlist before opening a
  socket; refuses redirects; caps response size; times out.
- Writes raw bytes **before** parsing, so a parser failure never costs another metered
  request to recover from.
- Already-cached activities are not re-fetched. A repeat call issues zero requests.
- Reports per-activity outcomes (`newly-cached`, `already-cached`, `unusable`, `failed`)
  so one bad activity never fails the batch. Activities are identified by index and cache
  digest, never by URL.

### `find_routes(targetMiles: number, toleranceMiles?: number)`

Groups previously ingested activities into distinct routes. **Reads the cache only and
makes zero network requests**, so it is free to call as often as you like.

```
find_routes({ targetMiles: 7 })
find_routes({ targetMiles: 7, toleranceMiles: 0.3 })   // default tolerance is 0.5
```

Returns a text summary plus structured content:

```
Found 4 distinct routes across 30 matching activities:
  Route A: 7.15 mi, run 15 times, last run 2026-03-12
  Route B: 7.02 mi, run 11 times, last run 2026-02-16
  Route C: 7.01 mi, run 3 times, last run 2025-12-04
  Route D: 7.35 mi, run 1 time, last run 2025-11-26
```

The structured content carries per-route statistics and a GeoJSON `FeatureCollection`,
one `LineString` feature per route, with `label`, `distanceMiles`, `runCount`,
`firstRunDate` and `lastRunDate` as feature properties. Geometry is the medoid run of the
group — the most typical shape, not the most recent — simplified with a bounded deviation
and capped in vertex count so the result fits in a context window.

Two empty cases are distinguished and neither is an error: `state: "empty-cache"` means
nothing has been ingested, `state: "no-match"` means nothing cached falls in the range.

### Rendering the map

Ask Claude to render the returned `geojson` as a map artifact. A Leaflet or MapLibre page
drawing each feature as a coloured polyline, labelled from `properties.label` and
`properties.runCount`, is enough — the GeoJSON is already simplified and small. Because
routes share a start point, give each feature a distinct colour rather than relying on
where it begins.

## Tuning

Grouping behaviour is configuration, not code. Defaults were chosen against a golden set
of known routes:

| Variable | Default | Effect |
| --- | --- | --- |
| `ROUTEFINDER_CELL_SIZE_M` | `75` | Grid cell size for the overlap metric |
| `ROUTEFINDER_SIMILARITY_THRESHOLD` | `0.35` | Jaccard overlap needed to call two runs the same route |
| `ROUTEFINDER_SIMPLIFY_TOLERANCE_M` | `10` | Maximum deviation of drawn geometry from the recorded track |
| `ROUTEFINDER_MAX_VERTICES` | `400` | Hard ceiling on vertices per route |
| `ROUTEFINDER_MIN_EXTENT_RATIO` | `0.05` | Below this extent-to-distance ratio a track is laps of a circuit, not a route |

Lower the threshold to merge more aggressively, raise it to split more readily.

## How grouping works

A route is reduced to the **set of grid cells it occupies**, and two runs are compared by
Jaccard overlap of those sets. Because a set has no order, the direction of travel is
invisible to the metric: a loop run backwards occupies the same cells and groups with its
forward runs automatically, with no special case. An out-and-back stays separate from a
loop of the same total distance because it covers roughly half the unique ground.

Clustering is union-find over pairs above the threshold. That is single-linkage, so it can
chain — `A~B` and `B~C` merges `A` with `C` even if those two are dissimilar. At this scale
and threshold that is acceptable; the golden set is the check on whether it bites.

## Privacy

Cached tracks contain full-resolution GPS covering your home. The cache directory is
gitignored and must stay that way. Coordinates never appear in logs. Nothing derived from
activity data belongs in the repository.
