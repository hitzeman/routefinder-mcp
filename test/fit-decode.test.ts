import test from "node:test";
import assert from "node:assert/strict";

import { decodeActivity } from "../src/fit/decode.js";
import {
  loadSampleFit,
  positionlessFit,
  sampleFitPath,
  syntheticFit,
} from "./helpers/fit-fixtures.js";

const METRES_PER_DEGREE_LAT = 111_320;

/** Task 2.1 - decoded totals must match the COROS activity summary for the real file. */
test("real COROS activity decodes to a track matching its summary", (t) => {
  const bytes = loadSampleFit();
  if (bytes === null) {
    t.skip(`sample FIT not present at ${sampleFitPath}; run an ingest first`);
    return;
  }

  const outcome = decodeActivity(bytes);
  assert.equal(outcome.ok, true, "real COROS file must decode");
  if (!outcome.ok) return;

  const { track } = outcome;

  // COROS reported this activity as 7.08 km.
  assert.equal(
    (track.totalDistanceM / 1000).toFixed(2),
    "7.08",
    `decoded ${track.totalDistanceM} m should round to the 7.08 km summary`,
  );

  assert.ok(
    track.points.length > 2000,
    `expected a dense 1 Hz track, got ${track.points.length} points`,
  );
  assert.equal(track.sport, "running");
  assert.match(track.startTime, /^\d{4}-\d{2}-\d{2}T/);
});

/** Task 2.1 - semicircles must be converted, not passed through raw. */
test("decoded coordinates are degrees, not raw semicircles", (t) => {
  const bytes = loadSampleFit();
  if (bytes === null) {
    t.skip("sample FIT not present");
    return;
  }

  const outcome = decodeActivity(bytes);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  for (const point of outcome.track.points) {
    assert.ok(
      Math.abs(point.lat) <= 90 && Math.abs(point.lon) <= 180,
      "coordinates outside degree range suggest semicircles leaked through",
    );
  }
});

/**
 * Task 2.2 - resolves the design's open question on coordinate precision.
 *
 * COROS summary responses quantize coordinates to ~111 m. If the FIT did the same, the
 * ~50 m grid cells grouping depends on would sit below the noise floor. The observed
 * quantum is one semicircle (~0.93 cm), so the summary rounding is an artifact of that
 * API and not a property of the file.
 */
test("in-FIT coordinate precision is far finer than the grouping cell size", (t) => {
  const bytes = loadSampleFit();
  if (bytes === null) {
    t.skip("sample FIT not present");
    return;
  }

  const outcome = decodeActivity(bytes);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  const lats = outcome.track.points.map((p) => p.lat);
  let smallestStepM = Infinity;
  for (let i = 1; i < lats.length; i += 1) {
    const stepM = Math.abs(lats[i]! - lats[i - 1]!) * METRES_PER_DEGREE_LAT;
    if (stepM > 0) smallestStepM = Math.min(smallestStepM, stepM);
  }

  const candidateCellSizeM = 50;
  assert.ok(
    smallestStepM < 0.05,
    `coordinates should resolve below 5 cm; smallest observed step was ${smallestStepM.toFixed(4)} m`,
  );
  assert.ok(
    candidateCellSizeM / smallestStepM > 100,
    "cell size must sit far above the coordinate noise floor",
  );
});

/** Task 2.3 - a positionless activity is unusable, not an exception. */
test("activity with no positional records is reported unusable", () => {
  const outcome = decodeActivity(positionlessFit());

  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.reason, /no positional records/);
});

test("synthetic activity with positions decodes successfully", () => {
  const bytes = syntheticFit({
    points: [
      { lat: 33.2, lon: -96.7 },
      { lat: 33.201, lon: -96.701 },
      { lat: 33.202, lon: -96.702 },
    ],
    totalDistanceM: 300,
  });

  const outcome = decodeActivity(bytes);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.track.points.length, 3);
  assert.equal(outcome.track.totalDistanceM, 300);
  // Round-trip through semicircles is lossy at the centimetre level, not the metre level.
  assert.ok(Math.abs(outcome.track.points[0]!.lat - 33.2) < 1e-5);
});

test("non-FIT bytes are rejected without throwing", () => {
  const outcome = decodeActivity(Buffer.from("this is not a FIT file at all"));
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.reason, /not a FIT file|decode failed/);
});
