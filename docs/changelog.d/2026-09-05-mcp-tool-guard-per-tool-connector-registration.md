## 2026-09-05 — Connector UUIDs: identify Supabase from settings, register every other tool exactly, accept kebab-case leaves (two Codex P1s on PR #605 head `68c1c32f0`)

Follow-up to `2026-09-05-mcp-tool-guard-unregistered-connector-registry.md`. That commit treated a
connector UUID as "registered" as soon as **one** of its tools appeared in a settings file and then
left every other tool on that server to `settings.json`. The GitHub Codex reviewer probed a UUID with
only `list_projects` listed in `~/.claude/settings.json`: `delete_project`, `future_write_tool`, and
`deploy_edge_function` all passed the hook. It also showed that the Supabase matcher accepted only
`[a-z0-9_]` leaves, so `mcp__supabase__future-write-tool` and `mcp__claude_ai_Supabase__delete-project`
skipped the fail-closed branch entirely.

### What changed in `.claude/hooks/mcp-tool-guard.mjs`

- **Supabase identity is derived from the settings entries.** A UUID server is the Supabase connector
  when any `allow`/`ask`/`deny` entry for that UUID names a leaf only Supabase's connector has
  (`list_tables`, `execute_sql`, `apply_migration`, `get_advisors`, `list_migrations`, and so on; the
  `*_project` leaves Vercel shares prove nothing and are excluded). An identified UUID gets the
  **complete** Supabase policy: exact read-only allowlist passes, `execute_sql` / `apply_migration` /
  `deploy_edge_function` go to the gates that own them, every other leaf is denied.
- **Everything else is registered per tool, not per server.** On any other UUID a leaf passes only if
  the exact `mcp__<uuid>__<leaf>` entry exists in a settings file (whatever the tier), or it is on the
  Supabase read-only allowlist, or it is read-shaped by verb. One listed leaf never settles the rest of
  the server, so the reinstalled-Supabase probe (only `list_projects` listed) now denies
  `delete_project`, `future_write_tool`, and `deploy_edge_function`. Consequence for today's registered
  connectors: Vercel `deploy_to_vercel` still reaches its `ask` entry, but Vercel `unpause_project` and
  Sentry `update_issue` (no exact entries) are denied until someone lists them — a one-line
  `settings.json` edit the denial text spells out.
- **Kebab-case leaves.** `SUPABASE_TOOL_RE` now matches the full MCP leaf alphabet including hyphens,
  so a hyphenated mutation on `mcp__supabase__`, `mcp__Supabase__`, or `mcp__claude_ai_Supabase__` hits
  the same fail-closed branch.
- The denial messages distinguish the three cases (identified Supabase UUID, Supabase live-action leaf
  without an exact entry, other non-read leaf without an exact entry) and name the fix for each.

### Tests

`.claude/hooks/mcp-tool-guard.test.mjs`: 70 assertions (was 55). New coverage spins up a temporary
project settings file through `CLAUDE_PROJECT_DIR`: a partially registered UUID (only `list_projects`)
keeps `delete_project`, `future_write_tool`, `deploy_edge_function` denied; a UUID identified by
`list_tables` passes `list_projects` and `execute_sql`, denies `get_event`, `delete_project`,
`pause_project`; Vercel `deploy_to_vercel` passes while `unpause_project` is denied; three kebab-case
leaves on the named Supabase servers are denied.

### Residual

A mutation deliberately named with a read verb on an unidentified connector passes; no known connector
does that, and the per-tool registry is the intended path.

### Verification

- `node .claude/hooks/mcp-tool-guard.test.mjs` passes (70 assertions).
- Hand probes of the real hook against the live settings files: `mcp__supabase__future-write-tool`,
  alternate-UUID `delete_project`, Vercel `unpause_project`, Sentry `update_issue` denied;
  alternate-UUID `list_events`, Vercel `deploy_to_vercel`, Sentry `search_issues`, registered Supabase
  UUID `list_tables` and `deploy_edge_function` silent.
- `node scripts/check-agent-guidance.mjs`, `node scripts/check-agent-workflows.mjs`,
  `node scripts/agent-manifest-parity.test.mjs`, and `node .codex/hooks/production-action-guard.test.mjs` pass.
- Not verified: no live call through a reinstalled connector.
