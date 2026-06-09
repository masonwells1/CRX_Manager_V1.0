# Autonomous Execution Prompt — CRX Audit Fix Sprint

This document contains the prompt to paste into a fresh Claude Code session so the agent can execute the audit fix implementation plan autonomously, without waiting for human input between PRs.

---

## How to use this

### Recommended setup (overnight run)

1. Open a new Claude Code session in `C:\Users\mason\CRX_Manager_V1.0`
2. Ensure auto-accept mode is enabled (so the agent doesn't pause on each tool call)
3. Confirm Supabase MCP is connected (`/list-tables` should return data)
4. Copy the entire prompt block below (starting at `BEGIN PROMPT` and ending at `END PROMPT`)
5. Paste into Claude Code and submit
6. Walk away. Agent will work until done, blocked, or session limits reached.

### To enable continuous overnight running

Without `/loop`, Claude Code will eventually stop after one big working session (could be many hours of work but bounded by context window and token budget). To keep the agent working overnight, use one of these approaches:

**Option A — `/loop` skill (recommended).** Type `/loop 30m execute-audit-plan` after pasting the prompt. The agent will re-fire the same prompt every 30 minutes, picking up from where it left off (the prompt is designed to be idempotent — it reads the execution log and git history to determine state).

**Option B — Scheduled task.** Use `/schedule` to create a recurring agent that fires every hour. The prompt is self-resuming.

**Option C — Single max-effort session.** Just paste and let it run as long as one session lasts. Re-paste in the morning to resume. This is the simplest approach.

### When you wake up

1. Read `docs/audits/2026-05-09-execution-log.md` for what got done
2. Read `docs/audits/2026-05-09-execution-summary.md` for the final report (if the agent finished or stopped cleanly)
3. Run `git log fix/audit-2026-05-09 --oneline` to see commits
4. Review any flagged-for-human-review items
5. If more work remains, paste the prompt again to resume

---

## What this prompt does NOT do

The agent will NOT:
- Push commits to GitHub remote
- Merge anything to `main`
- Open PRs
- Apply any migrations to **production** Supabase (uses dev/staging if available, otherwise generates SQL files for manual review)
- Use `--no-verify` to skip git hooks
- Make business-logic decisions you didn't already authorize
- Edit `tests/e2e/utils/auth.ts` credential fallback (PR-05 only — handled per the spec)
- Touch `.env` files

If the agent encounters something that needs human judgment, it logs it and skips to the next non-dependent PR. You'll see the flagged items in the summary report.

---

## BEGIN PROMPT

```
You are continuing an autonomous implementation sprint for CRX Manager. Your job is to execute as many PRs as possible from the implementation plan without waiting for human input. Mason has already approved every business-logic decision; you do not need to ask.

# Anchoring context

- Working directory: C:\Users\mason\CRX_Manager_V1.0 (Windows, PowerShell)
- Repo: https://github.com/masonwells1/CRX_Manager_V1.0
- Live app: https://croprxsolutions.app
- Supabase project ID: rhyzpcqhnizqbxphqdkr
- Branch you should work on: fix/audit-2026-05-09 (create if it doesn't exist; otherwise check it out)

# Required reading before any work

Read these three files in full before doing anything else:

1. docs/audits/2026-05-09-combined-audit.html — the source audit (52 findings, 11 business decisions)
2. docs/audits/2026-05-09-implementation-plan.md — the PR plan (26 PRs across 6 phases)
3. CLAUDE.md — project rules (always loaded, but re-skim relevant sections like Migration Safety Rules, Code Drift Prevention Rules, Hard Red Lines)

Also skim:
- docs/reference/gotchas.md
- The most recent 3 migrations in supabase/migrations/ to understand the current pattern for SECURITY DEFINER + idempotency

# Mission

Execute every PR in the implementation plan in dependency order. Commit each PR to the feature branch. Update the execution log after each PR. Generate a final summary when stopping.

# Decisions already made — do not re-ask

- Q1 password rotation: DONE before this session
- Q2 driver/applicator RLS: Option B (today's route + assigned customers)
- Q3 profiles RLS: safer default (admins + self for full PII)
- Q4 quick delivery credit limit: Option C (soft warn + admin notification, do not block)
- Q5 invoice payment: Option B (rewrite inline modal to use allocate_payment)
- Q6 PAGE_PERMISSIONS: actively used, patch missing routes + add fail-closed test
- Q7 send-email: assume broken, prioritize fix
- Q8 vendor chain: deep-dive integrated into the plan
- Q9 tote backfill: SKIP (do not write a backfill script)
- Q10 E2E env: Phase 1 hardening now (PR-05), Phase 2 staging later (PR-23)
- Q11 void paid bill: hard-block (must void payments individually first)

If you encounter ambiguity not covered by the above, default to the safer option, log it in the execution log under "Decisions made autonomously," and proceed.

# Idempotency — read before any execution

This prompt is designed to be re-run multiple times. Before doing anything:

1. git checkout fix/audit-2026-05-09 (create from main if it doesn't exist)
2. Read docs/audits/2026-05-09-execution-log.md if it exists. The log lists every PR with status: completed / failed / skipped / blocked / in-progress.
3. git log fix/audit-2026-05-09 --oneline to see what commits already exist on this branch
4. Determine the next un-completed PR. Do NOT redo completed work.
5. Resume from there.

If a PR is marked "in-progress" in the log but never reached "completed," check git status. If there are uncommitted changes related to that PR, decide: complete and commit, or revert and restart that PR. Do not leave the working tree dirty when starting a new PR.

# Per-PR workflow

For each PR, follow this loop exactly:

1. Read the PR section from the implementation plan (e.g., PR-01 starts under "## PR-01")
2. Update TodoWrite — add a single in-progress todo for this PR with the PR title
3. Append entry to docs/audits/2026-05-09-execution-log.md:
   ```
   ## PR-XX — <title>
   Status: in-progress
   Started: <ISO timestamp>
   ```
4. Implement the PR exactly as specified. If the PR has Risk: High, generate the migration SQL but do NOT apply it to a live Supabase project. Save it to the migration file and let Mason apply it manually after review.
5. Run quality gates in this order. STOP and mark failed if any gate fails:
   a. node scripts/regenerate-schema-registry.mjs (if migration changed)
   b. npm run lint
   c. npm run typecheck
   d. npm run build
   e. npm run test
   f. bash scripts/validate-sql-migrations.sh (if migration changed)
6. Stage and commit:
   - git add (specific files only — don't use git add -A, never commit .env or credentials)
   - git commit with a conventional message: "fix(domain): one-line summary"
   - Body: "Implements PR-XX of 2026-05-09-implementation-plan.md. Closes audit findings: <list>."
   - Always include "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
   - NEVER use --no-verify
7. Update execution log entry to "completed" with elapsed time
8. Mark TodoWrite todo as completed
9. Move to next PR

If a quality gate fails:
- Try once to fix the immediate problem (e.g., fix a syntax error, regenerate schema registry)
- If still failing, mark PR as failed in the log with the error message and revert any uncommitted changes (git checkout -- .)
- Move to next non-dependent PR
- Do NOT keep retrying the same PR more than twice

# Sequencing

Follow the sequencing in the implementation plan exactly:

Sprint 1 (Phase 1):
1. PR-01 — fix delivery_date column refs (Low risk, ~1 hour)
2. PR-02 — fix idempotency replay in 5 RPCs (Medium risk, ~2-3 hours)
3. PR-03 — fix send-email column (Low risk, ~30 min)
4. PR-05 — E2E hardening Phase 1 (Low risk, ~1 hour)
5. PR-04 — AP RPC trio + structural fixes (HIGH risk, ~5-7 hours)

For PR-04: because of the high risk, generate the migration SQL but do NOT apply it to live Supabase. Save the migration file. Run all OTHER quality gates (lint, typecheck, build, test will run unit tests but skip live migration). Mark the PR as "completed but pending live application — review and apply manually" in the log.

Sprint 2 (Phase 2):
6. PR-09 — write_off formula (Low risk, 30 min) — do this first, easy warmup
7. PR-06 — credit limit soft warn (Low risk, 1.5 hours)
8. PR-11 — PAGE_PERMISSIONS holes + test (Low risk, 1 hour)
9. PR-12 — pg_temp on SECURITY DEFINER (Low risk, 30 min)
10. PR-07 — RLS tightening (Medium risk — generate SQL, mark for manual apply, ~2 hours)
11. PR-08 — invoice detail unify (Medium risk, ~2-3 hours) — depends on PR-02
12. PR-10 — bulk idempotency wiring (Medium risk, ~2-3 hours) — depends on PR-02

Sprint 3 (Phase 2.5) — only after PR-04 confirmed applied:
13. PR-15 — parseDollarsToCents fix (Low risk, 1 hour)
14. PR-13 — void_vendor_payment + paid-bill guard (Medium risk — generate SQL, ~3-4 hours)
15. PR-14 — update_vendor_bill (Low risk — generate SQL, ~1.5 hours)

Sprint 4 (Phase 3, parallel-able):
16. PR-21 — misc cleanup bundle (Low risk, 45 min)
17. PR-19 — tighten coverage tests (Low risk, 2 hours)
18. PR-20 — logActivity cleanup (Low risk, 1 hour)
19. PR-16 — Edge function CORS (Low risk, 30 min)
20. PR-17 — team_note_tags RLS (Low risk, 30 min)
21. PR-18 — validate-frontend.sh --all (Low risk, 20 min)

Sprint 5 (Phase 3.5):
22. PR-22 — AP polish bundle (Low risk — generate SQL, ~2-3 hours)

Sprint 6 (Phase 4):
23. PR-25 — vendor master-data UI (Medium risk, 3-4 hours)
24. PR-26 — final docs update (Low risk, 1-1.5 hours)

PR-23 (E2E staging Supabase) requires creating a new Supabase project. SKIP this PR autonomously. Mark as blocked with reason: "Requires manual creation of staging Supabase project."

PR-24 (vendor master-data UI) does NOT require staging — it's just a new page. Proceed normally.

# Hard rules — NEVER break

- NEVER push to remote (no git push)
- NEVER merge to main
- NEVER use --no-verify or any other flag that bypasses git hooks
- NEVER apply migrations to live production Supabase (rhyzpcqhnizqbxphqdkr is prod — only generate SQL, mark for manual review on High Risk PRs)
- NEVER edit .env files
- NEVER commit credentials, API keys, or any secret strings
- NEVER bypass the PreToolUse hooks in .claude/hooks/
- NEVER claim a PR is "completed" if any quality gate failed
- NEVER make business-logic decisions Mason hasn't authorized
- NEVER skip the schema registry regeneration after migration changes
- NEVER reset --hard, force-push, or do any destructive git operations
- NEVER continue past 3 consecutive PR failures (likely systemic problem; stop and report)

# Soft rules — default to safer choice

- If a test is flaky, retry once. If still failing, mark PR failed.
- If a migration depends on a table column you can't verify exists, query Supabase MCP to confirm before writing
- If you're about to do something that feels risky and isn't explicitly in the plan, log it and skip
- If you're unsure about return shape of an RPC, read the existing function body before rewriting
- If a file edit is large (>200 lines), read the surrounding context first

# Progress log format

Append to docs/audits/2026-05-09-execution-log.md after each PR:

```
## PR-XX — <title>
Status: completed | failed | skipped | blocked | in-progress
Started: <ISO timestamp>
Completed: <ISO timestamp>
Elapsed: <minutes>
Risk: Low | Medium | High
Files changed: <count>
Commit: <short SHA>
Findings closed: <list of audit IDs>
Notes:
- <bullet>
- <bullet>
Test outcomes:
- npm run lint: pass | fail
- npm run typecheck: pass | fail
- npm run build: pass | fail
- npm run test: pass | fail (X tests)
- validate-sql-migrations: pass | fail
```

If a PR is blocked or failed, include a "Why" section with enough detail that Mason can pick up the work cold.

# Final summary

When you stop (because all PRs done, or 3 failures, or token budget warning, or other halt condition), write docs/audits/2026-05-09-execution-summary.md with:

```
# CRX Audit Fix Sprint — Execution Summary

Stopped at: <ISO timestamp>
Reason for stopping: <one of: all PRs complete | 3 consecutive failures | token budget approaching | catastrophic error | other>

## Completed PRs (X)
- PR-01: <one-line outcome>
- ...

## Failed PRs (X)
- PR-XX: <one-line reason>
  - Recovery: <what Mason should do>

## Skipped PRs (X)
- PR-XX: <reason>

## Blocked PRs (X) — pending Mason's action
- PR-XX: <what's needed from Mason>

## Migrations awaiting manual apply (HIGH RISK PRs)
- PR-XX: <migration filename> — <one-line description>

## Decisions made autonomously (not in original plan)
- <decision>: <why>

## Recommended next session focus
- <bullet>
- <bullet>

## Branch state
- Branch: fix/audit-2026-05-09
- Commits ahead of main: <count>
- Last commit: <short SHA> — <subject>
```

# Stop conditions — leave the working tree clean

You MUST stop and write the final summary if any of these happen:

1. All 26 PRs in the plan are processed (completed, failed, skipped, or blocked)
2. 3 consecutive PR failures (suggests systemic problem)
3. You attempted to do something the rules forbid (immediate stop with explanation)
4. You hit a context-window or token-budget warning
5. A quality gate is fundamentally broken (e.g., npm not found) and not recoverable

Before stopping:
- Ensure git working tree is clean (no uncommitted changes)
- Update execution log with current status
- Write the summary doc
- Final TodoWrite update reflecting actual state

# What to do at the very start

1. cd to C:\Users\mason\CRX_Manager_V1.0 (or verify you're already there)
2. git status — confirm clean working tree
3. git checkout fix/audit-2026-05-09 (create from main if needed: git checkout -b fix/audit-2026-05-09 main)
4. Read the three required-reading docs
5. Read the execution log if it exists; determine resume point
6. Update TodoWrite with the full list of PRs as todos (mark already-completed as done)
7. Begin the next PR
8. Do not output any preamble to Mason — go straight to work. The execution log is the report.

# Reminders

- Mason will be asleep. Do not generate questions for him.
- The execution log is the only durable record of progress.
- Each commit is durable progress. Aim for one commit per PR; never batch multiple PRs into one commit.
- Use the same model you're already running (don't switch models; you're configured for this session).
- TodoWrite + execution log + git commits are your three persistence layers.
- When in doubt, smaller is safer. Skip rather than risk corrupting state.

Begin now. Read the required docs, then start the next PR.
```

## END PROMPT

---

## Notes for Mason

### What "all night" really means

A single Claude Code session has practical limits — context window, token budget, and the agent eventually stopping when it's done with what it can do. With this prompt, expect:

- **Best case**: 15-25 PRs completed in one long session (most of Phases 1-3)
- **Likely case**: 10-15 PRs completed, mix of completed/failed/blocked
- **Worst case**: 3-5 PRs done if it hits an unexpected systemic issue early

The prompt is designed so re-pasting it next session resumes from where it left off. So one long night might cover Phases 1-2, the next morning you skim the log, paste again, agent does Phases 2.5-3, etc.

### What you'll see in the morning

Three artifacts:

1. **`docs/audits/2026-05-09-execution-log.md`** — the running log, one entry per PR with status, timing, and outcomes
2. **`docs/audits/2026-05-09-execution-summary.md`** — the final report, written when the agent stopped
3. **Git commits on `fix/audit-2026-05-09`** — durable progress; review with `git log fix/audit-2026-05-09 --oneline`

Plus any HIGH-risk migrations sitting in `supabase/migrations/` flagged for manual apply.

### Manual review queue

The agent will NOT apply these to production Supabase autonomously. Expect to manually apply (via Supabase MCP, dashboard, or CLI):

- PR-04 — AP RPC trio + structural fixes (largest)
- PR-07 — Customer + profile RLS tightening
- PR-13 — void_vendor_payment + paid-bill guard
- PR-14 — update_vendor_bill
- PR-22 — AP polish bundle

For each, the migration file will exist in `supabase/migrations/` and the execution log will have a "pending live application" note. Review the SQL, then apply via Supabase MCP `apply_migration` tool when you're ready.

### How to stop the agent if needed

If you wake up and want to halt the work:
- Press `Esc` in Claude Code to interrupt the current turn
- Or just let the session finish — the agent commits per-PR, so partial progress is preserved
- The execution log will be valid even if interrupted mid-PR

### How to resume

Just paste the same prompt again. The first thing it does is read the execution log and git history to figure out where it left off.

### Things that will trip up the agent

These will likely cause the agent to mark a PR as blocked/failed and skip:

- **No Supabase MCP connection** — anything requiring schema queries fails. Make sure MCP is connected before starting.
- **Network issues mid-session** — agent will retry once, then skip.
- **Production password DOES need re-rotation** — agent assumes it's been done. If it hasn't, manually rotate it before running this prompt.
- **Working tree not clean at start** — agent expects a clean state. Commit or stash before starting.
- **Branch has unrelated commits** — agent assumes `fix/audit-2026-05-09` is its own branch. Don't pre-populate it.

### One last thing

This is autonomous execution. The agent will commit code with your name. If something goes wrong, you can always:
- `git checkout main && git branch -D fix/audit-2026-05-09` to nuke everything
- `git revert <commit>` to undo specific commits
- Re-run with adjusted instructions if a class of errors shows up

The audit doc, the implementation plan, and this prompt together are the complete spec. The agent has everything it needs.
