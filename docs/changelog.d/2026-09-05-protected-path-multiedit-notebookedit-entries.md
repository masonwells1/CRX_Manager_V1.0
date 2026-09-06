## 2026-09-05 — Name every native editor in the protected-path `ask` entries (Codex P1 on PR #605 head `753165db4`)

The GitHub Codex reviewer showed that the 32 restored protected-path entries in `.claude/settings.json`
named only `Edit(...)` and `Write(...)`. `review-proof-guard.mjs` deliberately exempts all four native
editors (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`) so hook maintenance is never stranded, and leaves
the decision to the settings tiers — so under the new `acceptEdits` mode a `MultiEdit` (or
`NotebookEdit`) aimed at `.claude/hooks/**`, `.claude/settings.json`, or any other protected path was
auto-approved with no prompt. The carve-out was by tool name and inherited the list's omissions — the
same failure shape this PR closes for connector tools.

### What changed in `.claude/settings.json`

- `ask`: a `MultiEdit(<path>)` and a `NotebookEdit(<path>)` entry beside every protected
  `Edit(<path>)`/`Write(<path>)` pair — 16 path patterns, 64 entries (was 32).
- `deny`: the same two spellings beside the three `.env` pairs — 12 entries (was 6).
- No other tier, entry, hook, or hook matcher changed. `defaultMode` stays `acceptEdits`.

Sweep for the general case: the exemption list in `review-proof-guard.mjs` is the authority on which
native editors bypass the hook (`write|edit|notebookedit|multiedit`); all four are now named in both
blocks. Bash and MCP path-field writers to these paths are denied by the hooks themselves and need no
entry.

Not in this change (pre-existing on `main`, recorded as a follow-up): the `Write|Edit|MultiEdit`
PreToolUse matcher for the SQL/money content guards does not include `NotebookEdit`.

### Verification

- `node -e` parse of the file; protected `ask` entries counted at 64, `.env` `deny` entries at 12, every
  `MultiEdit`/`NotebookEdit` path identical to an existing `Edit` path.
- `node scripts/check-agent-workflows.mjs`, `node scripts/check-agent-guidance.mjs`,
  `node scripts/agent-manifest-parity.test.mjs`, `node .claude/hooks/mcp-tool-guard.test.mjs`,
  `node .claude/hooks/migration-apply-guard.test.mjs`, `node .claude/hooks/review-proof-guard.test.mjs`,
  `node .codex/hooks/production-action-guard.test.mjs`, `npm run check:docs` pass.
