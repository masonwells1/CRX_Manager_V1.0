## 2026-08-31 — Count authored deletions; state the archive batch's real verification basis

Two P2 findings from Codex's review of `f9426347`. Both are correct and both are fixed.

### The measure never counted a deletion

The authored/unique comparison walked the paths *present in the branch tree*. A path the branch
**removed** relative to its merge base exists in neither the branch tree nor the iteration, so it
was invisible to the measure.

The consequence is the exact failure this report exists to prevent: a branch whose only unique work
was deleting a tracked file would report `unique = 0` and be listed as **mechanically safe to
delete**. The deletion would be discarded silently, and the report would have called it an
all-clear.

Fixed by adding authored deletions — paths present at the merge base and absent from the branch —
to the unique set, counted as unique only while `main` still carries the path. Once the deletion
lands on `main` it is no longer branch-only work.

**Re-measured, the two mechanically-safe branches are unchanged.** Neither `pr435-work` nor
`claude/jobdetail-savegate-flake` authors any deletion, so neither all-clear was wrong. Across all
63 branches exactly one was affected: this cleanup's own branch, which deletes one duplicate and
moves 22 records. So the bug was real and the exposure was luck rather than design — which is
precisely why it is worth fixing before this report is used to delete anything.

This is the third correction to the measure (three-dot diff → whole-tree → authored-content →
deletions), and the pattern in all three is the same: a definition that looked complete until
someone asked what it does with a case outside the shape it was written for.

### The archive README made this batch's provenance false

`docs/archive/2026-summer-closeout/README.md` is headed "moved 2026-07-16" and states that every
"done" claim was re-verified against code on disk **and the live database** before the move. Its
latest documented batch was 2026-07-26 and its category descriptions cover June and early-July
records.

This PR moved 22 late-July/August records into that folder and said nothing there. A reader would
reasonably attribute them to the live-verified July pass. They should not: these were classified by
reading each file's own status line and searching for inbound references. **No live-database check
was performed and none of their claims were re-proven.**

Added a "Third batch — moved 2026-08-31" section that states the weaker basis explicitly, and
records why: an earlier revision of this cleanup deleted 30 records on a rule that never read their
statuses, and 8 of the restored files stayed in the live folders because their own text says the
work is unfinished. A batch with that history should declare how it was verified rather than
inherit a stronger claim by silence.

### Proof observed

- A dedicated scan over all 63 branches comparing the old and corrected measures: exactly one
  branch has unique authored deletions, and neither mechanically-safe branch is affected.
- Post-fix scan totals unchanged: 12 branches carrying migrations absent from `main`, 4 modifying
  an existing migration, 14 distinct, 2 safe.
- `git diff --name-status origin/main...HEAD -- docs/archive/2026-summer-closeout/` reports 22
  added paths, matching the count written into the README.
- `npm run check:docs` passes.
