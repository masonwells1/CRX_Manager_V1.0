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
- No workflow may push, deploy, apply live migrations, delete data, commit, or expose secrets without Mason's explicit approval in the current conversation.

## Required Verification

Run this after changing agent commands, skills, hooks, or helper scripts:

```powershell
npm run test:agent-workflows
node scripts/agent-health-check.mjs
.codex\sync-from-claude.ps1 -IncludeHooks
```
