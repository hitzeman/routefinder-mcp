import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ActivityCache, cacheKey } from "../src/cache/store.js";
import { ingestActivities } from "../src/ingest/ingest.js";
import type { UrlPolicy } from "../src/ingest/url-policy.js";
import { startFixtureServer } from "./helpers/fixture-server.js";
import { syntheticFit } from "./helpers/fit-fixtures.js";

const testPolicy: UrlPolicy = {
  allowedHosts: ["activities.test"],
  allowedPathPrefix: "/fit/",
};
const base = "https://activities.test";

const fit = syntheticFit({
  points: [
    { lat: 33.2, lon: -96.7 },
    { lat: 33.201, lon: -96.701 },
    { lat: 33.202, lon: -96.702 },
  ],
  totalDistanceM: 11_300,
  startTime: new Date("2026-02-11T12:00:00Z"),
});

async function tempCache(): Promise<{ cache: ActivityCache; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "routefinder-cache-"));
  const cache = new ActivityCache(root);
  await cache.init();
  return {
    cache,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

test("cache key is a digest, not the URL", () => {
  const url = `${base}/fit/v2/athlete-1234/file_deadbeef.fit`;
  const key = cacheKey(url);

  assert.match(key, /^[0-9a-f]{64}$/);
  assert.ok(!key.includes("athlete-1234"));
  assert.ok(!key.includes("deadbeef"));
  assert.equal(cacheKey(url), key, "key must be stable for the same URL");
  assert.notEqual(cacheKey(`${url}x`), key);
});

/** Task 3.3 - the parsed tier is disposable; rebuilding it must issue no requests. */
test("deleting the parsed tier rebuilds tracks with zero network requests", async () => {
  const server = await startFixtureServer(fit);
  const { cache, cleanup } = await tempCache();
  try {
    const url = `${base}/fit/good.fit`;

    const first = await ingestActivities([url], {
      cache,
      policy: testPolicy,
      fetchImpl: server.fetchImpl,
    });
    assert.equal(first.newlyCached, 1);
    assert.equal(first.requestsIssued, 1);

    // Drop the whole parsed tier, keep raw bytes.
    const key = cacheKey(url);
    await fs.rm(path.join(cache.root, "tracks", `${key}.json`));
    assert.equal(await cache.hasTrack(key), false);
    assert.equal(await cache.hasRaw(key), true);

    const rebuilt = await ingestActivities([url], {
      cache,
      policy: testPolicy,
      fetchImpl: () => {
        throw new Error("rebuilding from raw must not issue a request");
      },
    });

    assert.equal(rebuilt.requestsIssued, 0);
    assert.equal(rebuilt.alreadyCached, 1);
    assert.equal(await cache.hasTrack(key), true);
  } finally {
    await cleanup();
    await server.close();
  }
});

test("raw bytes are written before parsing is attempted", async () => {
  const { cache, cleanup } = await tempCache();
  try {
    // Valid FIT structurally, but no positions: parsing fails after bytes land.
    const unusable = syntheticFit({
      points: Array.from({ length: 4 }, () => ({ lat: 0, lon: 0 })),
      withoutPositions: true,
    });
    const url = `${base}/fit/good.fit`;

    const result = await ingestActivities([url], {
      cache,
      policy: testPolicy,
      fetchImpl: async () =>
        new Response(unusable, {
          status: 200,
          headers: { "content-length": String(unusable.byteLength) },
        }),
    });

    assert.equal(result.unusable, 1);
    assert.equal(
      await cache.hasRaw(cacheKey(url)),
      true,
      "raw bytes must survive a parse failure so a retry costs no quota",
    );
  } finally {
    await cleanup();
  }
});

/** Task 3.4 - idempotence. */
test("repeat ingest of the same set issues zero requests", async () => {
  const server = await startFixtureServer(fit);
  const { cache, cleanup } = await tempCache();
  try {
    const url = `${base}/fit/good.fit`;

    const first = await ingestActivities([url], {
      cache,
      policy: testPolicy,
      fetchImpl: server.fetchImpl,
    });
    assert.equal(first.newlyCached, 1);

    const second = await ingestActivities([url], {
      cache,
      policy: testPolicy,
      fetchImpl: () => {
        throw new Error("a cached activity must not be requested again");
      },
    });

    assert.equal(second.requestsIssued, 0);
    assert.equal(second.alreadyCached, 1);
    assert.equal(second.newlyCached, 0);
  } finally {
    await cleanup();
    await server.close();
  }
});

test("a mixed batch fetches only the uncached activities", async () => {
  const server = await startFixtureServer(fit);
  const { cache, cleanup } = await tempCache();
  try {
    const cached = `${base}/fit/good.fit`;
    await ingestActivities([cached], {
      cache,
      policy: testPolicy,
      fetchImpl: server.fetchImpl,
    });

    const before = server.callCount();
    const result = await ingestActivities([cached, `${base}/fit/redirect-target.fit`], {
      cache,
      policy: testPolicy,
      fetchImpl: server.fetchImpl,
    });

    assert.equal(result.alreadyCached, 1);
    assert.equal(result.newlyCached, 1);
    assert.equal(result.requestsIssued, 1, "only the uncached activity is fetched");
    assert.equal(server.callCount() - before, 1);
  } finally {
    await cleanup();
    await server.close();
  }
});

/** Partial failure must not fail the batch. */
test("one bad activity does not fail the rest of the batch", async () => {
  const server = await startFixtureServer(fit);
  const { cache, cleanup } = await tempCache();
  try {
    const result = await ingestActivities(
      [`${base}/fit/good.fit`, `${base}/fit/missing.fit`, "https://evil.example.com/fit/x.fit"],
      { cache, policy: testPolicy, fetchImpl: server.fetchImpl },
    );

    assert.equal(result.newlyCached, 1);
    assert.equal(result.failed, 2);
    assert.equal(result.outcomes.length, 3);
    assert.equal(result.outcomes[0]?.status, "newly-cached");
    assert.equal(result.outcomes[1]?.status, "failed");
    assert.match(result.outcomes[1]?.reason ?? "", /HTTP 404/);
    assert.match(result.outcomes[2]?.reason ?? "", /allowlist/);
    // Indices let a caller correlate without the URL being echoed back.
    assert.deepEqual(
      result.outcomes.map((o) => o.index),
      [0, 1, 2],
    );
  } finally {
    await cleanup();
    await server.close();
  }
});

test("allTracks is ordered by key for deterministic iteration", async () => {
  const { cache, cleanup } = await tempCache();
  try {
    for (const seed of [1, 2, 3]) {
      const bytes = syntheticFit({
        points: [
          { lat: 33.2 + seed / 1000, lon: -96.7 },
          { lat: 33.21 + seed / 1000, lon: -96.71 },
        ],
        totalDistanceM: 11_000 + seed,
      });
      const key = cacheKey(`${base}/fit/track-${seed}.fit`);
      await cache.putRaw(key, bytes);
      await cache.parseFromRaw(key);
    }

    const keys = (await cache.allTracks()).map((t) => t.key);
    assert.deepEqual(keys, [...keys].sort());
    assert.equal(keys.length, 3);
  } finally {
    await cleanup();
  }
});
