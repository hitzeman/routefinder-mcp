# AGENTS.md

Instructions for any coding agent working in this repo. (Claude Code reads it via
`CLAUDE.md`.)

routefinder-mcp is a stdio MCP server (TypeScript, Node >=22) that turns COROS activity
FIT files into distinct repeated running routes as GeoJSON. Two tools:
`ingest_activities` (the only network access) and `find_routes` (local cache only).

## Commands

```bash
npm ci
npm run lint        # ESLint, typescript-eslint strictTypeChecked
npm run typecheck   # tsc --noEmit, strict + noUncheckedIndexedAccess
npm test            # build, then node:test over dist/test/**/*.test.js
npm run check       # lint + typecheck + test: run before calling anything done
npm run audit       # npm audit, fails on high+
```

Tests use Node's built-in `node:test` runner against compiled output, not Vitest/Jest.
Three tests skip unless a real FIT file exists at `.cache/fixtures/sample.fit`; that is expected.

## Layout

- `src/tools/<name>.ts`: one MCP tool each: input/output zod schemas + register function
- `src/tools/errors.ts`: `toolError` / `unexpectedError`, the only way a tool reports failure
- `src/ingest/`: URL allowlist, bounded fetch with retry, batch ingest with deadline
- `src/routes/`: pure geometry: cell sets, Jaccard, union-find, RDP simplification
- `src/cache/`: two-tier cache (raw FIT bytes, parsed tracks), keyed by SHA-256 of the URL
- `src/config.ts`: every `ROUTEFINDER_*` env var, validated with bounds at startup
- `test/helpers/mcp-harness.ts`: in-process MCP client + network-free `mockFetch`

## Rules

1. **A new or changed tool requires all of:** a `z.strictObject` input schema with bounded,
   `.describe()`d fields; an `outputSchema`; a `test/contract-<name>.test.ts`; an entry in
   `test/integration.test.ts`; and a README section. (Claude: use the `add-mcp-tool` skill.)
2. **Tool failures are results, not exceptions.** Expected failures use
   `toolError(code, message, retryable)`; handlers wrap everything in `unexpectedError`.
   Messages say what the caller should do next. No stack traces to the model.
3. **stdout is the protocol.** Never `console.log` or write to `process.stdout` in `src/`.
   Log via `src/log.ts` (stderr, redacted). Lint enforces this.
4. **COROS download URLs are secrets.** They are unauthenticated, never expire, and cannot
   be revoked. Never persist, log, return, or commit one. Test fixtures use the
   placeholder form `https://s3.coros.com/fit/v2/athlete-<hex>/x_<hex>.fit`.
5. **GPS is private.** Never commit anything under `.cache/`, any `*.fit`, or `*.geojson`.
   Fixture coordinates must be neutral (tests use Greenwich or `pointAt()` offsets);
   never real coordinates from the owner's data.
6. **No network in tests.** Inject `fetchImpl` (`mockFetch` or `startFixtureServer`).
7. **Determinism.** Every ordering in `src/routes/` has an explicit sort key. Keep it that way.
8. **Do not weaken a gate to pass it.** No `.skip`, no loosened assertions, no lint
   disables without a comment explaining why.
9. **Tuning lives in env vars, not code.** New knobs go in `src/config.ts` with bounds.

## Planning

Larger changes go through OpenSpec (`openspec/`, `/opsx:*` commands): proposal ->
design -> specs -> tasks, then implement against the task list.
