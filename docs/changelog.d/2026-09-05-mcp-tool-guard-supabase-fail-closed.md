## 2026-09-05 — `mcp-tool-guard.mjs` fails closed on unrecognized Supabase tools (Codex P1 on PR #605 head `00b7a8b68`)

Once PR #605 removed the repository's `defaultMode: dontAsk` override, CRX sessions inherit Mason's
user-level Auto mode, where an *unlisted* tool goes to Claude's permission classifier instead of
being refused. The GitHub Codex reviewer pointed out the gap that opens: `.claude/settings.json`'s
Supabase `deny` list is finite, so a newly added or renamed Supabase mutation tool absent from it
could be accepted by the classifier. Claude's `mcp-tool-guard.mjs` passed every Supabase leaf
straight through, while Codex's `.codex/hooks/production-action-guard.mjs` already fails closed on
unknown Supabase leaves (pinned by its `future_write_tool` tests). The two agents had different
boundaries for the same connector.

### What changed

- `.claude/hooks/mcp-tool-guard.mjs` now matches any `mcp__<server>__<leaf>` whose server name
  contains `supabase` (case-insensitive: `supabase`, `Supabase`, `claude_ai_Supabase`) or is the UUID
  connector, and **denies** every leaf that is not on the exact eighteen-name read-only allowlist
  (the same set as the Codex guard and as the `allow` entries in `settings.json`).
- Three leaves stay silent here because another gate owns them and must keep deciding:
  `execute_sql` (live-testdata / live-db guards), `apply_migration` (migration-apply-guard), and
  `deploy_edge_function` (the `ask` tier, Mason's deploy gate, unchanged).
- Known lifecycle mutations (`pause_project`, `delete_branch`, …) are now denied by the hook as well
  as by `settings.json`'s `deny` list. Belt and braces; behaviour for those names is unchanged.
- `.claude/hooks/mcp-tool-guard.test.mjs` adds ten assertions: unknown leaves denied on all three
  server-name shapes, a known lifecycle leaf denied, a read-only leaf allowed (including a
  mixed-case spelling), the three gated-elsewhere leaves silent, and an unknown leaf on a
  non-Supabase server untouched by this rule.

### Verification

- `node .claude/hooks/mcp-tool-guard.test.mjs` passes (40 assertions, up from 30).
- `node scripts/check-agent-guidance.mjs`, `node scripts/check-agent-workflows.mjs`, and
  `node scripts/agent-manifest-parity.test.mjs` pass. The hook is already registered on both
  agents through `.codex/hooks.json`, so no manifest change.
- Not verified: no live call against the Supabase connector in a CRX-rooted session.
