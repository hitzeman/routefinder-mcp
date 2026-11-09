@AGENTS.md

## Claude Code specifics

- **Hooks** (`.claude/settings.json`):
  - `Stop` runs `npm run typecheck` and `npm test` when build-relevant files changed, and
    blocks finishing until they pass. After 3 failed attempts it hands control back to the
    human. Fix the cause; do not work around the hook.
  - `PreToolUse` (`privacy-guard`) denies writes into `.cache/` or of `*.fit` / `*.geojson`,
    `git add --force`, and commits that stage GPS files or real-looking COROS URLs.
- **Permissions** deny reading `.cache/**`, `*.fit`, `*.geojson`, and `.env*`. Real GPS
  does not belong in the context window either.
- **Skills:** `add-mcp-tool` for any new tool; `verify-change` before saying done or
  committing. OpenSpec skills and `/opsx:*` commands handle planning.
