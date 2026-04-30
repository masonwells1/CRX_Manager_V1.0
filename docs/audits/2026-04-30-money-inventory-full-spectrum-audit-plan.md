# Money and Inventory Full-Spectrum Audit Plan

Date: 2026-04-30
Scope: CRX Manager money flow, inventory flow, and every handoff between them.
Mode: Read-only audit first. Do not change code until the audit findings are ranked and Mason approves a fix phase.

## Executive Summary

This audit should focus on one business question:

Can CRX Manager prove that every quote, order, delivery, application job, invoice, payment, purchase receipt, inventory adjustment, and reversal leaves money and inventory in the correct final state?

The app already has many safety systems: database RPCs, idempotency keys, financial audit logs, inventory transaction ledgers, generated invoice balances, and reconciliation helpers. The audit should not only check whether those systems exist. It should prove they agree with each other across real workflows.

Highest-risk areas to audit first:

1. Quote/order/invoice total consistency.
2. Invoice posting, payment allocation, prepay, write-off, and AR balance accuracy.
3. Delivery completion inventory deduction and invoice creation.
4. Purchase order receiving, on-order quantity, cost history, and inventory additions.
5. Planned quote holds and order prebooked inventory release.
6. Field application and blend ticket grouped invoices, customer splits, service fees, and job-applied inventory.
7. Reversal paths: cancel, void, unpost, return, receiving reversal, cycle count reversal.
8. Security around money/inventory RPCs, especially `SECURITY DEFINER` functions that bypass normal table-level RLS.

## Current Workflow Map

### Normal Sales Pipeline

Quote to order:
- `src/pages/QuoteBuilder.tsx`
- `save_quote`
- `convert_quote_to_order`
- planned inventory holds through `inventory_holds`

Direct order:
- `src/pages/NewOrder.tsx`
- `create_direct_order`
- inventory warning and prebook behavior

Delivery:
- `src/pages/NewDelivery.tsx`
- `src/pages/DeliveryDetail.tsx`
- `src/components/deliveries/QuickDeliveryModal.tsx`
- `confirm_delivery`
- `complete_delivery`
- `create_quick_delivery`
- `delivery_items`
- `delivery_remainders`
- `inventory_transactions`

Invoice and payment:
- `src/pages/Invoices.tsx`
- `src/pages/InvoiceDetail.tsx`
- `src/pages/PaymentAllocation.tsx`
- `post_invoice`
- `post_invoice_group`
- `void_invoice`
- `allocate_payment`
- `invoices.balance_cents`
- `financial_audit_log`

AR reporting:
- `src/pages/ARaging.tsx`
- `src/pages/CustomerTransactionReview.tsx`
- `get_ar_aging`
- `get_customer_statement`
- `get_detailed_statement_data`
- `get_customer_transaction_review`

### Inventory and Purchasing Pipeline

Inventory screen:
- `src/pages/InventoryPage.tsx`
- inventory display, forecast, holds, manual adjustments, ledger modal entry point
- `adjust_inventory`
- `inventory_transactions`

Purchase orders and receiving:
- `src/pages/PurchaseOrders.tsx`
- `src/pages/NewPurchaseOrder.tsx`
- `src/pages/PurchaseOrderDetail.tsx`
- `src/pages/QuickReceive.tsx`
- `save_purchase_order`
- `receive_po_items`
- `match_quick_receive_items`
- `reverse_receiving_record`
- `purchase_order_items.quantity_received`
- `inventory.quantity_available`
- `inventory.quantity_on_order`
- `cost_history`

Cycle counts:
- `src/pages/CycleCounts.tsx`
- `complete_cycle_count`
- `reverse_completed_cycle_count`
- `inventory_transactions.transaction_type = adjusted`

### Field Application and Blend Ticket Branch

Direct field application invoice:
- `src/pages/FieldApplicationInvoice.tsx`
- `src/components/field-app/CustomerSharesTable.tsx`
- `src/components/field-app/FieldAppChemicalEntry.tsx`
- `src/components/field-app/ApplicationServicePicker.tsx`
- `save_field_app_invoice`
- `preview_field_app_invoice_split`
- `derive_customer_shares_from_fields`

Blend tickets:
- `src/pages/BlendTicketDetail.tsx`
- `create_invoice_from_blend_ticket`
- `create_order_from_blend_ticket`
- `create_application_record_from_blend_ticket`

Jobs:
- `src/pages/JobDetail.tsx`
- `start_job`
- `complete_job`
- `transfer_job_to_invoice`
- `job_applied` inventory transactions

## Audit Phases

### Phase 0 - Freeze the Ground Truth

Purpose: avoid auditing stale docs or stepping on in-flight work.

Actions:
- Capture `git status` before doing anything else.
- Treat current uncommitted files as user/in-flight work.
- Recount migrations, pages, tests, and Edge Functions from the repo instead of trusting older docs.
- Read `CLAUDE.md`, `docs/workflows/SAFE_DEVELOPMENT_RULES.md`, `docs/workflows/QUOTE_TO_DELIVERY.md`, `docs/workflows/INVENTORY_RULES.md`, `docs/workflows/DATABASE_CHANGE_CHECKLIST.md`, and `docs/workflows/RLS_SECURITY_GUIDE.md`.
- Identify the latest migration defining each critical RPC before making any claim about behavior.

Done means:
- A table of critical workflows, source files, latest RPC migration files, and test files exists.
- Any doc drift is listed separately from actual app defects.

### Phase 1 - Static Money Audit

Purpose: prove money is stored, calculated, posted, paid, reported, and locked correctly.

Check:
- All persisted money columns use whole-number cents where required.
- UI dollar inputs are converted to cents before database writes.
- `invoices.balance_cents` remains the AR source of truth.
- `balance_cents = total_amount_cents - paid_amount_cents - prepay_applied_cents`.
- Posted invoices cannot have amount-changing edits.
- `post_invoice()` and `post_invoice_group()` call `check_period_open()`.
- Voids, write-offs, payments, prepay applications, finance charges, and reversals all write `financial_audit_log`.
- Batch invoice actions use idempotency and do not partially post/void in a way that leaves mismatched state.
- AR aging, statements, customer transaction review, and customer pages all read the same balance source.

High-value files:
- `supabase/migrations/20260213100000_phase2_billing_architecture.sql`
- `supabase/migrations/20260330100000_prelaunch_state_machine_and_security.sql`
- `supabase/migrations/20260333900000_mega_audit_phase1_fixes.sql`
- `src/pages/InvoiceDetail.tsx`
- `src/pages/PaymentAllocation.tsx`
- `src/pages/ARaging.tsx`
- `src/lib/reconciliation.ts`

Specific questions:
- Can any invoice be created without an order or blend ticket?
- Can any posted invoice be edited instead of voided/reissued?
- Can payment allocation double-count or over-allocate?
- Does a payment remainder become prepay credit exactly once?
- Do grouped field-app invoices post atomically?
- Do statements and AR aging agree with invoice balances?

### Phase 2 - Static Inventory Audit

Purpose: prove physical stock, committed stock, planned holds, on-order stock, and the transaction ledger agree.

Check:
- Every stock-changing action writes exactly one intended `inventory_transactions` row.
- Inventory math lives in database RPCs, not React.
- `quantity_available` changes only for real stock movement: received, delivered, returned, adjusted, transferred, job_applied, cancellation/void reversals.
- `quantity_prebooked` changes only for committed orders or valid releases.
- Planned quote holds reduce net free inventory without changing physical stock.
- Order cancellation, quote decline/expiry, delivery void/cancel, receiving reversal, and cycle count reversal restore the correct state.
- On-order quantity matches open purchase orders.

High-value files:
- `docs/workflows/INVENTORY_RULES.md`
- `src/pages/InventoryPage.tsx`
- `src/pages/PurchaseOrderDetail.tsx`
- `src/pages/QuickReceive.tsx`
- `src/pages/DeliveryDetail.tsx`
- `src/pages/CycleCounts.tsx`
- `src/lib/reconciliation.ts`
- latest migrations for `complete_delivery`, `receive_po_items`, `adjust_inventory`, `complete_cycle_count`, `start_job`, and `complete_job`

Specific questions:
- Does delivery completion deduct both physical and committed quantities correctly?
- Does delivery cancellation or void restore physical stock exactly once?
- Does PO receiving update quantity received, inventory available, on-order quantity, and cost history together?
- Can manual inventory deletion or adjustment bypass RPC inventory rules?
- Can multiple active holds for one product cause over-release or under-release?
- Does `job_applied` allow real work to be recorded even when stock is short, while flagging review?

### Phase 3 - End-to-End Pipeline Audit

Purpose: prove full workflows reconcile from first action to final accounting and inventory state.

Run or create tests for:
- Quote draft -> sent -> accepted -> order -> delivery -> completed -> invoice -> posted -> payment.
- Planned quote hold -> converted order -> hold released -> prebooked quantity created or preserved correctly.
- Direct order -> invoice -> payment.
- Quick delivery -> order + delivery + draft invoice.
- Partial delivery -> delivery remainder -> follow-up delivery -> final invoice quantities.
- Delivery cancel before completion.
- Delivery void after completion.
- Order cancel with draft invoice and with posted invoice.
- Return -> received -> credit invoice.
- Purchase order -> partial receive -> full receive -> reverse receive.
- Cycle count adjustment -> reverse completed cycle count.

Use existing tests first:
- `tests/e2e/golden-path-quote-to-payment.spec.ts`
- `tests/e2e/mega-workflow.spec.ts`
- `tests/e2e/math-end-to-end-workflow.spec.ts`
- `tests/e2e/math-inventory-flow.spec.ts`
- `tests/e2e/math-invoice-verification.spec.ts`
- `tests/e2e/math-payment-allocation.spec.ts`
- `tests/e2e/math-quote-pricing.spec.ts`
- `tests/e2e/workflow-admin-full-lifecycle.spec.ts`
- `tests/e2e/workflow-cancellation-cascade.spec.ts`
- `tests/e2e/workflow-financial-operations.spec.ts`
- `tests/e2e/workflow-po-receiving.spec.ts`
- `tests/e2e/workflow-quick-delivery.spec.ts`
- `tests/e2e/workflow-write-off.spec.ts`

### Phase 4 - Field Application and Blend Ticket Audit

Purpose: prove application billing and chemical inventory work for single-customer and multi-customer fields.

Check:
- `derive_customer_shares_from_fields()` falls back to field owner at 100 percent when no billing defaults exist.
- Direct field-app invoice preview matches saved invoice output.
- Multi-customer fields create one invoice per customer with a shared `invoice_group_id`.
- `field_app_location_shares` carries the true split.
- `invoice_shares` remains compatible with PDF/statement expectations.
- Per-customer price mode is correct:
  - grower share / field override mode
  - line-item product pricing mode
  - quoted price fallback
  - tier price fallback
  - manual override
  - application service fee
- Editing grouped invoices cannot leave stale child invoices.
- Posted grouped invoices cannot be edited through any member.
- Blend ticket invoice creation matches direct field-app invoice logic.
- Job completion writes application records, field-level application detail, and inventory movement.
- Job completion is protected by correct role/ownership checks.

High-value files:
- `supabase/migrations/20260429140635_field_app_workflow_phase1.sql`
- `supabase/migrations/20260430190000_field_app_workflow_phase7.sql`
- `supabase/migrations/20260430200000_field_app_workflow_phase8.sql`
- `src/pages/FieldApplicationInvoice.tsx`
- `src/pages/BlendTicketDetail.tsx`
- `src/pages/JobDetail.tsx`
- `tests/e2e/workflow-field-app-multi-customer.spec.ts`
- `tests/e2e/workflow-job-lifecycle.spec.ts`

Known prior audit leads to re-check:
- Job RPC authorization and ownership checks.
- Quote-linked job prebook release.
- Multiple active hold release behavior.
- Grouped invoice edits that remove a customer.
- Full E2E coverage after the newer phase migrations.

### Phase 5 - Live Data Reconciliation

Purpose: catch real mismatches that code review and tests can miss.

Start from `src/lib/reconciliation.ts`, which already includes checks for:
- order totals vs order items
- inventory ledger balance
- invoice payment integrity
- invoice balance formula
- commission split totals
- planned quote hold parity
- delivery vs invoice quantity parity
- prebooked inventory consistency
- return credit linkage
- customer AR consistency

Add audit queries for:
- invoices missing `order_id` and `blend_ticket_id`
- posted invoices with missing financial audit log entries
- negative invoice balances
- active inventory holds past expiry
- duplicate active holds for same source/product where not expected
- inventory rows with negative quantity available
- inventory rows where `quantity_prebooked` exceeds open committed demand
- purchase order on-order mismatch
- delivery items completed but missing `inventory_transactions`
- job-applied chemicals missing `inventory_transactions`
- field-app invoice groups with child invoices whose totals no longer match their line items
- invoice groups where some members are posted and others are draft/unposted

### Phase 6 - Security and Permissions Audit

Purpose: prevent users from changing money or inventory through a database function they should not be able to call.

Check every mutating money/inventory RPC for:
- `SECURITY DEFINER` plus `SET search_path = public, pg_temp`
- `p_idempotency_key text DEFAULT NULL`
- explicit role/ownership checks inside the function when needed
- no accidental broad grants to unauthorized roles
- no frontend service-role key usage
- all frontend RPC calls wrapped with `assertRpcResult()`
- all `.update()` and `.delete()` calls wrapped with `checkMutationResult()`

Critical RPC families:
- quote/order creation and conversion
- delivery confirm/complete/cancel/void
- invoice save/post/group post/void/write-off/payment
- purchase order receive/reverse/cancel
- inventory adjustment and cycle count
- field-app invoice save/preview/post group
- blend ticket invoice/order/application-record creation
- job start/complete/transfer

### Phase 7 - Regression and Release Gate

Before any fix branch is considered safe:

Run:
- `scripts/validate-sql-migrations.sh`
- `scripts/validate-frontend.sh`
- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `npm run test`

Then run the narrow E2E set tied to the changed area. For a full money/inventory release gate, run:
- `npm run test:e2e -- tests/e2e/golden-path-quote-to-payment.spec.ts`
- `npm run test:e2e -- tests/e2e/math-end-to-end-workflow.spec.ts`
- `npm run test:e2e -- tests/e2e/math-inventory-flow.spec.ts`
- `npm run test:e2e -- tests/e2e/math-invoice-verification.spec.ts`
- `npm run test:e2e -- tests/e2e/math-payment-allocation.spec.ts`
- `npm run test:e2e -- tests/e2e/workflow-cancellation-cascade.spec.ts`
- `npm run test:e2e -- tests/e2e/workflow-field-app-multi-customer.spec.ts`
- `npm run test:e2e -- tests/e2e/workflow-job-lifecycle.spec.ts`
- `npm run test:e2e -- tests/e2e/workflow-po-receiving.spec.ts`

## Findings Format

Every finding should use this format:

```text
Severity: P0/P1/P2/P3
Business impact:
What can go wrong:
Evidence:
Files and lines:
Suggested fix phase:
Tests required:
Open decision for Mason:
```

Severity guide:
- P0: Can create wrong invoices, wrong AR, wrong inventory, unauthorized money/inventory change, or data loss.
- P1: Can block a core workflow, leave stale money/inventory state, or silently skip audit history.
- P2: Important correctness, reporting, or edge-case risk with a workaround.
- P3: Documentation drift, cleanup, UX clarity, or low-risk hardening.

## Recommended Fix Order After Audit

1. P0 money/inventory data corruption paths.
2. P0/P1 unauthorized mutation paths.
3. Invoice posting/payment/AR mismatches.
4. Inventory ledger/prebook/on-order mismatches.
5. Field-app grouped invoice and job-applied inventory mismatches.
6. Reversal and cleanup edge cases.
7. Tests and docs.

## Ready-to-Send Agent Prompt

Use this prompt to hand the audit to another agent:

```text
You are auditing CRX Manager V1.0 in C:\CRX_Manager_V1.0. Mason has 0 coding experience, so explain findings in plain English and rank business risk before technical detail.

Do not change code yet. This is a read-only audit.

Goal:
Perform a full money and inventory workflow audit. Analyze quote -> order -> delivery -> invoice -> payment, purchase order -> receiving -> inventory, returns/credits, cycle counts, quick delivery, and the field application / blend ticket / job branch.

Read first:
- CLAUDE.md
- AGENTS.md
- docs/workflows/SAFE_DEVELOPMENT_RULES.md
- docs/workflows/QUOTE_TO_DELIVERY.md
- docs/workflows/INVENTORY_RULES.md
- docs/workflows/DATABASE_CHANGE_CHECKLIST.md
- docs/workflows/RLS_SECURITY_GUIDE.md
- docs/audits/2026-04-30-money-inventory-full-spectrum-audit-plan.md

Audit rules:
- Check current git status and preserve unrelated changes.
- Verify latest migrations/RPCs before trusting older docs.
- Reference exact file paths and line numbers.
- Separate confirmed bugs from risks needing live-data verification.
- Do not propose implementation until findings are ranked.

Main evidence areas:
- src/pages/QuoteBuilder.tsx
- src/pages/NewOrder.tsx
- src/pages/OrderDetail.tsx
- src/pages/NewDelivery.tsx
- src/pages/DeliveryDetail.tsx
- src/components/deliveries/QuickDeliveryModal.tsx
- src/pages/Invoices.tsx
- src/pages/InvoiceDetail.tsx
- src/pages/PaymentAllocation.tsx
- src/pages/ARaging.tsx
- src/pages/InventoryPage.tsx
- src/pages/PurchaseOrderDetail.tsx
- src/pages/QuickReceive.tsx
- src/pages/CycleCounts.tsx
- src/pages/FieldApplicationInvoice.tsx
- src/pages/BlendTicketDetail.tsx
- src/pages/JobDetail.tsx
- src/lib/reconciliation.ts
- supabase/migrations/

Deliverable:
Create a ranked markdown audit report under docs/audits/. Include P0/P1/P2/P3 findings, business impact, exact evidence, suggested fix phase, tests required, and any business decisions Mason needs to make.
```
