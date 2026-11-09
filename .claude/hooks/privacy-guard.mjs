#!/usr/bin/env node
/**
 * PreToolUse hook: keep GPS data and COROS bearer URLs out of the repository.
 *
 * The cache holds full-resolution GPS around the owner's home, and a COROS activity URL
 * is an unauthenticated, non-expiring, unrevocable bearer link. Either one committed to a
 * public repo is a permanent leak. .gitignore already covers the cache; this hook covers
 * the ways an agent gets around .gitignore:
 *
 *  - Write/Edit into .cache/ or of *.fit / *.geojson files
 *  - `git add -f` / `--force` (the only way to stage an ignored file)
 *  - `git commit` while the index holds a cache/FIT/GeoJSON file, or a diff that adds a
 *    real-looking COROS activity URL not using the repo's `athlete-<hex>` fixture placeholder
 *
 * Fail-open on its own errors (a broken guard should not brick the session), fail-closed
 * on a match.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FORBIDDEN_PATH = /(^|\/)\.cache\/|\.fit$|\.geojson$/i;
// Shape of a real activity URL: /fit/v2/<athlete-id>/<file-id>_<md5-tail>.fit
const COROS_URL = /s3\.coros\.com\/fit\/v2\/[^\s/"'`]+\/[^\s/"'`]+_[0-9a-f]{6,}\.fit/gi;
const FIXTURE_PLACEHOLDER = /athlete-[0-9a-f]+/i;

const deny = (reason) => {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `privacy-guard: ${reason}`,
      },
    }),
  );
  process.exit(0);
};

let input;
try {
  input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
} catch {
  process.exit(0);
}

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
const tool = input.tool_name;
const toolInput = input.tool_input ?? {};

if (tool === "Write" || tool === "Edit" || tool === "MultiEdit" || tool === "NotebookEdit") {
  const target = String(toolInput.file_path ?? toolInput.notebook_path ?? "");
  const relative = path.relative(projectDir, path.resolve(projectDir, target));
  if (!relative.startsWith("..") && FORBIDDEN_PATH.test(relative.split(path.sep).join("/"))) {
    deny(
      `refusing to write ${relative}. The cache and FIT/GeoJSON files hold real GPS and are ` +
        "never edited by hand or created in the repo. Use synthetic fixtures from " +
        "test/helpers/fit-fixtures.ts instead.",
    );
  }
  process.exit(0);
}

if (tool !== "Bash") process.exit(0);

const command = String(toolInput.command ?? "");

// Match git invocations only where a shell command starts, not anywhere in the text: a
// commit message or heredoc that merely mentions "git add --force" is not a force-add.
// (The first version matched anywhere and blocked a commit whose message described this
// very hook.)
const segments = command
  .split(/\n|;|&&|\|\||\|/)
  .map((segment) => segment.trim().replace(/^(sudo|env\s+\S+=\S+)\s+/, ""));
const startsWith = (pattern) => segments.some((segment) => pattern.test(segment));

if (startsWith(/^git\s+add\b.*\s(-f|--force)\b/)) {
  deny(
    "`git add --force` is blocked: the only ignored files in this repo are the GPS cache, " +
      "FIT files, GeoJSON, and .env. Fix .gitignore deliberately if something is wrongly ignored.",
  );
}

if (startsWith(/^git\s+commit\b/)) {
  const git = (...args) =>
    execFileSync("git", args, { cwd: projectDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  let staged = [];
  let diff = "";
  try {
    // `git commit -a` stages tracked changes at commit time; include them.
    const all = /\s-[a-zA-Z]*a\b|\s--all\b/.test(command);
    staged = git("diff", "--name-only", all ? "HEAD" : "--cached").split("\n").filter(Boolean);
    diff = git("diff", "--unified=0", all ? "HEAD" : "--cached");
  } catch {
    process.exit(0);
  }

  const badFiles = staged.filter((file) => FORBIDDEN_PATH.test(file));
  if (badFiles.length > 0) {
    deny(`staged files contain GPS data: ${badFiles.join(", ")}. Unstage them.`);
  }

  const leaked = diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .flatMap((line) => line.match(COROS_URL) ?? [])
    .filter((url) => !FIXTURE_PLACEHOLDER.test(url));
  if (leaked.length > 0) {
    deny(
      `the staged diff adds ${leaked.length} COROS activity URL(s) that look real. These are ` +
        "unrevocable bearer secrets. Remove them; fixtures must use an athlete-<hex> placeholder " +
        "path such as /fit/v2/athlete-9f3c21/x_deadbeefcafe.fit.",
    );
  }
}

process.exit(0);
