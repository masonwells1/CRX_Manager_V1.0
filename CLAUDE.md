@AGENTS.md

# Claude Code Routing

`AGENTS.md` is the canonical shared contract. This file holds only Claude-specific routing and never weakens shared policy.

- Follow the `AGENTS.md` routing table; load nothing extra at session start. For architecture, difficult debugging, tracing, structural audits, and PR impact, invoke `graphify` before broad searching. It narrows source reads and never replaces source or live verification; documentation is outside its code-only corpus, so inspect docs directly.
- Search `.claude/schema-registry.json` by table or column (too large to read whole); refresh it after schema changes.
- Read `docs/reference/claude-model-tuning.md` only when choosing models or effort, delegating, or writing reviewer prompts.
- Cloud sessions may lack `node_modules`, `gh`, Codex, Graphify, or the Supabase MCP: say early which gates cannot run, finish what can, and deliver a draft PR. Never report an unrun gate as passed.
- `docs/manual/` is the synthesis layer: onboarding, architecture, decisions, known issues, current state, and Mason's owner playbook.

## Workflows

Route Mason's plain-English requests; he should not need workflow names.

| Need | Workflow |
|---|---|
| Read-only second-model review | `codex-review` from Claude; `claude-review` from Codex |
| Claude + Codex reconciliation | `agent-pair-review` |
| Adversarial review | `codex-gauntlet` or `codex-review` |
| Durable handoff | `codex-to-claude-handoff` |
| PR review comment | `agent-pr-comment` (dry-run by default) |
| Agent/tooling health | `agent-health` |
| Pre-ship verification and delivery | `preflight` or `ship` |
| Migration work | `migration-review`, `create-migration`, or `explain-migration` |

## Hooks and Maintenance

- `.claude/settings.json` is the permission and hook manifest; `.claude/hooks/` is the source of truth for guard logic, which `.codex/hooks.json` runs through the portable adapter. Behavior: `docs/reference/agent-guardrails.md`. Declare any Claude/Codex hook difference in `scripts/agent-manifest-parity.mjs`.
- After changing Claude commands, skills, hooks, permissions, or agents, run `node scripts/sync-agent-workflows.mjs --write`, `npm run test:agent-workflows`, and `npm run agent-health`.
