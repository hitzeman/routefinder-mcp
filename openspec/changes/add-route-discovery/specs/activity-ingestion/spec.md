# Spec Delta

## Purpose

Turns caller-supplied activity file URLs into cached, parsed GPS tracks, while
containing the risk that those URLs are unauthenticated bearer secrets pointing at an
external host. Owns fetching, validation, caching, and parse outcomes.

## ADDED Requirements

### Requirement: Activity URL validation

The system SHALL accept an activity file URL only when it uses HTTPS and matches the
configured allowlist of COROS object-storage host and path prefix. The system SHALL
reject any other URL without issuing a network request, and SHALL NOT follow HTTP
redirects when fetching an accepted URL.

#### Scenario: URL outside the allowlist is rejected

- **WHEN** ingestion is called with a URL whose host or path prefix is not on the allowlist
- **THEN** that URL is rejected and reported as invalid
- **AND** no network request is issued for it

#### Scenario: Non-HTTPS URL is rejected

- **WHEN** ingestion is called with an `http://` URL on the allowlisted host
- **THEN** that URL is rejected and reported as invalid

#### Scenario: Redirect is refused

- **WHEN** an allowlisted URL responds with a redirect to another location
- **THEN** the fetch fails for that activity
- **AND** the redirect target is not requested

### Requirement: Credential-free fetching

The system SHALL fetch activity files without sending any credentials, and SHALL NOT
require COROS credentials to operate. No authorization header, cookie, or API token is
sent with an activity file request.

#### Scenario: Fetch carries no credentials

- **WHEN** the system fetches an allowlisted activity file URL
- **THEN** the request carries no authorization header, cookie, or token
- **AND** the activity file is retrieved successfully

#### Scenario: Server holds no COROS credentials

- **WHEN** the system starts with no COROS credentials configured
- **THEN** ingestion operates normally

### Requirement: Download URLs are never persisted

Activity file URLs are unauthenticated bearer URLs that do not expire and cannot be
revoked. The system SHALL retain a URL only in memory for the duration of the ingestion
call, and SHALL NOT write it to the cache, to logs, to error messages, or to any tool
output.

#### Scenario: URL absent from cached data

- **WHEN** an activity has been ingested successfully
- **THEN** no cached artifact contains the URL it was fetched from

#### Scenario: URL absent from a failure report

- **WHEN** fetching an activity fails
- **THEN** the reported error identifies the activity without reproducing its URL

#### Scenario: Cache key does not reveal the URL

- **WHEN** an activity is cached
- **THEN** its cache key is a non-reversible derivation of the URL rather than the URL itself

### Requirement: Two-tier caching of raw bytes and parsed tracks

The system SHALL cache raw activity file bytes separately from parsed tracks, so that
re-parsing cached activities requires no network request. A change to parsing behavior
SHALL be satisfiable from the raw tier alone.

#### Scenario: Re-parsing uses cached bytes

- **WHEN** parsed tracks are discarded but raw cached bytes remain
- **AND** ingestion is called again for those activities
- **THEN** tracks are rebuilt from the raw tier
- **AND** no network request is issued

### Requirement: Idempotent ingestion

The system SHALL treat ingestion of an already-cached activity as a cache hit. Repeating
an ingestion call with the same activities SHALL issue zero network requests and SHALL
leave cached content unchanged.

#### Scenario: Repeat ingestion makes no requests

- **WHEN** ingestion is called twice with the same set of activities
- **THEN** the second call issues zero network requests
- **AND** reports every activity as already cached

#### Scenario: Mixed batch fetches only new activities

- **WHEN** ingestion is called with a set in which some activities are already cached
- **THEN** only the uncached activities are fetched

### Requirement: Response limits and integrity

The system SHALL enforce a maximum response size and a request timeout on every activity
fetch, and SHALL reject a response whose received length does not match the length the
server declared.

#### Scenario: Oversized response is rejected

- **WHEN** a fetch returns a body exceeding the configured maximum size
- **THEN** the fetch is aborted and reported as failed
- **AND** no partial content is cached

#### Scenario: Truncated response is rejected

- **WHEN** a fetch returns fewer bytes than the server declared
- **THEN** the response is rejected and reported as failed

#### Scenario: Slow fetch times out

- **WHEN** a fetch exceeds the configured timeout
- **THEN** it is aborted and reported as failed

### Requirement: Per-activity outcomes are reported

The system SHALL report the outcome of every activity in an ingestion batch
individually, and SHALL NOT fail an entire batch because individual activities failed.
The report SHALL distinguish newly cached, already cached, and failed activities.

#### Scenario: One bad activity does not fail the batch

- **WHEN** ingestion is called with several activities and one cannot be fetched or parsed
- **THEN** the remaining activities are cached successfully
- **AND** the result reports the failed activity with a reason

#### Scenario: Activity without GPS data is reported as unusable

- **WHEN** an activity file parses successfully but contains no positional records
- **THEN** it is reported as unusable for route discovery
- **AND** it is excluded from the parsed track cache

#### Scenario: Batch summary counts outcomes

- **WHEN** an ingestion batch completes
- **THEN** the result states how many activities were newly cached, already cached, and failed

### Requirement: Cached activity data stays out of version control

Cached raw files and parsed tracks contain full-resolution GPS covering the athlete's
home. The system SHALL store all cached activity data in a location excluded from version
control, and SHALL NOT emit GPS coordinates into logs.

#### Scenario: Cache location is ignored by version control

- **WHEN** activities have been ingested
- **THEN** no cached file is reported as a tracked or untracked addition by version control

#### Scenario: Logs omit coordinates

- **WHEN** ingestion runs at any log level
- **THEN** no GPS coordinate appears in the log output
