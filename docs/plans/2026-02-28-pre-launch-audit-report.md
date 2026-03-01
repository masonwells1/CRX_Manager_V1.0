# CRX Manager V1.0 — Pre-Launch Audit Report

**Date:** 2026-02-28
**Auditor:** Claude Opus 4.6
**Scope:** Full-stack audit (accounting, inventory, deliveries, data integrity, frontend, E2E coverage)
**Context:** $50M agricultural sales operation preparing for team deployment

---

## Executive Summary

| Severity | Count | Summary |
|----------|-------|---------|
| **CRITICAL** | 3 | Money vanishing (C1), tote regression (C2), lifecycle bypass (C3) |
| **HIGH** | 6 | Missing audit trails, race conditions, cascading deletes |
| **MEDIUM** | 10 | Deprecated references, missing guards, RLS performance |
| **LOW** | 8 | Nice-to-haves, documentation |
| **E2E Gaps** | 4 critical, 3 high | Missing golden-path and money-flow tests |

---

## CRITICAL (Must Fix Before Go-Live)

### C1. batch_apply_prepayments() calls wrong function — money vanishes

**File:** `supabase/migrations/20260301200001_prepay_application_rpcs.sql:119`

The batch wrapper calls the **old 4-parameter** overload of `apply_prepay_to_invoice()` which:
1. Writes directly to `invoices.balance_cents` — a **GENERATED ALWAYS** column (write silently ignored)
2. Does NOT update `invoices.prepay_applied_cents` (the actual component column)
3. DOES deduct from `prepay_credits.balance_cents` and `customers.prepay_balance_cents`

**Impact:** PrepayWorkspace allocations deduct from customer prepay balance but don't credit invoices.

**Fix:** Drop the 4-param overload, rewrite batch to call the correct 3-param version.

### C2. create_quick_delivery() lost tote_number — regression

**File:** `supabase/migrations/20260315200000_emergency_rpc_fixes.sql:802`

The emergency fixes migration overwrote the tote-threaded version from `20260301100001`. Quick deliveries no longer carry tote_number to delivery_items or invoice_items.

**Fix:** Re-apply tote_number columns to the create_quick_delivery() function.

### C3. No database-level status transition enforcement

**Where:** All lifecycle tables (orders, deliveries, invoices, quotes, jobs, POs, returns)

CHECK constraints validate status *values* but not *transitions*. A direct `.update({ status: 'completed' })` can bypass the entire RPC lifecycle (skip confirm_delivery, skip post_invoice, etc.).

**Fix:** Add BEFORE UPDATE triggers on each lifecycle table validating old -> new status transitions.

---

## HIGH (Fix Before or Immediately After Go-Live)

### H1. allocate_payment() missing check_period_open()
**File:** `20260315200000:53` — Payments can be backdated into closed periods.

### H2. allocate_payment() missing financial_audit_log
**File:** `20260315200000:53` — Primary payment path has no immutable audit entry.

### H3. receive_po_items() no FOR UPDATE on purchase_order_items
**File:** `20260310210000:5` — Concurrent receives can double-count inventory.

### H4. Cascading deletes on financial tables
**File:** `20260206172436` — `order_items`, `invoice_items`, `delivery_items` use ON DELETE CASCADE. Should be RESTRICT.

### H5. No CHECK >= 0 on key money columns
**File:** `20260206172436` — `orders.total_price`, `invoices.total_amount_cents`, etc. can go negative.

### H6. complete_delivery() idempotency key unused
**File:** `20260301100001:13` — Parameter exists but check_idempotency()/save_idempotency() never called.

---

## MEDIUM

| # | Issue | File |
|---|-------|------|
| M1 | get_customer_transaction_review() queries deprecated payments table | 20260218200000:213 |
| M2 | get_ar_aging() returns numeric dollars, not bigint cents | 20260311200000:285 |
| M3 | adjust_inventory() no negative quantity guard | 20260211100000:18 |
| M4 | complete_cycle_count() no FOR UPDATE on inventory rows | 20260315200001:848 |
| M5 | convert_quote_to_order() quote not locked FOR UPDATE | 20260312200000:73 |
| M6 | create_quick_delivery() no total_cost_cents on invoice | 20260315200000:802 |
| M7 | idempotency_keys FOR ALL USING (true) RLS | Schema |
| M8 | 85 bare auth.uid() in RLS (should be (select auth.uid())) | Across migrations |
| M9 | cancel_delivery() double-adjusts in_progress with delivered qty | 20260315200000:228 |
| M10 | Frontend cents-vs-dollars display inconsistency risk | CommissionPayments, ARaging |

---

## LOW

| # | Issue |
|---|-------|
| L1 | adjust_inventory()/complete_cycle_count() don't write to financial_audit_log |
| L2 | cancel_order() directly UPDATEs deliveries (less granular audit trail) |
| L3 | Number generation MAX() scan — slow at 100K+ rows |
| L4 | Idempotency TOCTOU race window |
| L5 | create_quick_delivery() doesn't set season on invoice |
| L6 | Statement generation uses loop, not window function |
| L7 | complete_delivery() second inventory SELECT not explicitly FOR UPDATE |
| L8 | Inconsistent lock acquisition ordering across RPCs |

---

## E2E Test Gaps

### Critical Gaps
1. No golden-path test (Quote -> Order -> Delivery -> Invoice -> Payment in one serial test)
2. Multi-invoice payment allocation not tested
3. Month-end close not functionally tested (close -> verify backdated rejection)
4. PrepayWorkspace page has zero E2E coverage

### High Gaps
5. Inventory hold automation not tested (planned quote -> auto-hold -> auto-release)
6. Quick delivery atomic operation not end-to-end tested
7. PO receiving inventory quantity verification (before/after check)

### Medium Gaps
8. Driver role login test (uses admin, not actual driver account)
9. Batch void invoices / batch cancel deliveries not tested
10. Concurrent access scenarios

---

## What's Working Well

- balance_cents GENERATED ALWAYS column — mathematically prevents balance drift
- FOR UPDATE locking on most critical operations
- Two-step delivery flow properly enforced in RPCs
- checkMutationResult() on 13+ pages catches silent RLS failures
- Inventory math (prebooked-first deduction) is correct
- Hold release trigger handles accepted/declined/expired correctly
- void_invoice() thoroughly hardened with full reversal logic
- generate_finance_charges() properly excludes compounding
- apply_write_off() clean with locks, period check, audit log
- Commission payments period-checked, locked, audit-logged
- Server-authoritative quote math in save_quote()
- 1,380 unit tests + all 8 critical libraries have test coverage
- All SECURITY DEFINER functions use SET search_path = public
