# Codex Cross-Review — B5 Applicator License Gates + RUP Phantom-Column Fix (2026-06-10)

**Status:** Both migrations APPLIED LIVE (stamps `20260610185714`, `20260610185741`); frontend committed on branch `feat/h1-quick-wins-2026-06-10`, NOT pushed. You are reviewing already-live DB changes + pre-push frontend.
**Verdict requested:** SHIP / SHIP-WITH-FOLLOWUPS / NEEDS-WORK, with file:line evidence for every finding.

## What changed

### Migration 1 — `supabase/migrations/20260610185714_applicator_license_gates.sql`
1. `applicator_licenses`: `customer_id` DROP NOT NULL; + `profile_id uuid REFERENCES profiles(id)`; + CHECK `applicator_licenses_holder_check (customer_id IS NOT NULL OR profile_id IS NOT NULL)`; + index.
2. New trigger `enforce_applicator_license` BEFORE INSERT OR UPDATE OF `applicator_id` ON `jobs` → fn `_enforce_applicator_license()` (plain, NOT SECDEF, `search_path` set): NULL applicator → allow; unchanged applicator (`IS NOT DISTINCT FROM`) → allow; `_is_admin_override()` → allow; no active licenses linked to the profile → allow; max(expiry) < today → RAISE `LICENSE_EXPIRED`.
3. New SECDEF RPC `assign_job_applicator(p_job_id, p_applicator_id, p_license_override, p_performed_by, p_idempotency_key)`: canonical strict-actor block; role gate admin/sales_rep (`is_active`); `p_license_override` requires admin (`OVERRIDE_REQUIRES_ADMIN`); idempotency helpers AFTER auth; `set_config('app.admin_override','true',true)` bracket around an applicator_id-only UPDATE, reset after; `activity_feed` insert logs `v_actor`; REVOKE PUBLIC/anon + GRANT authenticated/service_role.

### Migration 2 — `supabase/migrations/20260610185741_fix_generate_rup_sales_records_phantom_column.sql`
Live `generate_rup_sales_records` filtered `al.deleted_at IS NULL` but `applicator_licenses` has NO `deleted_at` column (42703 live-verified). `post_invoice` calls it UNGUARDED → first posted invoice containing an `is_rup` product would crash billing (latent only because zero `is_rup` products exist). CREATE OR REPLACE with the body reproduced verbatim from live (live def md5 `e5eab6536de508a532d84fc46cb9723a`), single predicate changed to `al.is_active = true`. DO block asserts overload=1 + `prosrc` no longer contains `deleted_at`.

### Frontend (branch)
- `src/lib/db.ts`: += `LICENSE_EXPIRED`, `OVERRIDE_REQUIRES_ADMIN`, `JOB_NOT_FOUND` tokens.
- `src/lib/licenseStatus.ts` (+`.test.ts`, 10 tests): status helper mirroring the trigger (`none` / `expired` / `expiring_soon` ≤30d / `valid`; latest active expiry wins; expiry today ≠ expired, matching `< CURRENT_DATE`).
- `src/pages/DispatchBoard.tsx`: `handleAssign` raw `jobs.update()` → `assign_job_applicator` RPC (+`useIdempotencyKey`, `assertRpcResult`, `hasRpcCode`); on `LICENSE_EXPIRED`: admin → ConfirmModal → retry `p_license_override: true`; non-admin → toast.
- `src/pages/JobDetail.tsx`: license badge under the applicator select; pre-save gate fires only when applicator CHANGED vs `savedApplicatorId`; admin override via two-phase save — existing job: override-assign FIRST then `save_job` (trigger skips unchanged); new job: `save_job` with applicator NULL → `assignWithOverride(result.job_id)`; if that follow-up assign fails the UI STILL navigates to the created job (duplicate-job prevention); `LICENSE_EXPIRED` race caught via `hasRpcCode`.
- `src/pages/Compliance.tsx`: Customer ↔ Staff holder toggle (staff list via `profile_public_view`), exactly-one-holder validation, list shows "Staff — name".
- `src/components/compliance/ExpiringLicensesCard.tsx` + Dashboard mount (admin/sales): licenses expired/expiring ≤60d.
- `src/lib/rupCompliance.ts`: `.is('deleted_at', null)` → `.eq('is_active', true)` (was silently 400ing → generic warning).

## Already reviewed (don't re-litigate without new evidence)
6 reviewer reports, 0 BLOCKER/0 HIGH confirmed. Known/accepted: (a) `generate_rup_sales_records` is authenticated-callable with attribution-only `auth.uid()` — pre-existing, queued for the defense-in-depth sweep; (b) the trigger reads `applicator_licenses` under invoker RLS — fail-open only IF the currently-permissive (`USING true` TO authenticated) SELECT policy is ever tightened; (c) `ADD CONSTRAINT` not re-runnable (once-applied MCP migration); (d) anon holds a table GRANT on `applicator_licenses` but the SELECT policy is scoped TO authenticated → anon reads return zero rows (verified).

## Verification already performed (live)
- B5 smoke (rolled back): no-license→allowed; expired→`LICENSE_EXPIRED`; override→allowed; unchanged→allowed; valid-latest→allowed; RPC w/o auth→`AUTH_REQUIRED`. All PASS.
- RUP smoke (rolled back): temp `is_rup` product + invoice item → `generate_rup_sales_records` = 1, `compliance_status='non_compliant'`, 2nd call = 0.
- Overloads=1 each; trigger attached (`pg_trigger`); constraint present; typecheck/lint/build green; 1,934 unit tests pass.

## Addendum — same-branch H1 batch (review these too)

After B5, four more deep-dive H1 items landed on the branch (commits after `0dc0222`):

- **B1 (frontend-only):** RUP warnings — `NewOrder.tsx` banner (effect keyed on sorted product-id set; activity-logged once per customer+set) + `InvoiceDetail.tsx` `openPostConfirm` folds a NON-COMPLIANT warning into the post ConfirmModal (danger + AlertTriangle). Invariant to verify: the check can NEVER block posting (try/catch falls through to the plain confirm).
- **B3:** migration `20260610193241` (APPLIED LIVE) — additive `products.rei_hours`/`phi_days` integers; `src/lib/wpsNoticePdf.ts` (40 CFR 170 notice; pdfTheme palette, per-page footer, `ensureRoom` heading guards); JobDetail "WPS Notice" button (`fieldRows.some(f => f.field_id)` gate); ProductDetail inputs with non-negative save validation.
- **E3 (frontend-only):** `DailyBrief.tsx` admin Dashboard card off `financial_dashboard_summary`. Money check: that RPC returns DOLLARS (not cents) — verify `formatUSD` (no ÷100) is correct by comparing with `FinancialDashboard.tsx`'s `fmt`.
- **C4 (frontend-only + CSP):** `weatherCapture.ts` (Open-Meteo, keyless; `degreesToCardinal`/`parseCentroid` unit-tested) prefills Complete-Job weather from the first field's centroid; `vercel.json` CSP `connect-src` += `https://api.open-meteo.com` (only change). Invariant: weather failure can never block completion (null + toast).

## Questions for Codex
1. Any path where a NON-admin reaches the override (UI or RPC)? Check both client branches and the RPC gate ordering.
2. The two-phase JobDetail override save: any state where the job ends up assigned WITHOUT an audit row, or assigned by the trigger-bypass outside the bracketed UPDATE?
3. Does `customer_id` nullable break anything we missed (views, reports, RLS predicates assuming NOT NULL)?
4. Is `expiry today = still valid` the right compliance semantics (`< CURRENT_DATE`), or should expiry day block?
5. Any concern with `set_config(..., is_local=true)` + explicit reset inside the SECDEF RPC (e.g., nested calls of other override-honoring triggers during the UPDATE)?
6. The RUP fix: confirm the single-predicate claim and that `is_active = true` (vs. no filter) is the right semantic for the buyer-license lookup.
