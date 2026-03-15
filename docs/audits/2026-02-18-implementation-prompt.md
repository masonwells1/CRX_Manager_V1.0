# CRX Manager V1.0 — Business Logic Enhancements Implementation Prompt

## Context

You are working on CRX Manager V1.0, an agricultural product distribution management system built with React 18 + TypeScript + Vite + Supabase. Read `CLAUDE.md` for full architecture, database schema, RPC functions, and coding patterns before starting.

## Business Decisions (Owner-Approved)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Partial Delivery Invoicing | Auto-adjust draft invoices to match delivered qty; notify admin on posted invoices |
| 2 | Quick Delivery Commissions | Always generate using customer's commission_split (same as regular orders) |
| 3 | Order Cancellation Cascade | Cancel everything automatically — void draft invoices, zero commissions, release holds |
| 4 | Delivery Remainders | Auto-remind after 7 days with escalating notifications |
| 5 | Draft Invoice Auto-Posting | Never auto-post — every invoice requires manual review and posting |

---

## Implementation Tasks

### 1. Partial Delivery Invoice Auto-Adjustment

**What:** When `complete_delivery()` finishes and any item was partially delivered, handle the linked invoice automatically based on its current status.

**Database changes (new migration):**
- No new tables or columns needed — uses existing `invoices`, `invoice_items`, `financial_audit_log`, `notifications`

**RPC changes — modify `complete_delivery()`:**
- After completing the delivery and creating remainder rows, look up any invoice linked to the delivery's order
- **If invoice `status = 'draft'`:**
  - Update each `invoice_items` row: set `quantity` and `line_total_cents` to match actual `quantity_delivered` from `delivery_items`
  - Recalculate the invoice's `balance_cents` as the sum of all `invoice_items.line_total_cents`
  - Insert a row into `financial_audit_log` with `action = 'partial_delivery_adjustment'`, recording old and new amounts in `old_data` / `new_data` JSONB
- **If invoice `status = 'posted'`:**
  - Do NOT modify the invoice
  - Insert a notification to all users where `role = 'admin'`:
    - `title`: `'Partial Delivery Review Needed'`
    - `message`: `'Partial delivery {delivery_number} completed — posted invoice {invoice_number} may need adjustment.'`
    - `notification_type`: `'partial_delivery_review'`
- **If no invoice exists yet:** do nothing (invoice hasn't been created)

**Frontend changes:**
- No UI changes needed — notifications will appear in the existing notification center
- Toast message on delivery completion should mention "Invoice adjusted" or "Admin notified" when partial

**Tests:**
- Unit test: partial delivery with draft invoice → verify invoice amounts reduced
- Unit test: partial delivery with posted invoice → verify notification created, invoice unchanged
- Unit test: full delivery → verify no invoice adjustment or notification

---

### 2. Quick Delivery Commissions — Always Generate

**What:** Ensure `create_quick_delivery()` generates commission records using the customer's `commission_split` JSONB, identical to regular order creation.

**Database changes (new migration):**
- No new tables or columns needed

**RPC changes — modify `create_quick_delivery()`:**
- After creating the order, look up the customer's `commission_split` JSONB
- If `commission_split` exists and has splits:
  - Calculate `order_profit` (sum of line items: `(unit_price - product_cost) * quantity`)
  - For each split entry: insert a `commissions` row with:
    - `order_id` = the newly created order
    - `recipient` = split.recipient (profile UUID)
    - `split_percentage` = split.percentage
    - `commission_amount` = order_profit × (split.percentage / 100)
    - `status` = `'pending'`
- Reference `convert_quote_to_order()` or `create_direct_order()` for the exact commission generation pattern — copy it exactly

**Frontend changes:**
- None — commissions will appear on the existing Commissions page and Commission Payments workflow

**Tests:**
- Unit test: quick delivery for customer WITH commission_split → verify commission rows created with correct amounts
- Unit test: quick delivery for customer WITHOUT commission_split → verify no commission rows, no errors

---

### 3. Order Cancellation Cascade

**What:** When `cancel_order()` is called, atomically clean up all linked entities.

**Database changes (new migration):**
- No new tables or columns needed

**RPC changes — modify `cancel_order()`:**
After setting the order status to `'cancelled'`, add these steps inside the same transaction:

1. **Release inventory holds:**
   - `UPDATE inventory_holds SET is_active = false WHERE order_id = p_order_id AND is_active = true`

2. **Zero out commissions:**
   - `UPDATE commissions SET status = 'cancelled', commission_amount = 0 WHERE order_id = p_order_id AND status = 'pending'`
   - Do NOT touch commissions that are already `'paid'` — if any exist, notify admin instead

3. **Void draft invoices:**
   - For each invoice linked to this order where `status = 'draft'`:
     - `UPDATE invoices SET status = 'void', balance_cents = 0, void_reason = 'Order cancelled' WHERE order_id = p_order_id AND status = 'draft'`
   - For each invoice linked to this order where `status = 'posted'`:
     - Do NOT void it
     - Insert notification to all admin users:
       - `title`: `'Manual Invoice Void Required'`
       - `message`: `'Order {order_number} cancelled but has posted invoice {invoice_number} — manual void required.'`
       - `notification_type`: `'cancellation_review'`

4. **Log everything:**
   - Insert `activity_feed` entries for: holds released, commissions cancelled, invoices voided, admin notifications sent

**Frontend changes:**
- `OrderDetail.tsx`: After cancel succeeds, show toast with summary: "Order cancelled. {X} holds released, {Y} commissions zeroed, {Z} invoices voided."
- If posted invoices exist, toast should add: "Admin notified about {N} posted invoice(s) requiring manual void."

**Tests:**
- Unit test: cancel order with draft invoice → verify invoice voided, commissions zeroed, holds released
- Unit test: cancel order with posted invoice → verify invoice NOT voided, admin notification created
- Unit test: cancel order with paid commissions → verify paid commissions untouched, admin notified
- Unit test: cancel order with no linked entities → verify clean cancellation, no errors

---

### 4. Delivery Remainder Auto-Reminders

**What:** Remainders pending for 7+ days trigger notifications to the sales rep and admins. Escalate at 14+ days.

**Database changes (new migration):**
```sql
-- Add reminder tracking to delivery_remainders
ALTER TABLE delivery_remainders ADD COLUMN IF NOT EXISTS reminder_sent_at timestamptz DEFAULT NULL;
ALTER TABLE delivery_remainders ADD COLUMN IF NOT EXISTS escalation_sent_at timestamptz DEFAULT NULL;
```

**New RPC — `check_remainder_reminders()`:**
```
CREATE OR REPLACE FUNCTION check_remainder_reminders()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
```
Logic:
1. **7-day reminders:** Find all `delivery_remainders` where:
   - `status = 'pending'`
   - `created_at < NOW() - INTERVAL '7 days'`
   - `reminder_sent_at IS NULL`
   - For each, insert notification to:
     - The order's `assigned_sales_rep` (from `orders` → `customers.assigned_sales_rep`)
     - All admin users
   - Notification: `title = 'Delivery Remainder Pending 7+ Days'`, `message = '{product_name} ({remainder_quantity} units) from delivery {delivery_number} has been pending for 7+ days.'`
   - Set `reminder_sent_at = NOW()`

2. **14-day escalation:** Find all `delivery_remainders` where:
   - `status = 'pending'`
   - `created_at < NOW() - INTERVAL '14 days'`
   - `reminder_sent_at IS NOT NULL`
   - `escalation_sent_at IS NULL`
   - For each, insert escalation notification:
     - `title = 'URGENT: Delivery Remainder Pending 14+ Days'`
     - `message = '{product_name} ({remainder_quantity} units) from delivery {delivery_number} has been pending for 14+ days. Please schedule follow-up or cancel.'`
   - Set `escalation_sent_at = NOW()`

3. Return a JSONB summary: `{ "reminders_sent": X, "escalations_sent": Y }`

**Frontend changes:**
- Call `check_remainder_reminders()` on Dashboard load (in `src/pages/Dashboard.tsx`), fire-and-forget — don't block the dashboard rendering
- Notifications will appear in the existing notification center automatically
- On the `DeliveryRemainders.tsx` page, show a visual indicator (amber badge) on remainders older than 7 days

**Tests:**
- Unit test: remainder created 5 days ago → no reminder sent
- Unit test: remainder created 8 days ago, no prior reminder → reminder sent, reminder_sent_at set
- Unit test: remainder created 8 days ago, already reminded → no duplicate
- Unit test: remainder created 15 days ago, reminded at day 8 → escalation sent

---

### 5. Draft Invoice — Never Auto-Post (Audit & Enforce)

**What:** Verify that every invoice creation path produces `status = 'draft'`. Add explicit comments and a safety check.

**Audit these RPC functions:**
- `create_quick_delivery()` — invoice must be created as `'draft'`
- `convert_quote_to_order()` — if it creates an invoice, must be `'draft'`
- `transfer_job_to_invoice()` — invoice must be created as `'draft'`
- Any other function that inserts into the `invoices` table

**For each function:**
- Verify the INSERT sets `status = 'draft'`
- If any sets a different status, fix it to `'draft'`
- Add a SQL comment: `-- Business rule: all invoices start as draft, require manual posting by sales rep`

**Frontend safety check:**
- In any component that creates invoices (look for `.insert()` on `invoices` table), verify `status: 'draft'` is explicitly set
- Add a TypeScript comment on each: `// Business rule: invoices always start as draft`

**Database constraint (new migration):**
```sql
-- Optional but recommended: add a check constraint as a safety net
-- This prevents any code path from accidentally creating a posted invoice
ALTER TABLE invoices ADD CONSTRAINT invoices_created_as_draft
  CHECK (
    status = 'draft' OR
    id IN (SELECT id FROM invoices) -- allows status transitions on existing rows
  );
```
Note: If a simple CHECK constraint can't express this (since it needs to distinguish INSERT vs UPDATE), instead create a trigger:
```sql
CREATE OR REPLACE FUNCTION enforce_invoice_draft_on_insert()
RETURNS trigger AS $$
BEGIN
  IF NEW.status != 'draft' THEN
    RAISE EXCEPTION 'Invoices must be created with status draft. Got: %', NEW.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_invoice_draft_insert
  BEFORE INSERT ON invoices
  FOR EACH ROW
  EXECUTE FUNCTION enforce_invoice_draft_on_insert();
```

**Tests:**
- Unit test: verify `create_quick_delivery()` creates draft invoice
- Unit test: verify `transfer_job_to_invoice()` creates draft invoice
- Unit test: verify direct invoice INSERT with status != 'draft' is rejected by trigger

---

## General Implementation Rules

1. **Each task gets its own migration file** in `supabase/migrations/` with timestamp prefix (e.g., `20260218100000_partial_delivery_invoice_adjustment.sql`)
2. **Update `src/types/index.ts`** if any columns are added (task 4 adds `reminder_sent_at` and `escalation_sent_at` to `DeliveryRemainder` interface)
3. **Follow existing patterns** — look at how current RPCs handle similar logic before writing new code
4. **Use `checkMutationResult()`** after every `.update()` or `.delete()` call
5. **Log to `activity_feed`** for all significant state changes
6. **Run `npm run build` and `npx vitest run`** after each task to verify nothing breaks
7. **Commit after each task** with a descriptive message (e.g., "feat: partial delivery auto-adjusts draft invoices, notifies on posted")

## Task Order

Implement in this order (dependencies flow downward):
1. Task 5 (audit/enforce draft invoices) — foundation, no dependencies
2. Task 2 (quick delivery commissions) — standalone
3. Task 3 (order cancellation cascade) — standalone
4. Task 1 (partial delivery invoice adjustment) — depends on task 5 being verified
5. Task 4 (delivery remainder reminders) — standalone, but do last since it adds new columns
