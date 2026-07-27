# Codex Review Gauntlet Design

## Goal

Build a repeatable CRX review loop where Claude and Codex cross-check each other, confirmed bugs are fixed, and every real bug class creates a durable prevention control such as a test, hook, smoke test, doc rule, or review prompt update.

## Problem

Codex has repeatedly caught important bugs after Claude believed work was ready. The current tools already help, but they are spread across `/ship`, `/codex-review`, `/review-workflow`, hooks, smoke tests, and docs. Mason needs one clear loop that can run in two modes:

- **Per-change gate:** review the current branch or uncommitted diff before push.
- **Foundation audit:** review the whole app workflow, business logic, and database wiring on a schedule or before major features.

The loop must learn by updating repo-owned checks, not by relying on memory or a model remembering past mistakes.

## Design

Create a new CRX workflow called **Codex Review Gauntlet** with one command-style entrypoint and one skill wrapper.

The gauntlet has two loops.

1. **Per-change loop**
   - Check repo state first: dirty files, staged files, branch, stale schema registry, doc drift warnings.
   - Pick review scope: `--base main`, `--uncommitted`, or `--commit <sha>`.
   - Run evidence gates before Codex when the diff touches database, money, RLS, migrations, RPCs, Edge Functions, or business workflows.
   - Run `codex review` read-only.
   - Claude independently verifies each BLOCKER/HIGH finding against source, tests, migrations, or live database evidence.
   - Fix confirmed BLOCKER/HIGH issues through the normal safe development path.
   - Re-run the same review until the verdict is `SHIP` or `SHIP-WITH-FOLLOWUPS`.

2. **Foundation audit loop**
   - Refresh the workflow map.
   - Run the existing `review-workflow` process.
   - Verify every finding before reporting.
   - Feed confirmed recurring bug classes back into the prevention backlog.

## Learning Mechanism

The gauntlet records a prevention action for each confirmed BLOCKER/HIGH bug. Valid prevention actions are:

- a unit, integration, E2E, smoke, or SQL invariant test;
- a Claude hook or local validation script;
- an ESLint rule or existing rule expansion;
- a review prompt update in a command or skill;
- a `docs/reference/gotchas.md` entry when the issue is too contextual for a deterministic check.

The preferred order is: executable check first, workflow prompt second, documentation third.

## Safety Gates

The gauntlet must never automatically push, deploy, apply migrations, delete data, or commit unrelated work.

Production-risk actions require Mason's explicit approval in the current conversation:

- production push;
- production deploy;
- live migration application;
- destructive data action;
- changes that touch `.env` or secrets;
- committing when unrelated staged files already exist.

## Files To Implement

- `docs/workflows/CODEX_REVIEW_GAUNTLET.md` documents the workflow in plain English.
- `.claude/commands/codex-gauntlet.md` provides the runnable Claude command instructions.
- `.claude/skills/codex-gauntlet/SKILL.md` exposes the workflow as a reusable skill.
- Run `.codex\sync-from-claude.ps1 -IncludeHooks` after command/skill changes so Codex receives the synced command and skill view.

## Verification

Because this is workflow/tooling documentation, the first implementation does not need a production build. Verification should include:

- `git diff --check`
- read the new command and skill files back from disk
- run the Claude-to-Codex sync script
- confirm no unrelated files were staged or committed

If later iterations add hooks, scripts, or tests, they must run the matching hook tests or npm scripts.

## Open Decision

The first implementation should not change the existing `/ship` command because `.claude/commands/ship.md` is already modified before this session. The safe first version adds a separate `/codex-gauntlet` workflow. After Mason confirms it works, a later pass can wire it deeper into `/ship`.
