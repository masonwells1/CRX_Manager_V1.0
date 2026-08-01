# Loop mission — PR #289 push-guard closeout

**Created:** 2026-08-01 · **Owner:** Mason · **Scope:** ordinary repository tooling only; no database or Supabase work.

## Driver

Codex drives each cycle: inspect the exact-head proof result, confirm each finding in current source,
make the smallest complete fix, run real-path and mutation proof where a guard changes, run the full
pipeline, commit only scoped files, and request a fresh exact-head Codex proof. A CLEAN proof triggers
push and PR verification automatically. Mason is contacted only for a genuine hard gate or unresolved
review disagreement after the loop cap.

## Granularity

One cycle is one exact-head review result and the smallest coherent commit that closes every confirmed
BLOCKER/HIGH finding from that result. Re-review after each commit. Maximum three fix-to-re-review
rounds in this resumed loop; the same finding surviving twice is a hard stop with evidence.

## Worktree

Dedicated worktree `C:\Users\mason\.claude\worktrees\secdef-pricing-guard\CRX_Manager`, branch `claude/claude-memory-ignore-and-offsite-20260729`. This loop owns only PR #289 changes and preserves
unrelated work.

## Definition of done

The loop ends when the exact-head proof is CLEAN and bound to current HEAD plus current `origin/main`,
the branch is pushed, PR #289 has green required checks including Vercel, CodeRabbit's latest review
is read and every valid finding is fixed or explicitly answered, and PR #289 is merged into `main`.
If a required external reviewer is unavailable or a confirmed finding survives the loop cap, end
BLOCKED with the exact evidence rather than self-certifying.

## Delivery gate

Mason explicitly authorized the ordinary fixes, branch push, PR work, and merge in this conversation.
Never force-push, bypass the exact-head proof, push a red pipeline, touch Supabase, apply a migration,
deploy an edge function, delete data, or change secrets/auth/permissions. The private CRX_Backups push
remains separate and is not part of this loop.

## Cycle protocol

1. Verify branch, worktree cleanliness, `origin/main`, and PR state.
2. Obtain or inspect the independent exact-head review result using the sanctioned proof wrapper.
3. Confirm and fix every BLOCKER/HIGH; fix cheap lower findings and document any justified dismissal.
4. Prove changed guards through focused, mutation, and actual-hook/backup paths as applicable.
5. Run the full commit and pre-push pipelines without bypasses.
6. Run `node scripts/write-codex-push-proof.mjs --timeout 1500` with no `--base`.
7. On CLEAN only: push the named branch, wait for required checks, read and answer CodeRabbit, merge,
   and verify PR state plus `main` ancestry.

## Cycle ledger

- Cycle 1: BLOCKERS — confirmed PowerShell expression-concatenated `push` bypass; MEDIUM missing or
  flag-shaped `--source` fallback. Both fixed with helper, actual-hook, and CLI regressions; awaiting
  mutation proof, full pipeline, and exact-head re-review.
