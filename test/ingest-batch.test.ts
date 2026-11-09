import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ActivityCache, cacheKey } from "../src/cache/store.js";
import { ingestActivities } from "../src/ingest/ingest.js";
import { syntheticFit } from "./helpers/fit-fixtures.js";
import { mockFetch, TEST_BASE, TEST_POLICY } from "./helpers/mcp-harness.js";
import { pointAt } from "./helpers/synthetic-tracks.js";

const fit = syntheticFit({
  points: [pointAt(0, 0), pointAt(500, 0), pointAt(500, 500)],
  totalDistanceM: 11_300,
});

const limits = { maxBytes: 1024 * 1024, timeoutMs: 2_000, retries: 0 };

async function withCache<T>(fn: (cache: ActivityCache, root: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "routefinder-batch-"));
  try {
    return await fn(new ActivityCache(root), root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("downloads never exceed the configured concurrency", async () => {
  await withCache(async (cache) => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl: typeof fetch = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
      return new Response(new Uint8Array(fit), { status: 200 });
    };
    const urls = Array.from({ length: 9 }, (_, i) => `${TEST_BASE}/fit/${i}.fit`);
    const result = await ingestActivities(urls, {
      cache,
      policy: TEST_POLICY,
      fetchImpl,
      limits,
      concurrency: 3,
    });
    assert.equal(result.newlyCached, 9);
    assert.equal(peak, 3);
  });
});

test("outcomes stay in submission order under concurrency", async () => {
  await withCache(async (cache) => {
    const { fetchImpl } = mockFetch({ "/fit/0.fit": fit, "/fit/2.fit": fit });
    const urls = [0, 1, 2].map((i) => `${TEST_BASE}/fit/${i}.fit`);
    const result = await ingestActivities(urls, { cache, policy: TEST_POLICY, fetchImpl, limits });
    assert.deepEqual(
      result.outcomes.map((o) => [o.index, o.status]),
      [
        [0, "newly-cached"],
        [1, "failed"],
        [2, "newly-cached"],
      ],
    );
  });
});

test("the batch deadline returns a partial, resumable result", async () => {
  await withCache(async (cache) => {
    const slowFetch: typeof fetch = (_input, init) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => resolve(new Response(new Uint8Array(fit), { status: 200 })),
          40,
        );
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    const urls = Array.from({ length: 6 }, (_, i) => `${TEST_BASE}/fit/${i}.fit`);

    const first = await ingestActivities(urls, {
      cache,
      policy: TEST_POLICY,
      fetchImpl: slowFetch,
      limits,
      concurrency: 1,
      deadlineMs: 200,
    });
    assert.equal(first.deadlineReached, true);
    assert.ok(first.newlyCached >= 1, "work finished before the deadline is kept");
    const unfinished = first.outcomes.filter((o) => o.status !== "newly-cached");
    assert.ok(unfinished.length >= 1);
    for (const outcome of unfinished) {
      assert.equal(outcome.retryable, true);
      assert.match(outcome.reason ?? "", /deadline/);
    }

    // Resubmitting finishes the job and re-requests nothing already cached.
    const { fetchImpl, requested } = mockFetch(
      Object.fromEntries(urls.map((_, i) => [`/fit/${i}.fit`, fit])),
    );
    const second = await ingestActivities(urls, { cache, policy: TEST_POLICY, fetchImpl, limits });
    assert.equal(second.deadlineReached, false);
    assert.equal(second.alreadyCached, first.newlyCached);
    assert.equal(second.newlyCached, 6 - first.newlyCached);
    assert.equal(requested.length, 6 - first.newlyCached);
  });
});

test("a duplicate URL in one batch is fetched once and the copy is skipped", async () => {
  await withCache(async (cache) => {
    const { fetchImpl, requested } = mockFetch({ "/fit/a.fit": fit });
    const url = `${TEST_BASE}/fit/a.fit`;
    const result = await ingestActivities([url, url], {
      cache,
      policy: TEST_POLICY,
      fetchImpl,
      limits,
    });
    assert.equal(requested.length, 1);
    assert.equal(result.outcomes[1]?.status, "skipped");
    assert.equal(result.outcomes[1]?.retryable, false);
    assert.match(result.outcomes[1]?.reason ?? "", /duplicate of #0/);
  });
});

test("a corrupt track file is rebuilt from raw bytes with zero requests", async () => {
  await withCache(async (cache, root) => {
    const url = `${TEST_BASE}/fit/a.fit`;
    const { fetchImpl } = mockFetch({ "/fit/a.fit": fit });
    await ingestActivities([url], { cache, policy: TEST_POLICY, fetchImpl, limits });

    const key = cacheKey(url);
    await fs.writeFile(path.join(root, "tracks", `${key}.json`), '{"key":"oops"');
    const loaded = await cache.loadTracks();
    assert.deepEqual(loaded.unreadable, [key]);
    assert.equal(loaded.tracks.length, 0);

    const offline = mockFetch({});
    const result = await ingestActivities([url], {
      cache,
      policy: TEST_POLICY,
      fetchImpl: offline.fetchImpl,
      limits,
    });
    assert.equal(result.alreadyCached, 1);
    assert.equal(offline.requested.length, 0);
    assert.equal((await cache.loadTracks()).unreadable.length, 0);
  });
});

test("a structurally valid track with impossible values is treated as unreadable", async () => {
  await withCache(async (cache, root) => {
    await cache.init();
    const key = "a".repeat(64);
    await fs.writeFile(
      path.join(root, "tracks", `${key}.json`),
      JSON.stringify({
        key,
        points: [{ lat: 123, lon: 0 }],
        totalDistanceM: 1000,
        startTime: "2026-01-01T00:00:00.000Z",
        sport: null,
      }),
    );
    assert.deepEqual((await cache.loadTracks()).unreadable, [key]);
  });
});
