## 2026-08-31 — Keep a record with unresolved findings out of the closed archive

Fifth Codex pass on PR #529. One P2 finding, verified and correct, and the most consequential of
the later rounds because it concerns a live defect rather than prose.

### What was wrong

`docs/audits/2026-08-20-codex-verdict-dryoz-guard.md` was moved into
`docs/archive/2026-summer-closeout/`. That archive's own README reserves it for work that is
"**fully shipped, merged, and live** (or reviews that are fully dispositioned)". This record is
neither: it carries a `## Still open` section listing server-side unit-invariant enforcement,
`bigint` job totals, and defects F06, F07/F08, F15/F16, plus items belonging to a parked redesign
branch.

F06 is not stale prose. `src/pages/JobDetail.tsx` says so in the source:

> `F06 IS STILL OPEN, DELIBERATELY.` `driver` is UI-only and never persisted, so a reloaded row
> comes back driverless and `recomputeChemRowForAcres` leaves it STALE on an acreage change — a
> saved 1.5 pt/ac line over 100 acres still reads 150 pt at 200 acres.

That is a billing-correctness defect on a chemical line. The comment also records that an earlier
attempt to recover the provenance by testing `quantity == rate x acres` was unsound and reverted,
because `applyChemEdit` back-solves `rate_per_acre` when a quantity is typed, so a hand-entered
total satisfies the same equality by construction. The real fix needs the driver persisted on
`job_chemicals`, which is migration work.

Archiving the record would therefore have hidden active remediation behind a folder that means
"done".

### Fixed

The file is restored to `docs/audits/`. The archived set is 23, not 24, and the kept-in-place set
is 7, not 6.

The other 23 archived files were re-scanned for headings that declare unfinished work. One other
matched — `2026-07-13-agent-pair-review-offline-stage1b-receipts.md`, whose `## Remaining` section
lists the steps a Stage 1B implementation would need. That one stays archived: the Stage 1B browser
rollout landed in `main` via PR #124, as recorded in
`docs/audits/2026-07-15-offline-stage1b-rollout-verification.md`, which is itself still in the live
audits folder and carries the one item that does remain parked (the phone/browser reconnect
checklist). The design review's remaining list was superseded by the rollout; the parked item is
tracked by the live document.

### Flagged, not fixed

**F06 and its siblings appear nowhere in the tracked open-work synthesis** — not in `TODO.md`, not
in `docs/manual/KNOWN_ISSUES.md`, not in `docs/manual/CURRENT_STATE.md`. The audit record is their
only home. That gap predates this change and is a content decision for Mason rather than something
to write in blind, so it is recorded here and left for him.

### Proof observed

- The archive README's stated scope, the file's `## Still open` section, and the `JobDetail.tsx`
  comment were each read directly.
- `grep -rn "F06" TODO.md docs/manual/KNOWN_ISSUES.md docs/manual/CURRENT_STATE.md` returns nothing.
- `npm run check:docs` passes.

### Lesson

This is the same failure as the H2 worksheet earlier in this PR — a record whose own text says the
work is unfinished, sorted by a rule that did not read it. The first time the rule was "dated and
orphaned"; this time it was "closed-looking enough to archive". Both moved a live problem somewhere
nobody would look for it.
