## 2026-09-05 — Interactive browser tools move to `ask` (Codex P1 on PR #605 head `e881acdbb`)

Once PR #605 dropped the repository's `defaultMode: dontAsk` override (see
`2026-09-05-claude-inherit-user-permission-mode.md`), CRX sessions inherit Mason's user-level Auto
mode, where an *unlisted* tool goes to Claude's classifier instead of being refused. The GitHub
Codex reviewer pointed out that the four interactive Claude Browser tools — `computer` (click/type),
`form_input`, `javascript_tool`, and `browser_batch` — were only unlisted, so the classifier could
accept a click or form submit on an authenticated production, GitHub, Vercel, Supabase, or billing
tab with no current-conversation approval. That is exactly the outward-facing class Mason said to
keep gated.

### What changed

- `.claude/settings.json` `permissions.ask` now lists `mcp__Claude_Browser__computer`,
  `mcp__Claude_Browser__form_input`, `mcp__Claude_Browser__javascript_tool`, and
  `mcp__Claude_Browser__browser_batch`. An `ask` rule outranks `allow` and forces a prompt in every
  prompting mode, Auto included.
- The fifteen read-only browser tools stay in `allow` (see
  `2026-09-05-claude-settings-browser-reads-only.md`).

### Also confirmed already fixed

The same review repeated two findings that Codex's own commit `2e1fad708` had already resolved
(the risky-path classifier covers `.coderabbit.yaml`, `.codex/config.toml`,
`.claude/settings.local.json`, and the `scripts/check-*`/`validate-*`/`verify-*` families; the
path-field denial text no longer cites the removed `ask` tier). Verified by reading the current
files, not the review.

### Verification

- `node scripts/check-agent-guidance.mjs`, `node scripts/check-agent-workflows.mjs`, and
  `node .claude/hooks/mcp-tool-guard.test.mjs` pass on the corrected file.
- Not verified: no live probe of the browser tools in a CRX-rooted session.
