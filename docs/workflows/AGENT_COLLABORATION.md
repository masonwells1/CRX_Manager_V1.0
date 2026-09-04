# Agent Collaboration Workflow

Read this when Claude and Codex work together, a task uses subagents, or agent tooling changes. Mason describes the business outcome; the coordinating agent owns the technical coordination.

## Owner Experience

- Never make Mason coordinate agents, worktrees, branches, or Git.
- Give him one consolidated plain-English status with one recommended next step.
- The coordinator owns task breakdown, risk classification, worker selection, integration, verification, and closeout.

## When to Delegate

Delegate only a significant, independent, bounded task when parallel work or a separate context will save time or improve review quality.

Keep work with the coordinator when it is small, tightly sequential, shares an unsettled interface, or can be completed in a handful of tool calls. Use no more than three ad-hoc workers unless a tested workflow defines a different cap.

Before delegating, give the worker a contract containing:

- the objective and minimum relevant context;
- files, worktree, and systems it owns;
- files and live systems it must not change;
- observable acceptance criteria and required checks; and
- the evidence, findings, and unresolved risks it must return.

Workers return distilled results, not raw logs or a bare “Done.”

## Worktree and Writer Rules

- Use exactly one writer per checkout. Concurrent writers require separate current-main worktrees and disjoint file ownership.
- Preserve unrelated changes and active worktrees. Never clean up, reset, move, or delete another agent’s work.
- Keep dependent database, API, UI, and test work sequential until the coordinator fixes the shared interface.
- A worker does not merge, deploy, apply a live migration, mutate live data, or widen scope independently. The coordinator applies the authority and hard gates in `AGENTS.md`.

## Review and Integration

- Worker tests are supporting evidence. The coordinator reviews every accepted diff and runs the real-path verification required by `AGENTS.md`.
- Money, inventory, auth, RLS, migration, permission, and other business-critical changes keep the exact-SHA independent-review gate.
- Do not add a custom queue, server, container layer, or permanent role merely to coordinate one task. Use the native Claude or Codex orchestration tools and existing workflows.

## Available Paths

| Need | Use |
|---|---|
| Claude reviews current Codex work | `claude-review` |
| Codex reviews current Claude work | `codex-review` |
| Both agents review and reconcile | `agent-pair-review` |
| Durable continuation packet | `codex-to-claude-handoff` |
| Agent/tooling health | `agent-health` |
| PR comment preview or post | `agent-pr-comment` |

Direct reviews are read-only. PR comments default to dry-run. Production and delivery authority comes from `AGENTS.md` and the selected workflow.

## Required Verification

After changing agent commands, skills, hooks, permissions, agents, or helpers:

```powershell
git status --short --branch
node scripts/sync-agent-workflows.mjs --write
npm run test:agent-workflows
npm run agent-health
```

`.claude/commands/`, `.claude/skills/`, and `.claude/hooks/` are the sources of truth. `.agents/` contains generated Codex adapters; `.codex/hooks.json` invokes shared hook implementations through the portable adapter.
