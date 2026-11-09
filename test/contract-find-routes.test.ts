/**
 * Contract tests for find_routes, exercised through a real MCP client.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ActivityCache } from "../src/cache/store.js";
import {
  FIND_ROUTES,
  findRoutesOutputSchema,
  MAX_TARGET_MILES,
  MAX_TOLERANCE_MILES,
  MIN_TARGET_MILES,
} from "../src/tools/find-routes.js";
import { connectHarness, textOf } from "./helpers/mcp-harness.js";
import { rectangleLoop, trackFrom } from "./helpers/synthetic-tracks.js";

test("valid input on an empty cache returns state empty-cache, not an error", async () => {
  const h = await connectHarness();
  try {
    const result = await h.client.callTool({ name: FIND_ROUTES, arguments: { targetMiles: 7 } });
    assert.notEqual(result.isError, true);
    const parsed = findRoutesOutputSchema.parse(result.structuredContent);
    assert.equal(parsed.state, "empty-cache");
    assert.equal(parsed.geojson.features.length, 0);
    assert.match(textOf(result), /ingest_activities/);
  } finally {
    await h.close();
  }
});

test("valid input on a populated cache returns routes matching the output schema", async () => {
  const h = await connectHarness();
  try {
    await h.cache.putTrack(trackFrom(rectangleLoop(2000, 800), { distanceM: 11_300 }));
    await h.cache.putTrack(trackFrom(rectangleLoop(2000, 800), { distanceM: 11_250 }));

    const result = await h.client.callTool({
      name: FIND_ROUTES,
      arguments: { targetMiles: 7, toleranceMiles: 0.3 },
    });
    assert.notEqual(result.isError, true);
    const parsed = findRoutesOutputSchema.parse(result.structuredContent);
    assert.equal(parsed.state, "ok");
    assert.equal(parsed.routeCount, 1);
    assert.equal(parsed.routes[0]?.runCount, 2);
    assert.equal(parsed.geojson.features.length, 1);
    assert.equal(parsed.unreadableCount, 0);
  } finally {
    await h.close();
  }
});

test("toleranceMiles defaults to 0.5 when omitted", async () => {
  const h = await connectHarness();
  try {
    // 7.45 mi: inside the default 0.5 tolerance of 7, outside 0.3.
    await h.cache.putTrack(trackFrom(rectangleLoop(2000, 800), { distanceM: 7.45 * 1609.344 }));
    const withDefault = findRoutesOutputSchema.parse(
      (await h.client.callTool({ name: FIND_ROUTES, arguments: { targetMiles: 7 } }))
        .structuredContent,
    );
    const narrow = findRoutesOutputSchema.parse(
      (
        await h.client.callTool({
          name: FIND_ROUTES,
          arguments: { targetMiles: 7, toleranceMiles: 0.3 },
        })
      ).structuredContent,
    );
    assert.equal(withDefault.state, "ok");
    assert.equal(narrow.state, "no-match");
  } finally {
    await h.close();
  }
});

const invalidInputs: Array<[string, unknown, RegExp]> = [
  ["missing targetMiles", {}, /targetMiles/],
  ["targetMiles as string", { targetMiles: "7" }, /targetMiles/],
  ["targetMiles below minimum", { targetMiles: MIN_TARGET_MILES / 2 }, /targetMiles/],
  ["targetMiles above maximum", { targetMiles: MAX_TARGET_MILES + 1 }, /targetMiles/],
  ["zero tolerance", { targetMiles: 7, toleranceMiles: 0 }, /toleranceMiles/],
  [
    "tolerance above maximum",
    { targetMiles: 7, toleranceMiles: MAX_TOLERANCE_MILES + 1 },
    /toleranceMiles/,
  ],
  ["snake_case guess", { target_miles: 7 }, /target_miles|targetMiles/],
];

for (const [label, args, expected] of invalidInputs) {
  test(`invalid input (${label}) returns isError naming the field`, async () => {
    const h = await connectHarness();
    try {
      const result = await h.client.callTool({
        name: FIND_ROUTES,
        arguments: args as Record<string, unknown>,
      });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /Input validation error/);
      assert.match(textOf(result), expected);
    } finally {
      await h.close();
    }
  });
}

test("an unusable cache directory returns a structured cache_unavailable error", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "routefinder-blocked-"));
  const blocker = path.join(dir, "not-a-directory");
  await fs.writeFile(blocker, "");
  const h = await connectHarness({ cache: new ActivityCache(blocker) });
  try {
    const result = await h.client.callTool({ name: FIND_ROUTES, arguments: { targetMiles: 7 } });
    assert.equal(result.isError, true);
    const body = JSON.parse(textOf(result)) as { error: { code: string; retryable: boolean } };
    assert.equal(body.error.code, "cache_unavailable");
    assert.equal(body.error.retryable, false);
  } finally {
    await h.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a corrupt cached track is counted, reported, and does not fail the call", async () => {
  const h = await connectHarness();
  try {
    await h.cache.putTrack(trackFrom(rectangleLoop(2000, 800), { distanceM: 11_300 }));
    await fs.writeFile(path.join(h.root, "tracks", `${"b".repeat(64)}.json`), "not json");
    const result = await h.client.callTool({ name: FIND_ROUTES, arguments: { targetMiles: 7 } });
    assert.notEqual(result.isError, true);
    const parsed = findRoutesOutputSchema.parse(result.structuredContent);
    assert.equal(parsed.unreadableCount, 1);
    assert.equal(parsed.routeCount, 1);
    assert.match(textOf(result), /unreadable/);
  } finally {
    await h.close();
  }
});
