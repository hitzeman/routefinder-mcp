# Proposal

## Why

Planning a longer run costs ~10 minutes of digging through Strava to remember which
routes are the right distance. The official COROS MCP can already find activities by
distance, but it exposes only a start point per activity — and that start point is
effectively constant: of 80 activities in the ~7-mile band, 64 share one identical
quantized value, so it carries no information about which route was run. There is no
way to answer "what are my usual 7-mile routes?" with paths or a map.

Now, because the enabling constraint was just resolved: COROS FIT download URLs are
anonymously fetchable and never expire, so a local server can turn those files into
route geometry without holding any COROS credentials.

## What Changes

- **New MCP server** (TypeScript/Node) that turns past COROS activities into a map of
  distinct repeated routes. Two tools, deliberately split at the metered boundary:
  - `ingest_activities(fitUrls)` — the only tool that touches the network. Fetches FIT
    bytes from caller-supplied URLs, caches raw bytes, parses to tracks, caches tracks.
  - `find_routes(targetMiles, toleranceMiles)` — reads cache only, performs **zero**
    network requests, and returns grouped routes as GeoJSON plus per-route statistics
    (distance, run count, last-run date).
- **Claude orchestrates and renders.** Claude selects candidate activities via the COROS
  connector, passes the resulting URLs to `ingest_activities`, then renders the GeoJSON
  from `find_routes` as a published artifact map. The server never calls COROS.
- **Deterministic data path.** Parse, simplify, cell-set, group. No LLM anywhere in the
  pipeline, so results are reproducible for a given cache.
- **Direction-agnostic grouping.** Routes are compared as *sets* of occupied grid cells,
  which makes a loop run backwards group with its forward runs by construction rather
  than by special-case handling.
- **Two-tier cache.** Raw FIT bytes and parsed tracks are cached separately, so parser
  changes never re-spend the COROS daily quota.
- **FIT URLs are treated as secrets and never persisted.** They are unauthenticated
  bearer URLs with no expiry and no revocation, so the server holds them only in memory
  for the duration of an `ingest_activities` call.
- **v1 scope boundaries:** the ~30 most recent in-range runs (no historical backfill),
  track-oval activities excluded, and no start/finish trimming — the full route renders.

No breaking changes; this is a greenfield repository with no existing behavior.

## Capabilities

### New Capabilities

- `activity-ingestion`: Acquiring activity files from caller-supplied bearer URLs and
  turning them into cached, parsed GPS tracks. Owns requirements for URL validation and
  SSRF containment, secret handling and non-persistence, the two-tier cache and its
  idempotence, FIT parsing, and quota-protective behavior.
- `route-discovery`: Identifying distinct repeated routes among cached tracks and
  describing them for display. Owns requirements for distance filtering, track
  simplification, the grouping method and its threshold, direction-agnostic and
  out-and-back handling, per-route statistics, and GeoJSON output.

### Modified Capabilities

None — no existing specs in this project.

## Impact

- **New code**, all of it: an MCP server entry point, a fetch/cache layer, a FIT parser
  adapter, and a deterministic grouping pipeline. No existing modules are touched.
- **New dependencies**: the MCP TypeScript SDK and a FIT decoding library. Geometry
  (simplification, cell keys, set overlap) is small enough to implement directly rather
  than take a geospatial dependency.
- **New gitignored cache directory.** Must never be committed: it holds raw GPS.
- **External quota.** `ingest_activities` depends on URLs the caller obtained from COROS,
  whose FIT access is capped daily. The v1 corpus fits inside one day's cap in a single
  pass, after which repeat use is free.
- **New network surface.** The server fetches URLs supplied by a model, which is an SSRF
  risk and requires host and path pinning, redirect refusal, size caps, and timeouts.
- **Privacy posture.** Parsed tracks and the cache contain full-resolution home-adjacent
  GPS. Nothing derived from activity data may be committed to the repository.
