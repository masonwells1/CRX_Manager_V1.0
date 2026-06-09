# Codex Findings Handoff - 2026-05-29 Workflow BLOCKER Review

**Date:** 2026-05-29  
**Reviewer:** Codex  
**Requested by:** Mason (CRX Manager)  
**Purpose:** Independent review of the 2026-05-28 workflow/security BLOCKER findings before Claude writes fixes.

---

## Executive Summary

Codex **confirms the core diagnoses**: the unauthenticated report-RPC leak is real, `void_order` is blocked by the stricter status trigger, and `void_invoice` would crash for draft/unposted invoice status writes.

However, the proposed anon-revoke list is **incomplete**, and Codex found one additional **must-fix security issue**: `batch_void_invoices` trusts a caller-supplied `p_performed_by` value before checking admin role. That creates an authenticated actor-spoof path for batch-voiding posted invoices if a non-admin user knows or obtains an admin UUID.

No fixes were applied in this review.

---

## Verification Notes

- Supabase MCP tools were not exposed in this Codex session, and the local Supabase CLI is not linked.
- Live checks were performed through the same frontend Supabase anon client configuration the browser uses.
- No secrets, customer names, or UUIDs are included in this handoff. Live result contents were redacted or summarized.
- Source verification used local repo files on branch `main`; `git status` was clean at review time.

---

## Must Fix Before Shipping

1. **BLOCKER:** Revoke anon/PUBLIC execution from the SECDEF report/dashboard RPC set, not just the originally listed report RPCs.
2. **BLOCKER:** Fix `batch_void_invoices` actor spoof before or with any invoice voiding work.
3. **BLOCKER:** Fix `void_order` and its draft-invoice branch together.
4. **BLOCKER/HIGH:** Fix `void_invoice` draft/unposted semantics: route draft/unposted to `cancelled`, not `voided`.
5. **HIGH:** Treat migration rebuild fidelity as unverified until a shadow DB content diff proves disk migrations reproduce live.

---

## Finding 1 - Anon-Executable SECDEF Report/Data Leak

**Verdict:** PARTIAL CONFIRM / BLOCKER  
**Diagnosis:** Correct.  
**Proposed fix:** SAFE BUT INCOMPLETE.

The anon leak is real. Using the public anon client with no login session, Codex confirmed these RPCs are callable and return structured data:

- `global_search` returned 6 rows for a customer-name search.
- `get_customer_summary` returned customer AR and activity summary keys.
- `get_customer_year_end_summary` returned customer identity/contact, invoice, acreage, and financial keys.
- `get_detailed_statement_data` returned statement/customer/transaction/aging keys.
- `get_batch_year_end_summaries` returned a year-end summary array.
- `get_customer_farm_group` returned farm group rows.
- `get_fields_with_geojson` returned field/customer/GeoJSON rows.
- `get_rup_sales_register` was callable.
- `get_ap_aging` was callable.
- `get_monthly_summary` returned accounting summary keys.

The original revoke list is missing additional anon-callable dashboard/AP RPCs:

- `dashboard_summary()` returned dashboard summary keys, including inventory and activity counters.
- `get_dashboard_action_items(int)` returned actionable delivery counts; in the live anon test it returned 10 overdue deliveries and 7 unassigned deliveries.
- `get_ap_dashboard_summary(text)` returned AP financial summary keys.

Likely revoke set should include at least:

```sql
REVOKE EXECUTE ON FUNCTION public.global_search(text, int) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_customer_summary(uuid) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_customer_year_end_summary(uuid, integer) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_detailed_statement_data(uuid, date, text) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_customer_transaction_review(uuid, date, date) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_batch_year_end_summaries(uuid[], integer) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_customer_farm_group(uuid) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_field_geojson(uuid) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_fields_with_geojson(uuid) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_rup_sales_register(date, date, uuid, uuid, text) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_ap_aging(date) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_monthly_summary(date, date) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.dashboard_summary() FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_dashboard_action_items(int) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_ap_dashboard_summary(text) FROM anon, PUBLIC;
```

Before applying, verify exact live signatures from `pg_get_function_identity_arguments(p.oid)`. Some functions have defaults, and disk grant statements do not always reflect the current live signature after later drops/recreates.

### Evidence

- `global_search` is `SECURITY DEFINER` with no `auth.uid()` guard: `supabase/migrations/20260404040100_global_search_rpc.sql:5`.
- `get_customer_summary` reads invoices, orders, deliveries, customers, and activity for an arbitrary `p_customer_id` with no actor guard: `supabase/migrations/20260404040200_get_customer_summary_rpc.sql:4`.
- `get_customer_year_end_summary` reads full customer/contact/financial details with no actor guard: `supabase/migrations/20260228200000_season_calendar_oct_sep.sql:843`.
- `get_detailed_statement_data` reads customer statements with no actor guard: `supabase/migrations/20260335500000_invoice_audit_fixes.sql:138`.
- `get_fields_with_geojson` reads all fields if `p_customer_id` is null: `supabase/migrations/20260334900000_field_grouping_multi_polygon.sql:194`.
- `get_customer_farm_group` has no actor guard: `supabase/migrations/20260307200000_sales_reports.sql:198`.
- `get_ap_aging` is `SECURITY DEFINER` with no actor guard: `supabase/migrations/20260510110000_ap_polish_partial.sql:61`.
- `get_rup_sales_register` is `SECURITY DEFINER` with no actor guard: `supabase/migrations/20260307100000_accounts_payable_and_rup_reporting.sql:497`.
- `get_monthly_summary` is `SECURITY DEFINER` with no actor guard: `supabase/migrations/20260333900000_mega_audit_phase1_fixes.sql:58`.
- `dashboard_summary` is `SECURITY DEFINER` with no actor guard: `supabase/migrations/20260311200000_invoice_ar_single_source.sql:91`.
- `get_dashboard_action_items` is `SECURITY DEFINER` with no actor guard: `supabase/migrations/20260404040300_get_dashboard_action_items_rpc.sql:5`.
- `get_ap_dashboard_summary` is `SECURITY DEFINER` with no actor guard: `supabase/migrations/20260325200000_sprint1_fix_financial_compliance.sql:81`.

### Fix Pressure Test

`REVOKE EXECUTE FROM anon, PUBLIC` is the correct first remediation. It closes the no-login public internet path.

It is not enough as a long-term defense. These are `SECURITY DEFINER`, so logged-in users can still bypass table RLS unless the function body enforces role and/or customer scope. At minimum:

- Admin-only reports should check `is_admin()`.
- Sales/customer reports should check admin or scoped sales access.
- Field GeoJSON should respect the same access model as the Fields pages.
- AP reports should be admin-only unless the business explicitly wants sales reps to see AP.

Defense in depth: add internal `auth.uid()`/role checks to the sensitive read RPCs, because future `DROP FUNCTION` + `CREATE FUNCTION` can silently restore default PUBLIC execute permissions.

---

## Finding 2 - `void_order` Crashes on Fulfilled Orders

**Verdict:** CONFIRM / BLOCKER  
**Diagnosis:** Correct.  
**Proposed fix:** SAFE if actor checks happen first.

The UI exposes `Void Order` only to admins on fulfilled orders:

- `src/pages/OrderDetail.tsx:899` shows the button when `isAdmin && order.status === 'fulfilled'`.
- `src/pages/OrderDetail.tsx:542` calls `rpc('void_order')`.

The current `void_order` function requires `fulfilled`, then writes `status = 'voided'` without `admin_override`:

- `supabase/migrations/20260526151856_execute_full_codebase_ultra_review.sql:734` requires `v_order.status != 'fulfilled'` to reject.
- `supabase/migrations/20260526151856_execute_full_codebase_ultra_review.sql:738` updates `orders.status = 'voided'`.

The order status trigger does not allow `fulfilled -> voided`:

- `supabase/migrations/20260228300000_critical_prelaunch_fixes.sql:377` allows `confirmed -> partially_fulfilled/fulfilled/cancelled`.
- `supabase/migrations/20260228300000_critical_prelaunch_fixes.sql:379` allows `partially_fulfilled -> fulfilled/cancelled`.
- There is no outgoing transition from `fulfilled`.

### Fix Pressure Test

Use the existing `set_config('app.admin_override', 'true', true)` bracket after strict auth/admin checks and before any out-of-machine status writes.

Do **not** add `fulfilled -> voided` as a general trigger transition unless there is a separate guard ensuring only `void_order` can use it. A direct status update would skip inventory restoration, commission cancellation, audit logging, and posted-invoice review notifications.

The override bracket itself is acceptable:

- The third argument `true` makes the setting transaction-local.
- If the function errors, the transaction aborts, so the setting does not persist globally.
- Existing safe patterns already use it in `void_delivery` and `cancel_delivery`.

Recommended sequence:

1. Derive `v_actor := auth.uid()`.
2. Reject null actor.
3. Reject `p_performed_by` mismatch.
4. Check admin role.
5. Lock target order.
6. Set transaction-local `app.admin_override = true`.
7. Perform status writes.
8. Reset to false before return.

---

## Finding 3 - `void_invoice` Crashes on Draft/Unposted

**Verdict:** CONFIRM, with UI nuance / BLOCKER-HIGH  
**Diagnosis:** Correct for the RPC. Direct UI blast radius is narrower than stated.

The current `void_invoice` function only rejects already-voided/cancelled invoices, and only runs `check_period_open()` for posted invoices:

- `supabase/migrations/20260510080000_bulk_idempotency_wiring.sql:128` locks invoice.
- `supabase/migrations/20260510080000_bulk_idempotency_wiring.sql:130` rejects `voided`.
- `supabase/migrations/20260510080000_bulk_idempotency_wiring.sql:131` rejects `cancelled`.
- `supabase/migrations/20260510080000_bulk_idempotency_wiring.sql:132` only checks accounting period if status is `posted`.
- `supabase/migrations/20260510080000_bulk_idempotency_wiring.sql:182` writes `status = 'voided'` with no override.

The invoice trigger allows:

- `draft -> unposted/posted/cancelled`
- `unposted -> posted/cancelled`
- `posted -> voided/paid/overdue`
- `overdue -> paid/voided`

Evidence:

- `supabase/migrations/20260228310000_high_priority_fixes.sql:33`.

So `draft -> voided` and `unposted -> voided` are invalid.

### Important Nuance

The current Invoice Detail UI only shows the `Void` button for posted invoices:

- `src/pages/InvoiceDetail.tsx:873`.

So a user clicking the direct Invoice Detail button should not hit draft/unposted in normal UI flow today.

But this still must be fixed because `void_order` contains an internal draft-invoice branch:

- `supabase/migrations/20260526151856_execute_full_codebase_ultra_review.sql:802` loops invoices for the order.
- `supabase/migrations/20260526151856_execute_full_codebase_ultra_review.sql:806` includes status `draft`.
- `supabase/migrations/20260526151856_execute_full_codebase_ultra_review.sql:808` handles draft invoices.
- `supabase/migrations/20260526151856_execute_full_codebase_ultra_review.sql:809` updates draft invoice status to `voided`.

If Claude only adds the override around the order status update, the next crash is likely the draft invoice status write inside `void_order`.

### Fix Pressure Test

Draft/unposted invoices should route to `cancelled`, not `voided`.

Suggested semantics:

- `draft` or `unposted`: set `status = 'cancelled'`, set cancel/void reason fields if those are the only available metadata fields, and audit as invoice cancelled or "draft invoice cancelled due to order void".
- `posted` or `overdue`: keep `voided` path with period checks and reversal logic.

Avoid using `admin_override` to force draft/unposted to `voided` unless Mason explicitly wants draft invoices to appear as voided financial documents. The state machine already encodes the better semantic: unposted work gets cancelled; posted accounting documents get voided.

---

## Finding 4 - Migration Drift / Rebuild Fidelity

**Verdict:** CONFIRM / HIGH  
**Diagnosis:** Correct. Current repo state has changed since the prompt.

At review time, the recovered migration file is already tracked and committed in this workspace:

- Commit seen in local log: `5b56f4e chore(db): recover live-only preserve_quote_price_overrides migration into repo`.
- Current branch: `main`.
- `git status` was clean.

The recovered file exists:

- `supabase/migrations/20260528042000_preserve_quote_price_overrides.sql:1`.

The file is named with the live-applied version and documents the live label:

- `supabase/migrations/20260528042000_preserve_quote_price_overrides.sql:3`.
- `supabase/migrations/20260528042000_preserve_quote_price_overrides.sql:8`.

The migration itself:

- Adds `quote_items.price_override NUMERIC NULL`: `supabase/migrations/20260528042000_preserve_quote_price_overrides.sql:22`.
- Replaces `save_quote`: `supabase/migrations/20260528042000_preserve_quote_price_overrides.sql:25`.
- Stores `price_override`: `supabase/migrations/20260528042000_preserve_quote_price_overrides.sql:174`.
- Recalculates price using `COALESCE(qi.price_override, tier_price)`: `supabase/migrations/20260528042000_preserve_quote_price_overrides.sql:214`.

### Fix Pressure Test

Committing the recovered file is the right call and appears already done locally.

The bigger rebuild-fidelity claim remains unverified. A name diff is not enough for this repo because live migration names and disk filenames are known to diverge after MCP apply and consolidated commits.

Recommended follow-up:

1. Create a fresh shadow database.
2. Apply every disk migration from `supabase/migrations`.
3. Diff schemas, function definitions, policies, triggers, grants, indexes, and constraints against live.
4. Treat differences as real drift only after content-level comparison, not name-level comparison.

---

## New Finding A - `batch_void_invoices` Actor Spoof

**Severity:** BLOCKER  
**Status:** New finding from Codex.

`batch_void_invoices` is not anon-callable in the live test, but it has an authenticated actor-spoof pattern.

The function trusts the caller-provided `p_performed_by` value:

- `supabase/migrations/20260327100000_wave4_bug_fixes.sql:484` sets `v_actor := COALESCE(p_performed_by, auth.uid())`.
- `supabase/migrations/20260327100000_wave4_bug_fixes.sql:485` reads the role for `v_actor`.
- `supabase/migrations/20260327100000_wave4_bug_fixes.sql:488` checks whether that role is admin.

Because the role check is against `p_performed_by` when supplied, a logged-in non-admin who can supply an admin UUID may pass the admin check.

The function then voids posted invoices:

- `supabase/migrations/20260327100000_wave4_bug_fixes.sql:505` skips non-posted invoices.
- `supabase/migrations/20260327100000_wave4_bug_fixes.sql:511` updates invoice status to `voided`.

The frontend passes `p_performed_by: profile?.id`:

- `src/pages/Invoices.tsx:222`.

### Recommended Fix

Patch before or with invoice voiding work:

```sql
v_actor := auth.uid();
IF v_actor IS NULL THEN
  RAISE EXCEPTION 'AUTH_REQUIRED';
END IF;
IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
  RAISE EXCEPTION 'ACTOR_MISMATCH';
END IF;
IF NOT is_admin() THEN
  RAISE EXCEPTION 'INSUFFICIENT_ROLE';
END IF;
```

Also verify the live signature. The frontend currently sends `p_idempotency_key`, but the visible disk definition at `supabase/migrations/20260327100000_wave4_bug_fixes.sql:467` has only `uuid[], text, uuid`. If live accepts the idempotency key, capture that exact definition before rewriting.

---

## New Finding B - Restore RPCs Have Both Status-Transition and Actor-Spoof Risk

**Severity:** HIGH if wired; MED if truly orphaned  
**Status:** New emphasis from Codex.

The original review already flagged the restore RPCs as unwired/crashing. Codex agrees but adds that they have the same actor-spoof pattern and should not receive an `admin_override` bracket until auth is fixed.

`restore_cancelled_order`:

- Uses caller-provided actor: `supabase/migrations/20260506190000_explicit_idempotency_rewrites.sql:259`.
- Checks role for that spoofable actor: `supabase/migrations/20260506190000_explicit_idempotency_rewrites.sql:261`.
- Writes `cancelled -> confirmed` with no override: `supabase/migrations/20260506190000_explicit_idempotency_rewrites.sql:292`.

`restore_cancelled_delivery`:

- Uses caller-provided actor: `supabase/migrations/20260506190000_explicit_idempotency_rewrites.sql:356`.
- Checks role for that spoofable actor: `supabase/migrations/20260506190000_explicit_idempotency_rewrites.sql:358`.
- Writes `cancelled -> scheduled` with no override: `supabase/migrations/20260506190000_explicit_idempotency_rewrites.sql:389`.

Because these are not exposed in the current UI and anon execution is denied in live testing, they are less urgent than `batch_void_invoices`. But if Claude touches them, fix actor derivation first, then add the transaction-local override.

---

## New Finding C - `get_customer_transaction_review` Runtime Error

**Severity:** MED  
**Status:** New finding from Codex.

Anon can call `get_customer_transaction_review`, but the live call returned:

```text
42804 structure of query does not match function result type
```

This likely affects logged-in users too. It is separate from the permission leak.

Evidence:

- Current disk definition starts at `supabase/migrations/20260228320000_medium_priority_fixes.sql:27`.
- The function returns a fixed table shape at `supabase/migrations/20260228320000_medium_priority_fixes.sql:32`.

Recommended action:

1. Revoke anon/PUBLIC execution as part of Finding 1.
2. Reproduce as authenticated admin/sales user.
3. Fix the return type mismatch in a separate migration or include it only if Claude is already rewriting that exact function.

---

## Admin Override Abuse Analysis

`set_config('app.admin_override', 'true', true)` is acceptable when used correctly.

Why it is safe:

- The third argument `true` makes the setting transaction-local.
- It does not grant permissions by itself; it only affects trigger functions that call `_is_admin_override()`.
- If an exception aborts the RPC transaction, the setting does not leak into another user's transaction.

What would make it unsafe:

- Setting it before proving `auth.uid()` and admin role.
- Trusting `p_performed_by` instead of `auth.uid()`.
- Adding broad trigger transitions instead of using the override inside the audited RPC.
- Catching exceptions inside the function and continuing without resetting the config.

Preferred pattern:

```sql
v_actor := auth.uid();
IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
  RAISE EXCEPTION 'ACTOR_MISMATCH';
END IF;
IF NOT is_admin() THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

PERFORM set_config('app.admin_override', 'true', true);

-- out-of-machine status writes here

PERFORM set_config('app.admin_override', 'false', true);
```

---

## Recommended Implementation Order

1. **Security migration 1:** Revoke anon/PUBLIC from all sensitive SECDEF report/dashboard/AP RPCs listed above. Keep `authenticated` where the app needs it.
2. **Security migration 2:** Add internal auth/role/scope checks to the same report RPCs, prioritizing admin-only financial/AP/dashboard reports.
3. **Security/logic migration 3:** Fix `batch_void_invoices` actor derivation and idempotency signature mismatch if live confirms the mismatch.
4. **Workflow migration 4:** Fix `void_order` with strict actor checks plus `admin_override`.
5. **Workflow migration 5:** Change draft/unposted invoice handling to `cancelled`; ensure `void_order` uses that same semantic for draft invoices.
6. **Optional cleanup:** Patch restore RPC actor derivation and status override only if Mason wants restore functionality kept.
7. **Drift follow-up:** Run shadow DB content diff before claiming rebuild fidelity.

---

## Short Answer for Claude

The review is mostly right, but do not ship the proposed fixes as-is. The anon revoke set is too small, and `batch_void_invoices` has a separate authenticated actor-spoof blocker. Fix public report access first, then fix actor derivation, then fix `void_order` and draft invoice cancellation together.

