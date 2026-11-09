import test from "node:test";
import assert from "node:assert/strict";

import { ConfigError, loadSettings } from "../src/config.js";

test("defaults apply when no ROUTEFINDER_* variable is set", () => {
  const settings = loadSettings({});
  assert.deepEqual(settings.discover, {
    cellSizeM: 75,
    similarityThreshold: 0.35,
    simplifyToleranceM: 10,
    maxVertices: 400,
    minExtentRatio: 0.05,
  });
  assert.deepEqual(settings.ingest, { concurrency: 4, deadlineMs: 45_000, fetchTimeoutMs: 15_000 });
});

test("valid overrides are parsed from strings", () => {
  const settings = loadSettings({
    ROUTEFINDER_CELL_SIZE_M: "50",
    ROUTEFINDER_SIMILARITY_THRESHOLD: "0.5",
    ROUTEFINDER_INGEST_CONCURRENCY: "2",
  });
  assert.equal(settings.discover.cellSizeM, 50);
  assert.equal(settings.discover.similarityThreshold, 0.5);
  assert.equal(settings.ingest.concurrency, 2);
});

test("an empty string is treated as unset, as MCP client configs often express it", () => {
  assert.equal(loadSettings({ ROUTEFINDER_CELL_SIZE_M: "" }).discover.cellSizeM, 75);
});

const invalid: Array<[string, string, RegExp]> = [
  // The regression this validation exists for: a negative cell size used to be accepted
  // and merged every run into one route.
  ["ROUTEFINDER_CELL_SIZE_M", "-5", />= 5/],
  ["ROUTEFINDER_CELL_SIZE_M", "abc", /must be a number/],
  ["ROUTEFINDER_SIMILARITY_THRESHOLD", "1.5", /<= 1/],
  ["ROUTEFINDER_MAX_VERTICES", "12.5", /integer/],
  ["ROUTEFINDER_INGEST_DEADLINE_MS", "10", />= 1000/],
];

for (const [name, value, expected] of invalid) {
  test(`${name}=${value} fails fast with a message naming the variable`, () => {
    assert.throws(
      () => loadSettings({ [name]: value }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, new RegExp(name));
        assert.match(error.message, expected);
        return true;
      },
    );
  });
}

test("every problem is reported at once, not just the first", () => {
  assert.throws(
    () => loadSettings({ ROUTEFINDER_CELL_SIZE_M: "0", ROUTEFINDER_MAX_VERTICES: "1" }),
    (error: unknown) => error instanceof ConfigError && error.problems.length === 2,
  );
});
