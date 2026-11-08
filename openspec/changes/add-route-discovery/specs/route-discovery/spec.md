# Spec Delta

## Purpose

Identifies the distinct routes an athlete actually repeats, by grouping cached GPS
tracks of a target distance on geometric overlap, and describes each route well enough
to pick one at a glance and draw it on a map.

## ADDED Requirements

### Requirement: Route queries use only cached data

The system SHALL answer a route query entirely from cached tracks and SHALL issue zero
network requests while doing so. A query for activities that are not cached SHALL report
them as missing rather than fetching them.

#### Scenario: Query issues no network requests

- **WHEN** a route query runs against a populated cache
- **THEN** no network request is issued

#### Scenario: Repeat query is free

- **WHEN** the same route query is run twice
- **THEN** both runs issue zero network requests
- **AND** return equivalent results

### Requirement: Candidate selection by target distance

The system SHALL accept a target distance and a tolerance, and SHALL consider only
cached tracks whose total distance falls within that tolerance of the target. Tracks
outside the band SHALL NOT influence grouping or output.

#### Scenario: Tracks inside the band are considered

- **WHEN** a query targets 7 miles with a tolerance of 0.5 miles
- **THEN** every cached track between 6.5 and 7.5 miles is considered

#### Scenario: Tracks outside the band are ignored

- **WHEN** a query targets 7 miles with a tolerance of 0.5 miles
- **AND** the cache contains a 4-mile track and a 13-mile track
- **THEN** neither appears in the result

### Requirement: Results are deterministic

The system SHALL produce identical results for identical inputs. Given the same cached
tracks and the same query parameters, repeated runs SHALL return the same routes, the
same grouping, and the same ordering. No language model SHALL participate in selecting,
grouping, or describing routes.

#### Scenario: Repeated runs match exactly

- **WHEN** the same query is run repeatedly against an unchanged cache
- **THEN** the returned routes, their grouping, and their order are identical each time

#### Scenario: Ordering is stable and defined

- **WHEN** a query returns multiple routes
- **THEN** they are ordered by a defined, reproducible rule rather than by cache or filesystem order

### Requirement: Repeated runs of one route are grouped together

The system SHALL group two candidate tracks into the same route when their spatial
overlap meets a configurable similarity threshold, and SHALL keep them separate
otherwise. Overlap SHALL be measured on the ground area each track covers, not on
summary statistics such as distance, duration, pace, or elevation.

#### Scenario: Same route run many times yields one route

- **WHEN** the candidate set contains many tracks that follow the same roads
- **THEN** they are reported as a single route

#### Scenario: Minor GPS variation does not split a route

- **WHEN** two tracks follow the same roads but differ slightly in recorded position
- **THEN** they are grouped into the same route

#### Scenario: Similarity threshold is configurable

- **WHEN** the similarity threshold is changed
- **THEN** grouping reflects the new threshold without code changes

### Requirement: Grouping is direction-agnostic

The system SHALL group two tracks that cover the same ground regardless of the direction
in which each was traversed.

#### Scenario: Reversed loop groups with its forward runs

- **WHEN** a loop appears in the candidate set traversed clockwise in some tracks and counter-clockwise in others
- **THEN** all of them are reported as a single route

### Requirement: Distinct routes of the same distance stay separate

The system SHALL report two routes separately when they cover substantially different
ground, even when their total distances are nearly identical. Distance alone SHALL NOT
cause two routes to merge.

#### Scenario: Two known routes of equal length are not merged

- **WHEN** the candidate set contains repeated runs of two different routes of nearly the same distance
- **THEN** two routes are reported, each containing only its own runs

#### Scenario: Out-and-back is not merged with a loop of equal distance

- **WHEN** the candidate set contains an out-and-back and a loop of the same total distance
- **AND** the out-and-back covers roughly half the unique ground of the loop
- **THEN** they are reported as separate routes

### Requirement: Degenerate tracks are excluded

A track whose spatial extent is very small relative to its total distance describes
repeated laps of a small circuit rather than a route. The system SHALL exclude such
tracks from route results and SHALL report that they were excluded.

#### Scenario: Lap workout on a small circuit is excluded

- **WHEN** a candidate track covers a very small area relative to its distance
- **THEN** it is excluded from the reported routes
- **AND** the result states that it was excluded and why

### Requirement: Each route is described for selection at a glance

The system SHALL report, for every route, a representative distance, how many times it
was run, and the date it was most recently run. Each route SHALL carry a stable
identifier within the result so it can be referred to unambiguously.

#### Scenario: Route carries selection details

- **WHEN** a route query returns a route
- **THEN** that route reports a representative distance, a run count, and a last-run date

#### Scenario: Run count matches grouped tracks

- **WHEN** a route groups a number of candidate tracks
- **THEN** its reported run count equals that number

### Requirement: Routes are returned as renderable GeoJSON

The system SHALL return route geometry as valid GeoJSON, one feature per route, with each
route's selection details carried as feature properties. Geometry SHALL be simplified so
that it deviates from the source track by no more than a configurable tolerance, and the
result SHALL stay small enough to pass through a model context window.

#### Scenario: Output is valid GeoJSON

- **WHEN** a route query returns routes
- **THEN** the output parses as a valid GeoJSON FeatureCollection with one feature per route

#### Scenario: Simplification stays within tolerance

- **WHEN** a route's geometry is simplified
- **THEN** no point on the simplified geometry deviates from the source track by more than the configured tolerance

#### Scenario: Full route is rendered

- **WHEN** a route is returned
- **THEN** its geometry covers the entire route including its start and finish

### Requirement: Empty results are explicit

The system SHALL distinguish "no cached activities match this query" from an error, and
SHALL report which condition applies.

#### Scenario: No candidates in range

- **WHEN** a query targets a distance for which no cached track is in range
- **THEN** the result is an empty route list with a statement that no cached activity matched

#### Scenario: Empty cache

- **WHEN** a query runs against an empty cache
- **THEN** the result states that no activities have been ingested yet
