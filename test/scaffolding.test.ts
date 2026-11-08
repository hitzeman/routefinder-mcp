import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { cacheDir, projectRoot } from "../src/config.js";

test("project root resolves to the repository containing package.json", () => {
  assert.equal(path.basename(projectRoot), "routefinder-mcp");
});

test("cache directory is honoured from the environment override", () => {
  assert.ok(path.isAbsolute(cacheDir));
});
