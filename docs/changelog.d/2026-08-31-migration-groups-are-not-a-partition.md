## 2026-08-31 — The two migration groups overlap and are not a partition

Fourth Codex pass on PR #529. One P2 finding, verified and correct.

### What was wrong

`2026-08-31-branch-inventory-authored-content-measure.md` said branches carrying migrations absent
from `main` went "16 → 12, with the other 4 reclassified into the modified-migration group". That
describes a category transition that never happened, and it is wrong in two independent ways.

**The groups overlap.** `claude/recover-applied-migrations-20260812` and
`codex/pr389-coderabbit-fixes` each hold both a migration absent from `main` *and* a modification to
a migration `main` already has, so each appears in both tables. The 12 and the 4 cover **14 distinct
branches**, not 16 — adding the counts double-counts two branches.

**The four that left are not the four that arrived.** The branches that dropped off the absent list
are `claude/ordering-cycle-review-t41vat`,
`claude/ordering-cycle-review-t41vat-local-20260831`, `claude/changelog-docs-honesty` and
`claude/hold-latch-cross-session-envelope`. None is in the modified-migration group. They left
because the authored-content filter found their migration differences were never authored by the
branch at all — `main` had simply moved ahead. That is the actual reason the count fell, and
"reclassified" hid it behind a tidier story.

### Fixed in three places

The false partition had already propagated across the record:

- this entry's predecessor now names the four departing branches and the real reason, and states
  the overlap explicitly;
- `2026-08-31-docs-cleanup-and-branch-inventory.md` dropped "a further 4", which implied disjoint
  groups;
- the inventory report gained an overlap row and a distinct-branches row in its totals table, a
  callout above the modified-migration table warning not to add the two sections, and a note in the
  review order that steps 1 and 2 are 14 branches rather than 16.

### Proof observed

The overlap and the four departures were computed directly from the per-branch tree data, not
inferred from the earlier tables. `npm run check:docs` passes.

### Lesson

The error was narrative, not arithmetic: both counts were right, and the sentence joining them
invented a clean before/after that the data never supported. A tidy explanation of a number is a
claim in its own right and needs checking like any other — particularly in `docs/changelog.d/`,
which outlives the review thread that would otherwise correct it.
