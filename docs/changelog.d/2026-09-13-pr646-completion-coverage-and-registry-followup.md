## 2026-09-13 - PR #646: completion call-site coverage, #599 reconcile, registry follow-up

Follow-up work on PR #646 (the byte-exact record of applied migration
`20260908120000_close_pr535_live_gaps`, ledger version `20260909023300`). No live
migration, SQL, or business-data change is included; the applied file still
hashes to LF sha256 `f64aff27…` / md5 `7f080ba8…`, equal to `md5(statements)` of
that ledger row.

**Conflict with #599 resolved (merge `5c9c5aded`).** Both PRs rewrote the live
ledger boundary in `docs/reference/migration-history.md`,
`docs/manual/CURRENT_STATE.md` and `docs/manual/KNOWN_ISSUES.md`. Rows were
reconciled by full migration filename against the live ledger (read-only):
row 923 `20260908120000_close_pr535_live_gaps` = `20260909023300`, row 924
`20260904180000_invoice_season_follows_invoice_date` = `20260904152221`, row 926
`20260906120000_preview_field_app_season_follows_invoice_date` = `20260908045843`,
and row 925 `20260905090000_next_invoice_number_year_chicago` is absent from the
ledger and stays not applied. Both sides' entries were kept; #599's 2026-09-06
capture was relabelled superseded. The patch-id of #646's other changes was
unchanged by the merge.

**CodeRabbit outside-diff finding fixed (`c150e366c`).** `CURRENT_STATE.md` claims
both `complete_cycle_count` call sites in `src/pages/CycleCounts.tsx` send
`p_expected_item_revision` and that `CYCLE_COUNT_REVISION_REQUIRED` reaches a
plain-English reload instruction. The suite pinned only the snapshot call site
and only the error code. `src/lib/cycleCountCompletionRevision.test.ts` now also
pins the retained-key replay call site and the reload sentence. Mutation-proven:
with both expected strings altered, exactly those two tests fail (2 failed, 9
passed); restored, 11/11 pass. The fail-closed half of the claim was verified in
source (`CycleCounts.tsx` gates the replay path on a numeric revision and refuses
a non-numeric one before building the snapshot).

**Codex App P1 deferred with a follow-up.** Running
`scripts/check-migration-hard-rules.mjs` as CI does classified the applied
`20260908120000` file as "revised in pending band" and passed, because
`.claude/schema-registry.json` (generated 2026-09-05) derives an applied
high-water of `20260904180000`. The gap predates this PR: ten migration files
already on `main` sort above that cutoff, including #599's applied
`20260906120000`. Refreshing the registry rewrites a repo-wide file every hook
reads, so it was filed as a separate follow-up rather than folded into this
minimal record PR.

**Review state.** Five CodeRabbit rounds on #646 (incremental and full) ended
with no actionable comments but issued no `APPROVED` review, so two stale
`CHANGES_REQUESTED` reviews (at `d933555c2` and `7fd2c08bf`) still block the
merge. CodeRabbit confirmed on the PR that no code finding remains. A
`COMMENTED` or empty round cannot lift that status; the exit is the repository
owner dismissing both reviews.
