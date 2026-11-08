import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { ActivityCache } from "../src/cache/store.js";
import { createServer } from "../src/server.js";
import type { UrlPolicy } from "../src/ingest/url-policy.js";
import { startFixtureServer } from "./helpers/fixture-server.js";
import { syntheticFit } from "./helpers/fit-fixtures.js";
import { findSecretFragment, findUrlLeak } from "./helpers/leak-detector.js";

const testPolicy: UrlPolicy = {
  allowedHosts: ["activities.test"],
  allowedPathPrefix: "/fit/",
};
const base = "https://activities.test";

const fit = syntheticFit({
  points: [
    { lat: 33.2, lon: -96.7 },
    { lat: 33.21, lon: -96.71 },
    { lat: 33.22, lon: -96.72 },
  ],
  totalDistanceM: 11_300,
  startTime: new Date("2026-02-11T12:00:00Z"),
});

interface Harness {
  client: Client;
  cache: ActivityCache;
  close: () => Promise<void>;
}

/** A genuine MCP client talking to a genuine server, over a linked in-memory pair. */
async function connectHarness(
  fetchImpl: typeof globalThis.fetch,
): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "routefinder-mcp-"));
  const cache = new ActivityCache(root);
  await cache.init();

  const server = createServer({
    cache,
    fetchOptions: { policy: testPolicy, fetchImpl },
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return {
    client,
    cache,
    close: async () => {
      await client.close();
      await server.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

test("the server advertises ingest_activities", async () => {
  const server = await connectHarness(async () => new Response(null, { status: 500 }));
  try {
    const { tools } = await server.client.listTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("ingest_activities"), `got tools: ${names.join(", ")}`);

    const tool = tools.find((t) => t.name === "ingest_activities");
    assert.ok(tool?.inputSchema);
  } finally {
    await server.close();
  }
});

/** Task 4.1 - a client call returns the three outcome counts for a mixed batch. */
test("an MCP call reports newly-cached, already-cached, and failed counts", async () => {
  const fixture = await startFixtureServer(fit);
  const harness = await connectHarness(fixture.fetchImpl);
  try {
    // Prime one activity so the second call sees a genuine mix.
    await harness.client.callTool({
      name: "ingest_activities",
      arguments: { fitUrls: [`${base}/fit/good.fit`] },
    });

    const result = await harness.client.callTool({
      name: "ingest_activities",
      arguments: {
        fitUrls: [
          `${base}/fit/good.fit`,
          `${base}/fit/redirect-target.fit`,
          `${base}/fit/missing.fit`,
        ],
      },
    });

    const structured = result.structuredContent as Record<string, number>;
    assert.equal(structured.alreadyCached, 1);
    assert.equal(structured.newlyCached, 1);
    assert.equal(structured.failed, 1);
    assert.equal(structured.requestsIssued, 2, "the cached activity is not re-requested");

    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    assert.match(text, /1 newly cached/);
    assert.match(text, /1 already cached/);
    assert.match(text, /1 failed/);
  } finally {
    await harness.close();
    await fixture.close();
  }
});

/**
 * Task 4.2 - partial-failure resilience end to end, including that the failure reason
 * names the activity without reproducing its URL.
 */
test("one unreachable URL does not prevent the others from caching", async () => {
  const fixture = await startFixtureServer(fit);
  const harness = await connectHarness(fixture.fetchImpl);
  const secretFragments = ["athlete-7c1f", "beefcafe99"];
  try {
    const result = await harness.client.callTool({
      name: "ingest_activities",
      arguments: {
        fitUrls: [
          `${base}/fit/good.fit?athlete-7c1f=1`,
          `${base}/fit/does-not-exist.fit#beefcafe99`,
          `${base}/fit/redirect.fit`,
        ],
      },
    });

    const structured = result.structuredContent as Record<string, unknown>;
    assert.equal(structured.newlyCached, 1, "the good activity must still cache");
    assert.equal(structured.failed, 2);

    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";

    // The reason is present and specific...
    assert.match(text, /HTTP 404/);
    assert.match(text, /refused redirect/);
    // ...and identifies the activity by index and digest, not by URL.
    assert.match(text, /#1 \([0-9a-f]{12}\)/);

    // Nothing in the whole response echoes a URL or a secret fragment.
    const whole = JSON.stringify(result);
    assert.equal(findUrlLeak(whole), null, `URL leaked in tool output: ${whole}`);
    assert.equal(findSecretFragment(whole, secretFragments), null);

    assert.equal(
      fixture.hits.get("/fit/redirect-target.fit") ?? 0,
      0,
      "a redirect target must never be fetched",
    );
  } finally {
    await harness.close();
    await fixture.close();
  }
});

test("an empty URL list is rejected by the input schema", async () => {
  const harness = await connectHarness(async () => {
    throw new Error("must not fetch");
  });
  try {
    const result = await harness.client.callTool({
      name: "ingest_activities",
      arguments: { fitUrls: [] },
    });
    assert.equal(result.isError, true);
  } finally {
    await harness.close();
  }
});
