@AGENTS.md

# Claude Code Additions

`AGENTS.md` is the canonical shared project contract. This file contains only Claude Code routing and must not duplicate or weaken it.

## Session Routing

- At session start, read `AGENTS.md`, then load `docs/workflows/SAFE_DEVELOPMENT_RULES.md` and only the workflow/reference files relevant to the task.
- `docs/manual/` is the synthesis layer: `AGENT_ONBOARDING.md` for a first session, `DECISION_LOG.md` before re-opening a settled decision, `KNOWN_ISSUES.md` before treating a bug as new, `OWNER_PLAYBOOK.md` when Mason asks "how do I…". Whoever changes a command, policy, or ships/parks work updates the affected manual file in the same change.
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
- Unattended mode never loosens the hard deny set for push, production deploy, destructive data operations, or secrets. Live migrations in an armed hands-free run follow the settled 2026-07-13 policy in `AGENTS.md`/`docs/manual/DECISION_LOG.md`: the migration-apply-guard proof + Codex gates apply in full, and destructive migrations are hard-refused while armed.

## Maintenance

After changing Claude commands, skills, hooks, permissions, or agent helpers:

```powershell
node scripts/sync-agent-workflows.mjs --write
npm run test:agent-workflows
npm run agent-health
```

Do not regenerate `AGENTS.md` from this file. `scripts/regenerate-agents-md.mjs` is a compatibility validator and will not overwrite the shared contract.
