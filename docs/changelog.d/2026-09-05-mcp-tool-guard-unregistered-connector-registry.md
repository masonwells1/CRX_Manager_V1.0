## 2026-09-05 — Unregistered connector UUIDs fail closed on every non-read tool (Codex P1 on PR #605 head `c3e2b3fd7`)

Follow-up to `2026-09-05-mcp-tool-guard-unregistered-connector-uuid.md`, whose "stated residual" this
entry removes. That fix denied twelve known Supabase live-action leaves on any unregistered
connector UUID but let every *other* leaf through, and pinned that pass-through in the tests. The
GitHub Codex reviewer probed an alternate UUID with `delete_project` and `future_write_tool` through
the full registered hook stack and got no denial: a reinstalled Supabase connector exposing a new or
renamed mutation would still reach the Auto-mode classifier without Mason's approval.

### What changed

- `.claude/hooks/mcp-tool-guard.mjs` now derives the connector's standing from the Claude settings
  files instead of a finite leaf list. A UUID-shaped MCP server named in **any** `allow`/`ask`/`deny`
  entry of the repo `.claude/settings.json`, `.claude/settings.local.json`, or
  `~/.claude/settings.json` is a **registered** connector (today: the Supabase UUID and the Vercel
  UUID in the repo file; Vercel and Sentry in Mason's user file) and is left to those entries.
- A UUID server named in **none** of them is **unregistered** and treated as possibly the reinstalled
  Supabase connector: a leaf on the exact Supabase read-only allowlist passes, a read-shaped leaf
  (`get_`, `list_`, `search_`, `read_`, `find_`, `query_`, `describe_`, `fetch_`, `show_`, `view_`,
  `check_`, `inspect_`, `compare_`, `validate_`, `render_`, `extract_`, `convert_`, `download_`,
  `suggest_`, `analyse_`/`analyze_`, `display_`, `lookup_`, `count_`, `preview_`) passes, and
  **everything else is denied** — the twelve Supabase live leaves, `delete_project`,
  `future_write_tool`, hyphenated leaves, any renamed mutation. The denial explains the fix:
  register the UUID in a settings file and, for a reinstalled Supabase connector, add it to
  `SUPABASE_TOOL_RE` so the exact allowlist applies again.
- The hook payload carries only the tool name, and no local file maps a connector UUID to its
  product name, so deriving the *identity* at call time is not possible; the settings registry is the
  closest source of truth an agent or Mason actually maintains. A malformed settings file yields
  fewer registered UUIDs, i.e. more denials, with a stderr note — the safe direction.
- `.claude/hooks/mcp-tool-guard.test.mjs`: the two assertions that pinned the pass-through now assert
  the read-shaped exemption; eight new assertions pin `delete_project`, `future_write_tool`, a
  mixed-case `Create_Event`, and a hyphenated leaf denied on an unregistered UUID (denial text names
  the cause), a `search_` leaf passing, and `unpause_project` / `deploy_to_vercel` on the
  **registered** Vercel UUID passing through to `settings.json`. 55 assertions total.
- `docs/reference/agent-guardrails.md`: the `mcp-tool-guard.mjs` row now records the Supabase exact
  allowlist and the connector-registry rule.

### Residual

A mutation deliberately named with a read verb on an unregistered connector passes to the
classifier. No known connector does that, and registering the UUID (one `settings.json` line, which
agents may now edit natively — PR #605) is the intended path for any new connector.

### Verification

- `node .claude/hooks/mcp-tool-guard.test.mjs` passes (55 assertions).
- Hand probes of the real hook: alternate UUID `delete_project`, `future_write_tool`, `send_message`
  denied; `list_tables`, `get_event` silent; registered Vercel UUID `pause_project` silent; registered
  Supabase UUID `delete_project` denied by the exact-allowlist rule.
- `node scripts/check-agent-guidance.mjs`, `node scripts/check-agent-workflows.mjs`, and
  `node scripts/agent-manifest-parity.test.mjs` pass.
- Not verified: no live call through a reinstalled connector.
