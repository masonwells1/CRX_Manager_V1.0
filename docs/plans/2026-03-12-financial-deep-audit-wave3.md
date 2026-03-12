# Financial Deep Audit — Wave 3 (2026-03-12)

**Focus:** Math/rounding, balance inconsistencies, month-end close gaps, audit log gaps, concurrency, edge cases.
**Scope:** RPCs, frontend financial pages, reconciliation logic.
**Baseline:** All 110 bugs from Wave 1 (49) and Wave 2 (65) excluded — only NEW findings below.

---

## Executive Summary

| Category | Critical | High | Medium | Low | Total |
|----------|----------|------|--------|-----|-------|
| RPC Balance/Math | 3 | 2 | 1 | 0 | 6 |
| Month-End Close Gaps | 0 | 2 | 0 | 0 | 2 |
| Frontend Math/Rounding | 0 | 2 | 2 | 1 | 5 |
| Reconciliation | 0 | 1 | 0 | 0 | 1 |
| Checklist Logic | 0 | 0 | 2 | 0 | 2 |
| Column Name | 0 | 0 | 1 | 0 | 1 |
| **TOTAL** | **3** | **7** | **6** | **1** | **17** |

---

## CRITICAL (3 bugs — fix immediately)

### FIN-C1 | `void_payment` sets GENERATED ALWAYS column `balance_cents` directly
- **File:** `supabase/migrations/20260321300000_void_payment.sql:58`
- **Severity:** Critical
- **What's wrong:** The UPDATE statement directly sets `balance_cents` on the invoices table:
  ```sql
  balance_cents = total_amount_cents - GREATEST(paid_amount_cents - v_alloc.total_amount, 0)
  ```
  But `balance_cents` is defined as `GENERATED ALWAYS AS (total_amount_cents - paid_amount_cents - prepay_applied_cents - write_off_cents)`. Postgres will either silently ignore the SET (the generated column overrides it) or raise an error depending on the version/mode.
- **What could go wrong in production:** The balance formula also ignores `prepay_applied_cents` and `write_off_cents`. If an invoice had $500 paid + $200 prepay applied + $100 write-off, voiding the $500 payment would compute balance as `total - 0` instead of `total - 0 - 200 - 100`. The generated column would calculate correctly on its own IF the direct SET is ignored — but the intent of the code is clearly wrong, and it may error on some Postgres configurations.
- **Suggested fix:** Remove the `balance_cents = ...` from the SET clause entirely (let the GENERATED column compute it). Only update `paid_amount_cents`:
  ```sql
  UPDATE invoices
  SET paid_amount_cents = GREATEST(paid_amount_cents - v_alloc.total_amount, 0),
      status = CASE WHEN ... END,
      updated_at = now()
  WHERE id = v_alloc.invoice_id;
  ```

### FIN-C2 | `void_payment` RETURNING gets NEW value, not OLD
- **File:** `supabase/migrations/20260321300000_void_payment.sql:81`
- **Severity:** Critical
- **What's wrong:** The code zeroes a prepay credit and tries to capture the old balance:
  ```sql
  UPDATE prepay_credits
  SET balance_cents = 0, ...
  RETURNING balance_cents INTO v_prepay_reversed;
  ```
  In Postgres, `RETURNING` returns the value AFTER the UPDATE, so `v_prepay_reversed` is always 0 (the new value), not the original balance.
- **What could go wrong in production:** Line 84 checks `IF v_prepay_reversed IS NOT NULL AND v_prepay_reversed > 0` — this will always be false (since it's 0), so the customer aggregate prepay balance (`customers.prepay_balance_cents`) is NEVER decremented when voiding a payment that created an overpayment credit. The customer's prepay balance becomes permanently inflated.
- **Suggested fix:** Capture the old value first:
  ```sql
  SELECT balance_cents INTO v_prepay_reversed
  FROM prepay_credits
  WHERE source_type = 'overpayment'
    AND source_reference = p_allocation_set_id::text
    AND balance_cents > 0
  FOR UPDATE;

  IF v_prepay_reversed IS NOT NULL AND v_prepay_reversed > 0 THEN
    UPDATE prepay_credits SET balance_cents = 0, ... WHERE ...;
    -- decrement customer aggregate
  END IF;
  ```

### FIN-C3 | `order_shares.amount_cents` stored as dollars, not cents
- **File:** `src/pages/OrderDetail.tsx:334`
- **Severity:** Critical
- **What's wrong:** The formula is:
  ```typescript
  const amountCents = Math.round((order.total_price * 100 * pct) / 100);
  ```
  `order.total_price` is `numeric` (dollars). This multiplies by 100 (to cents), multiplies by pct (e.g., 0.5 for 50%), then divides by 100 (back to dollars). The result is in dollars, not cents, despite being stored in `amount_cents` (bigint).
- **What could go wrong in production:** A $10,000 order with 50% split stores `amount_cents = 50` instead of `500000`. All downstream billing split calculations that read `amount_cents` expecting cents will be off by 100x.
- **Suggested fix:**
  ```typescript
  const amountCents = Math.round(order.total_price * 100 * (pct / 100));
  ```
  (Converts dollars to cents, then applies the percentage.)

---

## HIGH (7 bugs — fix before production use)

### FIN-H1 | `record_invoice_payment` has no `check_period_open()` call
- **File:** `supabase/migrations/20260318400000_fix_record_invoice_payment_use_payments_table.sql` (entire function)
- **Severity:** High
- **What's wrong:** The RPC allows recording payments against invoices in closed accounting periods. Other financial RPCs (`post_invoice`, `apply_write_off`, `void_invoice`) all call `check_period_open()`, but `record_invoice_payment` does not.
- **What could go wrong in production:** After month-end close, a user could record a payment that alters AR balances for a closed period, breaking reconciliation and financial statements.
- **Suggested fix:** Add at the start of the function:
  ```sql
  PERFORM check_period_open(p_payment_date::date);
  ```

### FIN-H2 | `void_payment` has no `check_period_open()` call
- **File:** `supabase/migrations/20260321300000_void_payment.sql` (entire function)
- **Severity:** High
- **What's wrong:** Same as FIN-H1. Voiding a payment in a closed period would reverse invoice balances and alter AR for a period that has already been closed and reported.
- **What could go wrong in production:** Month-end close is completed, statements generated, then someone voids a large payment — AR totals now disagree with the generated statements.
- **Suggested fix:** Add `PERFORM check_period_open(...)` using the allocation set's payment date.

### FIN-H3 | `record_invoice_payment` sets phantom status `'paid'`
- **File:** `supabase/migrations/20260318400000_fix_record_invoice_payment_use_payments_table.sql:71`
- **Severity:** High
- **What's wrong:** When `balance_cents` reaches 0, the RPC sets `status = 'paid'`. But the invoice status CHECK constraint only allows `draft`, `unposted`, `posted`, `voided`, `cancelled`. `'paid'` is not a valid DB value.
- **What could go wrong in production:** The UPDATE will fail with a CHECK constraint violation when a payment fully pays an invoice. The payment is recorded (in the `payments` table) but the invoice status is not updated — leaving the system in an inconsistent state.
- **Suggested fix:** Either add `'paid'` to the CHECK constraint, or keep status as `'posted'` and use a computed/virtual indicator for "fully paid" (e.g., `balance_cents = 0`).

### FIN-H4 | `record_invoice_payment` idempotency key is silently ignored
- **File:** `src/pages/InvoiceDetail.tsx:411-426` + `supabase/migrations/20260318400000_fix_record_invoice_payment_use_payments_table.sql`
- **Severity:** High
- **What's wrong:** The frontend passes `p_idempotency_key` to the RPC, but the RPC function signature does not accept that parameter. PostgREST silently discards the extra argument. There is no deduplication protection.
- **What could go wrong in production:** A network retry or double-click could record the same payment twice, double-decrementing the invoice balance and creating duplicate payment records.
- **Suggested fix:** Add `p_idempotency_key uuid` parameter to the RPC and implement `check_idempotency`/`save_idempotency` guards (same pattern used in other RPCs).

### FIN-H5 | InvoiceDetail falsy `||` guard on zero-cent values
- **File:** `src/pages/InvoiceDetail.tsx:499,503`
- **Severity:** High
- **What's wrong:** The PDF data builder uses:
  ```typescript
  total_amount_cents: invoice.total_amount_cents || items.reduce(...)
  balance_cents: invoice.balance_cents || 0
  ```
  In JavaScript, `0 || fallback` evaluates to `fallback` because 0 is falsy. A legitimately $0.00 invoice (e.g., a credit memo or sample) would use the wrong value.
- **What could go wrong in production:** A $0.00 invoice PDF would show the sum of line items instead of the stored total (which might differ due to adjustments). The balance would silently fall back to 0 even if the real value is meaningful.
- **Suggested fix:** Use nullish coalescing:
  ```typescript
  total_amount_cents: invoice.total_amount_cents ?? items.reduce(...)
  balance_cents: invoice.balance_cents ?? 0
  ```

### FIN-H6 | reconciliation.ts Check 3 queries wrong table
- **File:** `src/lib/reconciliation.ts:660` (approximately)
- **Severity:** High
- **What's wrong:** The invoice payment integrity check queries the `payment_allocations` table. But the current `record_invoice_payment` RPC (migration `20260318400000`) writes to the `payments` table instead. The reconciliation check will never find payments recorded via the current RPC.
- **What could go wrong in production:** The reconciliation page would report false discrepancies for every invoice that has been paid, showing "payment not found" for legitimate payments. This would undermine trust in the reconciliation system and mask real issues.
- **Suggested fix:** Update Check 3 to query the `payments` table (or query both tables for backward compatibility with older payment records).

### FIN-H7 | InvoiceDetail missing `Math.round()` on cost accumulation
- **File:** `src/pages/InvoiceDetail.tsx:500`
- **Severity:** High
- **What's wrong:** The total cost calculation for the PDF:
  ```typescript
  total_cost_cents: invoice.total_cost_cents || items.reduce((s, i) => s + (i.cost_cents * i.quantity), 0)
  ```
  Has two issues: (1) no `Math.round()` on each `cost_cents * quantity` — fractional quantities produce floating-point cents, and (2) the falsy `||` guard (same as FIN-H5) treats 0 as missing.
- **What could go wrong in production:** Accumulated floating-point errors could produce a cost total like `150099.99999999997` instead of `150100`, which displays incorrectly on the PDF. The margin calculation derived from this would also be wrong.
- **Suggested fix:**
  ```typescript
  total_cost_cents: invoice.total_cost_cents ?? items.reduce((s, i) => s + Math.round(i.cost_cents * i.quantity), 0)
  ```

---

## MEDIUM (6 bugs)

### FIN-M1 | MonthEndClose "Payments reconciled" check is trivially satisfied
- **File:** `src/pages/MonthEndClose.tsx:122`
- **Severity:** Medium
- **What's wrong:** The checklist condition is:
  ```typescript
  done: summary.payments.count === 0 || summary.payments.total_cents > 0
  ```
  Any non-zero payment total marks this as done. If there are 50 payments, ANY one of them having a positive amount satisfies the check. The intent should be to verify all payments have been reviewed/reconciled.
- **What could go wrong in production:** Admin closes the month thinking payments are reconciled when they haven't actually reviewed them. Unreconciled payments could include errors or duplicates.
- **Suggested fix:** Require explicit user confirmation (a checkbox or button) rather than auto-computing from payment totals. Or at minimum, check that all payments are allocated: `summary.payments.unallocated_count === 0`.

### FIN-M2 | MonthEndClose "Commissions reviewed" check is trivially satisfied
- **File:** `src/pages/MonthEndClose.tsx:134`
- **Severity:** Medium
- **What's wrong:** The condition is:
  ```typescript
  done: summary.commissions.earned_cents === 0 || summary.commissions.paid_count > 0
  ```
  Paying 1 out of 100 pending commissions marks the entire category as "done."
- **What could go wrong in production:** Admin closes the month with 99 unpaid commissions, believing they were all reviewed.
- **Suggested fix:** Check that ALL pending commissions have been addressed: `summary.commissions.pending_count === 0`.

### FIN-M3 | PrepaymentManager float rounding in split validation
- **File:** `src/pages/PrepaymentManager.tsx:273-279`
- **Severity:** Medium
- **What's wrong:** The validation computes total cents from user input and split sum separately:
  ```typescript
  const totalCents = Math.round(parseFloat(checkForm.total) * 100);
  const splitTotal = validSplits.reduce((s, b) => s + Math.round(parseFloat(b.amount) * 100), 0);
  ```
  Individually rounding each split amount then summing can differ from rounding the total. E.g., three splits of $33.335 each: `Math.round(33.335 * 100) * 3 = 3334 * 3 = 10002`, but `Math.round(100.005 * 100) = 10001`. The validation would reject a valid check.
- **What could go wrong in production:** Users entering legitimate split amounts that sum to the check total get a validation error and cannot record the prepayment.
- **Suggested fix:** Use a tolerance of 1 cent: `if (Math.abs(splitTotal - totalCents) > 1)`.

### FIN-M4 | InvoiceDetail references phantom status `'overdue'`
- **File:** `src/pages/InvoiceDetail.tsx:685`
- **Severity:** Medium
- **What's wrong:** The void eligibility check includes:
  ```typescript
  ['posted', 'overdue'].includes(invoice.status ?? '')
  ```
  `'overdue'` is not a valid DB status (CHECK allows only `draft|unposted|posted|voided|cancelled`). This condition can never be true for `'overdue'`.
- **What could go wrong in production:** No immediate harm (it's just dead code), but it signals a misunderstanding of the data model that could lead to bugs in future changes. If someone later adds UI to display "overdue" status, those invoices won't be voidable because the DB status is still `'posted'`.
- **Suggested fix:** Remove `'overdue'` from the check. Overdue is a computed condition (`balance > 0 AND due_date < now()`), not a stored status.

### FIN-M5 | PrepayWorkspace queries non-existent column `total_cents`
- **File:** `src/pages/PrepayWorkspace.tsx:103`
- **Severity:** Medium
- **What's wrong:** The invoices query selects `total_cents`:
  ```typescript
  .select('id, invoice_number, total_cents, balance_cents, due_date, created_at')
  ```
  The actual column name is `total_amount_cents`. Supabase/PostgREST will return an error or null for this column.
- **What could go wrong in production:** The prepay workspace invoice list would either fail to load or show null/undefined for invoice totals, making it impossible to see how much each invoice is for when applying prepay credits.
- **Suggested fix:** Change `total_cents` to `total_amount_cents`.

### FIN-M6 | PrepaymentManager non-atomic two-step write
- **File:** `src/pages/PrepaymentManager.tsx:296-321`
- **Severity:** Medium
- **What's wrong:** Recording a prepay check does two separate operations: (1) insert into `prepay_credits`, then (2) call `increment_customer_prepay` RPC. These are not in a transaction. If step 1 succeeds but step 2 fails (network error, RLS, etc.), the prepay credit exists but the customer's aggregate `prepay_balance_cents` is not incremented.
- **What could go wrong in production:** Customer has a prepay credit that can be applied to invoices, but their displayed prepay balance doesn't include it. Or conversely, on retry, the increment happens twice. Over time, `customers.prepay_balance_cents` drifts from the actual sum of `prepay_credits.balance_cents`.
- **Suggested fix:** Create a single RPC that atomically inserts the prepay credit(s) and increments the customer balance in one transaction.

---

## LOW (1 bug)

### FIN-L1 | Orders.tsx converts `total_price` (dollars) to cents for display comparison only
- **File:** `src/pages/Orders.tsx:111`
- **Severity:** Low
- **What's wrong:** `const orderCents = Math.round((o.total_price || 0) * 100)` converts to cents, and `invCents` (from a separate query) is presumably also cents. This is used only for the `invoiced_pct` display calculation. The falsy `|| 0` guard means a $0.00 order would use 0 (correct in this case). No data is stored.
- **What could go wrong in production:** Purely a display issue. If `invoicedByOrder[o.id]` returns dollars instead of cents (or vice versa), the percentage would be wildly wrong. Low severity because the value is capped at 100% on line 116.
- **Suggested fix:** Add a comment clarifying the units to prevent future confusion: `// total_price is dollars, convert to cents for comparison with invoiced cents`.

---

## Audit Log Gap Summary

| RPC | Has `financial_audit_log` entry? | Has `check_period_open()`? |
|-----|----------------------------------|---------------------------|
| `post_invoice` | Yes | Yes |
| `void_invoice` | Yes | Yes |
| `apply_write_off` | Yes | Yes |
| `record_invoice_payment` | Yes (line 79) | **NO** |
| `void_payment` | Yes (line 98) | **NO** |
| `allocate_payment` | Yes | Yes |
| `void_allocation_set` | Yes | N/A |

The two RPCs missing `check_period_open()` are `record_invoice_payment` and `void_payment` (FIN-H1 and FIN-H2 above).

---

## Fix Priority Recommendation

**Immediate (before any real data entry):**
1. FIN-C1 + FIN-C2: Fix `void_payment` RPC (GENERATED column + RETURNING bug)
2. FIN-C3: Fix `order_shares.amount_cents` dollars-vs-cents bug
3. FIN-H3: Fix phantom `'paid'` status in `record_invoice_payment`
4. FIN-H4: Add idempotency to `record_invoice_payment`

**Before month-end close:**
5. FIN-H1 + FIN-H2: Add `check_period_open()` to payment RPCs
6. FIN-M1 + FIN-M2: Fix trivially-satisfied checklist conditions

**Before reconciliation use:**
7. FIN-H6: Fix reconciliation Check 3 table reference

**General cleanup:**
8. FIN-H5 + FIN-H7: Fix falsy guards and missing Math.round
9. FIN-M3 through FIN-M6: Remaining medium bugs
