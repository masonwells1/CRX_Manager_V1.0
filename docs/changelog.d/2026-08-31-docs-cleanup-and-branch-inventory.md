## 2026-08-31 — Documentation cleanup and a branch inventory for Codex

Full pass over the repository's documentation, plus a read-only inventory of all 63 remote
branches for Codex to review before anything is deleted.

### Corrected documentation that was actively wrong

These were not stale-but-harmless; each one would send a reader to a file that does not exist.

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

- `docs/audits/2026-06-19-future-projects-idea-mining/SOURCE-chatgpt-codex-analysis.md`, a
  byte-for-byte duplicate of `docs/research/2026-06-19-future-projects-open-source-comparison.md`
  that nothing referenced.
- 30 closed one-off handoff and audit records in `docs/audits/` and `docs/handoffs/` (~314 KB).
  Each was dated, referenced by no other tracked file, and belonged to work that has landed.
  Records tied to a still-open PR (#361, #364, #401, #509) and anything dated on or after
  2026-08-25 were deliberately left in place — that is in-flight context, not closed history.
  Reusable undated templates (`foundation-audit-prompt.md`, `graph-workflow-analysis-prompt.md`,
  `factory-threat-model.md`) were also kept.

### Deliberately not touched

- `docs/changelog.d/` fragments. Its README states entries accumulate and that a consolidation
  tool is intentionally not part of the convention, so folding them into `docs/CHANGELOG.md` would
  have contradicted a settled decision.
- `docs/archive/**`. Point-in-time history, including the `C:/CRX_Manager/...` absolute paths in
  old gauntlet reports, which record what was reviewed at the time.
- Every branch. None was created, deleted, force-pushed, or modified.

### Added

`docs/audits/2026-08-31-branch-inventory-for-codex-review.md` — all 63 remote branches with the
number of files each would still add to `main`, its migration count, and its PR state.

**16 branches carry `supabase/migrations/*.sql` files that never reached `main`**, one of them 12
migrations. That is the finding that matters: each is either already applied live with the branch
holding the only record, or abandoned. Only 3 branches are provably empty against `main`.

### Proof observed

- `npm run check:docs` passes.
- Branch content measured with `git diff --name-only origin/main...<branch>` on a clone fetched
  with `git fetch --unshallow`. The original checkout was shallow, which made the first
  ahead/behind reading meaningless — it reported ~2,500 unmerged commits on branches that were
  merged. Commit counts are not used in the report; this repository squash-merges, so a merged
  branch still shows unmerged commits.
- Merged-ness read from each PR's `merged_at` timestamp, not the `merged` boolean, which the API
  returned as `false` for PRs that had plainly merged.

### Not verified

The schema registry is behind 6 migrations on disk. Refreshing it needs live database
introspection, which was out of scope here and is unaffected by this change.
