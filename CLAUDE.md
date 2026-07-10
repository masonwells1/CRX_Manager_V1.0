@AGENTS.md

# Claude Code Additions

`AGENTS.md` is the canonical shared project contract. This file contains only Claude Code routing and must not duplicate or weaken it.

## Session Routing

- At session start, read `AGENTS.md`, then load `docs/workflows/SAFE_DEVELOPMENT_RULES.md` and only the workflow/reference files relevant to the task.
- Use `docs/reference/gotchas.md` when working around project-specific behavior.
- Use `.claude/schema-registry.json` for current schema-aware hook checks; refresh it after approved schema changes.
- Treat `docs/CHANGELOG.md`, `docs/reference/`, and active loop/ledger files as the location for changing project status and counts.

## Claude Workflows

Mason can ask in plain English; route to these skills/commands without requiring him to remember names:

| Need | Workflow |
|---|---|
| Read-only second-model review | `claude-review` |
| Claude + Codex reconciliation | `agent-pair-review` |
| Durable handoff artifact | `codex-to-claude-handoff` |
| Agent/tooling health | `agent-health` |
| PR review comment preview/post | `agent-pr-comment` |
| Adversarial Codex review | `codex-gauntlet` or `codex-review` |
| Pre-ship verification | `preflight` or `ship` |
| Migration review/create/explain | `migration-review`, `create-migration`, `explain-migration` |

Direct reviews are read-only. PR comments default to dry-run. None of these workflows may push, deploy, apply a live migration, mutate/delete live data, or expose secrets without the approval required by `AGENTS.md`.

## Claude Hooks and Agents

- `.claude/settings.json` is the Claude permission and hook manifest.
- `.claude/hooks/` is the single source of truth for shared guard logic. The tracked `.codex/hooks.json` invokes those files through a portable adapter; do not copy hook implementations into `.codex/`.
- Full hook and reviewer-agent behavior is documented in `docs/reference/agent-guardrails.md`.
- Migration work must satisfy the RLS/security and drift-review gates before a live apply can even be considered.
- Unattended mode never widens the hard deny set for push, production deploy, live migration, destructive data operations, or secrets.

## Maintenance

After changing Claude commands, skills, hooks, permissions, or agent helpers:

```powershell
node scripts/sync-agent-workflows.mjs --write
npm run test:agent-workflows
npm run agent-health
```

Do not regenerate `AGENTS.md` from this file. `scripts/regenerate-agents-md.mjs` is a compatibility validator and will not overwrite the shared contract.
