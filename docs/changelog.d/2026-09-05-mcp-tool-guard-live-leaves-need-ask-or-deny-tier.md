## 2026-09-05 — Supabase live-action leaves on a connector UUID count as registered only through an `ask` or `deny` entry (Codex P1 on PR #605 head `6de456ac5`)

Follow-up to `2026-09-05-mcp-tool-guard-deploy-needs-exact-ask-entry.md`. The per-tool registry
accepted an exact `mcp__<uuid>__<leaf>` entry in **any** tier as settling that tool. The GitHub Codex
reviewer showed the gap: a reinstalled Supabase connector with `pause_project`, `create_project`, or
`restore_project` in an `allow` entry and no distinctive Supabase leaf is not identified as Supabase,
and the `allow` entry made the guard step aside — so the tool would run with no prompt at all, an
out-of-band production action without Mason's current-conversation approval. An `allow` line is the
bypass itself, not a registration.

### What changed in `.claude/hooks/mcp-tool-guard.mjs`

- The settings registry now records the tier(s) each exact `mcp__<server>__<leaf>` entry appears in.
- For a Supabase live-action leaf (`deploy_edge_function`, `execute_sql`, `apply_migration`, and the
  nine branch/project lifecycle leaves) on a UUID server, only an `ask` or `deny` entry settles the
  tool; an `allow`-only entry is ignored and the tool is denied with a message saying so. Ordinary
  (non-live-action) tools are still settled by any exact entry.
- The same rule applies to `deploy_edge_function` on every Supabase server spelling: it passes to the
  `ask` tier only when its exact entry is in `ask` or `deny`. Today's four `ask` entries are unchanged.

### Tests

`.claude/hooks/mcp-tool-guard.test.mjs`: 85 assertions (was 76). New fixtures through
`CLAUDE_PROJECT_DIR`: `pause_project`, `create_project`, `restore_project` registered only in `allow`
on an unidentified UUID are denied and the message says an `allow` line does not count; the same
leaves with `ask` or `deny` entries pass to those tiers; an ordinary tool (`sync_env`) is settled by an
`allow` entry; an identified Supabase UUID with `deploy_edge_function` only in `allow` is still denied.

### Verification

- `node .claude/hooks/mcp-tool-guard.test.mjs` passes (85 assertions).
- Hand probes of the real hook against the live settings files: `deploy_edge_function` silent on
  `mcp__supabase__` and the registered UUID (both in `ask`); `pause_project` denied on the registered
  UUID and on an alternate UUID; Vercel `deploy_to_vercel` silent (in `ask`); alternate-UUID
  `list_events` silent.
- `node scripts/check-agent-guidance.mjs`, `node scripts/check-agent-workflows.mjs`,
  `node scripts/agent-manifest-parity.test.mjs`, and `node .codex/hooks/production-action-guard.test.mjs` pass.
- Not verified: no live call through a reinstalled connector.
