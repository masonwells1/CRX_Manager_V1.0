## 2026-08-31 — Correct the branch-inventory measurement and stop deleting open-work records

Codex reviewed PR #529 and returned two P2 findings. Both were verified against the repository and
both were real. This entry records the fixes; the companion entry
`2026-08-31-docs-cleanup-and-branch-inventory.md` now describes the corrected end state.

### 1. The branch inventory measured the wrong thing

`docs/audits/2026-08-31-branch-inventory-for-codex-review.md` computed each branch's unmerged
content with `git diff --name-only origin/main...<branch>`. Three-dot diff compares
`merge-base(main, branch)` against the branch — not against main's current tree. Because this
repository squash-merges, every file already landed by a squash merge was re-reported as
branch-only work.

The irony is that the file's own method note warned about squash merges invalidating commit counts,
and then used an operator with the same defect.

Codex's falsifier, confirmed: the report claimed three unmerged migrations on
`claude/draw-down-price-tier-lines`, while `20260816110000_draw_down_cutover_barrier.sql` and
`20260816120000_draw_down_split_order_lines_by_price_tier.sql` are both present in `main`'s tree.

Every figure is now computed by comparing the full `git ls-tree -r` path-to-blob map of the branch
against `origin/main`, which is independent of merge base and of squash history. The report
distinguishes **new files** (paths `main` does not have — what is actually lost by deleting a
branch) from **modified files** (paths both have with different content, which on a branch behind
`main` is usually staleness rather than new work).

The correction was material, not cosmetic:

- `claude/draw-down-price-tier-lines`: 3 unmerged migrations → **0**.
- `claude/recover-applied-migrations-20260812`: 12 → 7. `codex/pr389-coderabbit-fixes`: 10 → 7.
- Four branches the old method missed now appear, including both `ordering-cycle-review-t41vat`
  branches at 4 migrations each.
- Branches holding no file `main` lacks: 3 → **15**. That is the set most likely to be deleted, so
  the old number would have left twelve branches sitting untouched for no reason.

The migration-carrying total is still 16, but its membership changed — the same count for a
different set of branches.

### 2. Closed-looking records were deleted without reading them

The cleanup deleted 30 dated, unreferenced handoff and audit records under the rule "dated and
orphaned, therefore closed." The rule never checked each file's own status.

`docs/audits/2026-06-15-H2-negative-inventory-worksheet.md` opens with
`Status: NEEDS MASON — physical counts required before any repair. Nothing has been applied.`, and
`docs/manual/KNOWN_ISSUES.md` still records the matching open item: 19 negative inventory rows to be
reconciled from physical counts only. Deleting it destroyed the row-level worksheet and the gated
repair template for unfinished production-data work.

All 30 files were restored and re-classified by reading each one. Six describe unfinished work and
stay in their original locations; the remaining 24 were **archived** into
`docs/archive/2026-summer-closeout/` rather than deleted. Only the byte-identical duplicate remains
deleted.

Among the six kept is `docs/audits/2026-07-27-branch-worktree-cleanup-restore-ledger.md`, which
records that the previous branch cleanup preserved every deleted tip with a real tag on `origin` —
because a SHA written in Markdown keeps nothing alive once the last ref is gone. The branch
inventory now points at it, since that is the safe procedure for the deletions it is preparing.

### Proof observed

- `npm run check:docs` passes.
- `claude/draw-down-price-tier-lines` migrations confirmed present in `main` via
  `git ls-tree -r origin/main -- supabase/migrations/`.
- The restored H2 worksheet's `NEEDS MASON` status and the matching open `KNOWN_ISSUES.md` item were
  read directly rather than inferred.
- Exact-duplicate groups under `docs/`: 0.

### Lesson

"Nothing references this file" is not evidence that its work is finished. In this repository,
handoffs, audits, and changelog fragments are standalone by design, so orphan status carries no
information about completion. Read the status line.
