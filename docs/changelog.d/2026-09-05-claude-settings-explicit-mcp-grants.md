## 2026-09-05 — Explicit MCP grants replace the server-wide ones (Codex HIGH on PR #605)

The first cut of PR #605 added server-wide `allow` grants for the GitHub, Supabase, Vercel,
Desktop Commander and filesystem MCP servers so an unlisted read tool would stop being silently
refused under `dontAsk`. The exact-SHA Codex review returned `BLOCKERS` with a HIGH finding: a
server-wide grant also admits every unlisted **mutating** tool — Supabase `delete_branch`,
`create_project`, `pause_project`, `restore_project`, `confirm_cost`, and filesystem
`delete_directory` — none of which appear in `ask` or `deny`, and none of which Claude's
`mcp-tool-guard.mjs` recognises. Codex's own `production-action-guard.mjs` fails closed on exactly
those leaves. A read-only probe confirmed `mcp__filesystem__delete_directory` aimed at `src` drew
no denial from any Claude guard.

Those tools sit behind the live-database and destructive-data gates Mason said to keep, so the
finding stands and the grants are corrected in this commit.

### What changed

- **Removed** the eight server-wide `allow` entries (`mcp__github`, `mcp__supabase`,
  `mcp__Supabase`, `mcp__claude_ai_Supabase`, the UUID-named Supabase connector, `mcp__Vercel`,
  `mcp__Desktop_Commander`, `mcp__filesystem`). `Task` and `mcp__Claude_Browser` stay.
- **Added** explicit read-only `allow` entries: the eighteen Supabase read tools (`list_*`,
  `get_*`, `query_logs`, `generate_typescript_types`, `search_docs`) for all four Supabase server
  names, and five Vercel read tools (`list_teams`, `get_web_analytics`,
  `search_vercel_documentation`, `get_project_deployment_protection`,
  `get_git_deployment_context`).
- **Added** explicit `deny` entries for the Supabase branch/project lifecycle leaves
  (`delete_branch`, `create_branch`, `merge_branch`, `reset_branch`, `rebase_branch`,
  `create_project`, `pause_project`, `restore_project`, `confirm_cost`) on all four server names,
  for the filesystem MCP mutators (`delete_directory`, `delete_file`, `move_file`, `write_file`,
  `edit_file`, `create_directory`), and for the Desktop Commander mutators (`start_process`,
  `interact_with_process`, `write_file`, `edit_block`, `move_file`, `delete_directory`,
  `kill_process`, `set_config_value`). `deny` is mode-independent, so these hold in `dontAsk`,
  `auto`, and prompt modes alike. The two Supabase lifecycle names that were previously in `ask`
  (`create_branch`, `merge_branch`) moved to `deny`, since a name cannot usefully sit in both.

### Unchanged

Everything the first entry lists as unchanged still holds: every merge and deploy entry stays in
`ask`, the hook registrations are untouched, and native `Edit`/`Write` of the agent-surface files
remains allowed (the point of PR #605).

### Verification

- `node scripts/check-agent-guidance.mjs` and `node scripts/check-agent-workflows.mjs` pass on the
  corrected file.
- The exact-SHA Codex proof is re-run against the corrected head before merge; the first run's
  `BLOCKERS` verdict is what produced this entry.
- Not verified: no live probe of the denied tools in a CRX-rooted session; the denies are read from
  the permission-precedence rule (`deny` > `ask` > `allow`).
