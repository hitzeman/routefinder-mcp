/**
 * Tests for the Claude Code hooks in .claude/hooks. They are part of the quality gate,
 * so they get the same treatment as the server: a hook that silently stops blocking is
 * a regression.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { projectRoot } from "../src/config.js";

const hook = (name: string): string => path.join(projectRoot, ".claude", "hooks", name);

interface HookRun {
  status: number | null;
  json: Record<string, unknown>;
}

function runHook(name: string, input: object, projectDir: string): HookRun {
  const run = spawnSync(process.execPath, [hook(name)], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    timeout: 60_000,
  });
  const stdout = run.stdout.trim();
  return { status: run.status, json: stdout === "" ? {} : (JSON.parse(stdout) as Record<string, unknown>) };
}

function tempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routefinder-hook-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "hook test");
  git("commit", "-q", "--allow-empty", "-m", "root");
  return dir;
}

const denied = (run: HookRun): boolean =>
  (run.json.hookSpecificOutput as { permissionDecision?: string } | undefined)
    ?.permissionDecision === "deny";

// --- privacy-guard -------------------------------------------------------------------

for (const file of [".cache/raw/abc.fit", ".cache/tracks/abc.json", "data/run.fit", "out/map.geojson"]) {
  test(`privacy-guard denies writing ${file}`, () => {
    const dir = tempRepo();
    const run = runHook(
      "privacy-guard.mjs",
      { tool_name: "Write", tool_input: { file_path: path.join(dir, file), content: "x" } },
      dir,
    );
    assert.equal(run.status, 0);
    assert.ok(denied(run), JSON.stringify(run.json));
  });
}

test("privacy-guard allows ordinary source edits", () => {
  const dir = tempRepo();
  const run = runHook(
    "privacy-guard.mjs",
    { tool_name: "Edit", tool_input: { file_path: path.join(dir, "src/server.ts") } },
    dir,
  );
  assert.ok(!denied(run));
});

test("privacy-guard denies git add --force", () => {
  const dir = tempRepo();
  for (const command of ["git add -f .cache", "git add --force data/x.fit", "git add . -f"]) {
    assert.ok(denied(runHook("privacy-guard.mjs", { tool_name: "Bash", tool_input: { command } }, dir)), command);
  }
  assert.ok(
    !denied(runHook("privacy-guard.mjs", { tool_name: "Bash", tool_input: { command: "git add src" } }, dir)),
  );
});

test("privacy-guard ignores a force-add that only appears inside a commit message", () => {
  const dir = tempRepo();
  // Regression: the first version matched anywhere in the command text and blocked a
  // commit whose heredoc message described this hook.
  const command = [
    "git add -A && git commit -q -F - <<'EOF'",
    "Document the hook",
    "",
    "    *.fit/*.geojson, git add --force, and commits",
    "EOF",
  ].join("\n");
  assert.ok(!denied(runHook("privacy-guard.mjs", { tool_name: "Bash", tool_input: { command } }, dir)));
});

test("privacy-guard denies a commit that stages a FIT file", () => {
  const dir = tempRepo();
  fs.writeFileSync(path.join(dir, "run.fit"), "bytes");
  execFileSync("git", ["add", "run.fit"], { cwd: dir });
  const run = runHook("privacy-guard.mjs", { tool_name: "Bash", tool_input: { command: "git commit -m x" } }, dir);
  assert.ok(denied(run));
});

test("privacy-guard denies a commit that adds a real-looking COROS URL", () => {
  const dir = tempRepo();
  // Built at runtime so this test file itself does not contain the pattern.
  const fake = ["https://s3.coros.com/fit/v2", "4412093", `7731_${crypto.randomBytes(6).toString("hex")}.fit`].join("/");
  fs.writeFileSync(path.join(dir, "notes.md"), `see ${fake}\n`);
  execFileSync("git", ["add", "notes.md"], { cwd: dir });
  const run = runHook("privacy-guard.mjs", { tool_name: "Bash", tool_input: { command: "git commit -m x" } }, dir);
  assert.ok(denied(run));
  const reason = JSON.stringify(run.json);
  assert.ok(!reason.includes(fake), "the guard must not echo the secret back");
});

test("privacy-guard allows fixture URLs that use the athlete-<hex> placeholder", () => {
  const dir = tempRepo();
  fs.writeFileSync(
    path.join(dir, "fixture.ts"),
    'const u = "https://s3.coros.com/fit/v2/athlete-9f3c21/x_deadbeefcafe.fit";\n',
  );
  execFileSync("git", ["add", "fixture.ts"], { cwd: dir });
  const run = runHook("privacy-guard.mjs", { tool_name: "Bash", tool_input: { command: "git commit -m x" } }, dir);
  assert.ok(!denied(run));
});

// --- verify-on-stop ------------------------------------------------------------------

function npmProject(testScript: string): string {
  const dir = tempRepo();
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "hook-fixture", private: true, scripts: { typecheck: "node -e 0", test: testScript } }),
  );
  execFileSync("git", ["add", "package.json"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "pkg"], { cwd: dir });
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "changed.ts"), "export {};\n");
  return dir;
}

const session = (): string => `test-${crypto.randomBytes(6).toString("hex")}`;

test("verify-on-stop is a no-op when nothing build-relevant changed", () => {
  const dir = tempRepo();
  fs.writeFileSync(path.join(dir, "README.md"), "docs only\n");
  const run = runHook("verify-on-stop.mjs", { session_id: session() }, dir);
  assert.deepEqual(run.json, {});
});

test("verify-on-stop allows stopping when the gate passes", () => {
  const dir = npmProject("node -e 0");
  const run = runHook("verify-on-stop.mjs", { session_id: session() }, dir);
  assert.equal(run.json.decision, undefined);
});

test("verify-on-stop blocks with the failing lines, then yields to a human after 3 tries", () => {
  const dir = npmProject(`node -e "console.log('not ok 1 - boom'); process.exit(1)"`);
  const id = session();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const run = runHook("verify-on-stop.mjs", { session_id: id, stop_hook_active: attempt > 1 }, dir);
    assert.equal(run.json.decision, "block", `attempt ${attempt}`);
    assert.match(String(run.json.reason), /not ok 1 - boom/);
    assert.match(String(run.json.reason), new RegExp(`attempt ${attempt}/3`));
  }
  const fourth = runHook("verify-on-stop.mjs", { session_id: id, stop_hook_active: true }, dir);
  assert.equal(fourth.json.decision, undefined);
  assert.match(String(fourth.json.systemMessage), /human/);
});
