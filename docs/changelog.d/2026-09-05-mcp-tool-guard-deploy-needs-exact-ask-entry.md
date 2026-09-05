## 2026-09-05 — `deploy_edge_function` passes the MCP guard only when that exact tool name has a settings entry (Codex P1 on PR #605 head `af30d4c17`)

Follow-up to `2026-09-05-mcp-tool-guard-per-tool-connector-registration.md`. The guard treats
`execute_sql`, `apply_migration`, and `deploy_edge_function` as "gated elsewhere" and stays silent so
the owning gate decides. For the first two that is true on any server: `live-testdata-guard.mjs` and
`migration-apply-guard.mjs` match the leaf name regardless of the `mcp__<server>__` prefix. For
`deploy_edge_function` there is no hook — its gate *is* the `ask` entry in `.claude/settings.json`,
and those entries name specific servers (`supabase`, `Supabase`, `claude_ai_Supabase`, the registered
connector UUID). The GitHub Codex reviewer showed that a reinstalled connector identified as Supabase
through a distinctive settings entry (`list_tables`) still had `deploy_edge_function` passed through
by the guard, with no `ask` entry for the new UUID, so under Auto mode a live Edge Function deploy
could be classified instead of prompting Mason.

### What changed in `.claude/hooks/mcp-tool-guard.mjs`

- On every Supabase server — the named spellings, the registered UUID, and a UUID identified from its
  settings entries — `deploy_edge_function` passes only when the **exact** tool name
  (`mcp__<server>__deploy_edge_function`) appears in a Claude settings file. Otherwise it is denied,
  and the denial says to add that line to the `ask` list. Today's four `ask` entries keep working
  unchanged; a fifth Supabase server spelling or a reinstalled UUID is denied until listed.
- The settings registry now also keeps the exact set of every `mcp__<server>__<leaf>` entry (all tiers,
  case-insensitive), cached per hook invocation, and `SUPABASE_TOOL_RE` captures the server name for
  the message.

### Tests

`.claude/hooks/mcp-tool-guard.test.mjs`: 76 assertions (was 70). New: an identified Supabase UUID
without a deploy entry has `deploy_edge_function` denied and the message names the missing prompt; the
same UUID with an `ask` entry for it passes; `mcp__supabase__` and `mcp__claude_ai_Supabase__`
deploys still pass to their `ask` entries; `mcp__other_supabase__deploy_edge_function` is denied.

### Verification

- `node .claude/hooks/mcp-tool-guard.test.mjs` passes (76 assertions).
- Hand probes of the real hook against the live settings files: `deploy_edge_function` silent on
  `mcp__supabase__`, `mcp__Supabase__`, `mcp__claude_ai_Supabase__`, and the registered UUID; denied on
  `mcp__other_supabase__` and on an alternate UUID; `execute_sql` and `list_tables` unchanged.
- `node scripts/check-agent-guidance.mjs`, `node scripts/check-agent-workflows.mjs`,
  `node scripts/agent-manifest-parity.test.mjs`, and `node .codex/hooks/production-action-guard.test.mjs` pass.
- Not verified: no live deploy attempted.
