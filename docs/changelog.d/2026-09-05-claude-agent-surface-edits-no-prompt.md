## 2026-09-05 — Claude may edit the agent-surface files without a permission prompt

Mason's direction (2026-09-05): give Claude and Codex free rein on everything reversible in this
repo. He cannot review code, so a permission prompt buys him nothing; the deterministic hooks are
the real gate. Merge behaviour, the deploy gates and the live-database gates stay exactly as they
were — he said so explicitly.

### What changed in `.claude/settings.json`

- Removed from `permissions.ask`: native `Edit`/`Write` of `.claude/hooks/**`, `.codex/hooks/**`,
  `.codex/hooks.json`, `.codex/config.toml`, `.claude/settings.json`, `.claude/settings.local.json`,
  `.coderabbit.yaml`, `.husky/**`, `package.json`, `.github/workflows/**`, `scripts/check-*`,
  `scripts/validate-*`, `scripts/verify-*`, `scripts/remove-applied-ledger-entry.mjs`,
  `scripts/write-codex-push-proof.mjs`, `scripts/run-claude-review.mjs`; and the Desktop Commander /
  filesystem MCP write tools (`start_process`, `interact_with_process`, `write_file`, `edit_block`,
  `edit_file`, `move_file`, `set_config_value`).
- Added to `permissions.allow`: `Task`, `mcp__Claude_Browser`, and explicit read-only Supabase and
  Vercel MCP tools, so a read tool is no longer silently refused. (The first cut used server-wide
  grants; the exact-SHA Codex review blocked that — see
  `2026-09-05-claude-settings-explicit-mcp-grants.md` for the correction and the new `deny`
  entries for the Supabase lifecycle and filesystem/Desktop Commander mutators.)

Why the `ask` entries mattered more than they looked: this repo runs `defaultMode: dontAsk`, and in
that mode an `ask` rule is a silent deny. So these were never prompts — Claude simply could not edit
`package.json`, a hook, a workflow, or a check script at all, and Mason could not tell why work
stalled.

### Unchanged on purpose

- Every merge entry stays in `ask`: `Bash(gh pr merge:*)`, `mcp__github__merge_pull_request`,
  `mcp__github__push_files`, `mcp__github__create_or_update_file`, `mcp__github__delete_file`.
- Every deploy entry stays in `ask`: the Vercel production CLI flags, the Supabase edge-function
  deploy CLI, every `deploy_edge_function` variant, `mcp__Vercel__deploy_to_vercel`,
  `mcp__Vercel__update_project_deployment_protection`.
- The `deny` list, every hook, and the hook registrations are untouched. `ask` still outranks
  `allow`, so the new `mcp__github` server grant does not unlock `merge_pull_request` — verified by
  reading the precedence rule, not assumed.
- `review-proof-guard.mjs` still denies SHELL writes to these same paths (fail-closed read-only
  allowlist, 2026-09-01). Native `Edit`/`Write` is the sanctioned path, and `.claude/settings.json`,
  `.claude/hooks/`, `.husky/`, `.github/workflows/` and `package.json` remain risky paths, so a change
  to any of them still needs the exact-SHA Codex proof before it can merge.

### Docs and comments brought in line

- `docs/reference/agent-guardrails.md` (review-proof-guard row) no longer claims the `ask` tier gates
  native `Edit`/`Write` of the enforcement surfaces; the mcp-tool-guard row no longer says
  `set_config_value` requires `ask` approval.
- `.claude/hooks/mcp-tool-guard.mjs` header comment updated the same way (comment only, no logic).

### Verification

- `node scripts/check-agent-workflows.mjs`, `node scripts/check-agent-guidance.mjs`, and
  `node scripts/agent-manifest-parity.test.mjs` pass against the new settings file.
- Not verified here: the loosened permissions take effect only in a session rooted in this checkout
  after the change lands on `main`; this PR does not exercise a live edit under the new settings.
