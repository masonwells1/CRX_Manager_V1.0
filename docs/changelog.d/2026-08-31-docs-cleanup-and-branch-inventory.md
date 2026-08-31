## 2026-08-31 — Documentation cleanup and a branch inventory for Codex

Full pass over the repository's documentation, plus a read-only inventory of all 63 remote
branches. No branch was created, deleted, force-pushed, or modified.

### Corrected documentation that was actively wrong

Each of these sent a reader to a file that does not exist.

- `DEPLOYMENT.md` told the reader that GitHub Actions was "optional" and to create
  `.github/workflows/test.yml`, followed by a toy `actions/checkout@v3` workflow. CI has in fact
  been required for some time: four workflows exist, and `ci.yml` alone runs containment,
  CI-scope classification, SQL validation, lint/typecheck/test/build, and an E2E smoke job.
  Replaced the invented snippet with what the repository actually runs.
- `docs/reference/code-patterns.md` placed `fuzzyMatchProduct()` in `src/lib/ocrParser.ts`, which
  does not exist. It lives in `src/components/purchase-orders/BulkPOImport.tsx`.
- `docs/workflows/INVENTORY_RULES.md` cited `src/pages/QuickReceive.tsx`; the real file is
  `src/components/receiving/QuickReceivePanel.tsx`.
- `docs/reference/sql-canonical-patterns.md` linked `src/lib/db.ts` at the wrong relative depth,
  so the link resolved to `docs/reference/src/lib/db.ts` and was dead.
- `docs/audits/nightly-debug/REPORT.md` linked two parked migration drafts that were deliberately
  removed in `1effc0b0` after being applied live, and a disposition document that had since moved
  into `docs/archive/2026-summer-closeout/audits/`. The historical claims are unchanged; the links
  no longer point at nothing.
- `docs/OPEN_ITEMS.md` still hedged that `docs/manual/KNOWN_ISSUES.md` "is being introduced this
  sprint" and might not exist. It exists. Trimmed to a plain pointer.

### Removed

`docs/audits/2026-06-19-future-projects-idea-mining/SOURCE-chatgpt-codex-analysis.md`, a
byte-for-byte duplicate of `docs/research/2026-06-19-future-projects-open-source-comparison.md`
that nothing referenced. This is the only file deleted.

### Archived rather than deleted

24 closed one-off handoff and audit records moved from `docs/audits/` and `docs/handoffs/` into
`docs/archive/2026-summer-closeout/`. The live folders now show current work; nothing was lost.

An earlier revision of this change **deleted** 30 such records on the rule "dated, orphaned, and
therefore closed." Codex review of PR #529 showed the rule was unsound: it never read the files'
own status. `2026-06-15-H2-negative-inventory-worksheet.md` states
`NEEDS MASON — physical counts required before any repair. Nothing has been applied.`, and
`docs/manual/KNOWN_ISSUES.md` still carries the matching open item — 19 negative inventory rows
awaiting physical-count reconciliation. Deleting it would have destroyed the row-level worksheet
and gated repair procedure for unfinished production-data work.

All 30 were restored and re-classified by reading each file's status. Six describe work that is
not finished and stay in place:

- `docs/audits/2026-06-15-H2-negative-inventory-worksheet.md` — NEEDS MASON; matches an open
  `KNOWN_ISSUES.md` item.
- `docs/audits/2026-07-29-section9-accounting-period-race-live-refresh.md` — verdict is
  `OPEN P1 / HIGH production-hardening gap`.
- `docs/audits/2026-07-26-supplier-pricing-phase3c-owner-review-summary.md` — status `PARKED`
  with unmet acceptance conditions.
- `docs/audits/2026-07-27-branch-worktree-cleanup-restore-ledger.md` — the ledger for the previous
  branch cleanup; it records which deleted tips are preserved by real tags on `origin` and warns
  not to delete those tags. Directly relevant to the branch work this change prepares.
- `docs/audits/2026-08-08-permissions-overhaul-handoff.md` — an explicit list of follow-ups
  deliberately left for later.
- `docs/handoffs/2026-08-08-foundation-ultra-review-remediation.md` — a remediation task list.

### Deliberately not touched

- `docs/changelog.d/` fragments. Its README states entries accumulate and that a consolidation
  tool is intentionally not part of the convention, so folding them into `docs/CHANGELOG.md` would
  have contradicted a settled decision.
- `docs/archive/**` existing contents, including the `C:/CRX_Manager/...` absolute paths in old
  gauntlet reports, which record what was reviewed at the time.

### Added

`docs/audits/2026-08-31-branch-inventory-for-codex-review.md` — all 63 remote branches with the
files each holds that `main` does not, its unmerged-migration count, and its PR state.

**12 branches hold `supabase/migrations/*.sql` files absent from `main`**, and a further **4 modify
a migration file that already exists on `main`** — which the CRX Hard Rules forbid. Only **2**
branches hold nothing `main` lacks and are mechanically safe to delete.

### Proof observed

- `npm run check:docs` passes.
- Branch content is measured against three trees per branch — the branch, `origin/main`, and their
  merge base. A path is *authored by the branch* when its blob differs from the merge base, and
  *unique* when `main` does not hold that identical blob. Unique is not the same as lost: content
  can be absent byte-identically because it was superseded, so only `unique = 0` is a mechanical
  all-clear.

  This measure took two corrections, both raised by Codex on this PR and both recorded in their own
  entries. The first revision used `git diff origin/main...<branch>`, which compares the merge base
  with the branch rather than main's current tree, so squash-merged files were re-reported as
  branch-only work. The second compared whole trees but then called any branch with no *new file
  paths* safe to delete — unsound, because a branch can hold unique work in a file `main` also has.
  See `2026-08-31-branch-inventory-measurement-correction.md` and
  `2026-08-31-branch-inventory-authored-content-measure.md` for the full detail and the numbers each
  round changed.
- Commit ahead/behind counts are not used anywhere: this repository squash-merges, so a merged
  branch still reports unmerged commits. The first shallow checkout reported ~2,500 such commits on
  branches that had merged.
- Merged-ness read from each PR's `merged_at` timestamp, not the `merged` boolean, which the API
  returned as `false` for PRs that had plainly merged.

### Not verified

The schema registry is behind 6 migrations on disk. Refreshing it needs live database
introspection, which was out of scope here and is unaffected by this change.
