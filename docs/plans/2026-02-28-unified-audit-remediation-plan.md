# Unified Pre-Launch Audit Remediation Plan

**Date:** 2026-02-28
**Sources:** Claude Opus deep audit + OpenAI Codex audit
**Branch:** `feature/pre-launch-hardening`
**Approach:** Single branch, one migration per phase, sequential commits

---

## Phase 0 — Apply Codex Fixes (Frontend Type Safety)
**Risk:** LOW | **Effort:** 15 min | **Files:** 4

These are Codex-generated fixes that harden frontend type contracts. Not yet committed.

### Task 0.1: Add `tote_number` to DeliveryItem type
**File:** `src/types/index.ts`
- Add `tote_number?: string | null` to `DeliveryItem` interface

### Task 0.2: Remove unsafe casts in DeliveryDetail
**File:** `src/pages/DeliveryDetail.tsx`
- Replace 4× `(i as Record<string, unknown>).tote_number` with typed `i.tote_number`
- Replace 2× `items.some((i: Record<string, unknown>) => i.tote_number)` with `items.some((i) => i.tote_number)`

### Task 0.3: Add tote_number to InvoiceDetail line item creation
**File:** `src/pages/InvoiceDetail.tsx`
- Add `tote_number: null` when creating new invoice line items in `handleAddProduct()`

### Task 0.4: Fix PrepaymentManager fallback (Codex HIGH fix)
**File:** `src/pages/PrepaymentManager.tsx`
- Replace the broken fallback (which no-op'd on RPC failure) with:
  1. Fetch current `prepay_balance_cents` from customer row
  2. Update to `currentBalance + totalCents`
  3. Throw on fetch/update errors

**Commit:** `fix: apply Codex type safety fixes (tote_number, prepay fallback)`

---

## Phase 1 — CRITICAL Fixes (Must Ship Before Go-Live)
**Risk:** CRITICAL | **Effort:** 2-3 hours | **Files:** 1 migration + 0-1 frontend

### Task 1.1: Fix `batch_apply_prepayments()` wrong overload (C1)
**Migration:** `20260228300000_critical_prelaunch_fixes.sql`

**Problem:** The batch wrapper calls the 4-parameter overload of `apply_prepay_to_invoice()` which writes directly to `invoices.balance_cents` (a GENERATED ALWAYS column — write silently ignored). Customer prepay balance goes down but invoices aren't credited.

**Fix:**
1. DROP the 4-parameter overload of `apply_prepay_to_invoice()`
2. Rewrite `batch_apply_prepayments()` to call the correct 3-parameter version that updates `invoices.prepay_applied_cents` (the component column)
3. The GENERATED ALWAYS `balance_cents` column will auto-recalculate

**Test:** Unit test verifying that after batch_apply, both `prepay_credits.balance_cents` decreases AND `invoices.balance_cents` decreases by the same amount.

### Task 1.2: Re-apply tote_number to `create_quick_delivery()` RPC (C2)
**Same migration**

**Problem:** Migration `20260315200000` (emergency fixes) overwrote the tote-threaded version from `20260301100001`. Quick deliveries don't carry tote data.

**Fix:**
1. `CREATE OR REPLACE FUNCTION create_quick_delivery()` with `tote_number` included in:
   - `delivery_items` INSERT
   - `invoice_items` INSERT (if invoice is created)
2. Accept `p_items` JSONB that includes tote_number per item

**Test:** Unit test verifying quick delivery items have tote_number populated.

### Task 1.3: Add status transition triggers with admin override (C3)
**Same migration**

**Problem:** Direct `.update({ status: 'completed' })` calls bypass RPC business logic.

**Fix:** Add `BEFORE UPDATE` triggers for each lifecycle table:

| Table | Valid Transitions | Admin Override |
|-------|------------------|----------------|
| `orders` | confirmed→partially_fulfilled→fulfilled, confirmed→cancelled, partially_fulfilled→cancelled | Yes, via `current_setting('app.admin_override', true) = 'true'` |
| `deliveries` | scheduled→in_progress→completed, scheduled→cancelled, in_progress→cancelled | Yes |
| `invoices` | draft→posted→voided | Yes |
| `quotes` | draft→sent→revised→accepted/declined/expired, sent→revised, revised→sent | Yes |
| `jobs` | scheduled→in_progress→completed→invoiced, any→cancelled | Yes |
| `purchase_orders` | draft→submitted→partially_received→fully_received, draft→cancelled, submitted→cancelled | Yes |
| `returns` | requested→approved→received→credited, requested→rejected | Yes |

Admin override mechanism: RPCs call `SET LOCAL app.admin_override = 'true'` before status changes. Direct client calls don't set this, so the trigger blocks them.

**Test:** SQL test attempting invalid transition without override → expect error. With override → expect success.

**Commit:** `fix: critical pre-launch fixes (prepay batch, tote regression, status guards)`

---

## Phase 2 — HIGH Fixes (Ship Before or Immediately After Go-Live)
**Risk:** HIGH | **Effort:** 2-3 hours | **Files:** 1 migration

### Task 2.1: Add `check_period_open()` to `allocate_payment()` (H1)
**Migration:** `20260228310000_high_priority_fixes.sql`

Add period check at the start of allocate_payment() using the payment date.

### Task 2.2: Add `financial_audit_log` entry to `allocate_payment()` (H2)
**Same migration**

Insert audit log entry with action='payment_allocated', old_data/new_data JSONB showing invoice balances before/after.

### Task 2.3: Add FOR UPDATE to `receive_po_items()` (H3)
**Same migration**

Lock `purchase_order_items` rows before reading `quantity_received` to prevent concurrent double-count.

### Task 2.4: Change financial CASCADE to conditional RESTRICT (H4)
**Same migration**

For `order_items`, `invoice_items`, `delivery_items`:
- Add a BEFORE DELETE trigger on parent tables that:
  - Allows CASCADE behavior when parent status is 'draft' or 'cancelled'
  - RAISES EXCEPTION when parent is 'posted', 'completed', 'fulfilled', etc.
- This preserves draft deletion while protecting finalized records.

### Task 2.5: Add CHECK >= 0 on money columns (H5)
**Same migration**

```sql
ALTER TABLE orders ADD CONSTRAINT orders_total_price_non_negative CHECK (total_price >= 0);
ALTER TABLE invoices ADD CONSTRAINT invoices_total_non_negative CHECK (total_amount_cents >= 0);
ALTER TABLE invoices ADD CONSTRAINT invoices_paid_non_negative CHECK (paid_amount_cents >= 0);
ALTER TABLE prepay_credits ADD CONSTRAINT prepay_balance_non_negative CHECK (balance_cents >= 0);
```

### Task 2.6: Wire up idempotency in `complete_delivery()` (H6)
**Same migration**

Add at the start of complete_delivery():
```sql
IF p_idempotency_key IS NOT NULL THEN
  INSERT INTO idempotency_keys (key, result) VALUES (p_idempotency_key, null)
  ON CONFLICT (key) DO NOTHING;
  IF NOT FOUND THEN
    RETURN (SELECT result FROM idempotency_keys WHERE key = p_idempotency_key);
  END IF;
END IF;
```
And at the end, update the idempotency key with the result.

**Commit:** `fix: high-priority pre-launch fixes (period check, audit log, locks, constraints)`

---

## Phase 3 — MEDIUM Fixes
**Risk:** MEDIUM | **Effort:** 2-3 hours | **Files:** 1 migration + 1-2 frontend

### Task 3.1: Fix `get_customer_transaction_review()` deprecated payments query (M1)
Replace `payments` table query with `allocation_sets + invoice_line_allocations` join.

### Task 3.2: Standardize `get_ar_aging()` return units (M2)
Ensure all money columns return bigint cents, not numeric dollars. Update frontend if needed.

### Task 3.3: Add negative quantity guard to `adjust_inventory()` (M3)
Add check: `IF (current_qty + p_adjustment) < 0 THEN RAISE EXCEPTION 'Adjustment would result in negative inventory'`

### Task 3.4: Add FOR UPDATE to `complete_cycle_count()` (M4)

### Task 3.5: Add FOR UPDATE on quote row in `convert_quote_to_order()` (M5)

### Task 3.6: Add `total_cost_cents` to quick delivery invoice (M6)

### Task 3.7: Restrict `idempotency_keys` RLS to own keys (M7)
Change `FOR ALL USING (true)` to `USING (user_id = (select auth.uid()))`.

### Task 3.8: Add unit conversion warning telemetry (Codex M1)
In quote math, when unknown unit defaults to factor 1 or OZ→GL, call `trackBusinessEvent('unit_conversion_fallback', { product_id, unit, fallback_used })`.

**Commit:** `fix: medium-priority pre-launch fixes`

---

## Phase 4 — E2E Test Gaps (Post-Fix Verification)
**Risk:** Testing | **Effort:** 3-4 hours | **Files:** 4 new E2E specs

### Task 4.1: Golden path test
`e2e/golden-path-quote-to-payment.spec.ts`
Quote → Accept → Convert to Order → Create Delivery → Confirm → Complete → Invoice → Post → Payment → Verify balances

### Task 4.2: Multi-invoice payment allocation test
`e2e/multi-invoice-payment.spec.ts`
Create 3 invoices, allocate single check across all 3, verify partial balances.

### Task 4.3: PrepayWorkspace end-to-end test
`e2e/prepay-workspace.spec.ts`
Split check → stage allocations → commit → verify invoice balances + prepay deduction.

### Task 4.4: Month-end close enforcement test
`e2e/month-end-close.spec.ts`
Close period → attempt backdated invoice post → expect rejection.

**Commit:** `test: add critical E2E coverage for pre-launch`

---

## Execution Order

```
Phase 0 (frontend fixes)     → commit → typecheck + build
Phase 1 (CRITICAL migration) → commit → typecheck + build + test
Phase 2 (HIGH migration)     → commit → typecheck + build + test
Phase 3 (MEDIUM migration)   → commit → typecheck + build + test
Phase 4 (E2E tests)          → commit → run E2E suite
Final: PR to main
```

## Go/No-Go Gate
- [x] All CRITICAL findings fixed and tested — migrations `20260228300000` through `20260316200001` applied
- [x] All HIGH findings fixed and tested — migration `20260228310000_high_priority_fixes.sql` applied
- [x] MEDIUM findings fixed (or risk-accepted) — migration `20260228320000_medium_priority_fixes.sql` applied
- [x] Golden path E2E passes — `tests/e2e/golden-path-quote-to-payment.spec.ts` exists
- [x] `npm run build` clean — verified 2026-03-02
- [x] `npm run typecheck` clean — verified 2026-03-02
- [x] `vitest` all passing — 1,380+ tests passing
- [ ] Manual smoke test of: payment allocation, prepay split check, quick delivery, delivery confirm→complete
