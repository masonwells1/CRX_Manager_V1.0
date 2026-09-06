## 2026-09-05 — Supabase live-action leaves are denied on any unregistered connector UUID (Codex P1 on PR #605 head `f9bd7e4a0`)

The previous fix made `mcp-tool-guard.mjs` fail closed on unknown Supabase leaves, but it
recognised the Supabase connector only by name (`supabase`, `Supabase`, `claude_ai_Supabase`) or by
the one hard-coded UUID. `.claude/skills/deploy-edge-function/SKILL.md` already records that the
connector UUID is per-install and changes on reinstall. The GitHub Codex reviewer exercised an
alternate UUID with `pause_project`, `deploy_edge_function`, and an unknown write leaf: all passed
the hook silently, and `.claude/settings.json` has no `ask`/`deny` entry for an unknown UUID, so
under Auto mode a reinstalled connector could hand a lifecycle mutation or an Edge Function deploy
to the classifier without Mason's current-conversation approval.

### What changed

- `.claude/hooks/mcp-tool-guard.mjs`: any tool on a **UUID-shaped server** whose leaf is a Supabase
  live-action leaf — `apply_migration`, `deploy_edge_function`, `execute_sql`, or the nine
  branch/project lifecycle leaves — is denied unless the UUID is the registered one. The denial
  names the fix: register the new UUID in `settings.json` and in the guard's `SUPABASE_TOOL_RE`.
- Matching is by leaf suffix, mirroring the Codex guard's `LIVE_TOOL_ACTIONS` rule, so both agents
  now treat an unrecognised connector the same way.
- On the registered UUID and the named servers nothing changes: `deploy_edge_function` still goes
  to the `ask` tier (Mason's deploy gate), `execute_sql` and `apply_migration` to their own guards.
- Seven new assertions in `.claude/hooks/mcp-tool-guard.test.mjs` pin: the four sensitive leaves
  denied on an alternate UUID (one in mixed case), a read-only leaf and an unrelated leaf on that
  UUID passing through, and `deploy_edge_function` on the registered UUID still silent.

### Stated residual

An *unknown* leaf on an *unregistered* UUID server still passes through to the permission
classifier. The guard cannot tell a Supabase UUID from a Vercel, Drive, or Calendar connector UUID,
and denying every unknown leaf on every UUID server would break unrelated connectors. The exact
read-only allowlist covers every named Supabase server and the registered UUID; a reinstall
requires registering the new UUID, which the denial message says in so many words.

### Verification

- `node .claude/hooks/mcp-tool-guard.test.mjs` passes (47 assertions).
- `node scripts/check-agent-guidance.mjs`, `node scripts/check-agent-workflows.mjs`, and
  `node scripts/agent-manifest-parity.test.mjs` pass.
- Not verified: no live call through an alternate connector UUID.
