/**
 * In-process integration: a real MCP client against the real server, with only the
 * network boundary mocked. Lists the tools, then runs the full ingest -> find_routes
 * flow on synthetic FIT files that go through the production decoder.
 *
 * If you add a tool, add it to EXPECTED_TOOLS and give it a call below. The first test
 * fails until you do, which is the point.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { FIND_ROUTES, findRoutesOutputSchema } from "../src/tools/find-routes.js";
import { INGEST_ACTIVITIES, ingestOutputSchema } from "../src/tools/ingest-activities.js";
import { syntheticFit } from "./helpers/fit-fixtures.js";
import { connectHarness, mockFetch, TEST_BASE } from "./helpers/mcp-harness.js";
import { jitter, outAndBack, rectangleLoop } from "./helpers/synthetic-tracks.js";

const EXPECTED_TOOLS = [FIND_ROUTES, INGEST_ACTIVITIES].sort();

test("the server advertises exactly the expected tools, each fully described", async () => {
  const h = await connectHarness();
  try {
    const { tools } = await h.client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), EXPECTED_TOOLS);
    for (const tool of tools) {
      assert.ok((tool.description ?? "").length > 80, `${tool.name} needs a real description`);
      assert.ok(tool.title, `${tool.name} needs a title`);
      assert.ok(tool.outputSchema, `${tool.name} needs an outputSchema`);
      assert.equal(
        (tool.inputSchema as { additionalProperties?: boolean }).additionalProperties,
        false,
        `${tool.name} input schema must reject unknown keys`,
      );
      const props = (tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
      for (const [name, prop] of Object.entries(props)) {
        assert.ok(prop.description, `${tool.name}.${name} needs a description`);
      }
      assert.ok(tool.annotations, `${tool.name} needs annotations`);
    }
  } finally {
    await h.close();
  }
});

test("the server sends workflow instructions to the client", async () => {
  const h = await connectHarness();
  try {
    assert.match(h.client.getInstructions() ?? "", /ingest_activities[\s\S]*find_routes/);
  } finally {
    await h.close();
  }
});

test("ingest then find_routes groups runs into distinct routes end to end", async () => {
  const MILE = 1609.344;
  const loopA = rectangleLoop(2400, 1100);
  const loopB = rectangleLoop(1600, 1200, 10, 3000, 0);
  const files: Record<string, Buffer> = {
    // Loop A three times, one reversed: direction must not split a route.
    "/fit/a1.fit": syntheticFit({ points: jitter(loopA, 3), totalDistanceM: 7.0 * MILE }),
    "/fit/a2.fit": syntheticFit({ points: jitter(loopA, 4), totalDistanceM: 7.1 * MILE }),
    "/fit/a3.fit": syntheticFit({
      points: [...loopA].reverse(),
      totalDistanceM: 7.05 * MILE,
      startTime: new Date("2026-03-12T12:00:00Z"),
    }),
    // Loop B twice.
    "/fit/b1.fit": syntheticFit({ points: loopB, totalDistanceM: 6.9 * MILE }),
    "/fit/b2.fit": syntheticFit({ points: jitter(loopB, 3), totalDistanceM: 6.95 * MILE }),
    // An out-and-back of the same distance: must stay its own route.
    "/fit/oab.fit": syntheticFit({ points: outAndBack(5600), totalDistanceM: 7.0 * MILE }),
    // Out of the distance band: must not appear.
    "/fit/far.fit": syntheticFit({ points: loopA, totalDistanceM: 13.1 * MILE }),
  };
  const { fetchImpl, requested } = mockFetch(files);
  const h = await connectHarness({ fetchImpl });
  try {
    const fitUrls = Object.keys(files).map((p) => `${TEST_BASE}${p}`);
    const ingest = await h.client.callTool({ name: INGEST_ACTIVITIES, arguments: { fitUrls } });
    const ingested = ingestOutputSchema.parse(ingest.structuredContent);
    assert.equal(ingested.newlyCached, 7);
    assert.equal(requested.length, 7);

    const found = await h.client.callTool({ name: FIND_ROUTES, arguments: { targetMiles: 7 } });
    const routes = findRoutesOutputSchema.parse(found.structuredContent);
    assert.equal(routes.state, "ok");
    assert.equal(routes.consideredCount, 6);
    assert.deepEqual(
      routes.routes.map((r) => [r.label, r.runCount]),
      [
        ["Route A", 3],
        ["Route B", 2],
        ["Route C", 1],
      ],
    );
    assert.equal(routes.routes[0]?.lastRunDate.slice(0, 10), "2026-03-12");
    for (const feature of routes.geojson.features) {
      assert.ok(feature.geometry.coordinates.length >= 2);
    }

    // A second find_routes and a repeat ingest are both free.
    await h.client.callTool({ name: FIND_ROUTES, arguments: { targetMiles: 7 } });
    const again = ingestOutputSchema.parse(
      (await h.client.callTool({ name: INGEST_ACTIVITIES, arguments: { fitUrls } }))
        .structuredContent,
    );
    assert.equal(again.alreadyCached, 7);
    assert.equal(again.requestsIssued, 0);
    assert.equal(requested.length, 7);
  } finally {
    await h.close();
  }
});
