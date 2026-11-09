---
name: add-mcp-tool
description: Scaffold a new MCP tool in routefinder-mcp the required way - schema first, a failing contract test, then the implementation, then README docs. Use whenever adding or renaming a tool exposed by this server.
---

# Add an MCP tool

A tool is not done until it has: a strict input schema, an output schema, a contract
test, an entry in the integration test, and a README section. Do the steps **in order**;
step 2 must fail before step 3 exists.

Throughout, `<name>` is the snake_case tool name (e.g. `list_routes`) and `<file>` is its
kebab-case file name (e.g. `list-routes`).

## 1. Schema first: `src/tools/<file>.ts`

Copy the shape of `src/tools/find-routes.ts`. Export, before any handler code:

- `export const <CONST_NAME> = "<name>";`
- `export const <camel>InputSchema = z.strictObject({...})`
  - `strictObject`, never `object`: unknown keys must be rejected.
  - Every field bounded: `.min/.max` on numbers, strings and arrays, `z.enum` for choices.
    Export the bounds as constants so tests reference them instead of repeating numbers.
  - Every field has `.describe()` written for a model: units, an example, and where the value comes from.
- `export const <camel>OutputSchema = z.object({...})` describing `structuredContent`.
- A tool `description` that says what it does, whether it touches the network or costs
  COROS quota, and what to call next.
- `annotations`: set `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`
  truthfully.

Stub the register function with a handler that returns
`toolError("internal_error", "not implemented", false)`, and wire it in `src/server.ts`.

## 2. Failing contract test: `test/contract-<file>.test.ts`

Copy `test/contract-find-routes.test.ts`. Use `connectHarness` / `mockFetch` from
`test/helpers/mcp-harness.ts`. No real network, ever.

Required cases:
- valid input -> `isError` not set, and `<camel>OutputSchema.parse(result.structuredContent)` succeeds
- a table of invalid inputs (missing, wrong type, each bound exceeded, unknown key) ->
  `isError: true`, text matches `/Input validation error/` and names the field
- each domain failure -> `isError: true`, `JSON.parse(text).error.code` is the expected `ToolErrorCode`
- if the tool takes URLs or returns user data: assert with `findUrlLeak` that nothing leaks

Also add `<CONST_NAME>` to `EXPECTED_TOOLS` in `test/integration.test.ts` and extend
the stdio smoke test's tool list.

Run `npm test` and **confirm the new tests fail** for the right reason (not implemented),
not because of a typo.

## 3. Implement

- Put the logic in a domain module (`src/routes/`, `src/ingest/`, ...) as a pure
  function where possible, with its own unit tests. Keep the handler thin: parse args, call
  domain code, shape `structuredContent`, write a human-readable text summary.
- Wrap the handler body in `try { ... } catch (error) { return unexpectedError(NAME, error); }`.
- Expected failures return `toolError(code, message, retryable)`. Add a new code to
  `ToolErrorCode` in `src/tools/errors.ts` rather than inventing free text. The message
  tells the model what to do next.
- Never log or return a URL or coordinate. Log through `src/log.ts` only.
- Network: go through `fetchActivityBytes` (allowlist, size cap, timeout, retry). Do not
  call `fetch` directly.

## 4. Document

Add a `### \`<name>(...)\`` section under **Tools** in `README.md` with: one-line
purpose, parameters with bounds, an example call, the shape of the result, and its error codes.

## 5. Verify

Run the `verify-change` skill. All gates must pass before reporting done.
