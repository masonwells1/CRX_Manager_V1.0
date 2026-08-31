## 2026-08-31 — Count authored deletions in the branch measure

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

**Re-measured, the mechanically-safe branches are unchanged** — the two as of this round; a third,
`dependabot/npm_and_yarn/minor-and-patch-7fe11a6bea`, joined them later when its PR merged into
`main`. Neither `pr435-work` nor
`claude/jobdetail-savegate-flake` authors any deletion, so neither all-clear was wrong. Across all
63 branches exactly one was affected: this cleanup's own branch, which deletes one duplicate. (It
also moved 22 records when this round ran; that archiving was withdrawn in a later round, so the
branch moves no records at its final tip.) So the bug was real and the exposure was luck rather
than design — which is
precisely why it is worth fixing before this report is used to delete anything.

This is the third correction to the measure (three-dot diff → whole-tree → authored-content →
deletions), and the pattern in all three is the same: a definition that looked complete until
someone asked what it does with a case outside the shape it was written for.

### A second finding in this round is no longer applicable

The other finding in this round concerned the archive README's provenance: this PR was moving 22
records into a folder whose header claims every "done" claim was re-verified against code **and the
live database**, without saying that this batch had no live-database check behind it.

That was correct at the time and is now moot — the archiving was withdrawn entirely in a later
round, and `docs/archive/` ships byte-identical to `main`. The reasoning is preserved in
`2026-08-31-archiving-withdrawn-from-this-change.md`, since the underlying point stands for any
future batch: a weaker verification basis has to be stated, not inherited by silence from a
stronger earlier pass.

### Proof observed

- A dedicated scan over all 63 branches comparing the old and corrected measures: exactly one
  branch has unique authored deletions, and neither mechanically-safe branch is affected.
- Post-fix scan totals unchanged: 12 branches carrying migrations absent from `main`, 4 modifying
  an existing migration, 14 distinct, 2 safe.
- `npm run check:docs` passes.
