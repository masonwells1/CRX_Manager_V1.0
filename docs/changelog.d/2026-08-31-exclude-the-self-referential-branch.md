## 2026-08-31 — Exclude the report's own branch; a row that cannot be correct

Codex found the branch inventory's row for `claude/document-cleanup-review-r2nbhj` stale at
publication: the branch had advanced past the recorded tip, and the final tree yields 26 unique
paths rather than the reported 25.

**That row can never be correct.** The report lives on that branch, so any commit that updates the
row also changes what the row describes. Re-measuring produces a new figure that is wrong by the
time it is committed — this is not a stale number, it is a fixed point that does not exist.

Codex named the right fix rather than another re-measure: exclude the self-referential branch. The
scan now skips it and the report says so at the top, so the omission is explicit rather than a gap.
Its disposition needs no analysis anyway — it is the branch of the pull request the reader is
holding, and it goes away when that merges.

Totals now read **62 measured branches** (excluding `main` and this report's own), not 63. The
findings are unchanged: 12 branches carrying migrations absent from `main`, 4 modifying an existing
migration, 14 distinct, 3 mechanically safe.

This is the same lesson as the baseline drift, one turn further in. A report cannot photograph
itself. Where a measurement's subject includes the measurement, the honest move is to name the
exclusion, not to chase a number that recedes as you approach it.

### Proof observed

- Scan re-run with the source branch filtered: 62 branches, `newMig=12 modMig=4 safe=3` — findings
  identical to the 63-branch run.
- `claude/document-cleanup-review-r2nbhj` appears exactly once in the report, in the exclusion note,
  and in no table.
- The totals row reads "Remote branches measured (excludes `main` and this report's own branch) |
  62".
- `npm run check:docs` passes.
