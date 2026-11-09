/**
 * Contract tests for ingest_activities, exercised through a real MCP client.
 *
 * Every tool must have: valid input -> structuredContent matching the exported output
 * schema; invalid input -> isError with a message naming the offending field; unexpected
 * failure -> isError with a JSON {error: {code, message, retryable}} body.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ActivityCache } from "../src/cache/store.js";
import {
  INGEST_ACTIVITIES,
  ingestOutputSchema,
  MAX_BATCH,
  MAX_URL_LENGTH,
} from "../src/tools/ingest-activities.js";
import { syntheticFit } from "./helpers/fit-fixtures.js";
import { findUrlLeak } from "./helpers/leak-detector.js";
import { connectHarness, mockFetch, TEST_BASE, textOf } from "./helpers/mcp-harness.js";
import { pointAt } from "./helpers/synthetic-tracks.js";

const fit = syntheticFit({ points: [pointAt(0, 0), pointAt(300, 400)], totalDistanceM: 11_300 });

test("valid input returns structuredContent matching the output schema", async () => {
  const { fetchImpl } = mockFetch({ "/fit/good.fit": fit });
  const h = await connectHarness({ fetchImpl });
  try {
    const result = await h.client.callTool({
      name: INGEST_ACTIVITIES,
      arguments: { fitUrls: [`${TEST_BASE}/fit/good.fit`, `${TEST_BASE}/fit/missing.fit`] },
    });
    assert.notEqual(result.isError, true);
    const parsed = ingestOutputSchema.parse(result.structuredContent);
    assert.equal(parsed.newlyCached, 1);
    assert.equal(parsed.failed, 1);
    assert.equal(parsed.outcomes[1]?.retryable, false);
    assert.match(textOf(result), /1 newly cached/);
  } finally {
    await h.close();
  }
});

const invalidInputs: Array<[string, unknown, RegExp]> = [
  ["missing fitUrls", {}, /fitUrls/],
  ["empty list", { fitUrls: [] }, /fitUrls/],
  ["not an array", { fitUrls: "https://activities.test/fit/a.fit" }, /fitUrls/],
  ["non-string item", { fitUrls: [42] }, /fitUrls/],
  ["empty string item", { fitUrls: [""] }, /fitUrls/],
  [
    `more than ${MAX_BATCH} URLs`,
    { fitUrls: Array.from({ length: MAX_BATCH + 1 }, (_, i) => `${TEST_BASE}/fit/${i}.fit`) },
    /fitUrls/,
  ],
  [
    `URL longer than ${MAX_URL_LENGTH}`,
    { fitUrls: [`${TEST_BASE}/fit/${"a".repeat(MAX_URL_LENGTH)}.fit`] },
    /fitUrls/,
  ],
  ["unknown parameter", { fitUrls: [`${TEST_BASE}/fit/a.fit`], urls: [] }, /Unrecognized key.*urls/],
];

for (const [label, args, expected] of invalidInputs) {
  test(`invalid input (${label}) returns isError naming the field, issues no request`, async () => {
    const mock = mockFetch({});
    const h = await connectHarness({ fetchImpl: mock.fetchImpl });
    try {
      const result = await h.client.callTool({
        name: INGEST_ACTIVITIES,
        arguments: args as Record<string, unknown>,
      });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /Input validation error/);
      assert.match(textOf(result), expected);
      assert.equal(mock.requested.length, 0);
      // A rejected secret URL must not be echoed back by the validation message.
      assert.equal(findUrlLeak(textOf(result)), null, textOf(result));
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
    const result = await h.client.callTool({
      name: INGEST_ACTIVITIES,
      arguments: { fitUrls: [`${TEST_BASE}/fit/a.fit`] },
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
    const body = JSON.parse(textOf(result)) as {
      error: { code: string; message: string; retryable: boolean };
    };
    assert.equal(body.error.code, "cache_unavailable");
    assert.equal(body.error.retryable, false);
    assert.match(body.error.message, /ROUTEFINDER_CACHE_DIR/);
    assert.doesNotMatch(body.error.message, /\n\s+at /, "no stack trace");
  } finally {
    await h.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
