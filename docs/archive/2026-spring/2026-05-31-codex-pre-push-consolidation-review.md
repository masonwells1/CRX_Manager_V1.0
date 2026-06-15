# Codex Pre-Push Consolidation Review - 2026-05-31

**Reviewer:** Codex
**Repo:** `C:\CRX_Manager`
**Branch reviewed:** `consolidation/2026-05-30-pre-push`
**HEAD reviewed:** `e084a4897d61c7b3c580a5d566d3a279ee99c15e`
**Supabase project:** `rhyzpcqhnizqbxphqdkr`
**Scope:** Independent adversarial pre-push review of the May 30 consolidation branch.

## Verdict

**SHIP-WITH-FOLLOWUPS**

Do not block the consolidation push. The merge/recovery work is clean, the new migration stamps match live for the recent window, and lint/typecheck/build/unit tests pass.

However, ship the strict-actor fixes for `batch_apply_all_prepayments` and `batch_void_invoices` as the very next database follow-up before calling the release fully done.

## Verification Summary

Commands/checks run locally:

- `npm run lint` - passed
- `npm run typecheck` - passed
- `npm run build` - passed
- `npm run test -- --run` - passed: 130 files, 1924 passed, 70 skipped
- `scripts/validate-sql-migrations.sh` through Git Bash - nonzero because of historical old-migration violations; no new May 30 violation surfaced
- `scripts/validate-frontend.sh` through Git Bash - passed
- Conflict-marker scan for `<<<<<<<`, `=======`, `>>>>>>>` - none found
- Live DB read-only checks through Supabase Management API read-only query endpoint - no migrations applied

## Item 1 - `statementPdf.ts` Merge Resolution

Disposition: **CONFIRMED**

Evidence:

- `src/lib/statementPdf.ts:223` calls `drawRemittanceStub(doc, data, margin, pageW, pageH, asOfDate, y)` directly.
- There is no caller-side `doc.addPage()` immediately before the `drawRemittanceStub` call in `generateStatementPdf`.
- `src/lib/statementPdf.ts:671` has the single remittance-stub page-break path: `if (currentY > stubY - 15)`.
- Stub try/catch is intact at `src/lib/statementPdf.ts:660` and `src/lib/statementPdf.ts:776`.

Conclusion: The merged PDF code kept exactly one relevant remittance-stub page-break path and preserved the p2p3 try/catch hardening.

## Item 2 - Recovered `20260530192441` Migration

Disposition: **CONFIRMED / REPRESENTATION ACCEPTED**

Evidence:

- File under review: `supabase/migrations/20260530192441_batch_rpc_idempotency_entity_type_fix.sql`.
- The local function body for `batch_apply_all_prepayments` is byte-equivalent to `20260530191823`'s final function body in the repo.
- Live `pg_get_functiondef()` for `batch_apply_all_prepayments` matches the recovered file modulo the trailing semicolon that `pg_get_functiondef()` omits.
- Live body has:
  - `entity_type = 'batch'`
  - no `'system'`
  - no `ACTOR_MISMATCH`
  - still uses `COALESCE(p_performed_by, auth.uid())`

Judgment:

Keeping `192441` as a separate recovered live-only file is the right representation for disk-vs-live migration version parity. Reconstructing the bad intermediate `191823` body with `'system'` would preserve a known-broken state and add unnecessary fresh-replay risk. The current representation keeps the final schema correct and makes the version list line up with live.

## Item 3 - HIGH Actor-Forgery Findings

Disposition: **CONFIRMED, NOT A CONSOLIDATION BLOCKER**

Live DB evidence:

- `batch_apply_all_prepayments`
  - one overload
  - `SECURITY DEFINER`
  - `search_path=public, pg_temp`
  - `anon_execute=false`
  - `authenticated_execute=true`
  - uses `COALESCE(p_performed_by, auth.uid())`
  - no mismatch check
  - calls `require_admin_or_sales_rep()`

- `batch_void_invoices`
  - one overload
  - `SECURITY DEFINER`
  - `search_path=public, pg_temp`
  - `anon_execute=false`
  - `authenticated_execute=true`
  - uses `COALESCE(p_performed_by, auth.uid())`
  - no mismatch check
  - calls `require_admin_or_sales_rep()`

Disk evidence:

- `supabase/migrations/20260530192441_batch_rpc_idempotency_entity_type_fix.sql:42` trusts `p_performed_by` via `COALESCE`.
- `supabase/migrations/20260530192441_batch_rpc_idempotency_entity_type_fix.sql:65` passes the forged actor into `apply_remaining_prepayments`.
- `supabase/migrations/20260506180000_guard_prepay_with_period_check.sql:120` inserts the supplied actor into `financial_audit_log.actor_user_id`.
- `supabase/migrations/20260530191823_batch_rpc_idempotency.sql:160` trusts `p_performed_by` in `batch_void_invoices`.
- `supabase/migrations/20260530191823_batch_rpc_idempotency.sql:190` writes the batch summary audit row using the role looked up from that actor.

Impact:

- `batch_apply_all_prepayments`: HIGH audit-attribution forgery. Authenticated admin/sales rep can make immutable audit rows appear under another user.
- `batch_void_invoices`: HIGH but narrower audit-attribution forgery. The inner `void_invoice` derives actor from `auth.uid()`, but the batch summary row can still be mis-attributed.

Recommendation:

Do not edit historical migrations. Add a new follow-up `CREATE OR REPLACE FUNCTION` migration for both functions.

Use the same strict-actor pattern as `supabase/migrations/20260530020412_reverse_write_off_strict_actor.sql:47`:

```sql
v_actor := auth.uid();
IF v_actor IS NULL THEN
  RAISE EXCEPTION 'AUTH_REQUIRED';
END IF;
IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
  RAISE EXCEPTION 'ACTOR_MISMATCH';
END IF;
```

Then keep role checks based on `v_actor`, not on client-provided IDs.

### `allocate_payment` Check

Disposition: **REFUTED - NOT SAME FLAW**

Evidence:

- Live DB shows `allocate_payment` derives actor from `auth.uid()`, has one overload, and has a mismatch guard.
- Disk evidence at `supabase/migrations/20260513110000_allocate_payment_gate_on_payment_date.sql:64` derives `v_actor := auth.uid()`.
- Disk evidence at `supabase/migrations/20260513110000_allocate_payment_gate_on_payment_date.sql:68` rejects mismatched `p_performed_by`.

Note:

`allocate_payment` still has `anon_execute=true` live. It rejects unauthenticated callers before mutation, so this is defense-in-depth rather than the same actor-forgery bug. Optional follow-up: revoke `anon`/`PUBLIC` execute and keep `authenticated`/`service_role`.

## Item 4 - Migration Disk-vs-Live

Disposition: **CONFIRMED FOR RECENT SCOPE**

New migrations since `origin/main`:

- `20260530121534_delivery_items_parent_lock_trigger.sql`
- `20260530121737_gate_admin_only_financial_report_rpcs.sql`
- `20260530183926_returns_rpc_role_actor_guard.sql`
- `20260530191823_batch_rpc_idempotency.sql`
- `20260530192441_batch_rpc_idempotency_entity_type_fix.sql`
- `20260530194520_save_blend_ticket_canonical_return.sql`

Live check:

- All six versions are present in live `supabase_migrations.schema_migrations`.
- For versions `>= 20260526000000`, live has 16 and disk has 16, with no missing versions either direction.

Historical drift:

- Live has 452 migration rows.
- Disk has 369 migration files.
- The historical gap is below the recent window and was not introduced by this consolidation.
- Note: the handoff's "83-version gap" is a count comparison, not a one-to-one version-set comparison.

## Item 5 - Other Findings

Disposition: **MOSTLY CLEAN, LOW DOC DRIFT**

Confirmed clean:

- No conflict markers found.
- `npm run lint` passed.
- `npm run typecheck` passed.
- `npm run build` passed.
- `npm run test -- --run` passed with 1924 tests and 70 skipped.
- Current branch was clean after review; Supabase link temp files and build output are ignored.

New LOW findings:

1. `CLAUDE.md:283` still says `docs/reference/migration-history.md | 365 migrations`; it should be `369 migrations`.
2. `docs/audits/2026-05-30-pre-push-consolidation-handoff.md` header says HEAD `c815d79`, but actual reviewed HEAD is `e084a48`.

## Requested Follow-Up Work

1. Create a new follow-up migration hardening `batch_apply_all_prepayments` and `batch_void_invoices` with strict actor derivation from `auth.uid()`.
2. Do not edit `20260530191823` or `20260530192441`.
3. Fix the two low documentation drifts:
   - `CLAUDE.md:283` migration-history count
   - handoff HEAD from `c815d79` to `e084a48`
4. Optional defense-in-depth: revoke `anon`/`PUBLIC` execute on `allocate_payment` while preserving valid authenticated/service_role access.

