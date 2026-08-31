## 2026-08-31 — Documentation cleanup and a branch inventory for Codex

Full pass over the repository's documentation, plus a read-only inventory of all 63 remote
branches. No branch was created, deleted, force-pushed, or modified.

### Corrected documentation that was actively wrong

Each of these sent a reader to a file that does not exist.

- `DEPLOYMENT.md` told the reader that GitHub Actions was "optional" and to create
  `.github/workflows/test.yml`, followed by a toy `actions/checkout@v3` workflow. CI has in fact
  been required for some time: `ci.yml` alone runs containment, CI-scope classification, SQL
  validation, the docs check, and lint/typecheck/test/build. It also *defines* an `e2e-smoke` job,
  but that job is pinned `if: false` and never runs, so CI provides no browser coverage — see
  `2026-08-31-ci-claims-no-browser-coverage.md`. Replaced the invented snippet with what the
  repository actually runs. **Two** workflows exist as of `ec90015d`, not the four this entry
  originally claimed; `production-migration.yml` and `production-approval-canary.yml` were deleted
  while this PR was in review — see `2026-08-31-pin-the-main-baseline.md`.
- `docs/reference/code-patterns.md` placed `fuzzyMatchProduct()` in `src/lib/ocrParser.ts`. Neither
  the file nor that function name exists. `fuzzyMatchProductWithScore()` is defined in
  `src/components/purchase-orders/BulkPOImport.tsx` and delegates to
  `resolveFuzzyProductIdentity()` in `src/lib/productIdentityResolver.ts`, which is where the
  matching and the `0.7` threshold actually live — see
  `2026-08-31-fuzzy-matcher-name-and-stale-counts.md`.
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

### Nothing archived, and nothing deleted but one duplicate

**No record was archived by this change.** `docs/archive/` is byte-identical to `main`.

An earlier revision **deleted** 30 one-off handoff and audit records on the rule "dated, orphaned,
and therefore closed." Codex review of PR #529 showed the rule was unsound: it never read the
files' own status. `2026-06-15-H2-negative-inventory-worksheet.md` states
`NEEDS MASON — physical counts required before any repair. Nothing has been applied.`, and
`docs/manual/KNOWN_ISSUES.md` still carries the matching open item — 19 negative inventory rows
awaiting physical-count reconciliation. Deleting it would have destroyed the row-level worksheet
and gated repair procedure for unfinished production-data work.

All 30 were restored. Successive revisions then tried to archive the closed subset under
progressively stricter rules, and four consecutive review rounds each found records the previous
pass had wrongly classified as finished. The archiving was withdrawn entirely rather than iterated
further; the reasoning, the four rules tried, and what a future attempt should do differently are
in `2026-08-31-archiving-withdrawn-from-this-change.md`.

Records whose text shows unfinished work are therefore all still in the live folders, where they
were. Eight are worth naming because they are the ones an earlier revision would have destroyed
outright:

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
- `docs/audits/2026-08-20-codex-verdict-dryoz-guard.md` — carries a `## Still open` section listing
  F06, F07/F08, F15/F16 and further deferred chemical-entry defects. It was archived in an earlier
  revision of this change and restored after Codex caught it. `src/pages/JobDetail.tsx` states in
  the code itself that F06 is still open — a reloaded rate line goes stale on an acreage change,
  so a saved 1.5 pt/ac line over 100 acres still reads 150 pt at 200 acres — and needs the driver
  persisted on `job_chemicals`. This file is the only record of those items: **F06 appears nowhere
  in `TODO.md`, `docs/manual/KNOWN_ISSUES.md`, or `docs/manual/CURRENT_STATE.md`.** That synthesis
  gap is pre-existing and is flagged, not fixed, here.
- `docs/handoffs/2026-07-18-gauntlet-2-6-leftover.md` — headed "completed/superseded", but carries
  unfinished UX follow-ups H3, H4 and H5. H5 is verifiable in current source:
  `src/components/integrity/IntegrityCleanupPanel.tsx` renders "Create draft invoice"
  unconditionally for every unbilled row, so an admin backfilling an invoice on a split-billing
  order still gets a raw `ORDER_NEEDS_SPLIT_BILLING` error. Neither that code nor
  `ORDER_RESTORE_NOT_SUPPORTED` appears in `TODO.md` or `KNOWN_ISSUES.md`. Also archived in an
  earlier revision and restored after Codex caught it.

### Deliberately not touched

- `docs/changelog.d/` fragments. Its README states entries accumulate and that a consolidation
  tool is intentionally not part of the convention, so folding them into `docs/CHANGELOG.md` would
  have contradicted a settled decision.
- `docs/archive/**` existing contents, including the `C:/CRX_Manager/...` absolute paths in old
  gauntlet reports, which record what was reviewed at the time.

### Added

`docs/audits/2026-08-31-branch-inventory-for-codex-review.md` — all 63 remote branches with the
files each holds that `main` does not, its unmerged-migration count, and its PR state.

**12 branches hold `supabase/migrations/*.sql` files absent from `main`**, and **4 modify a
migration file that already exists on `main`** — which the CRX Hard Rules forbid. Those two groups
**overlap and must not be added together**: `claude/recover-applied-migrations-20260812` and
`codex/pr389-coderabbit-fixes` are in both, so they cover 14 distinct branches, not 16. Only **2**
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

When this pass ran, the schema registry was behind 6 migrations on disk, and refreshing it needs
live database introspection that was out of scope here. That gap has since been closed on `main`
by `5258b0f2` (#531), which refreshed the registry to high-water `20260827113443`; no migration on
disk is now newer. Recorded here because the finding was real when made, not because it is still
outstanding.
