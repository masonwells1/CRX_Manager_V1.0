# Restore ledger — five landed-or-retired branches deleted (2026-09-03, batch 2)

**Status: EXECUTED 2026-09-03 with Mason's explicit in-chat answer ("yes to all three") to the
three questions the first ledger left open.** Every branch below is recoverable from its tag on
`origin`. This is the second batch of the day; the first six are in
`docs/audits/2026-09-03-merged-pr-leftover-restore-ledger.md`.

These are rows 1–3, 10 and 11 of the delete list in
`docs/audits/2026-09-02-github-branch-cleanup-audit.md`. Rows 1–3 became eligible when Mason
merged PRs #576 and #577 himself; row 10 needed its clean worktree removed; row 11 needed the
content-gate decision now recorded in `docs/manual/DECISION_LOG.md` (2026-09-03).

## What was verified immediately before each deletion, in this session

- `git ls-remote --heads origin <branch>` returned the same commit the audit measured.
- Fresh open-PR lookup by head branch: zero for all five.
- Local branch refs exist for all five and are 0 commits ahead of their remotes.
- Only `offline-review-stale-snapshot` was checked out anywhere (`C:\crx-wt\ledger-gitdir`, 0 dirty
  files, 0 untracked files); that worktree was removed with `git worktree remove` first.
- Per-file blob comparison at `origin/main = 5d8dad6f2`:
  - `sanitizeerror-mock-divergence-followup` — all 5 files IDENTICAL on `main` (landed via #576).
  - `rescue-orphaned-docs-round2` — 7 documents IDENTICAL on `main` (landed via #577); the fragment
    is MAIN-MOVED because #577 corrected it from "eight" to "seven"; the one ABSENT file is
    `docs/audits/2026-08-04-pending-doc-updates.md`, deliberately deleted by PR #331 and withdrawn on
    purpose.
  - `closed-pr-branch-disposition` — its single document IDENTICAL on `main` (landed via #577).
  - `offline-review-stale-snapshot` — both code files IDENTICAL on `main`; its old
    `docs/CHANGELOG.md` prose is accepted as superseded by the equivalent fragment on `main`.
  - `guard-content-scan-and-savegate-flake` — 0 ABSENT, 0 BRANCH-ONLY; the save-gate half shipped
    via #485, the content-gate half is retired by owner decision.
- The preservation tag was pushed and read back from `origin` before the branch was removed.

## The table

| Branch | Deleted commit | Tag on `origin` | Why it is safe |
|---|---|---|---|
| `claude/sanitizeerror-mock-divergence-followup` | `f6f96b3fe0d626cbb1b325d36afcd1cd46c7c4ab` | `archive/2026-09-03/sanitizeerror-mock-divergence-followup` | landed via #576 |
| `claude/rescue-orphaned-docs-round2` | `aa896a4235baf2971232f938efb272545f3c9e2d` | `archive/2026-09-03/rescue-orphaned-docs-round2` | 7 of 8 landed via #577; 8th withdrawn on purpose |
| `claude/closed-pr-branch-disposition` | `3f10837796d4d8fedc73730795ef6481184a3f7f` | `archive/2026-09-03/closed-pr-branch-disposition` | landed via #577 |
| `claude/offline-review-stale-snapshot` | `5c2c129d431c49f08138fd96baa2015d270b6015` | `archive/2026-09-03/offline-review-stale-snapshot` | code already on `main`; worktree removed |
| `claude/guard-content-scan-and-savegate-flake` | `480dc106ef7b37f82fab1103b94353af85189bd5` | `archive/2026-09-03/guard-content-scan-and-savegate-flake` | retired by owner decision (DECISION_LOG 2026-09-03) |

## Restoring a branch

Everything needed is in the table: the branch name, the exact commit, and the tag on `origin` that
still holds it. As with the earlier ledgers, no copy-paste command is included on purpose.

## Sequencing

Order used this time, correcting the first batch: tags pushed and read back from `origin` → this
ledger written and pushed to its own PR branch → branches deleted through the GitHub ref API on an
exact tip match. The check-then-delete is still not atomic (the guards refuse `--force-with-lease`
deletes); all five were quiescent, so the residual was accepted.

Local branch refs for the five still exist on Mason's PC and are harmless; they are not part of
this record.
