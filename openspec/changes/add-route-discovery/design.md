# Design

## Context

See `proposal.md` — Why. The constraints that actually shape the approach, all
established during discovery (`docs/discovery-notes.md` §4–§6):

- **COROS activity file URLs are anonymously fetchable, permanent, and content-addressed.**
  No signature, no expiry. This is what allows a credential-free server at all.
- **The daily FIT cap binds on URL *discovery*, not on bytes.** Obtaining a URL costs the
  same as downloading the file; fetching from the object host is free and unmetered.
  There is therefore no cheap "collect URLs now, download later" strategy.
- **The server cannot call COROS.** It is an MCP server, not a client of the COROS
  connector, so candidate selection and URL retrieval necessarily happen on the Claude
  side.
- **Terrain is flat and summary coordinates are quantized to ~111 m**, so no summary-level
  signal (start point, elevation profile, distance) discriminates between routes. Only
  the recorded geometry does. This is why grouping must read the track.
- Greenfield repository: no existing code, modules, or conventions to fit.

## Goals / Non-Goals

**Goals:**

- Hold zero COROS credentials in this server.
- Spend the metered quota exactly once per activity, and make that boundary visible in
  the tool surface rather than implicit.
- Survive parser iteration without re-spending quota.
- Separate the two golden-set routes correctly — that is the accuracy bar.
- Emit output small enough to pass through a model context window and render as a map.

**Non-Goals:**

- Streaming, incremental, or scheduled ingestion. Ingestion is explicitly invoked.
- Any route ranking, recommendation, or scoring beyond the distance filter.
- Concurrency across ingestion calls. Single user, single process.
- Cross-machine cache portability.

## Decisions

### D1: Claude brokers URL retrieval; the server never talks to COROS

The flow is three steps on the Claude side and one on the server:

```
  Claude ---> querySportRecords (free)              ---> labelIds in distance band
  Claude ---> queryActivityFitFileDownloadUrls x N  ---> URLs        [METERED]
  Claude ---> ingest_activities(urls)   --> server --> object host   [free bytes]
  Claude ---> find_routes(target)       --> server --> GeoJSON       [no network]
  Claude ---> renders GeoJSON as an artifact map
```

**Alternative considered:** make the server a second OAuth client of the COROS MCP. That
means token storage, refresh, a second consent to maintain, and write scopes the server
has no use for. Anonymous URLs make it unnecessary, so the credential boundary stays
inside the official connector.

**Consequence:** `ingest_activities` must take URLs as a parameter. That is forced by
this decision, not a convenience.

### D2: URLs are fetched per `labelId`, never by date range

`queryActivityFitFileDownloadUrls` accepts a date range but has no distance filter, so a
range call would return whatever activities it finds and spend metered slots on
activities outside the target band. Requesting one `labelId` at a time is the only way to
spend exactly N slots for N wanted activities. This is guidance for the Claude-side
orchestration, documented here because getting it wrong silently wastes the day's cap.

Track-oval activities are excluded for free at the same layer by requesting only outdoor
and trail run sport types and omitting the track sport type, so they never enter the
corpus. The server still guards against a degenerate track reaching it
(`route-discovery`, "Degenerate tracks are excluded") because that exclusion lives in
the caller and cannot be relied upon.

### D3: Two tools, split exactly at the metered boundary

`ingest_activities` is the only tool that touches the network; `find_routes` is pure
cache. **Alternative considered:** one cache-first `find_routes(urls, target)` that
downloads misses. Rejected because the metered side effect becomes implicit — an
accidental call with fresh URLs silently spends quota — and because the two halves have
genuinely different lifecycles: ingest runs once, queries run dozens of times while
tuning.

### D4: Two-tier cache, raw bytes beneath parsed tracks

```
  .cache/raw/<key>.fit        <- never re-fetched; the quota-protection tier
  .cache/tracks/<key>.json    <- freely rebuildable from raw
```

`<key>` is a SHA-256 of the URL, which is stable, collision-free in practice, and stores
no secret (D5 forbids storing the URL itself). Bytes are written to the raw tier *before*
parsing is attempted, so a parser crash costs zero quota to retry — the single most
important property for iterating on a four-day timebox.

**Alternative considered:** cache only parsed tracks. Rejected: every parser change would
re-spend quota, and the parser is the component most likely to need changes.

### D5: Download URLs live in memory only

They are unauthenticated bearer URLs with no expiry and no revocation path, so a leak is
permanent. The tempting optimization runs the other way — re-obtaining a URL costs quota,
so caching it looks thrifty — but the parsed track is both the cheaper and the safer
artifact, and caching tracks already satisfies the zero-request requirement. Storing the
URL buys nothing and adds a permanent liability.

### D6: Grouping on occupied-cell sets with Jaccard similarity

Quantize each track's points to a fixed-size grid cell, reduce to the *set* of occupied
cells, and compare two tracks by Jaccard overlap.

The decisive property is that **a set is unordered, so direction disappears by
construction.** A loop run backwards produces the same cell set as its forward runs and
groups with them automatically — the reversal problem is dissolved rather than
special-cased. It is also cheap: O(points) to build, O(cells) to compare, and needs no
geospatial dependency.

**Alternatives considered:**

- *Fréchet or dynamic-time-warping distance between polylines* — order-sensitive, so
  reversal needs explicit handling; O(n·m) per pair; much heavier to implement correctly.
- *Hausdorff distance* — direction-agnostic too, but sensitive to a single outlier point
  and more expensive than set overlap.
- *Summary-statistic grouping (distance + elevation profile)* — evaluated and rejected
  during discovery; the terrain is flat enough that ~35% of the elevation signal on one
  run was barometric drift (§6).

**Trade-off:** quantization is brittle at cell boundaries — a point that falls near an
edge can land in either of two cells run-to-run, deflating similarity between genuinely
identical routes. Cell size is the tuning knob; neighbor dilation is the fallback (see
Open Questions).

### D7: Union-find over thresholded pairs for clustering

Compute pairwise similarity, union any pair above the threshold, and read off connected
components. **Alternative considered:** k-means (requires knowing the route count up
front, which is the thing being discovered) and DBSCAN (more parameters to tune for no
gain at this scale). With ~30 candidate tracks, the pairwise matrix is ~435 comparisons —
small enough that nothing cleverer is warranted.

This is single-linkage, which can chain: A~B and B~C merges A and C even when A and C are
dissimilar. At a high threshold and this scale it is acceptable, and the golden set will
reveal it if it happens (see Risks).

### D8: Render the medoid track, not the newest

Each route's drawn geometry is the group member with the highest mean similarity to the
rest of its group. **Alternative considered:** most recent run (noisier — one bad GPS day
becomes the canonical shape) or longest. The medoid is deterministic and is the most
typical geometry in the group, which is what should be drawn.

Reported distance is the median of the group's distances, which resists a single
mis-measured run.

### D9: Simplify with Ramer–Douglas–Peucker, implemented directly

RDP gives a bounded deviation guarantee, which is what the spec requires, and is roughly
thirty lines. **Alternative considered:** a geospatial library dependency for one
function. Not worth the dependency surface when the output has to stay small anyway.
Simplification is load-bearing here, not cosmetic: the GeoJSON passes through a context
window.

### D10: Official Garmin FIT SDK for decoding

COROS writes standard FIT (discovery verified protocol 2.0, profile 21.158, intact header
and CRC), so the official SDK is the lowest-risk decoder and tracks profile revisions.
**Alternative considered:** a lighter community FIT parser; rejected as a correctness risk
on a file format with per-profile field definitions, for no meaningful gain.

### D11: stdio transport

Single user, single machine, invoked by a local MCP client. An HTTP transport would add a
listening socket and an auth story for no benefit.

### D12: Determinism is explicit, not incidental

Every ordering is sorted on a defined key before output, and no result depends on object
key order, directory listing order, or set iteration order. The spec requires
reproducibility, which means ordering cannot be left to whatever the runtime happens to
do.

## Risks / Trade-offs

- **Cell-boundary noise splits one real route into two.** → Tune cell size against the
  golden set before trusting any result; dilate each point to its neighbouring cells if
  tuning alone is insufficient.
- **Single-linkage chaining merges two real routes that share a corridor.** Likely in a
  neighbourhood where routes overlap for the first mile. → The golden set is the arbiter;
  if it merges, raise the threshold or move to complete-linkage.
- **In-FIT GPS precision is unverified** (discovery Q1b, spike deliberately skipped). If
  coordinates were quantized like the summary data, a ~50 m cell would sit below the noise
  floor. → Assessed as low risk, but confirm on the first parsed file *before* fixing the
  default cell size. This is cheap exactly once a parser exists.
- **Quota exhausted part-way through the first ingest.** → Bytes land in the raw tier
  before parsing, and outcomes are per-activity, so a partial batch is resumable the next
  day without re-spending anything already cached.
- **SSRF through a model-supplied URL.** → Host and path allowlist, HTTPS only, redirects
  refused, response size cap, timeout. Specified in `activity-ingestion`.
- **GeoJSON exceeds a usable context size.** → Only distinct routes are emitted (expect a
  handful, not thirty), geometry is simplified, and vertices per route are capped.
- **Full-resolution home-adjacent GPS reaches a rendered artifact.** Accepted: trimming
  was explicitly dropped. → The cache stays out of version control and coordinates stay
  out of logs; the privacy boundary is the repository and the log, not the map.

## Migration Plan

Greenfield; nothing to migrate. Rollback is deleting the cache directory and the server.

The only irreversible cost is the metered first ingest, which argues for running it early
in the timebox: once the raw tier is populated, every subsequent change is free to
iterate, and each new day restores a full cap as backstop.

## Open Questions

These are deferrable because the spec makes the relevant values configurable, so none of
them changes the approach, the specs, or the task breakdown:

- **Default grid cell size and similarity threshold.** Starting point ~50 m cells and ~0.8
  Jaccard; the golden set decides the final values. Settled by tuning, not by analysis.
- **Whether neighbour-cell dilation is needed** to absorb boundary noise. Add only if
  cell-size tuning fails to group the golden set cleanly.
- **Whether a route needs a minimum run count** to be reported at all, to suppress
  one-off routes from the list. Depends on what the first real output looks like.
