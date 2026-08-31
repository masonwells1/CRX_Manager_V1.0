## 2026-08-31 — Measure branch content by what the branch authored, not by new paths

Second Codex finding on `docs/audits/2026-08-31-branch-inventory-for-codex-review.md`, on the
already-corrected version. Verified and fixed. This is a distinct defect from the three-dot diff
issue recorded in `2026-08-31-branch-inventory-measurement-correction.md`.

### What was wrong

The corrected report split each branch's files into "new" (paths `main` lacks) and "modified"
(paths both hold), then declared every branch with zero new paths **safe to delete, loses no
content**. That does not follow. A branch can hold unique work in a file that also exists on
`main`; having no new *paths* says nothing about the *content* of the paths it does have.

Codex's example: the five Dependabot branches show zero new paths, 4–6 modified files, and **open
PRs**. The report listed them as safe to delete.

### The measure now used

Three trees per branch — the branch, `origin/main`, and their merge base:

1. **Authored by the branch** — paths whose blob differs from the *merge base*. A path still
   matching the merge base was never touched by the branch, so any difference from `main` there is
   `main` moving ahead. That is staleness, and it is no longer counted as branch content.
2. **Unique** — of those authored paths, the ones where `main` does not hold the identical blob.

The report now also states plainly that **unique is not the same as lost**: content can be absent
byte-identically because it was superseded or reworked. Only `unique = 0` is a mechanical all-clear;
everything else needs a judgement. The earlier wording promised more certainty than the data
supports.

### What changed in the numbers

- **"Safe to delete" collapses from 15 branches to 2** (`pr435-work`,
  `claude/jobdetail-savegate-flake`). Thirteen of the fifteen hold unique authored content —
  including all five Dependabot branches with live dependency PRs. Acting on the old list would
  have discarded open work.
- **A risk the previous method could not see: 4 branches modify a migration file that already
  exists on `main`**, to content `main` does not have:
  - `claude/recover-applied-migrations-20260812` — 2 files (PR #395 closed unmerged)
  - `codex/pr509-source-recognition-fix-v2-20260830` — 2 files (**open PR #517**)
  - `codex/pr389-coderabbit-fixes` — 1 file (PR #397 closed unmerged)
  - `claude/draw-down-price-tier-lines` — 1 file (PR #404 merged)

  Editing an applied migration is forbidden by the CRX Hard Rules, so each is a rebase artifact, an
  abandoned edit, or a real violation that never landed. Counting only *new* migration paths hid
  this completely. The report now leads with it.
- Branches carrying migrations absent from `main`: 16 → 12, with the other 4 reclassified into the
  modified-migration group above.

### Proof observed

- `npm run check:docs` passes.
- The five Dependabot branches were confirmed to hold unique authored blobs despite zero new paths.
- The four modified-migration branches were confirmed by comparing each branch's blob for the path
  against both the merge base and `origin/main`.

### Lesson

Two rounds of review, two wrong measurements, both caught by Codex rather than by me. The common
error was answering an easier question than the one asked — first "what changed since the branch
diverged" and then "what filenames are new" — when the actual question is "what content does this
branch hold that `main` does not". Each wrong answer was internally consistent and looked
authoritative in a table, which is what made it dangerous: the deletion set was the output.
