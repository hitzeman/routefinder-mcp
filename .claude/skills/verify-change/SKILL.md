---
name: verify-change
description: Run the full quality gate for routefinder-mcp (lint, strict typecheck, unit + contract + integration + stdio smoke tests, dependency audit, privacy checks) and report results honestly. Use before saying any change is done, before committing, and before opening a PR.
---

# Verify a change

Run every step, even if an earlier one fails, so the report is complete. Do not skip,
`.skip`, loosen, or delete a test to get green. If a test is wrong, say so and explain why.

## Gate

```bash
npm ci            # only if package.json or package-lock.json changed
npm run lint
npm run typecheck
npm test          # builds, then runs unit, contract, integration, hook, and stdio smoke tests
npm run audit     # fails on high or critical advisories
```

`npm test` includes:
- `test/integration.test.ts`: in-process MCP client, lists tools, runs ingest -> find_routes
- `test/stdio-smoke.test.ts`: spawns the built server over real stdio
- `test/contract-*.test.ts`: per-tool schema and error contracts
- `test/hooks.test.ts`: the Claude Code hooks themselves

Expect 3 skipped tests: they need a real FIT file at `.cache/fixtures/sample.fit`, which
is never committed. Any other skip is a problem.

## Privacy checks

```bash
git status --porcelain                 # nothing under .cache/, no *.fit, no *.geojson
git diff --cached --name-only          # same, for anything staged
```

And confirm the diff adds no real COROS activity URLs (only `athlete-<hex>` placeholders)
and no coordinates with more than 4 decimal places outside test fixtures. Fixture
coordinates must be neutral (the repo uses Greenwich).

## If a tool changed

- Its input schema still uses `z.strictObject` with bounded fields and `.describe()` on each.
- Its contract test covers the change, including at least one invalid-input case.
- `README.md` documents the new behaviour.

## Report

List each gate as pass/fail with the failing output for any failure. State the test
counts (pass / fail / skipped). Do not summarise a failing gate as passing.
