@AGENTS.md

# Claude Code Routing

`AGENTS.md` is the canonical shared contract. This file contains only Claude-specific routing and must not duplicate or weaken shared policy.

## Load Guidance on Demand

- Follow the task-routing table in `AGENTS.md`; do not load every workflow or reference file at session start.
- For the architecture, difficult-debugging, tracing, structural-audit, and PR-impact tasks named in `AGENTS.md`, invoke the `graphify` skill before broad `Read`/`Glob`/`Grep` exploration. Graphify narrows source reads; it never replaces source or live verification. Documentation is outside its code-only corpus, so use focused document inspection for documentation tasks.
- Use `.claude/schema-registry.json` for schema-aware work and refresh it after approved schema changes.
- Read `docs/reference/claude-model-tuning.md` only when choosing Claude models or effort, delegating work, or writing reviewer prompts.
- The synthesis layer is `docs/manual/`: onboarding, architecture, settled decisions, known issues, current state, and Mason’s plain-English owner playbook.

## Claude Workflows

Mason can ask in plain English; route the request without requiring him to remember workflow names.

| Need | Workflow |
|---|---|
| Read-only second-model review | `codex-review` from Claude; `claude-review` from Codex |
| Claude + Codex reconciliation | `agent-pair-review` |
| Durable handoff | `codex-to-claude-handoff` |
| Agent/tooling health | `agent-health` |
| PR review comment | `agent-pr-comment` |
| Adversarial review | `codex-gauntlet` or `codex-review` |
| Pre-ship verification and delivery | `preflight` or `ship` |
| Migration work | `migration-review`, `create-migration`, or `explain-migration` |

Direct reviews are read-only and PR comments default to dry-run. Production authority and hard gates come from `AGENTS.md` and the selected workflow.

## Hooks and Generated Surfaces

- `.claude/settings.json` is Claude’s permission and hook manifest. `.claude/hooks/` is the source of truth for shared guard logic; `.codex/hooks.json` invokes those files through the portable adapter.
- Hook and reviewer behavior is documented in `docs/reference/agent-guardrails.md`. Never copy shared hook implementations into `.codex/`.
- Claude/Codex hook differences must be declared in `scripts/agent-manifest-parity.mjs`; otherwise wire the guard on both sides.

## Maintenance

After changing Claude commands, skills, hooks, permissions, agents, or helpers:

```bash
git status --short --branch
node scripts/sync-agent-workflows.mjs --write
npm run test:agent-workflows
npm run agent-health
```

Do not generate `AGENTS.md` from this file. `scripts/regenerate-agents-md.mjs` only validates compatibility.
