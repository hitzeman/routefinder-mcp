/**
 * Smoke test of the shipped entry point over the real stdio transport.
 *
 * The in-process tests cannot catch a stray write to stdout (which corrupts JSON-RPC
 * framing), a broken shebang/bin path, or a startup crash. This spawns the built
 * dist/src/index.js exactly as an MCP client would.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { projectRoot } from "../src/config.js";

const entry = path.join(projectRoot, "dist", "src", "index.js");

test("the built server starts on stdio, lists tools, and answers a call", async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "routefinder-stdio-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { ROUTEFINDER_CACHE_DIR: cacheRoot, PATH: process.env.PATH ?? "" },
    stderr: "pipe",
  });
  const client = new Client({ name: "stdio-smoke", version: "1.0.0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["find_routes", "ingest_activities"]);

    const result = await client.callTool({ name: "find_routes", arguments: { targetMiles: 7 } });
    assert.equal((result.structuredContent as { state: string }).state, "empty-cache");
  } finally {
    await client.close();
    await fs.rm(cacheRoot, { recursive: true, force: true });
  }
});

test("an invalid tuning variable stops the server at launch with a clear message", () => {
  const run = spawnSync(process.execPath, [entry], {
    env: { ROUTEFINDER_CELL_SIZE_M: "-1", PATH: process.env.PATH ?? "" },
    input: "",
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /ROUTEFINDER_CELL_SIZE_M must be >= 5/);
  assert.equal(run.stdout, "", "nothing may be written to stdout");
});
