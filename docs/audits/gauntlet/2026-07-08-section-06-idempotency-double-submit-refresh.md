# CRX Live Foundation Gauntlet - Section 6 Refresh

Run time: 2026-07-08 02:08 CDT  
Section: Idempotency and double-submit safety for mutating RPCs and frontend callers  
Mode: Read-only audit of current repo code plus live Supabase database structure only  
Skipped by design: Sentry, Vercel, GitHub PRs, browser sessions, production runtime telemetry  

## Verdict

PRODUCTION RISK: HIGH follow-up required before treating the newer field-application applied-record save path as double-submit safe. The canonical idempotency helper layer is broadly healthy: live mutating RPCs that declare `p_idempotency_key` are wired, unscoped idempotency lookups are gone, and prior Section 6 findings for `create_invoice_from_delivery` / `generate_rup_sales_records` are remediated. The confirmed gap is a newer mutating RPC, `save_job_applied_record`, that creates legal applied-info records without accepting or replaying an idempotency key.

Counts: BLOCKER 0, HIGH 1, MED 1, LOW 1.

No app/source code was edited. No migrations were applied. No live data was mutated. No commit, push, deploy, or delete was performed.

## Repo And Run State

- Branch: `codex/BrainstormFable`
- HEAD: `30adac32cdd3c101c0627ea669670bf5373aa23d`
- Existing uncommitted files at run start: 56 files reported by `git status --short`, including `.claude/*` workflow/hook files, `.claude/schema-registry.json`, `.claude/settings*.json`, the gauntlet index, prior Section 5 gauntlet report/summary files, `docs/runbooks/`, and several scripts. These were pre-existing and were not reverted or modified except for the permitted gauntlet index update.

## Findings

### HIGH-1 - Applied-record create path can duplicate a legal application entry on retry

Evidence:

- `supabase/migrations/20260629190000_save_job_applied_record.sql:57` defines `save_job_applied_record(p_record jsonb, p_fields jsonb, p_crew jsonb DEFAULT NULL)` with no `p_idempotency_key`.
- `supabase/migrations/20260629190000_save_job_applied_record.sql:72` derives `v_record_id` from `p_record->>'id'`; `supabase/migrations/20260629190000_save_job_applied_record.sql:80` enters the create path when that ID is NULL.
- `supabase/migrations/20260629190000_save_job_applied_record.sql:81` inserts a new `job_applied_records` parent and returns the new ID at `supabase/migrations/20260629190000_save_job_applied_record.sql:112`.
- The child rows are then replaced/inserted under that new parent at `supabase/migrations/20260629190000_save_job_applied_record.sql:147` and `supabase/migrations/20260629190000_save_job_applied_record.sql:150`.
- `src/components/jobs/AppliedRecordsManager.tsx:280` calls `supabase.rpc('save_job_applied_record', ...)` without any idempotency key.
- `src/components/jobs/AppliedRecordsManager.tsx:1198` only passes `loading={saving}` to the Save/Add button; `src/components/ui/Button.tsx:51` through `src/components/ui/Button.tsx:53` show that loading disables the button after React state updates, but this is a UI guard, not a server replay contract.
- Live structure query for `job_applied_records`, `job_applied_record_fields`, and `job_applied_record_crew` found no parent-level uniqueness on `job_applied_records`. The only relevant uniqueness is child-level: `UNIQUE (application_record_id, field_id)` and `UNIQUE (application_record_id, member_id)`, so duplicate parent records are structurally allowed.
- `src/types/index.ts:2334` through `src/types/index.ts:2336` document that child rows roll into `jobs.applied_acres`, which feeds `jobs.remaining_acres`.

Plain-English business risk:

If a new applied-info entry is retried by a browser/network double-submit before the first response is settled, the server can create two parent applied records for the same real spray pass. That can overstate applied acres, understate remaining acres, and pollute customer/compliance proof data for field application work.

Suggested fix:

Add a new migration that changes `save_job_applied_record` to accept `p_idempotency_key text DEFAULT NULL`, checks `check_idempotency(p_idempotency_key, 'save_job_applied_record')` before the insert/update work, and saves the returned `{ record_id }` result with `save_idempotency()` after success. Update `AppliedRecordsManager` to use `useIdempotencyKey('save_job_applied_record', performedBy)` and reset only after confirmed success.

Prevention action:

Add a regression test or rolled-back smoke spec that sends the same `p_idempotency_key` twice for a new applied record and proves only one `job_applied_records` parent exists. Also add `save_job_applied_record` to the idempotency coverage contract until the dynamic guard below replaces the stale static list.

### MED-1 - The idempotency coverage test is stale and missed this new mutating RPC

Evidence:

- `src/lib/rpcContracts.test.ts:1424` through `src/lib/rpcContracts.test.ts:1433` tracks a hard-coded `MUTATING_RPCS_MISSING_IDEMPOTENCY` list of only four older functions.
- `src/lib/rpcContracts.test.ts:1450` through `src/lib/rpcContracts.test.ts:1453` only asserts that the list length is `<= 4`.
- The list does not include `save_job_applied_record`, even though live pg_proc shows it is an authenticated-executable public function that performs `INSERT`, `UPDATE`, and `DELETE` and has no `p_idempotency_key`.
- A focused test run still passed: `npm run test -- --run src/lib/rpcIdempotencyScope.test.ts src/lib/rpcContracts.test.ts` -> 2 files passed, 74 tests passed.

Plain-English business risk:

The guardrail can stay green while a new mutating RPC ships without double-submit protection. That is how this Section 6 finding was missed by existing tests.

Suggested fix:

Replace the static "small and shrinking" list with a generated check over the current RPC fixture/types or a refreshed live snapshot: every authenticated-executable mutating RPC must either accept `p_idempotency_key`, be explicitly classified as naturally idempotent with evidence, or be listed as a known gap that fails the threshold until fixed.

Prevention action:

Make `rpcContracts.test.ts` fail on newly discovered authenticated mutators without `p_idempotency_key` unless they appear in a dated, evidence-backed natural-idempotency allowlist.

### LOW-1 - Three read-only/report RPCs still carry unused idempotency parameters

Evidence:

- Live catalog query found three functions with `p_idempotency_key` but no idempotency helper/table use: `generate_batch_statements(p_as_of_date date, p_performed_by uuid, p_mode text, p_idempotency_key text)`, `get_ap_dashboard_summary(p_idempotency_key text)`, and `get_expiring_planned_holds(p_days_ahead integer, p_idempotency_key text)`.
- `supabase/migrations/20260219210000_invoice_statement_rpcs.sql:467` through `supabase/migrations/20260219210000_invoice_statement_rpcs.sql:500` show `generate_batch_statements` only builds and returns JSON; it does not mutate.
- `supabase/migrations/20260530121737_gate_admin_only_financial_report_rpcs.sql:65` through `supabase/migrations/20260530121737_gate_admin_only_financial_report_rpcs.sql:95` show `get_ap_dashboard_summary` performs an admin-gated SELECT summary and returns JSON.
- `supabase/migrations/20260316500000_planned_programs.sql:81` through `supabase/migrations/20260316500000_planned_programs.sql:116` show `get_expiring_planned_holds` only returns a JSON aggregation.

Plain-English business risk:

This is not a proven double-submit bug because these paths are read-only/report style. The risk is contract noise: future reviewers and callers may assume the parameter means replay protection exists or is required.

Suggested fix:

During the next RPC hygiene migration, either remove these unused parameters where callers allow it, or document them as read-only legacy signatures and exclude them from mutating-idempotency checks.

Prevention action:

Split the idempotency contract tests into mutating RPC coverage and read-only signature hygiene, so non-mutating legacy parameters do not hide real mutating gaps.

## Verified Safe / Remediated Leads

- Prior Section 6 MED for `create_invoice_from_delivery` is resolved. Live catalog now shows no `create_invoice_from_delivery`; the replacement `create_invoice_for_unbilled_delivery` uses `check_idempotency()` at `supabase/migrations/20260622060000_unbilled_delivery_invoice_order_lock.sql:66` and `save_idempotency()` at `supabase/migrations/20260622060000_unbilled_delivery_invoice_order_lock.sql:179`.
- Prior Section 6 LOW for `generate_rup_sales_records` is resolved in the current live body: `supabase/migrations/20260617190500_generate_rup_sales_records_idempotency.sql:47` through `supabase/migrations/20260617190500_generate_rup_sales_records_idempotency.sql:51` replay cached results, and `supabase/migrations/20260617190500_generate_rup_sales_records_idempotency.sql:130` through `supabase/migrations/20260617190500_generate_rup_sales_records_idempotency.sql:131` saves the result.
- Live idempotency coverage query: 145 public functions declare `p_idempotency_key`; 140 of them are mutating by SQL-body heuristic; all 140 mutating functions are fully wired with check+save or direct idempotency table access.
- Live unscoped-lookup query returned zero rows for direct `FROM idempotency_keys` lookups lacking an operation filter.
- Live `idempotency_keys` still has `UNIQUE (idempotency_key)`, but `save_idempotency()` now detects cross-operation key reuse and raises `IDEMPOTENCY_CROSS_OP_KEY_REUSE`; see `supabase/migrations/20260630172745_parked_008_idempotency_cross_op_guard.sql:74` through `supabase/migrations/20260630172745_parked_008_idempotency_cross_op_guard.sql:87`.
- `refresh_watchdog_flags` has no idempotency key, but its current body deletes non-dismissed scoped flags and upserts by `natural_key` (`supabase/migrations/20260630170000_watchdog_normalize_rate_unit.sql:118` through `supabase/migrations/20260630170000_watchdog_normalize_rate_unit.sql:124`, and `supabase/migrations/20260630170000_watchdog_normalize_rate_unit.sql:585` through `supabase/migrations/20260630170000_watchdog_normalize_rate_unit.sql:589`), so repeated sweeps do not duplicate active flags.
- `check_remainder_reminders` has no idempotency key, but it uses `FOR UPDATE OF dr SKIP LOCKED` and stamps `reminder_sent_at` / `escalation_sent_at` (`supabase/migrations/20260527020457_grant_authenticated_on_frontend_secdef_helpers.sql:75` through `supabase/migrations/20260527020457_grant_authenticated_on_frontend_secdef_helpers.sql:86`, `supabase/migrations/20260527020457_grant_authenticated_on_frontend_secdef_helpers.sql:115`, and `supabase/migrations/20260527020457_grant_authenticated_on_frontend_secdef_helpers.sql:143`).
- `reconcile_prepay_balances` has no idempotency key, but it only updates customers whose cached prepay balance differs from the derived sum and only writes an audit row when corrections occur (`supabase/migrations/20260305200000_audit_safety_fixes.sql:735` through `supabase/migrations/20260305200000_audit_safety_fixes.sql:762`).

## Verification Commands

Passed:

- `git status --short`
- `npm run test -- --run src/lib/rpcIdempotencyScope.test.ts src/lib/rpcContracts.test.ts`
- `C:\Program Files\Git\bin\bash.exe scripts/validate-sql-migrations.sh --idempotency-only --changed-only --base=origin/main`
- Read-only live Supabase catalog queries via `supabase db query --linked --output json` for pg_proc idempotency coverage, direct idempotency lookup scoping, idempotency helper definitions, idempotency table constraints, function grants, and applied-record table constraints.

Known non-pass:

- `C:\Program Files\Git\bin\bash.exe scripts/validate-sql-migrations.sh --idempotency-only` scanned all 584 historical migrations and exited 1 with 52 legacy violations. The script itself notes old migration violations are expected and later fixed; changed-only scan found 0 changed migration files and passed.

Not run:

- No E2E or live workflow smoke that would insert test application records, because this automation is read-only and live data mutation is outside scope.

## Next Section

Section 7 - Commissions, commission splits, entity recipients, payout batches, cancellations/voids.

