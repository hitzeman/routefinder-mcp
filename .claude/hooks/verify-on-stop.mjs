#!/usr/bin/env node
/**
 * Stop hook: the agent may not finish while typecheck or tests fail.
 *
 * Runs only when the working tree has changes that could affect the build, so a pure
 * question-and-answer turn stays fast. On failure it returns {"decision":"block"} with
 * the failing lines as the reason, which Claude Code feeds back to the agent as the next
 * thing to fix.
 *
 * Loop guard: after MAX_BLOCKS consecutive blocked stops in one session the hook lets the
 * agent stop and tells the human instead, so a change the agent cannot fix does not spin
 * forever. A green run resets the count.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_BLOCKS = 3;
const RELEVANT = /^(src\/|test\/|package(-lock)?\.json$|tsconfig\.json$|eslint\.config\.js$)/;

const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
const projectDir = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
const sessionId = String(input.session_id ?? "unknown").replace(/[^A-Za-z0-9_-]/g, "");
const counterFile = path.join(os.tmpdir(), `routefinder-verify-${sessionId}`);

const respond = (body) => {
  process.stdout.write(JSON.stringify(body));
  process.exit(0);
};

let changed;
try {
  changed = execFileSync("git", ["status", "--porcelain"], { cwd: projectDir, encoding: "utf8" })
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter((file) => RELEVANT.test(file));
} catch {
  // Not a git checkout: verify anyway.
  changed = ["(unknown)"];
}
if (changed.length === 0) respond({});

const run = (script) =>
  spawnSync("npm", ["run", "--silent", script], {
    cwd: projectDir,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
    maxBuffer: 64 * 1024 * 1024,
  });

const failures = [];
for (const script of ["typecheck", "test"]) {
  const result = run(script);
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const interesting = output
      .split("\n")
      .filter((line) => /error TS|^not ok|AssertionError|Error:|expected|actual/.test(line))
      .slice(0, 40);
    failures.push(
      `npm run ${script} failed:\n${(interesting.length > 0 ? interesting : output.split("\n").slice(-40)).join("\n")}`,
    );
    break; // A type error makes the test run noise; fix in order.
  }
}

if (failures.length === 0) {
  fs.rmSync(counterFile, { force: true });
  respond({});
}

const blocks = Number(fs.existsSync(counterFile) ? fs.readFileSync(counterFile, "utf8") : 0) + 1;
if (blocks > MAX_BLOCKS) {
  fs.rmSync(counterFile, { force: true });
  respond({
    systemMessage:
      `verify-on-stop: the gate is still failing after ${MAX_BLOCKS} attempts; ` +
      "stopping so a human can look. Do not treat this change as done.",
  });
}
fs.writeFileSync(counterFile, String(blocks));

respond({
  decision: "block",
  reason:
    `Quality gate failed (attempt ${blocks}/${MAX_BLOCKS}). Fix the cause, do not skip or ` +
    `weaken the test.\n\n${failures.join("\n\n")}`,
});
