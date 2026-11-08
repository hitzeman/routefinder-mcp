import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { ensureCacheLayout, rawDir, tracksDir } from "../src/cache/paths.js";
import { projectRoot } from "../src/config.js";

/**
 * Writes into the real default cache location, because the point of this test is that
 * the default location is ignored by version control. Cleans up after itself.
 */
test("writing into both cache tiers leaves version control clean", async () => {
  const defaultCache = path.join(projectRoot, ".cache");
  await ensureCacheLayout(defaultCache);

  const rawProbe = path.join(rawDir(defaultCache), "layout-probe.fit");
  const trackProbe = path.join(tracksDir(defaultCache), "layout-probe.json");

  try {
    await fs.writeFile(rawProbe, Buffer.from([0x0e, 0x20]));
    await fs.writeFile(trackProbe, JSON.stringify({ probe: true }));

    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: projectRoot,
      encoding: "utf8",
    });

    const offending = status
      .split("\n")
      .filter((line) => line.trim() !== "")
      .filter((line) => line.includes(".cache"));

    assert.deepEqual(
      offending,
      [],
      `cache files must be ignored by git, but saw:\n${offending.join("\n")}`,
    );
  } finally {
    await fs.rm(rawProbe, { force: true });
    await fs.rm(trackProbe, { force: true });
  }
});

test("both cache tiers are created under the configured root", async () => {
  const root = path.join(projectRoot, ".cache", "test-layout");
  try {
    await ensureCacheLayout(root);
    assert.ok((await fs.stat(rawDir(root))).isDirectory());
    assert.ok((await fs.stat(tracksDir(root))).isDirectory());
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
