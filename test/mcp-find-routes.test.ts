import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { ActivityCache, type CachedTrack } from "../src/cache/store.js";
import { createServer } from "../src/server.js";
import { MILES_TO_METRES } from "../src/routes/geo.js";
import { jitter, rectangleLoop } from "./helpers/synthetic-tracks.js";

const SEVEN_MILES_M = 7 * MILES_TO_METRES;

interface Harness {
  client: Client;
  cache: ActivityCache;
  fetchCalls: () => number;
  close: () => Promise<void>;
}

async function connect(tracks: CachedTrack[]): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "routefinder-find-"));
  const cache = new ActivityCache(root);
  await cache.init();
  for (const track of tracks) await cache.putTrack(track);

  let calls = 0;
  const server = createServer({
    cache,
    fetchOptions: {
      fetchImpl: () => {
        calls += 1;
        throw new Error("find_routes must not issue network requests");
      },
    },
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
    fetchCalls: () => calls,
    close: async () => {
      await client.close();
      await server.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

function track(
  points: ReturnType<typeof rectangleLoop>,
  key: string,
  startTime: string,
): CachedTrack {
  return {
    key: key.padEnd(64, "0"),
    points,
    totalDistanceM: SEVEN_MILES_M,
    startTime,
    sport: "running",
  };
}

const apex = rectangleLoop(1500, 1200, 5);
const clubhouse = rectangleLoop(1400, 1100, 5, 6000, 6000);

const corpus: CachedTrack[] = [
  ...Array.from({ length: 4 }, (_, i) =>
    track(jitter(apex, 3), `a${i}`, `2026-01-0${i + 1}T12:00:00.000Z`),
  ),
  ...Array.from({ length: 2 }, (_, i) =>
    track(jitter(clubhouse, 3), `b${i}`, `2026-02-0${i + 1}T12:00:00.000Z`),
  ),
];

test("the server advertises find_routes", async () => {
  const harness = await connect(corpus);
  try {
    const { tools } = await harness.client.listTools();
    assert.ok(tools.map((t) => t.name).includes("find_routes"));
  } finally {
    await harness.close();
  }
});

/** Task 6.1 - a query must touch no network. */
test("a route query issues zero network requests", async () => {
  const harness = await connect(corpus);
  try {
    const result = await harness.client.callTool({
      name: "find_routes",
      arguments: { targetMiles: 7 },
    });

    assert.equal(harness.fetchCalls(), 0, "find_routes must not fetch");
    const structured = result.structuredContent as Record<string, unknown>;
    assert.equal(structured.state, "ok");
    assert.equal(structured.routeCount, 2);
  } finally {
    await harness.close();
  }
});

test("repeat queries return equivalent results and still issue no requests", async () => {
  const harness = await connect(corpus);
  try {
    const first = await harness.client.callTool({
      name: "find_routes",
      arguments: { targetMiles: 7 },
    });
    const second = await harness.client.callTool({
      name: "find_routes",
      arguments: { targetMiles: 7 },
    });

    assert.equal(harness.fetchCalls(), 0);
    assert.deepEqual(first.structuredContent, second.structuredContent);
  } finally {
    await harness.close();
  }
});

/** Task 6.2 - valid GeoJSON, one feature per route, properties present, size bounded. */
test("output is a valid GeoJSON FeatureCollection with one feature per route", async () => {
  const harness = await connect(corpus);
  try {
    const result = await harness.client.callTool({
      name: "find_routes",
      arguments: { targetMiles: 7 },
    });

    const structured = result.structuredContent as {
      routeCount: number;
      geojson: {
        type: string;
        features: Array<{
          type: string;
          geometry: { type: string; coordinates: Array<[number, number]> };
          properties: Record<string, unknown>;
        }>;
      };
    };

    const { geojson } = structured;
    assert.equal(geojson.type, "FeatureCollection");
    assert.equal(geojson.features.length, structured.routeCount);

    for (const feature of geojson.features) {
      assert.equal(feature.type, "Feature");
      assert.equal(feature.geometry.type, "LineString");
      assert.ok(feature.geometry.coordinates.length >= 2);

      for (const [lon, lat] of feature.geometry.coordinates) {
        assert.ok(lon >= -180 && lon <= 180, `longitude out of range: ${lon}`);
        assert.ok(lat >= -90 && lat <= 90, `latitude out of range: ${lat}`);
      }

      for (const key of [
        "id",
        "label",
        "distanceMiles",
        "runCount",
        "lastRunDate",
        "firstRunDate",
      ]) {
        assert.ok(key in feature.properties, `missing property ${key}`);
      }
    }

    const bytes = Buffer.byteLength(JSON.stringify(geojson));
    assert.ok(bytes < 400_000, `geojson too large for a context window: ${bytes} B`);
  } finally {
    await harness.close();
  }
});

test("a vertex cap is enforced per route", async () => {
  const dense = rectangleLoop(1500, 1200, 1);
  const harness = await connect([track(dense, "d0", "2026-01-01T12:00:00.000Z")]);
  try {
    process.env.ROUTEFINDER_MAX_VERTICES = "40";
    const result = await harness.client.callTool({
      name: "find_routes",
      arguments: { targetMiles: 7 },
    });

    const structured = result.structuredContent as {
      geojson: { features: Array<{ geometry: { coordinates: unknown[] } }> };
    };
    const count = structured.geojson.features[0]?.geometry.coordinates.length ?? 0;
    assert.ok(count <= 40, `vertex cap not applied: ${count}`);
  } finally {
    delete process.env.ROUTEFINDER_MAX_VERTICES;
    await harness.close();
  }
});

test("the full route including start and finish is returned", async () => {
  const harness = await connect([track(apex, "a0", "2026-01-01T12:00:00.000Z")]);
  try {
    const result = await harness.client.callTool({
      name: "find_routes",
      arguments: { targetMiles: 7 },
    });
    const structured = result.structuredContent as {
      geojson: { features: Array<{ geometry: { coordinates: Array<[number, number]> } }> };
    };
    const coords = structured.geojson.features[0]!.geometry.coordinates;

    // A closed loop: first and last coordinate coincide, so nothing was trimmed.
    assert.deepEqual(coords[0], coords[coords.length - 1]);
  } finally {
    await harness.close();
  }
});

/** Task 6.3 - empty cache and no-match are different conditions, neither an error. */
test("an empty cache reports that nothing has been ingested", async () => {
  const harness = await connect([]);
  try {
    const result = await harness.client.callTool({
      name: "find_routes",
      arguments: { targetMiles: 7 },
    });

    assert.notEqual(result.isError, true);
    const structured = result.structuredContent as Record<string, unknown>;
    assert.equal(structured.state, "empty-cache");
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    assert.match(text, /No activities have been ingested yet/);
  } finally {
    await harness.close();
  }
});

test("a no-match query reports the cache size rather than an error", async () => {
  const harness = await connect(corpus);
  try {
    const result = await harness.client.callTool({
      name: "find_routes",
      arguments: { targetMiles: 26.2 },
    });

    assert.notEqual(result.isError, true);
    const structured = result.structuredContent as Record<string, unknown>;
    assert.equal(structured.state, "no-match");
    assert.equal(structured.cachedCount, corpus.length);
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    assert.match(text, /No cached activity matched this distance/);
  } finally {
    await harness.close();
  }
});

test("the summary text states distance, run count and last-run date", async () => {
  const harness = await connect(corpus);
  try {
    const result = await harness.client.callTool({
      name: "find_routes",
      arguments: { targetMiles: 7 },
    });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";

    assert.match(text, /Route A: 7(\.\d+)? mi, run 4 times, last run 2026-01-04/);
    assert.match(text, /Route B: .* run 2 times/);
  } finally {
    await harness.close();
  }
});
