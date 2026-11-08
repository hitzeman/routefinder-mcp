# Tasks

## 1. Project scaffolding

- [x] 1.1 Initialize the TypeScript/Node project (ESM, Node 20+, `tsconfig`, build and test scripts) and verify `npm run build` and the test runner both exit 0 against an empty suite
- [x] 1.2 Add the MCP TypeScript SDK, the official Garmin FIT SDK, and a schema validator, then verify installation succeeds and a smoke import of each resolves from the built output
- [x] 1.3 Create the gitignored two-tier cache layout (`raw/` and `tracks/`) and verify `git status --porcelain` reports nothing after writing a file into each tier

## 2. FIT decoding and track extraction

- [x] 2.1 Implement a FIT decode adapter returning an ordered sequence of positions plus total distance, and verify against the sample FIT already in the scratchpad that decoded total distance matches the known activity summary within rounding
- [x] 2.2 Resolve the design's coordinate-precision open question: assert decoded positions carry sub-metre resolution rather than the ~111 m quantization seen in summary data, record the finding in `docs/discovery-notes.md` under Q1b, and verify with a test asserting the minimum spacing between distinct decoded coordinates is far below the candidate cell size — **complete this before choosing a default cell size in group 5**
- [x] 2.3 Reject activities containing no positional records and verify a unit test with a GPS-less fixture reports the activity unusable instead of throwing

## 3. Fetch and cache layer

- [x] 3.1 Implement URL validation (HTTPS only, host and path allowlist, redirects refused) and verify unit tests covering an off-allowlist host, an `http://` URL, and a redirect response each reject without issuing a network request
- [x] 3.2 Implement the fetch with a response size cap, a timeout, and a declared-versus-received length check, and verify tests against a local fixture server for oversized, truncated, and slow responses
- [x] 3.3 Implement the two-tier cache keyed by a SHA-256 derivation of the URL, writing raw bytes before parsing is attempted, and verify a test that deletes the parsed tier rebuilds tracks with zero network requests
- [x] 3.4 Implement cache-hit idempotence and verify a test that a second ingest of the same set issues zero network requests and reports every activity as already cached
- [x] 3.5 Add a leak test asserting no URL appears in cache contents, cache filenames, logs, or error messages and no coordinate appears in logs, and verify the test fails when a URL is deliberately logged

## 4. ingest_activities tool and the first real ingest

- [x] 4.1 Expose `ingest_activities` over stdio MCP reporting per-activity outcomes plus a batch summary, and verify an MCP client call returns newly-cached, already-cached, and failed counts for a mixed fixture batch
- [x] 4.2 Verify partial-failure resilience end to end by ingesting a batch containing one unreachable URL among good ones, confirming the good ones cache and the result names the failure with a reason and without reproducing its URL
- [x] 4.3 Document the Claude-side orchestration in the README — request URLs one `labelId` at a time (never by date range, which has no distance filter and would spend the cap on unwanted activities) and request only outdoor and trail run sport types so track ovals never enter the corpus — and verify the documented sequence is the one used in 4.4
- [x] 4.4 Run the real metered ingest for the 30 most recent in-range runs, confirm the raw tier holds 30 files, and verify a repeat ingest of the same set reports 30 already-cached with zero requests — **run this early in the timebox; the cap is daily and every later task is free**

## 5. Route grouping pipeline

- [x] 5.1 Implement candidate filtering by target distance and tolerance and verify tests that tracks outside the band never reach grouping or output
- [x] 5.2 Implement Ramer–Douglas–Peucker simplification with a configurable tolerance and verify a test asserting maximum deviation from the source polyline stays within that tolerance
- [x] 5.3 Implement cell quantization and Jaccard similarity with a configurable cell size and verify a test that a synthetic track and its exact reversal score identical similarity
- [x] 5.4 Implement union-find clustering above a configurable threshold and verify tests covering one group, two disjoint groups, and a deliberate chaining case
- [x] 5.5 Implement degenerate-track exclusion by spatial-extent-to-distance ratio and verify a synthetic lap-oval fixture is excluded with a stated reason
- [x] 5.6 Implement per-route statistics (median distance, run count, last-run date) and medoid selection for the drawn geometry, and verify run count equals the number of grouped tracks and the medoid is identical across repeated runs
- [x] 5.7 Apply explicit sort keys to every ordering in the pipeline and verify a determinism test that repeated runs over an unchanged cache produce byte-identical output

## 6. find_routes tool and GeoJSON output

- [x] 6.1 Expose `find_routes` over stdio MCP reading cache only, and verify a test asserting zero network requests occur during a query
- [x] 6.2 Emit a valid GeoJSON FeatureCollection with one feature per route, selection details as feature properties, and a per-route vertex cap, and verify the output passes GeoJSON validation and stays within the context size budget
- [x] 6.3 Distinguish an empty cache from a no-match query and verify each reports its own condition rather than an error
- [x] 6.4 Document `find_routes` usage and the artifact rendering step in the README and verify the documented call returns routes against the real cache

## 7. Accuracy tuning and integration

- [ ] 7.1 Tune cell size and similarity threshold against the golden set until both known ~7-mile routes are reported as exactly two routes with correct run counts, and record the chosen values with the evidence that selected them
- [x] 7.2 Confirm direction and shape handling on real data, verifying that any reversed traversals group with their forward runs and that no out-and-back merges with a loop of equal total distance
- [x] 7.3 Render the returned GeoJSON as a Claude artifact map and verify a route is identifiable at phone viewport width by opening the published artifact
- [x] 7.4 Re-run the repository leak check and verify no coordinates, download URLs, athlete or file identifiers, or cached activity data are tracked, using `git status` plus a grep over tracked files

## Workflow follow-up

- Archive the change once the golden-set accuracy bar in 7.1 is met and the artifacts have been reviewed.
- Verify the archived result and sync the two new capability specs into `openspec/specs/`.
