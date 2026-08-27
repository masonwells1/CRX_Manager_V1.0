# Agent Collaboration Workflow

This is the shared CRX Manager workflow for making Claude and Codex work together without Mason remembering command names.

## Available Paths

| Need | Use |
|---|---|
| Claude directly reviews Codex/current work | `claude-review` |
| Claude needs a durable packet to continue elsewhere | `codex-to-claude-handoff` |
| Both agents review and disagreements are reconciled | `agent-pair-review` |
| Check whether the collaboration setup is healthy | `agent-health` |
| Attach a review/handoff/audit file to a PR | `agent-pr-comment` |

## Safety Defaults

- Direct reviews are read-only.
- PR comments default to dry-run.
- Pair reviews keep BLOCKER/HIGH disagreements visible for Mason.
- Routine reversible work, commits, feature-branch pushes, protected green-PR merges, and verification use Mason's standing authorization and must not trigger a second approval request. Workflows still stop at the hard gates in `AGENTS.md`; existing migration, production-action, review, CI, and branch-protection guards remain authoritative.

## Required Verification

Run this after changing agent commands, skills, hooks, or helper scripts:

```powershell
npm run test:agent-workflows
node scripts/agent-health-check.mjs
node scripts/sync-agent-workflows.mjs --check
```

`.claude/commands/` and `.claude/skills/` are the workflow source. Run `node scripts/sync-agent-workflows.mjs --write` after changing them. Shared hook implementations are not copied: tracked `.codex/hooks.json` invokes `.claude/hooks/` through the worktree-aware adapter.
