import test from "node:test";
import assert from "node:assert/strict";

import { cellsFor, gridAnchorFor, jaccard } from "../src/routes/cells.js";
import { clusterByThreshold } from "../src/routes/cluster.js";
import { discoverRoutes } from "../src/routes/discover.js";
import { MILES_TO_METRES } from "../src/routes/geo.js";
import { maxDeviationM, simplify, simplifyToBudget } from "../src/routes/simplify.js";
import {
  jitter,
  pointAt,
  outAndBack,
  rectangleLoop,
  smallOvalLaps,
  trackFrom,
} from "./helpers/synthetic-tracks.js";

const SEVEN_MILES_M = 7 * MILES_TO_METRES;

/** The synthetic fixtures all sit near this origin. */
const TEST_ANCHOR = gridAnchorFor(33.2, -96.7);

// ---------------------------------------------------------------- 5.1 distance filter

test("tracks outside the distance band never reach the output", () => {
  const loop = rectangleLoop(1500, 1200);
  const result = discoverRoutes(
    [
      trackFrom(loop, { distanceM: SEVEN_MILES_M, key: "a".repeat(64) }),
      trackFrom(rectangleLoop(400, 300), { distanceM: 4 * MILES_TO_METRES, key: "b".repeat(64) }),
      trackFrom(rectangleLoop(4000, 3000), { distanceM: 13 * MILES_TO_METRES, key: "c".repeat(64) }),
    ],
    7,
    0.5,
  );

  assert.equal(result.state, "ok");
  assert.equal(result.consideredCount, 1, "only the in-band track is considered");
  assert.equal(result.routes.length, 1);
  assert.equal(result.routes[0]?.runCount, 1);
});

test("the band boundaries are inclusive of the tolerance", () => {
  const loop = rectangleLoop(1500, 1200);
  const result = discoverRoutes(
    [
      trackFrom(loop, { distanceM: 6.5 * MILES_TO_METRES, key: "a".repeat(64) }),
      trackFrom(loop, { distanceM: 7.5 * MILES_TO_METRES, key: "b".repeat(64) }),
      trackFrom(loop, { distanceM: 7.51 * MILES_TO_METRES, key: "c".repeat(64) }),
    ],
    7,
    0.5,
  );

  assert.equal(result.consideredCount, 2);
});

// ------------------------------------------------------------------ 5.2 simplification

test("simplification keeps every point within the tolerance", () => {
  const loop = jitter(rectangleLoop(1500, 1200, 5), 3);

  for (const tolerance of [1, 5, 10, 25]) {
    const simplified = simplify(loop, tolerance);
    const deviation = maxDeviationM(loop, simplified);
    assert.ok(
      deviation <= tolerance + 1e-6,
      `tolerance ${tolerance} m exceeded: max deviation ${deviation.toFixed(3)} m`,
    );
    assert.ok(simplified.length <= loop.length);
    assert.ok(simplified.length >= 2);
  }
});

test("simplification reduces a dense track substantially", () => {
  const loop = rectangleLoop(1500, 1200, 2);
  const simplified = simplify(loop, 10);
  assert.ok(
    simplified.length < loop.length / 5,
    `expected real reduction, got ${simplified.length} of ${loop.length}`,
  );
});

test("endpoints are always preserved", () => {
  const loop = rectangleLoop(1500, 1200, 5);
  const simplified = simplify(loop, 50);
  assert.deepEqual(simplified[0], loop[0]);
  assert.deepEqual(simplified[simplified.length - 1], loop[loop.length - 1]);
});

test("a vertex budget is enforced by coarsening the tolerance", () => {
  const loop = jitter(rectangleLoop(3000, 2500, 2), 5);
  const { points, toleranceM } = simplifyToBudget(loop, 1, 50);
  assert.ok(points.length <= 50, `budget exceeded: ${points.length} vertices`);
  assert.ok(toleranceM >= 1);
});

// ---------------------------------------------------- 5.3 cells, Jaccard, and reversal

test("a track and its exact reversal produce identical cell sets", () => {
  const loop = rectangleLoop(1500, 1200);
  const reversed = [...loop].reverse();

  const forward = cellsFor(loop, 50, TEST_ANCHOR);
  const backward = cellsFor(reversed, 50, TEST_ANCHOR);

  assert.equal(
    jaccard(forward, backward),
    1,
    "direction must be invisible to the metric",
  );
  assert.deepEqual([...forward].sort(), [...backward].sort());
});

/**
 * Regression: a track whose first and last points differ in latitude.
 *
 * The original implementation derived the longitude scale from `points[0]`, so reversing
 * such a track changed the scale and shifted the whole grid - by more than a cell, because
 * the index was computed from raw `lon * metresPerDegree` magnitudes near 9,000,000 m.
 * Closed-loop fixtures hid this; real tracks did not.
 */
test("reversal invariance holds for a track with differing endpoints", () => {
  const openPath = [
    pointAt(0, 0),
    pointAt(400, 300),
    pointAt(900, 1200),
    pointAt(1500, 2600),
    pointAt(2100, 4800),
  ];
  const reversed = [...openPath].reverse();

  assert.equal(
    jaccard(
      cellsFor(openPath, 50, TEST_ANCHOR),
      cellsFor(reversed, 50, TEST_ANCHOR),
    ),
    1,
    "an open path must be identical to its own reversal",
  );
});

test("the grid anchor is stable against small corpus changes", () => {
  // Two nearby centres must round to the same anchor, or adding one activity would
  // reshuffle every group.
  assert.deepEqual(gridAnchorFor(33.155, -96.676), gridAnchorFor(33.199, -96.708));
});

test("identical tracks score 1 and disjoint tracks score 0", () => {
  const here = cellsFor(rectangleLoop(1000, 800), 50, TEST_ANCHOR);
  const alsoHere = cellsFor(rectangleLoop(1000, 800), 50, TEST_ANCHOR);
  const farAway = cellsFor(rectangleLoop(1000, 800, 10, 50_000, 50_000), 50, TEST_ANCHOR);

  assert.equal(jaccard(here, alsoHere), 1);
  assert.equal(jaccard(here, farAway), 0);
});

test("GPS jitter barely moves the similarity score", () => {
  const loop = rectangleLoop(1500, 1200, 5);
  const noisy = jitter(loop, 4);

  const score = jaccard(cellsFor(loop, 50, TEST_ANCHOR), cellsFor(noisy, 50, TEST_ANCHOR));
  assert.ok(score > 0.8, `jitter should not split a route; scored ${score.toFixed(3)}`);
});

test("interpolation fills gaps between sparse samples", () => {
  // Two points 500 m apart: without interpolation this is 2 cells, not a line.
  const sparse = [pointAt(0, 0), pointAt(500, 0)];
  const cells = cellsFor(sparse, 50, TEST_ANCHOR);
  assert.ok(cells.size >= 9, `expected an interpolated line, got ${cells.size} cells`);
});

// ------------------------------------------------------------------- 5.4 clustering

test("clustering finds one group when everything is similar", () => {
  const groups = clusterByThreshold(4, () => 0.95, 0.8);
  assert.deepEqual(groups, [[0, 1, 2, 3]]);
});

test("clustering finds disjoint groups", () => {
  const similarity = (a: number, b: number): number => {
    const sameHalf = a < 2 === b < 2;
    return sameHalf ? 0.95 : 0.1;
  };
  const groups = clusterByThreshold(4, similarity, 0.8);
  assert.deepEqual(groups, [
    [0, 1],
    [2, 3],
  ]);
});

test("clustering keeps everything separate when nothing matches", () => {
  const groups = clusterByThreshold(3, () => 0.1, 0.8);
  assert.deepEqual(groups, [[0], [1], [2]]);
});

/**
 * Single-linkage chaining, asserted explicitly rather than left as a surprise: A~B and
 * B~C merges A with C even though A and C are dissimilar. Documented behaviour of the
 * chosen algorithm; the golden set is the check on whether it matters in practice.
 */
test("single-linkage chains transitively, as designed", () => {
  const similarity = (a: number, b: number): number => {
    const pair = [a, b].sort((x, y) => x - y).join(":");
    if (pair === "0:1") return 0.9;
    if (pair === "1:2") return 0.9;
    return 0.1; // 0 and 2 are dissimilar
  };
  const groups = clusterByThreshold(3, similarity, 0.8);
  assert.deepEqual(groups, [[0, 1, 2]], "chaining is expected single-linkage behaviour");
});

test("group and member ordering is explicit, not incidental", () => {
  const groups = clusterByThreshold(6, (a, b) => (a % 2 === b % 2 ? 0.9 : 0.1), 0.8);
  assert.deepEqual(groups, [
    [0, 2, 4],
    [1, 3, 5],
  ]);
});

// ------------------------------------------------------- 5.5 degenerate track exclusion

test("many laps of a small oval are excluded with a stated reason", () => {
  const result = discoverRoutes(
    [
      trackFrom(smallOvalLaps(28), { distanceM: SEVEN_MILES_M, key: "a".repeat(64) }),
      trackFrom(rectangleLoop(1500, 1200), { distanceM: SEVEN_MILES_M, key: "b".repeat(64) }),
    ],
    7,
    0.5,
  );

  assert.equal(result.excluded.length, 1);
  assert.equal(result.excluded[0]?.key, "a".repeat(64));
  assert.match(result.excluded[0]?.reason ?? "", /repeated laps of a small circuit/);
  assert.equal(result.routes.length, 1, "the real loop still comes through");
});

test("a genuine road loop is not mistaken for a circuit", () => {
  const result = discoverRoutes(
    [trackFrom(rectangleLoop(1500, 1200), { distanceM: SEVEN_MILES_M, key: "a".repeat(64) })],
    7,
    0.5,
  );
  assert.equal(result.excluded.length, 0);
  assert.equal(result.routes.length, 1);
});

// ---------------------------------------- 5.6 distinct routes, stats, medoid selection

test("repeated runs of one route collapse into a single route", () => {
  const loop = rectangleLoop(1500, 1200, 5);
  const tracks = Array.from({ length: 8 }, (_, i) =>
    trackFrom(jitter(loop, 3), {
      distanceM: SEVEN_MILES_M + i,
      startTime: `2026-02-0${i + 1}T12:00:00.000Z`,
      key: String(i).repeat(64).slice(0, 64),
    }),
  );

  const result = discoverRoutes(tracks, 7, 0.5);

  assert.equal(result.routes.length, 1);
  assert.equal(result.routes[0]?.runCount, 8);
  assert.equal(result.routes[0]?.label, "Route A");
});

test("two distinct routes of the same distance stay separate", () => {
  const apex = rectangleLoop(1500, 1200, 5);
  const clubhouse = rectangleLoop(1400, 1100, 5, 6000, 6000);

  const tracks = [
    ...Array.from({ length: 5 }, (_, i) =>
      trackFrom(jitter(apex, 3), {
        distanceM: SEVEN_MILES_M,
        startTime: `2026-01-1${i}T12:00:00.000Z`,
        key: `a${i}`.padEnd(64, "0"),
      }),
    ),
    ...Array.from({ length: 3 }, (_, i) =>
      trackFrom(jitter(clubhouse, 3), {
        distanceM: SEVEN_MILES_M,
        startTime: `2026-02-1${i}T12:00:00.000Z`,
        key: `b${i}`.padEnd(64, "0"),
      }),
    ),
  ];

  const result = discoverRoutes(tracks, 7, 0.5);

  assert.equal(result.routes.length, 2, "equal distance must not merge distinct routes");
  // Most-run first.
  assert.equal(result.routes[0]?.runCount, 5);
  assert.equal(result.routes[1]?.runCount, 3);
  assert.equal(result.routes[0]?.label, "Route A");
  assert.equal(result.routes[1]?.label, "Route B");
});

test("an out-and-back does not merge with a loop of equal distance", () => {
  const loop = rectangleLoop(1500, 1200, 5);
  const there_and_back = outAndBack(5600, 5);

  const result = discoverRoutes(
    [
      trackFrom(loop, { distanceM: SEVEN_MILES_M, key: "a".repeat(64) }),
      trackFrom(there_and_back, { distanceM: SEVEN_MILES_M, key: "b".repeat(64) }),
    ],
    7,
    0.5,
  );

  assert.equal(result.routes.length, 2);
});

test("reversed runs of a loop group with their forward runs", () => {
  const loop = rectangleLoop(1500, 1200, 5);
  const tracks = [
    trackFrom(jitter(loop, 2), { distanceM: SEVEN_MILES_M, startTime: "2026-01-01T12:00:00.000Z", key: "a".repeat(64) }),
    trackFrom(jitter([...loop].reverse(), 2), { distanceM: SEVEN_MILES_M, startTime: "2026-01-02T12:00:00.000Z", key: "b".repeat(64) }),
    trackFrom(jitter(loop, 2), { distanceM: SEVEN_MILES_M, startTime: "2026-01-03T12:00:00.000Z", key: "c".repeat(64) }),
  ];

  const result = discoverRoutes(tracks, 7, 0.5);

  assert.equal(result.routes.length, 1, "direction must not create a second route");
  assert.equal(result.routes[0]?.runCount, 3);
});

test("route statistics describe the group", () => {
  const loop = rectangleLoop(1500, 1200, 5);
  const tracks = [
    trackFrom(jitter(loop, 2), { distanceM: 11_200, startTime: "2025-10-08T12:00:00.000Z", key: "a".repeat(64) }),
    trackFrom(jitter(loop, 2), { distanceM: 11_300, startTime: "2026-03-12T12:00:00.000Z", key: "b".repeat(64) }),
    trackFrom(jitter(loop, 2), { distanceM: 11_400, startTime: "2026-01-20T12:00:00.000Z", key: "c".repeat(64) }),
  ];

  const result = discoverRoutes(tracks, 7, 0.5);
  const route = result.routes[0];

  assert.equal(route?.runCount, 3, "run count equals grouped tracks");
  assert.equal(route?.distanceM, 11_300, "median distance resists an outlier");
  assert.equal(route?.firstRunDate, "2025-10-08T12:00:00.000Z");
  assert.equal(route?.lastRunDate, "2026-03-12T12:00:00.000Z");
  assert.equal(route?.distanceMiles, Number((11_300 / MILES_TO_METRES).toFixed(2)));
});

test("the medoid is stable regardless of input order", () => {
  const loop = rectangleLoop(1500, 1200, 5);
  const tracks = Array.from({ length: 5 }, (_, i) =>
    trackFrom(jitter(loop, 3 + i), {
      distanceM: SEVEN_MILES_M,
      startTime: `2026-01-0${i + 1}T12:00:00.000Z`,
      key: `k${i}`.padEnd(64, "0"),
    }),
  );

  const forward = discoverRoutes(tracks, 7, 0.5);
  const shuffled = discoverRoutes([...tracks].reverse(), 7, 0.5);

  assert.equal(forward.routes[0]?.id, shuffled.routes[0]?.id);
  assert.deepEqual(forward.routes[0]?.geometry, shuffled.routes[0]?.geometry);
});

// --------------------------------------------------------------------- 5.7 determinism

test("repeated runs over the same tracks produce byte-identical output", () => {
  const apex = rectangleLoop(1500, 1200, 5);
  const clubhouse = rectangleLoop(1400, 1100, 5, 6000, 6000);
  const tracks = [
    ...Array.from({ length: 4 }, (_, i) =>
      trackFrom(jitter(apex, 3), { distanceM: SEVEN_MILES_M, startTime: `2026-01-0${i + 1}T12:00:00.000Z`, key: `a${i}`.padEnd(64, "0") }),
    ),
    ...Array.from({ length: 4 }, (_, i) =>
      trackFrom(jitter(clubhouse, 3), { distanceM: SEVEN_MILES_M, startTime: `2026-02-0${i + 1}T12:00:00.000Z`, key: `b${i}`.padEnd(64, "0") }),
    ),
  ];

  const first = JSON.stringify(discoverRoutes(tracks, 7, 0.5));
  for (let i = 0; i < 5; i += 1) {
    assert.equal(JSON.stringify(discoverRoutes(tracks, 7, 0.5)), first);
  }
});

test("the similarity threshold is configurable without code changes", () => {
  const apex = rectangleLoop(1500, 1200, 5);
  const nearby = rectangleLoop(1500, 1200, 5, 700, 0);
  const tracks = [
    trackFrom(apex, { distanceM: SEVEN_MILES_M, key: "a".repeat(64) }),
    trackFrom(nearby, { distanceM: SEVEN_MILES_M, key: "b".repeat(64) }),
  ];

  const strict = discoverRoutes(tracks, 7, 0.5, { similarityThreshold: 0.95 });
  const loose = discoverRoutes(tracks, 7, 0.5, { similarityThreshold: 0.05 });

  assert.equal(strict.routes.length, 2);
  assert.equal(loose.routes.length, 1);
});

// ------------------------------------------------------------------- 6.3 empty results

test("an empty cache is distinguished from a no-match query", () => {
  const empty = discoverRoutes([], 7, 0.5);
  assert.equal(empty.state, "empty-cache");
  assert.equal(empty.routes.length, 0);

  const noMatch = discoverRoutes(
    [trackFrom(rectangleLoop(400, 300), { distanceM: 2000, key: "a".repeat(64) })],
    7,
    0.5,
  );
  assert.equal(noMatch.state, "no-match");
  assert.equal(noMatch.cachedCount, 1);
  assert.equal(noMatch.routes.length, 0);
});
