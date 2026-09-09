## 2026-09-05 — Supabase connector fingerprint no longer counts `list_branches` / `create_branch`; suffix read verbs count as read-shaped (GitHub Codex P2 on PR #605 head `3612eb3a1`)

The guard identifies a connector UUID as Supabase when one of its settings entries names a leaf only
Supabase has. `list_branches` and `create_branch` were in that fingerprint set, but the GitHub connector
exposes both (and `.claude/settings.json` grants them to `mcp__github__`). The reviewer showed a
UUID-installed GitHub connector registered for `list_branches` being treated as Supabase, so its
`get_file_contents`, `pull_request_read`, and even an `ask`-tier `create_pull_request` were denied.

### What changed in `.claude/hooks/mcp-tool-guard.mjs`

- `list_branches` and `create_branch` join `SUPABASE_SHARED_LEAVES`, so they are excluded from
  `SUPABASE_DISTINCTIVE_LEAVES` and no longer identify a UUID as Supabase. On the named Supabase servers and
  an identified UUID they keep exactly their previous treatment (`list_branches` read-only, `create_branch`
  live-action).
- Read-shape detection now also accepts a read verb as the final segment (`pull_request_read`, `issue_read`,
  `actions_get`, `actions_list` — GitHub's spelling), not only as the leading verb. Mutations are never named
  that way in any connector in use.
- No settings entry changed.

### Tests

`.claude/hooks/mcp-tool-guard.test.mjs`: a GitHub-shaped UUID registered for the two shared leaves keeps
`get_file_contents`, `pull_request_read`, `list_branches`, `search_code` (silent), keeps its `ask`-tier
`create_pull_request` (silent), and still has an allow-only `create_branch` and an unlisted `delete_file`
denied; the same UUID with `list_tables` added is still identified as Supabase.

### Verification

- `node .claude/hooks/mcp-tool-guard.test.mjs` passes; agent guidance/workflow/parity checks and the Codex
  production-action-guard tests pass. Reviewer's case reproduced against the real hook with a temporary
  project settings file before and after. Not verified: no live UUID-installed GitHub connector exists.
