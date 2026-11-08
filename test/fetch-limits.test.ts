import test from "node:test";
import assert from "node:assert/strict";

import { fetchActivityBytes } from "../src/ingest/fetch.js";
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
  ],
  totalDistanceM: 150,
});

test("a conforming response returns the exact bytes", async () => {
  const server = await startFixtureServer(fit);
  try {
    const outcome = await fetchActivityBytes(`${base}/fit/good.fit`, {
      policy: testPolicy,
      fetchImpl: server.fetchImpl,
    });

    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.bytes.byteLength, fit.byteLength);
    assert.ok(outcome.bytes.equals(fit));
  } finally {
    await server.close();
  }
});

test("a response declaring more than the size cap is rejected", async () => {
  const server = await startFixtureServer(fit);
  try {
    const outcome = await fetchActivityBytes(`${base}/fit/oversized-declared.fit`, {
      policy: testPolicy,
      fetchImpl: server.fetchImpl,
      limits: { maxBytes: 1024, timeoutMs: 5_000 },
    });

    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.match(outcome.reason, /exceeds the 1024 B limit/);
  } finally {
    await server.close();
  }
});

/** With chunked encoding there is no declared length, so only the streaming cap applies. */
test("a chunked response exceeding the size cap is aborted mid-stream", async () => {
  const server = await startFixtureServer(fit);
  try {
    const outcome = await fetchActivityBytes(`${base}/fit/oversized-chunked.fit`, {
      policy: testPolicy,
      fetchImpl: server.fetchImpl,
      limits: { maxBytes: 1024, timeoutMs: 5_000 },
    });

    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.match(outcome.reason, /exceeded the 1024 B limit/);
  } finally {
    await server.close();
  }
});

test("a response that never completes hits the timeout", async () => {
  const server = await startFixtureServer(fit);
  try {
    const outcome = await fetchActivityBytes(`${base}/fit/slow.fit`, {
      policy: testPolicy,
      fetchImpl: server.fetchImpl,
      limits: { maxBytes: 1024 * 1024, timeoutMs: 250 },
    });

    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.match(outcome.reason, /timed out after 250 ms/);
  } finally {
    await server.close();
  }
});

/** Spec: the fetch fails and the redirect target is not requested. */
test("a redirect is refused and its target is never requested", async () => {
  const server = await startFixtureServer(fit);
  try {
    const outcome = await fetchActivityBytes(`${base}/fit/redirect.fit`, {
      policy: testPolicy,
      fetchImpl: server.fetchImpl,
    });

    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.match(outcome.reason, /refused redirect/);
    assert.equal(
      server.hits.get("/fit/redirect-target.fit") ?? 0,
      0,
      "the redirect target must never be fetched",
    );
  } finally {
    await server.close();
  }
});

test("an error status is reported as a failure", async () => {
  const server = await startFixtureServer(fit);
  try {
    const outcome = await fetchActivityBytes(`${base}/fit/missing.fit`, {
      policy: testPolicy,
      fetchImpl: server.fetchImpl,
    });

    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.match(outcome.reason, /HTTP 404/);
  } finally {
    await server.close();
  }
});

/**
 * A conforming HTTP/1.1 server cannot cleanly end a body short of its own
 * Content-Length, so this branch is exercised directly: it guards against a transport
 * that reports one length and delivers another.
 */
test("a body shorter than its declared length is rejected as truncated", async () => {
  const outcome = await fetchActivityBytes(`${base}/fit/good.fit`, {
    policy: testPolicy,
    fetchImpl: async () =>
      new Response(Buffer.from([1, 2, 3]), {
        status: 200,
        headers: { "content-length": "999" },
      }),
  });

  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.reason, /truncated response: received 3 B of a declared 999 B/);
});

test("fetch sends no credentials", async () => {
  let seenHeaders: Headers | undefined;
  const outcome = await fetchActivityBytes(`${base}/fit/good.fit`, {
    policy: testPolicy,
    fetchImpl: async (_input, init) => {
      seenHeaders = new Headers(init?.headers);
      return new Response(fit, {
        status: 200,
        headers: { "content-length": String(fit.byteLength) },
      });
    },
  });

  assert.equal(outcome.ok, true);
  assert.equal(seenHeaders?.get("authorization"), null);
  assert.equal(seenHeaders?.get("cookie"), null);
});
