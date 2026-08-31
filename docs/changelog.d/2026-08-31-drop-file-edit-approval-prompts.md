## 2026-08-31 — Claude no longer prompts for approval to edit configuration and guard files

Mason approved removing the file-edit half of the `ask` list in `.claude/settings.json`. Editing
the guard scripts, agent settings, `.codex` config, `.coderabbit.yaml`, `.husky`, `package.json`,
`.github/workflows`, `AGENTS.md`, `CLAUDE.md`, and the `scripts/check-*`, `scripts/validate-*`,
`scripts/verify-*` helpers no longer raises an approval prompt. The `mcp__Desktop_Commander__*`
and `mcp__filesystem__*` write entries were removed with them; `Bash`, `Edit`, and `Write` were
already blanket-allowed, so those entries granted no capability the session lacked.

The `ask` list keeps every production action: `vercel --prod`, Supabase edge-function deploys
(all four MCP aliases plus the CLI forms), `mcp__Vercel__deploy_to_vercel`,
`update_project_deployment_protection`, `gh pr merge`, and the GitHub `push_files`,
`create_or_update_file`, `delete_file`, and `merge_pull_request` write tools. The `deny` list is
unchanged — force-push, `git reset --hard`, `git clean -f`, `rm -rf`, and `.env` writes stay
hard-blocked.

Approval prompts were never the enforcement layer here; the deterministic PreToolUse hooks are,
and none of them changed. `npm run test:agent-workflows` passes and asserts directly that every
`deploy_edge_function` alias still "requires approval" and is "not auto-allowed", proving the
production gates survived the edit. `node scripts/agent-manifest-parity.mjs` and
`npm run agent-health` also pass (the one `agent-health` warning is the pre-existing
schema-registry staleness, unrelated to this change). No schema, live data, or hook logic changed.
