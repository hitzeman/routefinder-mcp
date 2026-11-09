# routefinder-mcp

[![CI](https://github.com/hitzeman/routefinder-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/hitzeman/routefinder-mcp/actions/workflows/ci.yml)

An MCP server that turns your past COROS runs into a map of the distinct routes you
actually repeat: "Route A: 7.1 mi, run 31 times, last run Mar 12". It reads GPS from the
activity FIT files, groups runs by the ground they cover, and returns GeoJSON that
Claude renders as a map.

It is also a worked example of an agent harness: see [HARNESS.md](HARNESS.md) for the
instruction files, hooks, skills, and tests an agent must pass before a human reviews a diff.

## Why

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

The server also sends this workflow to the client as MCP `instructions`.

## Install

Requires Node 22 or later. Not published to npm; run it from a clone.

```bash
git clone https://github.com/hitzeman/routefinder-mcp.git
cd routefinder-mcp
npm ci
npm run build
```

You also need the official COROS connector enabled in the same Claude client, so Claude
can fetch the download URLs.

### Claude Code

Project-scoped `.mcp.json` (or `~/.claude.json` for user scope):

```json
{
  "mcpServers": {
    "routefinder": {
      "command": "node",
      "args": ["/absolute/path/to/routefinder-mcp/dist/src/index.js"],
      "env": { "ROUTEFINDER_CACHE_DIR": "/absolute/path/to/routefinder-cache" }
    }
  }
}
```

Or from the command line:

```bash
claude mcp add routefinder -e ROUTEFINDER_CACHE_DIR=/absolute/path/to/routefinder-cache -- node /absolute/path/to/routefinder-mcp/dist/src/index.js
```

### Claude Desktop

`claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "routefinder": {
      "command": "node",
      "args": ["/absolute/path/to/routefinder-mcp/dist/src/index.js"],
      "env": { "ROUTEFINDER_CACHE_DIR": "/absolute/path/to/routefinder-cache" }
    }
  }
}
```

Restart the client after editing.

## Configuration

No variable is required. All are validated at startup: an out-of-range value stops the
server with a message naming the variable, instead of silently producing wrong groupings.

| Variable | Default | Range | Purpose |
| --- | --- | --- | --- |
| `ROUTEFINDER_CACHE_DIR` | `.cache` in the clone | path | Where raw FIT bytes and parsed tracks live. **Contains GPS around your home.** |
| `ROUTEFINDER_CELL_SIZE_M` | `75` | 5–1000 | Grid cell size for the overlap metric |
| `ROUTEFINDER_SIMILARITY_THRESHOLD` | `0.35` | 0.01–1 | Jaccard overlap needed to call two runs the same route |
| `ROUTEFINDER_SIMPLIFY_TOLERANCE_M` | `10` | 0–1000 | Max deviation of drawn geometry from the recorded track |
| `ROUTEFINDER_MAX_VERTICES` | `400` | 2–10000 | Hard ceiling on vertices per route |
| `ROUTEFINDER_MIN_EXTENT_RATIO` | `0.05` | 0–1 | Below this extent-to-distance ratio a track is laps of a circuit, not a route |
| `ROUTEFINDER_INGEST_CONCURRENCY` | `4` | 1–16 | Downloads in flight at once |
| `ROUTEFINDER_INGEST_DEADLINE_MS` | `45000` | 1000–600000 | Time budget for one `ingest_activities` call |
| `ROUTEFINDER_FETCH_TIMEOUT_MS` | `15000` | 500–120000 | Timeout for a single download |

No credentials or API keys are used.

## Tools

### `ingest_activities`

Downloads, caches, and parses activity files. **The only tool that makes network requests.**

| Parameter | Type | Bounds |
| --- | --- | --- |
| `fitUrls` | `string[]` | 1–50 items, each 1–2048 chars |

```json
{ "name": "ingest_activities",
  "arguments": { "fitUrls": ["https://s3.coros.com/fit/v2/athlete-9f3c21/x_deadbeefcafe.fit"] } }
```

- Fetches only `https://s3.coros.com/fit/...`. Anything else fails without a request.
  Redirects are refused, responses are capped at 8 MB, each download times out.
- Writes raw bytes **before** parsing, so a parser failure never costs another metered request.
- Already-cached activities are not re-fetched. A repeat call issues zero requests.
- One retry on 408/429/5xx or a network error, honouring `Retry-After` up to 5 s. Retries
  cost no COROS quota: the quota is spent when the URL is obtained, not when bytes are fetched.
- Runs 4 downloads at a time under a 45 s budget. If the budget runs out the result has
  `deadlineReached: true` and the remaining items come back `skipped` / `retryable`; call
  again with the same URLs to finish.
- Each activity gets an outcome: `newly-cached`, `already-cached`, `unusable`, `failed`,
  or `skipped`, plus `reason` and `retryable` where relevant. Activities are identified by
  index and cache digest, never by URL.

### `find_routes`

Groups previously ingested activities into distinct routes. **Reads the cache only and
makes zero network requests**, so it is free to call as often as you like.

| Parameter | Type | Bounds |
| --- | --- | --- |
| `targetMiles` | number | 0.5–100 |
| `toleranceMiles` | number | > 0, ≤ 5, default 0.5 |

```json
{ "name": "find_routes", "arguments": { "targetMiles": 7 } }
{ "name": "find_routes", "arguments": { "targetMiles": 7, "toleranceMiles": 0.3 } }
```

Returns a text summary plus `structuredContent`:

<!-- TODO(Todd): confirm this is real output from your cache; if not, mark it "illustrative". -->
```
Found 4 distinct routes across 30 matching activities:
  Route A: 7.15 mi, run 15 times, last run 2026-03-12
  Route B: 7.02 mi, run 11 times, last run 2026-02-16
  Route C: 7.01 mi, run 3 times, last run 2025-12-04
  Route D: 7.35 mi, run 1 time, last run 2025-11-26
```

`structuredContent` holds `state`, counts (`consideredCount`, `cachedCount`,
`excludedCount`, `unreadableCount`), per-route statistics, and a GeoJSON
`FeatureCollection` with one `LineString` per route (`[longitude, latitude]` order) and
`label`, `distanceMiles`, `runCount`, `firstRunDate`, `lastRunDate` as properties.
Geometry is the medoid run of the group (the most typical shape, not the most recent),
simplified with bounded deviation and capped in vertex count so it fits in a context window.

`state: "empty-cache"` (nothing ingested) and `state: "no-match"` (nothing in range) are
normal results, not errors.

### Errors

Both tools publish an `outputSchema` and the server validates results against it.

- **Invalid arguments** (missing, wrong type, out of range, unknown parameter) are
  rejected by the MCP SDK before the handler runs: `isError: true` with text such as
  `Input validation error: ... Too big: expected number to be <=100 at targetMiles`.
- **Tool failures** return `isError: true` with a JSON body in the text content:
  `{"error": {"code": "cache_unavailable", "message": "...", "retryable": false}}`.
  Codes: `cache_unavailable` (fix `ROUTEFINDER_CACHE_DIR`), `internal_error` (a bug).
  The body is not in `structuredContent` because clients check that against `outputSchema`.
- **Per-activity problems** in `ingest_activities` are not tool errors: the batch succeeds
  and each outcome carries its own `reason` and `retryable`.

## Claude-side orchestration

This is the part that is easy to get wrong and expensive to get wrong.

### Request URLs one `labelId` at a time

`queryActivityFitFileDownloadUrls` accepts either a single `labelId` + `sportType`, or a
date range. **Use the `labelId` form.** The date-range form has no distance filter, so it
returns whatever activities fall in the range and spends metered slots on activities you
do not want.

### Exclude track-oval activities at the query layer

When selecting candidates with `querySportRecords`, pass only the outdoor and trail run
sport types and omit the track sport type:

```
sportTypeCodes: [100, 102]     // outdoor run, trail run - NOT 103 (track run)
minDistanceKm: 10.5
maxDistanceKm: 12.0
```

A lap workout on a 400 m oval lands in the right distance band but is not a route. The
server also excludes such tracks by their extent-to-distance ratio, because this
exclusion lives in the caller and cannot be relied upon.

### The quota binds on URL discovery, not on bytes

The COROS connector's tool guide states that file downloads and download links share a
quota of **50 files per user per 24 hours**. Fetching the bytes from the object host does
not count. So there is no cheap "collect URLs now, download later" strategy, and once an
activity is cached, re-parsing and re-querying cost nothing.

### URLs are secrets

A COROS activity URL is an unauthenticated bearer URL with no expiry and no revocation
path, so a leak is permanent. This server holds one in memory only for the duration of an
`ingest_activities` call: it is never written to the cache, a cache filename, a log, an
error message, or a tool result. A leak test enforces this. Do not paste them into
issues, commits, or anywhere retained.

### Rendering the map

Ask Claude to render the returned `geojson` as a map artifact. A Leaflet or MapLibre page
drawing each feature as a coloured polyline, labelled from `properties.label` and
`properties.runCount`, is enough. Because routes share a start point, give each feature a
distinct colour rather than relying on where it begins.

## How grouping works

A route is reduced to the **set of grid cells it occupies**, and two runs are compared by
Jaccard overlap of those sets. Because a set has no order, direction of travel is
invisible to the metric: a loop run backwards groups with its forward runs with no special
case. An out-and-back stays separate from a loop of the same total distance because it
covers roughly half the unique ground.

Clustering is union-find over pairs above the threshold. That is single-linkage, so it can
chain: `A~B` and `B~C` merges `A` with `C` even if those two are dissimilar.

## Development

```bash
npm run check       # lint + strict typecheck + all tests
npm run audit       # dependency audit, fails on high+
npm run test:coverage
```

Tests run on Node's built-in `node:test` against compiled output and never touch the
network: unit tests for the geometry and fetch layers, contract tests per tool, an
in-process MCP client integration test, a stdio smoke test of the built binary, and
tests for the Claude Code hooks. See [AGENTS.md](AGENTS.md) for contributor rules.

## Limitations

- **Accuracy is not yet signed off.** The acceptance check against the author's golden
  set of known routes (OpenSpec task 7.1) is still open. Grouping defaults were measured
  on one runner's ~30 runs in one area; other terrain or GPS quality may need tuning.
- **Single user, local, stdio only.** No HTTP transport, no multi-user isolation.
- **Depends on Claude orchestrating the COROS connector** to obtain URLs, and on the
  COROS quota of 50 files per 24 hours. The server cannot discover activities itself.
- **Maps show the start point.** Start/finish trimming is not implemented, so a rendered
  route begins at your door. Think before sharing a map artifact.
- **Single-linkage clustering can chain** distinct-but-overlapping routes into one group.
- **Labels wrap after 26 routes** ("Route A" … "Route Z", then "Route A" again).
- **Activities without GPS** (treadmill, indoor) are reported `unusable`.
- **The default cache lives inside the clone.** Set `ROUTEFINDER_CACHE_DIR` if you want it elsewhere.
- **Tested on Linux only** (CI runs Ubuntu on Node 22 and 24).

## Third-party terms

- **COROS.** Data comes from your own account via the official COROS MCP connector, which
  documents `queryActivityFitFileDownloadUrls` for clients that download FIT files from
  the returned links. Use is subject to the [COROS Terms of Service](https://coros.com/terms)
  and [Privacy Policy](https://coros.com/privacy). This project is not affiliated with or
  endorsed by COROS.
  <!-- TODO(Todd): read coros.com/terms yourself (it could not be fetched while preparing this) and confirm nothing there restricts anonymous fetching from the object host or caching your own data locally. -->
- **Garmin FIT SDK.** FIT decoding uses [`@garmin/fitsdk`](https://www.npmjs.com/package/@garmin/fitsdk),
  which is under Garmin's FIT Protocol License, not an open-source license. It is
  installed from npm as a dependency and is not redistributed in this repository.

## Privacy

Cached tracks contain full-resolution GPS covering your home. The cache directory is
gitignored and must stay that way; a Claude Code hook in this repo also blocks writing to
it, force-adding it, or committing FIT/GeoJSON files. Coordinates never appear in logs.
Nothing derived from activity data belongs in the repository.

## License

<!-- TODO(Todd): choose a license (e.g. MIT or Apache-2.0), add LICENSE, set "license" in package.json, and replace this section. -->
No license has been chosen yet. Until one is, default copyright applies.
