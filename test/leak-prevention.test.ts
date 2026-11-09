import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ActivityCache } from "../src/cache/store.js";
import { ingestActivities } from "../src/ingest/ingest.js";
import type { UrlPolicy } from "../src/ingest/url-policy.js";
import { logInfo, redact, setLogSink } from "../src/log.js";
import { startFixtureServer } from "./helpers/fixture-server.js";
import { syntheticFit } from "./helpers/fit-fixtures.js";
import {
  findCoordinateLeak,
  findSecretFragment,
  findUrlLeak,
} from "./helpers/leak-detector.js";

const testPolicy: UrlPolicy = {
  allowedHosts: ["activities.test"],
  allowedPathPrefix: "/fit/",
};
const base = "https://activities.test";

/** Distinctive fragments that would identify a leak of the URLs used below. */
const SECRET_FRAGMENTS = ["athlete-9f3c21", "deadbeefcafe"];

const fit = syntheticFit({
  points: [
    { lat: 51.477928, lon: -0.001545 },
    { lat: 51.478512, lon: -0.000921 },
    { lat: 51.479104, lon: -0.000307 },
  ],
  totalDistanceM: 11_300,
  startTime: new Date("2026-02-11T12:00:00Z"),
});

/**
 * Negative control: proves the detector actually detects. Without this, a leak test that
 * trivially passes would be indistinguishable from one that works.
 */
test("the leak detector catches a deliberately leaked URL and coordinate", () => {
  const leaky = [
    "[routefinder] info fetched https://s3.coros.com/fit/v2/athlete-9f3c21/x_deadbeefcafe.fit",
    "[routefinder] info point 51.477928,-0.001545",
  ].join("\n");

  assert.ok(findUrlLeak(leaky) !== null, "detector must flag a URL");
  assert.ok(findCoordinateLeak(leaky) !== null, "detector must flag a coordinate");
  assert.equal(findSecretFragment(leaky, SECRET_FRAGMENTS), "athlete-9f3c21");
});

test("the detector does not flag ordinary distances or counts", () => {
  const benign = [
    "[routefinder] info ingest complete: 30 newly cached, 0 failed, 30 requests issued",
    "[routefinder] info activity #3 (a1b2c3d4e5f6) cached, 2402 points",
    "[routefinder] info route distance 11300.25 m over 7.08 mi",
  ].join("\n");

  assert.equal(findUrlLeak(benign), null);
  assert.equal(findCoordinateLeak(benign), null);
});

test("redact strips URLs and coordinates passed to the logger", () => {
  const scrubbed = redact(
    "fetched https://s3.coros.com/fit/v2/athlete-9f3c21/x_deadbeefcafe.fit at 51.477928,-0.001545",
  );

  assert.ok(!scrubbed.includes("athlete-9f3c21"));
  assert.ok(!scrubbed.includes("51.477928"));
  assert.match(scrubbed, /\[url-redacted\]/);
  assert.match(scrubbed, /\[coord-redacted\]/);
});

test("the logger writes through the sink and never to stdout", () => {
  const lines: string[] = [];
  setLogSink((line) => lines.push(line));
  try {
    logInfo("plain message");
    assert.deepEqual(lines, ["[routefinder] info plain message"]);
  } finally {
    setLogSink(null);
  }
});

/**
 * The real assertion: run an ingest that both succeeds and fails, then scan everything it
 * produced -- logs, cache file contents, cache filenames, and the returned outcomes.
 */
test("a real ingest leaks no URL into logs, cache, filenames, or outcomes", async () => {
  const server = await startFixtureServer(fit);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "routefinder-leak-"));
  const cache = new ActivityCache(root);

  const lines: string[] = [];
  setLogSink((line) => lines.push(line));

  try {
    const urls = [
      `${base}/fit/good.fit?athlete-9f3c21=1`,
      `${base}/fit/missing.fit#deadbeefcafe`,
      "https://evil.example.com/fit/athlete-9f3c21/deadbeefcafe.fit",
    ];

    const result = await ingestActivities(urls, {
      cache,
      policy: testPolicy,
      fetchImpl: server.fetchImpl,
    });

    assert.equal(result.newlyCached, 1);
    assert.ok(result.failed >= 1);

    // 1. Logs: no URLs, no coordinates, no secret fragments.
    const logText = lines.join("\n");
    assert.equal(findUrlLeak(logText), null, `URL leaked into logs: ${logText}`);
    assert.equal(
      findCoordinateLeak(logText),
      null,
      `coordinate leaked into logs: ${logText}`,
    );
    assert.equal(findSecretFragment(logText, SECRET_FRAGMENTS), null);

    // 2. Returned outcomes: no URLs anywhere, including reasons.
    const outcomeText = JSON.stringify(result);
    assert.equal(findUrlLeak(outcomeText), null);
    assert.equal(findSecretFragment(outcomeText, SECRET_FRAGMENTS), null);

    // 3. Cache filenames: digests only.
    const rawNames = await fs.readdir(path.join(root, "raw"));
    const trackNames = await fs.readdir(path.join(root, "tracks"));
    for (const name of [...rawNames, ...trackNames]) {
      assert.match(name, /^[0-9a-f]{64}\.(fit|json)$/, `unexpected cache filename ${name}`);
      assert.equal(findSecretFragment(name, SECRET_FRAGMENTS), null);
    }

    // 4. Cache contents: no URL. Coordinates are expected here and allowed.
    for (const name of trackNames) {
      const content = await fs.readFile(path.join(root, "tracks", name), "utf8");
      assert.equal(findUrlLeak(content), null, `URL leaked into cached track ${name}`);
      assert.equal(findSecretFragment(content, SECRET_FRAGMENTS), null);
      assert.ok(
        findCoordinateLeak(content) !== null,
        "a cached track should contain coordinates; otherwise this scan proves nothing",
      );
    }
  } finally {
    setLogSink(null);
    await fs.rm(root, { recursive: true, force: true });
    await server.close();
  }
});
