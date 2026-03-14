# CRX Manager — Next Steps & Debugging Roadmap

> **Created:** 2026-03-14 | **Context:** After finding and fixing 40+ bugs from migration drift

---

## What We Fixed (Summary)

| Bug | Impact | Migration Fix |
|-----|--------|---------------|
| 37 stale RPC overloads (frozen since Mar 6) | Bug fixes never reached production for 8+ days | `20260331600000_consolidate_all_rpc_overloads.sql` |
| 4 completely missing functions | Vendor bills, payments, returns all broken | Same migration (Part 1: explicit recreations) |
| inventory_transactions CHECK missing prebooked/released | Order editing and cancellation would crash | `20260331700000_fix_inventory_transaction_type_check.sql` |
| commissions.status CHECK missing entirely | No validation on commission status values | `20260331800000_restore_commissions_status_check.sql` |

---

## Phase 1: Deploy Fixes to Production (DO FIRST)

### Step 1: Apply migrations to Supabase

Open the Supabase SQL Editor and run these migrations **in order**:

1. `supabase/migrations/20260331600000_consolidate_all_rpc_overloads.sql`
2. `supabase/migrations/20260331700000_fix_inventory_transaction_type_check.sql`
3. `supabase/migrations/20260331800000_restore_commissions_status_check.sql`

### Step 2: Verify in production

After applying, run these verification queries in the SQL Editor:

```sql
-- 1. Verify NO function overloads exist
SELECT proname, count(*)
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
GROUP BY proname
HAVING count(*) > 1;
-- Expected: ZERO rows

-- 2. Verify inventory transaction_type CHECK includes prebooked/released
SELECT pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'inventory_transactions'::regclass
  AND conname = 'inventory_transactions_transaction_type_check';
-- Expected: Should list all 11 values including 'prebooked' and 'released'

-- 3. Verify commissions status CHECK
SELECT pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'commissions'::regclass
  AND conname = 'commissions_status_check';
-- Expected: CHECK (status IN ('pending', 'paid', 'cancelled'))
```

### Step 3: Deploy frontend

Push to GitHub and let Vercel auto-deploy. The frontend code is already clean.

---

## Phase 2: Check for Data Corruption (NEXT SESSION)

The overload bug was live for ~8 days (Mar 6-14). During that time, the frozen function copies may have written incorrect data. Run these queries to check:

### Inventory integrity check
```sql
-- Check if any inventory quantities are negative (shouldn't happen)
SELECT product_id, location, quantity_available, quantity_prebooked
FROM inventory
WHERE quantity_available < 0 OR quantity_prebooked < 0;

-- Check if prebooked quantities match actual pending orders
SELECT i.product_id, p.product_name,
       i.quantity_prebooked AS recorded,
       COALESCE(SUM(oi.total_units_needed - oi.quantity_delivered), 0) AS calculated
FROM inventory i
JOIN products p ON p.id = i.product_id
LEFT JOIN order_items oi ON oi.product_id = i.product_id
LEFT JOIN orders o ON o.id = oi.order_id AND o.status IN ('confirmed', 'partially_fulfilled')
WHERE i.location = 'Main Warehouse'
GROUP BY i.product_id, p.product_name, i.quantity_prebooked
HAVING i.quantity_prebooked != COALESCE(SUM(oi.total_units_needed - oi.quantity_delivered), 0);
```

### Commission integrity check
```sql
-- Check for commissions with invalid status values
SELECT id, order_id, status
FROM commissions
WHERE status NOT IN ('pending', 'paid', 'cancelled');

-- Check commission splits still sum to 100%
SELECT c.order_id, SUM(c.split_percentage) AS total_split
FROM commissions c
GROUP BY c.order_id
HAVING SUM(c.split_percentage) != 100;
```

### Invoice/AR integrity check
```sql
-- Check for invoices where balance_cents doesn't match expected
-- (balance_cents is GENERATED ALWAYS, so this verifies the formula)
SELECT id, invoice_number, total_cents, paid_cents, balance_cents,
       (total_cents - paid_cents) AS expected_balance
FROM invoices
WHERE status NOT IN ('voided')
  AND balance_cents != (total_cents - paid_cents);
```

---

## Phase 3: Runtime Error Monitoring (ONGOING)

### Sentry Dashboard
Check https://sentry.io for your project. Look for:
- `42883` errors (function does not exist) — should STOP after deploying fixes
- `23514` errors (CHECK constraint violation) — should STOP after deploying fixes
- Any new errors that appear after deployment

### Supabase Logs
In Supabase Dashboard > Logs > Postgres:
- Filter for `ERROR` level
- Look for any remaining function-not-found or constraint violations
- Check for any `SECURITY DEFINER` search_path errors

---

## Phase 4: New Tests to Write

These tests would have caught the bugs we found. Add them to prevent regression:

### Unit Tests (add to existing test files)

#### 1. RPC Contract Verification Test
**File:** `src/lib/rpcContracts.test.ts` (extend existing)

Add tests that verify every mutating RPC accepts `p_idempotency_key`:
- For each of the 42 mutating RPCs, call with `p_idempotency_key` parameter
- Verify the call doesn't fail with "function does not exist"
- This catches the overload problem at the contract level

#### 2. Schema Integrity: CHECK Constraint Tests
**File:** `src/lib/schemaIntegrity.test.ts` (extend existing)

Add tests that query `pg_constraint` and verify:
- `inventory_transactions.transaction_type` includes all 11 values
- `commissions.status` includes 'pending', 'paid', 'cancelled'
- `invoices.status` includes 'draft', 'posted', 'paid', 'overdue', 'voided'
- `deliveries.status` includes 'scheduled', 'in_progress', 'completed', 'cancelled', 'voided'
- `orders.status` includes 'confirmed', 'partially_fulfilled', 'fulfilled', 'cancelled'
- All status columns have CHECK constraints (none missing)

#### 3. Function Overload Detection Test
**File:** `src/lib/schemaIntegrity.test.ts` (extend existing)

Add a test that queries `pg_proc` and verifies NO public function has more than 1 overload:
```typescript
test('no public functions have multiple overloads', async () => {
  const { data } = await supabase.rpc('execute_sql', {
    query: `SELECT proname, count(*) FROM pg_proc
            WHERE pronamespace = 'public'::regnamespace
            GROUP BY proname HAVING count(*) > 1`
  });
  expect(data).toHaveLength(0);
});
```

### E2E Tests (add to existing specs)

#### 4. Order Edit Product Swap Test
**File:** `tests/e2e/order-editing.spec.ts` (new)

Test the full flow that was broken by the CHECK constraint bug:
1. Create an order with Product A
2. Edit the order — swap Product A for Product B
3. Verify inventory: Product A prebooked decreased, Product B prebooked increased
4. Verify no errors in the process

#### 5. Vendor Bill Full Lifecycle Test
**File:** `tests/e2e/vendor-bills.spec.ts` (new or extend `accounts-payable.spec.ts`)

Test the functions that were completely missing:
1. Create a vendor bill (was missing — `create_vendor_bill`)
2. Record a payment against it (was missing — `record_vendor_payment`)
3. Void a different bill (was missing — `void_vendor_bill`)
4. Verify AP aging reflects the changes

#### 6. Return Processing Test
**File:** `tests/e2e/returns.spec.ts` (extend existing)

Test the function that was missing:
1. Create an order, deliver it
2. Request a return
3. Approve and receive the return (`receive_return` — was missing)
4. Verify inventory updated correctly

---

## Phase 5: Structural Cleanup (FUTURE — Lower Priority)

These are quality-of-life improvements, not bug fixes:

| Task | Effort | Benefit |
|------|--------|---------|
| Squash 169 migrations to baseline + recent | Medium | Faster local setup, clearer history |
| Fix 10 groups of duplicate-timestamp migrations | Low | Deterministic migration ordering |
| Remove orphaned files (`ocrParser.ts`, `reconciliation.ts`) | Low | Less confusion |
| Add `orders.balance_due` / `orders.total_paid` column removal migration | Low | Clean up deprecated columns |
| Consolidate `financial_audit_log.operation_type` CHECK | Low | Single clear constraint definition |

---

## Decision Log

### Why we didn't add CASCADE DELETE
Orders are soft-deleted via `cancel_order()` which explicitly handles related records (commissions, deliveries). CASCADE DELETE would destroy audit trails.

### Why orders.balance_due wasn't fixed
It was intentionally deprecated in migration 20260311200000. AR tracking now lives on `invoices.balance_cents` (GENERATED ALWAYS column). The old column exists but is never read.

### Why some trigger rewrites looked like bugs but weren't
All trigger function rewrites we investigated were intentional:
- `trg_recalc_order_totals` — deliberately removed `balance_due` (AR moved to invoices)
- `_enforce_invoice_status_transition` — deliberately added `paid` and `overdue` transitions
- `log_note_activity` — deliberately added soft-delete detection
- All changes were documented in migration comments.

---

## Quick Reference: What to Check Each Session

Before making ANY database change, run this checklist:

- [ ] Read `CLAUDE.md` Migration Safety Rules section
- [ ] Query existing CHECK constraints for any table you're modifying
- [ ] Query `pg_proc` for any function you're creating/modifying
- [ ] After migration: verify zero function overloads
- [ ] After migration: `npm run build` + `npm run test`
