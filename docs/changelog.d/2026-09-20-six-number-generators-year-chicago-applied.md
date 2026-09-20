## 2026-09-20 — the six document-number generators now take their year from Chicago on live (issue #617)

**What happened.** `supabase/migrations/20260908140000_number_generators_year_chicago.sql` merged as
`6171c0a20` (PR #726) and was **applied live** on 2026-09-20 under ledger version `20260920051333`
(B7 convention: the ledger row's `version` is the apply timestamp, its `name` carries the file's
stamp). It was the effective ordering high-water only briefly: `20260911120000` (#664) applied
eight minutes later and superseded it, as the ordering section below records. Mason gave the
attended go-ahead in session.

The six generators — `next_application_record_number`, `next_commission_payment_number`,
`next_cycle_count_number`, `next_job_number`, `next_po_number`, `next_return_number` — previously
took the year from the UTC `CURRENT_DATE`. From about 18:00 Chicago on 31 December they minted next
year's number. Each now reads `(now() AT TIME ZONE 'America/Chicago')::date`. The written record of
the change itself is `docs/changelog.d/2026-09-19-six-number-generators-year-chicago.md`.

**Gates cleared before the apply.**

- Exact-SHA `gpt-5.6-sol` high-effort review of `71bde00` through `scripts/write-codex-push-proof.mjs`:
  CLEAN, no findings. That wrapper worked again only because PR #725 rebuilt its sandbox for Codex
  CLI 0.155 the same night.
- CodeRabbit: APPROVED, "No actionable comments were generated", reviewing `3b1b559..71bde00` across
  all seven changed files. **Incomplete by its own report, and the approval must not be read as a
  Hard-Rule pass.** CodeRabbit could not clone the repository ("clone-backed analysis was skipped and
  this review may be incomplete"), so all five `mode: error` Hard-Rule pre-merge checks — RLS on new
  tables, `SECURITY DEFINER` search_path, mutating-RPC idempotency, exact whole-cent money, and edits
  to applied migrations — returned "Inconclusive — Repository clone failed" instead of passing. The
  four checks that did pass (Linked Issues, Out of Scope Changes, Description, Title) are not Hard
  Rules. A `@coderabbitai full review` retry was refused ("Pull request is closed") because #726 had
  already merged, so the five rules were verified BY HAND against the merged file instead, and all
  five hold: no `CREATE TABLE` anywhere, so the RLS rule is not engaged; all six functions carry
  `SECURITY DEFINER` with `SET search_path = public, pg_temp`, one-for-one; none of the six writes
  (no `INSERT`/`UPDATE`/`DELETE` in any body), which is the basis of the file's own idempotency-key
  exemption; no money columns are touched (the "cost" matches are PostgreSQL's planner `procost` in
  the attribute pins); and the file is new (first added in `5e3b05e67`), not an edit to an applied
  migration. Evidence: the `🚥 Pre-merge checks` disclosure on the #726 walkthrough reads "✅ 4 | ❌ 5"
  (`gh api repos/masonwells1/CRX_Manager_V1.0/issues/726/comments`). The clone failure was transient,
  not chronic — #721, #722 and #724 each reviewed with no clone error.
- `scripts/write-apply-proofs.mjs`: both reviewer charters CLEAN from `gpt-5.6-sol/high`, run
  markers present — `rls-security-reviewer` ("Safe to apply", 0 BLOCKER/HIGH/MED) and
  `migration-drift-reviewer` (no drift blocker, stamp strictly above the then high-water
  `20260908130000`).
- Full vitest suite (378 files), `test:correction-guards`, `check-doc-drift` and
  `check-migration-hard-rules` all green on the merge commit.
- Immediately before the apply, a read-only live read confirmed all six `md5(prosrc)` still equalled
  the file's live pins — zero drift since the bodies were read on 2026-09-19.

**Applied through** `scripts/apply-migration-file.mjs --confirm` (all five gates inside the script;
the Supabase token was read from Windows Credential Manager in-process and never written anywhere).
`APPLY OK — HTTP 201`, one transaction, 53,649 bytes including the ledger row.

**Post-apply verification, read-only against the live catalog** (not the HTTP status):

- All six `md5(prosrc)` now equal the file's candidate pins — `9bf10abe…`, `3f876d75…`, `d6626bf1…`,
  `b97a23c4…`, `0fd0c786…`, `0c5ab61f…` — and every body contains `America/Chicago`.
- All six remain `SECURITY DEFINER`, `search_path=public, pg_temp`, owner `postgres`, zero-argument.
- On the live server the boundary instant `2027-01-01 02:00+00` (20:00 Chicago, 31 December 2026)
  yields UTC year **2027** and Chicago year **2026**, which is exactly the six-hour window that
  produced the wrong label.
- Ledger: 1003 rows / 996 distinct names, `max(version)` `20260920051333`.

**Unblocked by this.** The pending-migration guard refused every unapplied migration stamped above
this file. With it applied, #664's `20260911120000_bind_adjust_inventory_receipt_to_intent` went
live eight minutes later, at 05:21 UTC under ledger version `20260920052149`, and is now the
effective ordering high-water (1004 ledger rows / 997 distinct names). The parked
`20260914100100`..`20260914100900` cohort still sorts above that and is clear to apply; of the
field-app season files only `20260908190000` sorts below it and must be restamped, while
`20260912165758`, `20260913040359` and `20260913152700` already sort above it.

**The migration file is unchanged.** Its `PARKED` header stays byte-exact to what ran; applied status
lives in `docs/reference/migration-history.md` row 929 (corrected 2026-09-10 after the #646 finding).

Docs updated with the apply: `migration-history.md` (new boundary block and row 929),
`CURRENT_STATE.md` and `KNOWN_ISSUES.md` ledger stamps and status.
