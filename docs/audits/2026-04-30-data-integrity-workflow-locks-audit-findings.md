# Data Integrity and Workflow Locks Audit Findings

Date: 2026-04-30

Scope: quote -> order -> delivery -> invoice/payment, inventory, cycle counts, order shares, and critical status locks.

This was a read-only audit. No production code was changed in this pass.

## Executive Summary

The highest-risk pattern is workflow drift between the database rules and the app screens. In a few places the UI teaches or assumes a business rule, but the database function does not enforce it tightly enough, or the database behavior changed after the UI text was written.

The most urgent fixes are:

1. `complete_delivery()` can complete a delivery without requiring `in_progress`.
2. delivery completion no longer auto-creates a draft invoice, while the UI/docs still say it does.
3. `create_invoice_from_order()` can create duplicate active invoices for the same order.
4. cycle count completion/reversal can make the transaction ledger disagree with actual inventory because negative adjustments are clamped to zero.
5. drivers can start deliveries, and the driver UI shows a complete flow, but the completion RPC only allows admin/sales.

## Reference Rules

- Pipeline rule: `Quote (draft) -> Send -> Accept -> Convert to Order -> Create Delivery -> Confirm -> Complete -> Invoice -> Payment` in `docs/workflows/QUOTE_TO_DELIVERY.md:7-13`.
- Delivery lifecycle rule: `scheduled -> in_progress -> completed -> cancelled -> voided`, with `confirm_delivery()` before `complete_delivery()`, in `CLAUDE.md:122-125`.
- Invoice/AR rule: `invoices.balance_cents` is the AR source of truth and `post_invoice()` checks open accounting periods in `CLAUDE.md:127-130`.
- Inventory rule: inventory math belongs in PostgreSQL RPCs/triggers, not React, in `docs/workflows/INVENTORY_RULES.md:88-90`.

## Findings

### P1-1: `complete_delivery()` can skip the required start/confirm step

Business risk: a delivery can be moved directly from `scheduled` to `completed` by calling the RPC, skipping the required start/confirm step. That weakens the driver handoff, audit trail, and status history.

Evidence:

- The rulebook says delivery is a two-step flow: `confirm_delivery()` then `complete_delivery()` in `CLAUDE.md:122-125`.
- `confirm_delivery()` correctly requires `scheduled` and then updates to `in_progress` in `supabase/migrations/20260316300000_confirm_delivery_idempotency.sql:44-64`.
- Current `complete_delivery()` only rejects already `completed` or `cancelled`; it does not require `in_progress` before setting status to `completed` in `supabase/migrations/20260331200000_fix_complete_delivery_precheck.sql:55-95`.

Recommended fix:

- In `complete_delivery()`, require `v_delivery.status = 'in_progress'`.
- Add a regression test proving a direct RPC call cannot complete a `scheduled` delivery.
- Keep the UI rule that completion section only appears for `in_progress`.

### P1-2: Delivery completion no longer auto-creates the draft invoice the UI promises

Business risk: completed deliveries may not become invoices unless a person manually creates the invoice. That is direct revenue leakage risk.

Evidence:

- An older `complete_delivery()` implementation explicitly auto-created a draft invoice and returned `auto_invoice` in `supabase/migrations/20260320100000_workflow_quote_order_invoice_fixes.sql:538-574`.
- A later migration dropped `create_invoice_from_delivery(uuid, uuid)` in `supabase/migrations/20260331500000_drop_unused_overloads_convert_quote_record_payment.sql:158-164`.
- Current `complete_delivery()` only adjusts already-linked draft invoices for partial deliveries and returns `status`, `delivery_id`, and `order_fulfilled`, with no auto invoice in `supabase/migrations/20260331200000_fix_complete_delivery_precheck.sql:170-208`.
- The delivery screen still reads `auto_invoice` and logs "draft invoice auto-created" when present in `src/pages/DeliveryDetail.tsx:812-825`.
- The completion help text says a draft invoice is created automatically in `src/pages/DeliveryDetail.tsx:1342-1345`.
- The getting-started guide says completion generates a draft invoice in `src/pages/GettingStarted.tsx:368-370` and `src/pages/GettingStarted.tsx:436-437`.

Recommended fix:

- Preferred: restore server-side auto-invoice creation from delivery completion and return the invoice id/number.
- Alternative: remove the automatic-invoice promise from UI/docs and add a hard "completed but uninvoiced deliveries" queue that admins must clear daily.
- Add a database-level or test-level check that a completed delivery cannot be forgotten by billing.

### P1-3: Duplicate active invoices can be created from the same order

Business risk: a user can click "Create Invoice" more than once on an order and create multiple active invoices with the same order items. That can overbill a customer.

Evidence:

- `create_invoice_from_order()` only checks the idempotency key, then creates a new invoice; it does not check whether an active invoice already exists for the order in `supabase/migrations/20260311200000_wave2_audit_fixes.sql:1080-1102`.
- The same function copies all order items into the new invoice in `supabase/migrations/20260311200000_wave2_audit_fixes.sql:1104-1128`.
- `OrderDetail` loads active invoices for the order in `src/pages/OrderDetail.tsx:180-187`.
- The "Create Invoice" button still appears whenever the order is not cancelled or fulfilled; it does not hide when an active invoice already exists in `src/pages/OrderDetail.tsx:800-810`.
- The UI always calls `create_invoice_from_order()` with a fresh idempotency key in `src/pages/OrderDetail.tsx:704-718`.

Recommended fix:

- Add a database guard before invoice insert: if an active draft/unposted/posted invoice already exists for the order, return it or raise a clear error.
- If partial billing is intended, add line-level/delivery-level uniqueness so the same order item quantity cannot be billed twice.
- Disable or relabel the button when active invoices already exist.

### P1-4: Cycle count ledger can drift because inventory changes are clamped but ledger entries use the full variance

Business risk: inventory on hand can change by one amount while the transaction ledger records a different amount. That makes the ledger unreliable for explaining stock discrepancies.

Evidence:

- `complete_cycle_count()` caps inventory at zero with `GREATEST(0, quantity_available + variance)` in `supabase/migrations/20260315200001_accounting_and_integrity_fixes.sql:887-900`.
- It still inserts the full `v_item.variance` into `inventory_transactions` in `supabase/migrations/20260315200001_accounting_and_integrity_fixes.sql:902-910`.
- `reverse_completed_cycle_count()` also caps with `GREATEST(0, quantity_available - variance)` in `supabase/migrations/20260333000000_fix_reverse_cycle_count_search_path_and_idempotency.sql:56-63`.
- The reversal ledger still records `-v_item.variance` in `supabase/migrations/20260333000000_fix_reverse_cycle_count_search_path_and_idempotency.sql:65-76`.

Recommended fix:

- Do not silently clamp and record the full variance.
- Either block the adjustment/reversal when the exact ledger move cannot be applied, or record the actual inventory delta plus a separate exception/reconciliation record.
- Add tests for "available 5, variance -10" and reversal after downstream stock movement.

### P1-5: Drivers can start assigned deliveries but cannot complete them

Business risk: field users may get stuck after starting a delivery. The screen presents completion as a field flow, but the RPC rejects drivers.

Evidence:

- `confirm_delivery()` allows admin, sales rep, or assigned driver in `supabase/migrations/20260316300000_confirm_delivery_idempotency.sql:48-57`.
- `complete_delivery()` only allows `admin` or `sales_rep` in `supabase/migrations/20260331200000_fix_complete_delivery_precheck.sql:44-48`.
- `DeliveryDetail` defines driver state and shows the completion section when a delivery is `in_progress` in `src/pages/DeliveryDetail.tsx:178-184` and `src/pages/DeliveryDetail.tsx:1342-1393`.

Recommended fix:

- Decide the business rule.
- If drivers should complete their assigned deliveries, update the RPC to allow the assigned driver.
- If only office staff should complete deliveries, hide the completion section for drivers and rewrite the driver workflow text.

### P2-1: `cancel_delivery()` allows cancelling completed deliveries even though `void_delivery()` is the completed-delivery path

Business risk: a completed delivery can be reversed into `cancelled` by direct RPC call, while the app UI treats completed delivery reversal as an admin-only void. That creates unclear history.

Evidence:

- `cancel_delivery()` allows statuses `scheduled`, `in_progress`, and `completed` in `supabase/migrations/20260333900000_mega_audit_phase1_fixes.sql:510-513`.
- If status is `completed` or `in_progress`, it reverses inventory/order delivered quantities in `supabase/migrations/20260333900000_mega_audit_phase1_fixes.sql:517-527`.
- It then sets delivery status to `cancelled` in `supabase/migrations/20260333900000_mega_audit_phase1_fixes.sql:546`.
- `void_delivery()` requires `completed` in `supabase/migrations/20260332300000_fix_void_delivery_three_bugs.sql:72-74` and sets status to `voided` in `supabase/migrations/20260332300000_fix_void_delivery_three_bugs.sql:151-155`.
- The UI only allows cancel before completed and void only for admin/completed in `src/pages/DeliveryDetail.tsx:181-183`.

Recommended fix:

- Restrict `cancel_delivery()` to `scheduled` and `in_progress`.
- Keep completed-delivery reversal inside `void_delivery()`.
- Add tests for direct RPC calls against completed deliveries.

### P2-2: Order share edits can drift from already-created invoices

Business risk: customer splits can be changed on the order after an invoice exists, while invoice shares and AR reporting may still reflect the old split.

Evidence:

- `OrderDetail` loads linked active invoices in `src/pages/OrderDetail.tsx:180-187`.
- `canEdit` still allows confirmed order edits as long as the order is not fulfilled/cancelled/partially fulfilled in `src/pages/OrderDetail.tsx:116-117`.
- `handleAddShare()` directly inserts `order_shares` and calculates `amount_cents` from the order total in React in `src/pages/OrderDetail.tsx:643-670`.
- `handleRemoveShare()` directly deletes `order_shares` in `src/pages/OrderDetail.tsx:681-685`.

Recommended fix:

- Move order-share edits into an RPC.
- Block edits when a posted invoice exists.
- For draft invoices, either sync invoice shares automatically or require invoice cancellation/recreate.

### P2-3: Cycle count item edits and cancellations bypass parent status checks

Business risk: counted quantities can be edited after completion or cancellation if the direct table update is allowed. That can make a completed count's evidence disagree with the inventory movement it produced.

Evidence:

- The item edit path directly updates `cycle_count_items` from React in `src/pages/CycleCounts.tsx:229-252`.
- Cancel directly updates `cycle_counts.status` from React in `src/pages/CycleCounts.tsx:327-338`.
- RLS only checks `is_admin()` for cycle count and item updates; it does not require parent status `in_progress` in `supabase/migrations/20260213160000_phase5_inventory_enhancements.sql:103-126`.
- Completion itself correctly requires parent status `in_progress` in `supabase/migrations/20260315200001_accounting_and_integrity_fixes.sql:862-875`.

Recommended fix:

- Add `update_cycle_count_item()` and `cancel_cycle_count()` RPCs that lock the parent row and require `status = 'in_progress'`.
- Add a trigger or RLS `WITH CHECK` guard so item rows cannot be edited after parent completion/cancellation.

### P2-4: Inventory delete still splits safety checks, ledger entry, and delete across the frontend

Business risk: the browser checks whether an item is safe to delete, then separately inserts a ledger transaction, then separately deletes inventory. Another user/process can change data between those steps.

Evidence:

- Inventory rules say all inventory math belongs in PostgreSQL, not React, in `docs/workflows/INVENTORY_RULES.md:88-90`.
- `InventoryPage` checks active holds, prebooked quantity, and pending deliveries in React in `src/pages/InventoryPage.tsx:644-679`.
- It inserts the audit transaction from React in `src/pages/InventoryPage.tsx:686-700`.
- It deletes the inventory row in a separate frontend operation in `src/pages/InventoryPage.tsx:703-710`.

Recommended fix:

- Replace the split frontend flow with a single `retire_inventory_item()` RPC.
- The RPC should lock the inventory row, re-check holds/prebooked/deliveries, insert the ledger row, and retire/delete in one transaction.

## Positive Controls Found

- `confirm_delivery()` correctly locks the delivery row, checks status, checks caller role/assigned driver, and moves `scheduled` to `in_progress` in `supabase/migrations/20260316300000_confirm_delivery_idempotency.sql:44-64`.
- `complete_cycle_count()` locks the parent cycle count and requires `in_progress` before completion in `supabase/migrations/20260315200001_accounting_and_integrity_fixes.sql:862-875`.
- `generate_finance_charges()` checks the accounting period before generating charge invoices in `supabase/migrations/20260333900000_mega_audit_phase1_fixes.sql:587-604`.
- `checkMutationResult()` and `assertRpcResult()` exist to catch silent failures in `src/lib/db.ts:48-73`.
- The app has a reconciliation library that can compare order totals, inventory ledger, and invoice balances in `src/lib/reconciliation.ts:609-728`.

## Recommended Fix Order

1. Fix `complete_delivery()` status requirement and driver authorization decision.
2. Fix the delivery-to-invoice gap or add a required uninvoiced-delivery work queue.
3. Add duplicate-invoice prevention for `create_invoice_from_order()`.
4. Fix cycle count clamp/ledger behavior.
5. Move cycle count item updates/cancel into locked RPCs.
6. Restrict `cancel_delivery()` so completed deliveries use `void_delivery()`.
7. Move order-share edits and inventory delete into transactional RPCs.

## Suggested Regression Tests

- Direct RPC cannot `complete_delivery()` from `scheduled`.
- Assigned driver can or cannot complete delivery according to the chosen business rule.
- Delivery completion either returns `auto_invoice` or creates an explicit "needs invoice" record.
- `create_invoice_from_order()` cannot create two active invoices for the same order unless a designed partial-billing rule allows it.
- Cycle count negative variance does not create ledger drift.
- Completed cycle count items cannot be edited.
- Completed delivery cannot be cancelled through `cancel_delivery()`.
