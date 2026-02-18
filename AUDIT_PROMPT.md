# CRX Manager V1.0 — Full Production Readiness Audit & Fix Prompt

> **How to use:** Copy this entire prompt into a fresh Claude Code session on your PC that has Playwright MCP and Chrome installed. Claude will systematically audit your app, find integrity issues, test workflows, and fix everything it finds.

---

## SYSTEM CONTEXT

You are auditing **CRX Manager V1.0**, an agricultural product distribution management system. The codebase is at `/home/user/CRX_Manager_V1.0`. Read `CLAUDE.md` for full architecture details before starting.

**Your tools:**
- Playwright MCP (browser automation against `localhost:5173`)
- Full file system access (read/write/edit)
- Bash for running builds, tests, migrations
- Supabase CLI if available

**Your mission:** Full production readiness audit. You will find bugs, fix them, add missing safeguards, test everything, and leave the app ship-ready.

**Rules:**
1. READ the relevant source code BEFORE testing any feature — understand what SHOULD happen
2. After every fix, run `npm run build` to verify no regressions
3. After every batch of fixes, run `npx vitest run` to verify tests pass
4. Create a new migration file for ANY database change (never modify existing migrations)
5. Update TypeScript types in `src/types/index.ts` when adding DB columns
6. Use `checkMutationResult()` after every `.update()` or `.delete()` call
7. Log to `logActivity()` for important user actions
8. Commit working batches frequently with clear messages
9. When you find something broken, fix it immediately before moving on
10. Track every issue found and its resolution in a summary at the end

---

## PHASE 1: ENVIRONMENT SETUP & SMOKE TEST

**Goal:** Verify the app builds, tests pass, and the dev server runs.

```
Step 1.1: cd /home/user/CRX_Manager_V1.0
Step 1.2: npm install
Step 1.3: npm run build  (must succeed with 0 errors)
Step 1.4: npx vitest run  (all 379 tests must pass)
Step 1.5: npm run dev  (start dev server in background)
Step 1.6: Use Playwright to navigate to http://localhost:5173
Step 1.7: Verify login page loads
Step 1.8: Log in as admin (mason@croprxsolutions.com) — get credentials from .env or ask user
Step 1.9: Verify dashboard loads with KPI cards
```

**If any step fails, STOP and fix it before proceeding.**

---

## PHASE 2: DATA INTEGRITY AUDIT — THE CRITICAL CHAIN

This is the most important phase. These are KNOWN integrity gaps discovered through code analysis. For each one:
1. Read the relevant code to confirm the gap exists
2. Design the fix (migration + frontend changes)
3. Implement the fix
4. Write a unit test proving the fix works
5. Test via Playwright that the UI reflects the fix

### 2.1 DELIVERY CANCELLATION DOES NOT RESTORE INVENTORY

**The bug:** When `cancel_delivery()` is called, it marks the delivery as cancelled but does NOT:
- Restore inventory (no inventory_transaction type='returned' or 'adjusted' created)
- Update `order_items.quantity_delivered` and `quantity_remaining` back
- Reset order status from `partially_fulfilled`/`fulfilled` back to `confirmed`

**Files to read first:**
- `supabase/migrations/20260225200000_delivery_system_enhancements.sql` (lines 309-375, cancel_delivery)
- `supabase/migrations/20260227200000_delivery_integrity_and_quick_delivery.sql` (complete_delivery for comparison)
- `src/pages/DeliveryDetail.tsx` (handleCancel around line 276)

**Fix requirements:**
- Modify `cancel_delivery()` RPC to:
  - Check if delivery was `completed` or `in_progress` — if completed, restore inventory
  - For each `delivery_item`, create an `inventory_transaction` with type `'cancelled_delivery_reversal'`
  - Update `order_items`: decrement `quantity_delivered`, increment `quantity_remaining`
  - Re-evaluate order status: if all items have `quantity_remaining > 0`, set status back to `confirmed`
  - If delivery was only `scheduled`, just cancel it (no inventory to restore)
- Add activity log entry: "Delivery DEL-XXXX cancelled, inventory restored for X items"
- Add notification to admin: "Delivery cancelled — inventory has been restored"

**Test via Playwright:**
- Create a test order → delivery → complete delivery → cancel delivery
- Verify inventory page shows quantities restored
- Verify order status reverted

### 2.2 DELIVERY CANCELLATION DOES NOT VOID LINKED INVOICES

**The bug:** When a delivery is cancelled, any invoice created from the same order remains active. For quick deliveries (which atomically create order + delivery + invoice), this is especially bad — the invoice charges for a delivery that was cancelled.

**Files to read first:**
- `src/pages/DeliveryDetail.tsx` (handleCancel)
- `supabase/migrations/20260213100000_phase2_billing_architecture.sql` (void_invoice)
- `supabase/migrations/20260227200000_delivery_integrity_and_quick_delivery.sql` (create_quick_delivery)

**Fix requirements:**
- After `cancel_delivery()`, check if the delivery's order has linked invoices
- If invoice status = `'draft'`, automatically void it with reason "Delivery cancelled"
- If invoice status = `'posted'`, DO NOT auto-void — instead create an URGENT notification:
  - Type: `delivery_cancelled_invoice_posted`
  - Message: "Delivery DEL-XXXX was cancelled but invoice INV-XXXX is already posted. Manual review required."
  - Target: all admins + the sales rep who created the order
- For quick deliveries (`is_quick_delivery = true`), auto-void draft invoices since they're 1:1 linked
- Log to `financial_audit_log`

**Test via Playwright:**
- Create quick delivery → cancel it → verify invoice is voided
- Create order → delivery → post invoice → cancel delivery → verify notification appears

### 2.3 VOID INVOICE DOES NOT REVERSE PAYMENT ALLOCATIONS

**The bug:** When `void_invoice()` is called, payment allocations (`invoice_line_allocations`) and prepay applications remain. The customer's prepay balance is permanently reduced even though the invoice is void.

**Files to read first:**
- `supabase/migrations/20260213100000_phase2_billing_architecture.sql` (void_invoice, ~line 601)
- `supabase/migrations/20260223200000_payment_allocation.sql` (allocate_payment)
- `src/pages/InvoiceDetail.tsx`

**Fix requirements:**
- Modify `void_invoice()` RPC to:
  - Find all `invoice_line_allocations` for this invoice
  - Sum the allocated amounts
  - Delete the allocation records
  - Find all `prepay_applications` for this invoice
  - Restore `prepay_credits.remaining_cents` for each application
  - Update `customer.prepay_balance` to reflect restored credits
  - Update the parent `allocation_sets` if they become empty
  - Log all reversals to `financial_audit_log`
- Add notification: "Invoice INV-XXXX voided — $X.XX in allocations reversed, $Y.YY in prepay credits restored"

### 2.4 CANCEL ORDER DOES NOT CANCEL COMMISSIONS

**The bug:** When `cancel_order()` is called, commission records for that order remain as `'pending'`. Sales reps see inflated commission balances.

**Files to read first:**
- `supabase/migrations/20260209200000_tier1_audit_fixes.sql` (cancel_order, ~line 354)
- `src/pages/OrderDetail.tsx`
- Commission-related pages

**Fix requirements:**
- Modify `cancel_order()` to update all `commissions` where `order_id = cancelled_order_id`:
  - If status = `'pending'`, set status = `'cancelled'`
  - If status = `'paid'`, DO NOT reverse — create notification for admin review
- Add `'cancelled'` to the commission status enum if it doesn't exist
- Update commission report queries to exclude cancelled commissions
- Log: "X commissions cancelled for order ORD-XXXX"

### 2.5 QUICK DELIVERY USES TIER 1 PRICING FOR ALL CUSTOMERS

**The bug:** In `create_quick_delivery()`, when `price_cents` is NULL, it falls back to `tier1_price` regardless of the customer's `assigned_tier`.

**Files to read first:**
- `supabase/migrations/20260227200000_delivery_integrity_and_quick_delivery.sql` (~line 513)
- `src/components/deliveries/QuickDeliveryModal.tsx`

**Fix requirements:**
- In the RPC, look up `customer.assigned_tier` before selecting price
- Use the corresponding tier price: `tier1_price`, `tier2_price`, or `tier3_price`
- Fallback chain: assigned tier price → tier1_price → 0 (with warning)
- In the UI (QuickDeliveryModal), display the customer's tier so the sales rep sees what pricing applies

### 2.6 PARTIAL DELIVERY CREATES INVOICE/ORDER MISMATCH

**The bug:** When a delivery is completed with fewer items than ordered (partial delivery), `order_items` is updated correctly but the linked invoice (if it exists) still shows the original full quantities. Customer gets billed for items not yet delivered.

**Files to read first:**
- `supabase/migrations/20260225200000_delivery_system_enhancements.sql` (complete_delivery ~line 736)
- `src/pages/InvoiceDetail.tsx`

**Fix requirements:**
- After `complete_delivery()`, if a linked draft invoice exists:
  - Update `invoice_items` quantities to match actual delivered quantities
  - Recalculate `invoice.total_amount_cents` and `invoice.balance_cents`
  - Log the adjustment to `financial_audit_log`
- If invoice is already `posted`, create notification: "Partial delivery completed — posted invoice INV-XXXX may need adjustment"
- Consider: should remainder items automatically generate a second invoice? (Ask user for preference)

### 2.7 INVENTORY HOLDS NOT RELEASED ON QUOTE DECLINE/EXPIRY

**The bug:** When a quote with `is_planned = true` is declined or expires, the `inventory_holds` records remain active, permanently reducing the "Free" inventory calculation.

**Files to read first:**
- `src/pages/QuoteBuilder.tsx` (where is_planned is set and hold logic exists)
- `supabase/migrations/20260209143537_inventory_overhaul.sql`

**Fix requirements:**
- When quote status changes to `'declined'` or `'expired'`:
  - Set all linked `inventory_holds` to `is_active = false`
  - Log: "Inventory holds released for quote QT-XXXX"
- Add to `checkExpiringQuoteNotifications()`: also check for expired quotes with active holds

### 2.8 JOB COMPLETION DEDUCTS FROM WRONG INVENTORY COLUMN

**The bug:** `complete_job()` deducts from `quantity_on_hand` instead of `quantity_available`, bypassing the inventory hold/prebooked logic.

**Files to read first:**
- `supabase/migrations/20260215200000_job_scheduling_tables.sql` (complete_job ~line 533)
- Compare with `complete_delivery()` which correctly uses `quantity_available`

**Fix requirements:**
- Change `complete_job()` to deduct from `quantity_available` (consistent with delivery completion)
- Add inventory availability check before deduction (like delivery completion does)
- If insufficient inventory, raise an exception with a clear message

---

## PHASE 3: MISSING NOTIFICATIONS & ALERTS

The app has a notification system (`notifications` table, `notificationTriggers.ts`, `NotificationsPanel`) but only 5 of 15+ critical events actually trigger notifications. Fix each gap:

### 3.1 Driver Reports Delivery Issue — NO NOTIFICATION

**The bug:** Driver can report issues (damaged, shortage, refused, wrong_product, access_issue) on delivery completion, but nobody is notified. The issue sits silently on the delivery record.

**Files:** `src/pages/DeliveryDetail.tsx` (driver issue reporting section), `src/lib/notificationTriggers.ts`

**Fix:** After `complete_delivery()` with a non-null `issue_type`:
- Create notification for all admins + assigned sales rep
- Type: `delivery_issue_reported`
- Title: "Driver Issue: {issue_type} on DEL-XXXX"
- Message includes customer name, driver name, issue notes
- Priority: urgent (consider adding a `priority` field to notifications if it doesn't exist)

### 3.2 PO Items Received in Damaged Condition — NO NOTIFICATION

**The bug:** When receiving PO items with `condition: 'damaged'` or `'wrong_item'`, only the receiving_record is created. Nobody is alerted.

**Files:** `src/pages/PurchaseOrderDetail.tsx` (receive modal), `src/lib/notificationTriggers.ts`

**Fix:** After `receive_po_items()`, check if any items have condition !== 'good':
- Create notification for admins
- Type: `po_damaged_received`
- Title: "Damaged items received on PO-XXXX"
- Message: list of damaged products with quantities

### 3.3 Customer Credit Limit Exceeded — NO CHECK

**The bug:** The `customers` table has `credit_limit` but no code ever checks it. A customer can accumulate unlimited AR without any warning.

**Files:** `src/pages/NewOrder.tsx`, `src/pages/QuoteBuilder.tsx`, `src/pages/InvoiceDetail.tsx`

**Fix:**
- When creating/converting an order, check: customer's total outstanding AR + new order total vs credit_limit
- If exceeded, show a WARNING (not a blocker) with the amounts
- Create notification for admin: "Customer {name} credit limit exceeded: ${outstanding} / ${limit}"
- Add a dashboard card showing count of customers over their credit limit

### 3.4 Delivery Cancelled — NO NOTIFICATION

**Fix:** After `cancel_delivery()`:
- Notify the assigned driver (if any)
- Notify the sales rep who created the order
- Notify admins
- Type: `delivery_cancelled`

### 3.5 Order Status Change — FUNCTION EXISTS BUT NEVER CALLED

**The bug:** `notifyOrderStatusChange()` is defined in `notificationTriggers.ts` but never called from any page.

**Fix:** Call it from `OrderDetail.tsx` whenever order status changes.

### 3.6 Dashboard Integrity Alerts

**Current state:** Dashboard shows low stock count and outstanding AR. That's it.

**Add these dashboard alert cards:**
- "X deliveries with driver-reported issues (unresolved)" — link to filtered deliveries
- "X customers over credit limit" — link to customers
- "X expired quotes with active inventory holds" — link to quotes
- "X cancelled deliveries with posted invoices (needs review)" — link to invoices

---

## PHASE 4: WORKFLOW END-TO-END TESTING WITH PLAYWRIGHT

Now that integrity gaps are fixed, test the complete workflows via browser automation. For each workflow:
1. Use Playwright MCP to drive the browser
2. Create real data through the UI
3. Verify each step produces the correct cascading effects
4. Check the database state matches expectations

### 4.1 Quote-to-Cash Full Lifecycle

```
1. Navigate to /customers → Create a new customer (Tier 2, credit limit $50k)
2. Navigate to /quotes/new → Create quote for that customer
   - Add 2 products (100 units each)
   - Mark as "planned" (should create inventory holds)
   - Verify inventory page shows holds
3. Send the quote → verify status = 'sent'
4. Accept the quote → verify status = 'accepted'
5. Convert to order → verify:
   - Order created with correct totals
   - Commission records created
   - Inventory holds still active
6. Create delivery from order → assign a driver
7. Confirm delivery (scheduled → in_progress)
   - Verify inventory check warning shows
8. Complete delivery (mark as partial — deliver 80 of 100 units)
   - Verify order_items shows delivered=80, remaining=20
   - Verify delivery_remainders created for remaining 20
   - Verify inventory decreased by 80
   - Verify inventory holds released (order fulfilled partially)
9. Create follow-up delivery from remainders
10. Navigate to /invoices → create invoice from order
    - Verify invoice amounts match DELIVERED quantities, not ordered
11. Post the invoice
12. Navigate to /payments → record payment
13. Navigate to /payment-allocation → allocate payment to invoice
14. Verify order.balance_due updated
15. Verify invoice.balance_cents updated
16. Navigate to /ar-aging → verify customer shows correct aging
```

### 4.2 Quick Delivery Lifecycle

```
1. Navigate to /deliveries → Click "Quick Delivery"
2. Search and select a customer
3. Add 2 products with quantities
4. Submit → verify:
   - Order created
   - Delivery created (is_quick_delivery = true)
   - Draft invoice created (is_quick_delivery = true)
   - Inventory decreased
5. Navigate to the invoice → post it
6. Now CANCEL the delivery
7. Verify:
   - Delivery status = cancelled
   - Draft invoice auto-voided (or notification if posted)
   - Inventory restored
   - Order updated
```

### 4.3 Purchase Order Receiving

```
1. Navigate to /purchase-orders/new → Create PO with 3 products
2. Submit PO
3. Open PO → click Receive
4. Receive 2 items as "good", 1 as "damaged"
5. Verify:
   - PO status = partially_received
   - Inventory increased for 2 good items
   - Receiving log shows all 3 records with correct conditions
   - Notification created for damaged item
6. Receive remaining items
7. Verify PO status = fully_received
```

### 4.4 Cancellation Cascade

```
1. Create order → delivery → invoice → post invoice → allocate payment
2. Now cancel the delivery
3. Verify:
   - Notification created (posted invoice needs review)
   - Inventory restored
   - Order status reverted
4. Void the invoice
5. Verify:
   - Payment allocation reversed
   - Prepay credits restored (if applicable)
   - Financial audit log has entries for everything
```

### 4.5 Driver Role Permissions

```
1. Log out → Log in as a driver user
2. Verify driver CANNOT:
   - Access /quotes, /orders, /invoices, /payments, /settings
   - Edit delivery item quantities
   - Cancel deliveries (only admin/sales_rep should)
   - Access financial data
3. Verify driver CAN:
   - View assigned deliveries
   - Confirm/start a delivery
   - Complete a delivery with signature + photos
   - Report issues on delivery
   - Self-assign available deliveries
   - Create quick deliveries
4. After driver reports an issue:
   - Verify notification is created for admin/sales_rep
   - Verify issue shows on delivery detail
```

### 4.6 Credit Limit Enforcement

```
1. Set a customer's credit limit to $1,000
2. Create an order for $5,000 for that customer
3. Verify:
   - Warning shown about credit limit exceeded
   - Notification created for admin
   - Order still allowed (warning, not blocker)
4. Check dashboard shows "1 customer over credit limit"
```

---

## PHASE 5: ROLE-BASED SECURITY TESTING

Use Playwright to test each role can only access what they should. Log in as each role and systematically verify the permission matrix in CLAUDE.md.

**Critical checks:**
- Driver cannot edit delivery amounts or access invoice data
- Sales rep cannot access month-end close or commission payments
- Applicator cannot create jobs or access financial pages
- Admin has full access to everything

For each role, navigate to every route in the app and verify either:
- Correct content loads, OR
- Redirect to dashboard / access denied

---

## PHASE 6: EDGE CASE TESTING

Test these scenarios that commonly break things:

1. **Double-submit:** Click "Complete Delivery" twice rapidly — should only process once (idempotency)
2. **Negative inventory:** Complete delivery for more than available stock — should show error
3. **Zero-quantity order items:** Create order with 0 quantity line — should be rejected
4. **Concurrent delivery completion:** Two drivers complete the same delivery — second should fail
5. **Cancel already-cancelled:** Cancel a delivery that's already cancelled — should show error/no-op
6. **Invoice void on posted with payments:** Void an invoice that has payments — should reverse allocations
7. **Very long product names:** Create product with 200-char name — verify PDF generation doesn't break
8. **Empty customer name:** Try to create customer with blank name — should validate
9. **Commission split at 150%:** Enter commission split totaling 150% — should reject
10. **Bulk import with bad data:** Upload CSV with invalid rows — verify error display and partial import

---

## PHASE 7: UNIT TEST COVERAGE FOR NEW CODE

For every fix implemented in Phases 2-3, write corresponding unit tests:

1. Test `cancel_delivery()` RPC restores inventory (mock the RPC call, verify state changes)
2. Test `void_invoice()` reverses allocations
3. Test `cancel_order()` cancels commissions
4. Test `create_quick_delivery()` uses correct tier pricing
5. Test `complete_delivery()` with partial quantities updates invoice
6. Test notification creation for each new notification type
7. Test credit limit check function
8. Test inventory hold release on quote decline

Place tests alongside existing test files or create new ones as appropriate. Target: at least 20 new unit tests covering the integrity fixes.

---

## PHASE 8: BUILD VERIFICATION & FINAL SWEEP

```
Step 8.1: npm run build  (0 errors, 0 type errors)
Step 8.2: npx vitest run  (all tests pass including new ones)
Step 8.3: npm run lint  (no critical lint errors)
Step 8.4: npm run typecheck  (0 type errors)
Step 8.5: Run full Playwright E2E suite: npm run test:e2e
Step 8.6: Manual final sweep via Playwright:
  - Load every page as admin — no crashes
  - Check console for errors/warnings
  - Verify no "undefined" or "NaN" displayed on any page
```

---

## DELIVERABLES CHECKLIST

When complete, you should have:

- [ ] All 8 data integrity gaps from Phase 2 fixed with migrations
- [ ] All 6 notification gaps from Phase 3 fixed
- [ ] Dashboard integrity alerts added
- [ ] 20+ new unit tests
- [ ] All Playwright workflow tests passing
- [ ] Role-based security verified for all 4 roles
- [ ] Edge cases tested
- [ ] Build + all tests passing
- [ ] Summary document of every issue found and how it was resolved

---

## IMPORTANT QUESTIONS TO ASK THE USER

Before starting Phase 2 fixes, ask the user these business logic questions:

1. **Partial delivery invoicing:** When a partial delivery happens and an invoice already exists, should the system (a) auto-adjust the invoice to match delivered quantities, or (b) leave the invoice alone and let the admin manually adjust?

2. **Cancelled delivery with posted invoice:** Should the system (a) auto-void the posted invoice (risky — may have payments allocated), or (b) create an urgent notification requiring manual review?

3. **Credit limit:** Should exceeding credit limit (a) block order creation entirely, or (b) show a warning but allow it to proceed?

4. **Quick delivery pricing:** When no price is specified, should it (a) always use the customer's assigned tier, (b) default to tier 1 and let the sales rep override, or (c) require the price to be entered?

5. **Commission cancellation:** When an order is cancelled, should commissions that are already marked 'paid' be (a) reversed (create negative commission), (b) left as-is with a note, or (c) flagged for admin review?

---

## PRIORITY ORDER

If time is limited, do these in order of business impact:

1. **P0 — Money at risk:** 2.1 (inventory), 2.2 (invoice cascade), 2.3 (payment reversal), 2.5 (pricing)
2. **P1 — Data integrity:** 2.4 (commissions), 2.6 (partial delivery), 2.7 (holds), 2.8 (job inventory)
3. **P2 — Operational safety:** 3.1-3.6 (notifications and alerts)
4. **P3 — Confidence:** Phases 4-7 (testing)
5. **P4 — Polish:** Phase 8 (final sweep)
