import test from "node:test";
import assert from "node:assert/strict";

import { fetchActivityBytes, parseRetryAfter, type FetchLimits } from "../src/ingest/fetch.js";
import { findUrlLeak } from "./helpers/leak-detector.js";
import { mockFetch, TEST_BASE, TEST_POLICY } from "./helpers/mcp-harness.js";

const BYTES = Buffer.from("fit-bytes");
const URL_ = `${TEST_BASE}/fit/a.fit`;
const fast: FetchLimits = {
  maxBytes: 1024,
  timeoutMs: 1_000,
  retries: 1,
  retryBaseDelayMs: 1,
  maxRetryDelayMs: 50,
};

/** A fetch double that serves the given responses in order, then 200 with BYTES. */
function sequence(...responses: Array<() => Response>) {
  let call = 0;
  return mockFetch({
    "/fit/a.fit": () => {
      const next = responses[call];
      call += 1;
      return next ? next() : new Response(new Uint8Array(BYTES), { status: 200 });
    },
  });
}

test("parseRetryAfter reads delta-seconds and HTTP dates, rejects junk", () => {
  assert.equal(parseRetryAfter("2"), 2000);
  assert.equal(parseRetryAfter("0"), 0);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter("soon"), null);
  assert.equal(parseRetryAfter("-1"), null);
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(parseRetryAfter("Thu, 01 Jan 2026 00:00:03 GMT", now), 3000);
});

for (const status of [429, 500, 502, 503, 504]) {
  test(`HTTP ${status} is retried once and then succeeds`, async () => {
    const mock = sequence(() => new Response(null, { status }));
    const outcome = await fetchActivityBytes(URL_, {
      policy: TEST_POLICY,
      fetchImpl: mock.fetchImpl,
      limits: fast,
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.attempts, 2);
    assert.equal(mock.requested.length, 2);
  });
}

test("persistent 503 fails as retryable after the bounded retry", async () => {
  const mock = sequence(
    () => new Response(null, { status: 503 }),
    () => new Response(null, { status: 503 }),
    () => new Response(null, { status: 503 }),
  );
  const outcome = await fetchActivityBytes(URL_, {
    policy: TEST_POLICY,
    fetchImpl: mock.fetchImpl,
    limits: fast,
  });
  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok && outcome.retryable);
  assert.equal(mock.requested.length, 2, "one attempt plus exactly one retry");
});

test("404 is permanent: not retried, not retryable", async () => {
  const mock = sequence(() => new Response(null, { status: 404 }));
  const outcome = await fetchActivityBytes(URL_, {
    policy: TEST_POLICY,
    fetchImpl: mock.fetchImpl,
    limits: fast,
  });
  assert.ok(!outcome.ok);
  assert.equal(outcome.retryable, false);
  assert.match(outcome.reason, /HTTP 404/);
  assert.equal(mock.requested.length, 1);
});

test("a 429 asking to wait longer than the cap fails fast instead of stalling", async () => {
  const mock = sequence(
    () => new Response(null, { status: 429, headers: { "retry-after": "3600" } }),
  );
  const started = Date.now();
  const outcome = await fetchActivityBytes(URL_, {
    policy: TEST_POLICY,
    fetchImpl: mock.fetchImpl,
    limits: fast,
  });
  assert.ok(!outcome.ok);
  assert.equal(outcome.retryable, true);
  assert.match(outcome.reason, /rate limited/);
  assert.match(outcome.reason, /3600 s/);
  assert.equal(mock.requested.length, 1);
  assert.ok(Date.now() - started < 1_000);
});

test("a network error is retryable and its reason never echoes the URL", async () => {
  const secretUrl = `${TEST_BASE}/fit/athlete-55aa/file_beefbeef.fit`;
  const outcome = await fetchActivityBytes(secretUrl, {
    policy: TEST_POLICY,
    limits: { ...fast, retries: 0 },
    fetchImpl: () => Promise.reject(new TypeError(`fetch failed for ${secretUrl}`)),
  });
  assert.ok(!outcome.ok);
  assert.equal(outcome.retryable, true);
  assert.match(outcome.reason, /network error/);
  assert.equal(findUrlLeak(outcome.reason), null);
  assert.ok(!outcome.reason.includes("athlete-55aa"));
});

test("a policy rejection issues zero requests and is not retryable", async () => {
  const mock = sequence();
  const outcome = await fetchActivityBytes("https://elsewhere.test/fit/a.fit", {
    policy: TEST_POLICY,
    fetchImpl: mock.fetchImpl,
    limits: fast,
  });
  assert.ok(!outcome.ok);
  assert.equal(outcome.retryable, false);
  assert.equal(outcome.attempts, 0);
  assert.equal(mock.requested.length, 0);
});

test("an outer abort signal stops an in-flight download as retryable", async () => {
  const controller = new AbortController();
  const fetchImpl: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
      );
    });
  setTimeout(() => controller.abort(), 20);
  const outcome = await fetchActivityBytes(URL_, {
    policy: TEST_POLICY,
    fetchImpl,
    limits: { ...fast, timeoutMs: 5_000 },
    signal: controller.signal,
  });
  assert.ok(!outcome.ok);
  assert.equal(outcome.retryable, true);
  assert.match(outcome.reason, /deadline/);
});
