# Money and Inventory Full-Spectrum Audit Findings

Date: 2026-04-30
Scope: CRX Manager quote/order/delivery/invoice/payment, inventory, purchase receiving, and field-application billing paths.
Mode: Read-only audit plus markdown artifacts. No code fixes were made.

## Ready-to-Send Prompt

Use this prompt with another agent if you want a second pass or a fix-plan review:

```text
You are auditing CRX Manager V1.0, a production agricultural chemical distributor app. Mason has 0 coding experience, so explain findings in plain business language first and code detail second.

Perform a full money and inventory workflow audit. Focus on whether the app can prove that every quote, order, delivery, field application job, blend ticket, invoice, payment, purchase receipt, inventory adjustment, and reversal leaves money and inventory in the correct final state.

Rules:
- Read `AGENTS.md`, `CLAUDE.md`, `docs/workflows/SAFE_DEVELOPMENT_RULES.md`, `docs/workflows/QUOTE_TO_DELIVERY.md`, `docs/workflows/INVENTORY_RULES.md`, `docs/workflows/DATABASE_CHANGE_CHECKLIST.md`, and `docs/workflows/RLS_SECURITY_GUIDE.md` first.
- Treat latest migrations as the source of truth. Do not trust stale docs without checking current SQL.
- Do not change code until findings are ranked and Mason approves a fix phase.
- Preserve unrelated uncommitted changes.
- Cite exact file paths and line numbers.

Audit phases:
1. Freeze ground truth: git state, latest RPC definitions, workflow docs, key pages.
2. Money audit: quote totals, order totals, invoice creation/posting, grouped invoices, payment allocation, prepay, write-offs, voids, AR aging, financial audit logs, and period-close enforcement.
3. Inventory audit: planned holds, prebooked committed stock, physical stock, PO receiving, quick receiving, delivery completion, job-applied inventory, cycle counts, reversals, and transaction ledger parity.
4. End-to-end workflow audit: quote -> order -> delivery -> invoice -> payment, direct order, quick delivery, partial delivery, field application invoice, blend ticket invoice, purchase receiving, cycle count, cancel/void/reverse paths.
5. Security audit: every `SECURITY DEFINER` RPC that moves money or inventory must derive actor from `auth.uid()`, reject actor spoofing, check role, set `search_path`, and use idempotency.
6. Produce a ranked report with P0/P1/P2/P3 findings, exact evidence, business impact, recommended fix phases, and test plan.

Known high-risk files to inspect:
- `src/pages/QuoteBuilder.tsx`
- `src/pages/NewOrder.tsx`
- `src/pages/OrderDetail.tsx`
- `src/pages/NewDelivery.tsx`
- `src/pages/DeliveryDetail.tsx`
- `src/components/deliveries/QuickDeliveryModal.tsx`
- `src/pages/InvoiceDetail.tsx`
- `src/pages/PaymentAllocation.tsx`
- `src/pages/InventoryPage.tsx`
- `src/pages/PurchaseOrderDetail.tsx`
- `src/pages/QuickReceive.tsx`
- `src/pages/CycleCounts.tsx`
- `src/pages/FieldApplicationInvoice.tsx`
- `src/pages/BlendTicketDetail.tsx`
- `src/pages/JobDetail.tsx`
- latest migrations defining `save_quote`, `convert_quote_to_order`, `create_direct_order`, `save_purchase_order`, `receive_po_items`, `confirm_delivery`, `complete_delivery`, `create_quick_delivery`, `create_invoice_from_order`, `save_invoice`, `post_invoice`, `void_invoice`, `allocate_payment`, `save_field_app_invoice`, `create_invoice_from_blend_ticket`, `post_invoice_group`, `start_job`, and `complete_job`.
```

## Executive Summary

The strongest existing protections are in the older quote/order/invoice posting path. `save_quote`, `convert_quote_to_order`, `create_direct_order`, `adjust_inventory`, `post_invoice`, and the newer `start_job`/`complete_job` functions all show the right security shape: derive the actor from `auth.uid()`, reject mismatched `p_performed_by`, check role, and keep key money/inventory changes inside database RPCs.

The highest-risk issue is inconsistent actor validation in other money and inventory RPCs. Several current `SECURITY DEFINER` functions still trust a user id sent from the browser. Because those functions are granted to authenticated users and run with elevated database rights, a lower-privilege logged-in user could potentially pass an admin or sales user's UUID and perform protected actions. This is the first fix phase I recommend.

The second major issue is that one inventory delete path still performs inventory ledger writing and inventory deletion as two separate frontend operations instead of one database transaction. That creates a realistic ledger-drift risk if one step succeeds and the other fails.

## Checks Run

Passed:
- `npm run typecheck`
- `npm run build`
- Focused tests: `src/lib/reconciliation.test.ts`, `src/pages/PaymentAllocation.test.tsx`, `src/pages/FieldApplicationInvoice.test.tsx`, `src/pages/InvoiceDetail.test.tsx`, `src/pages/BlendTicketDetail.test.tsx`, `src/lib/paymentAllocation.test.ts`
- Focused test result: 6 test files passed, 110 tests passed.

Ran with warnings:
- `npm run lint` passed with 0 errors and 2 existing accessibility warnings in `src/components/field-app/FieldAppChemicalEntry.tsx:204` and `src/components/field-app/FieldAppChemicalEntry.tsx:230`.

Could not run in this shell:
- The audit skill's bash-based validation scripts could not run because this Windows shell does not have `bash` available.
- Full unit suite, full E2E suite, live Supabase reconciliation, and live production data checks were not run in this pass.

## Findings

### P1 - Several money/inventory RPCs trust a browser-sent actor id

Business impact: a logged-in user may be able to perform protected money or inventory actions by passing another user's UUID as `p_performed_by` or `p_created_by`. This affects audit accountability and, depending on role setup, may allow unauthorized invoice creation, payment allocation, purchase order changes, purchase receiving, quick deliveries, and delivery state changes.

Evidence:
- Good pattern for comparison: `save_quote` derives `v_actor := auth.uid()` and rejects mismatch at `supabase/migrations/20260333200000_fix_save_quote_search_path_and_idempotency_type.sql:34-47`.
- Good pattern for comparison: `convert_quote_to_order` derives `auth.uid()` and rejects mismatch at `supabase/migrations/20260331500000_drop_unused_overloads_convert_quote_record_payment.sql:66-89`.
- Weak pattern: `allocate_payment` uses `v_actor := COALESCE(p_performed_by, auth.uid())` and then authorizes based on that value at `supabase/migrations/20260333900000_mega_audit_phase1_fixes.sql:749-762`.
- Weak pattern: `save_purchase_order` verifies admin role using `p_performed_by` directly, without checking `auth.uid()`, at `supabase/migrations/20260331200001_fix_po_edit_partially_received.sql:39-44`.
- Weak pattern: `receive_po_items` uses `COALESCE(p_performed_by, auth.uid())` and authorizes that value at `supabase/migrations/20260332500000_fix_receive_po_and_audit_constraints.sql:58-63`.
- Weak pattern: `confirm_delivery` uses `COALESCE(p_performed_by, auth.uid())` and checks that value at `supabase/migrations/20260316300000_confirm_delivery_idempotency.sql:25-58`.
- Weak pattern: `complete_delivery` uses `COALESCE(p_performed_by, auth.uid())` and checks that value at `supabase/migrations/20260331200000_fix_complete_delivery_precheck.sql:43-48`.
- Weak pattern: `create_quick_delivery` uses `COALESCE(p_performed_by, auth.uid())` and checks that value at `supabase/migrations/20260333600000_quick_delivery_optional_invoice.sql:52-60`.

Recommended fix:
- Add one shared SQL auth pattern to every mutating `SECURITY DEFINER` RPC:
  - `v_actor := auth.uid();`
  - reject if `v_actor IS NULL`
  - reject if supplied actor is not null and does not equal `v_actor`
  - authorize by `v_actor`, not by a browser-supplied id
- Prioritize `allocate_payment`, `save_purchase_order`, `receive_po_items`, `confirm_delivery`, `complete_delivery`, and `create_quick_delivery`.

### P1 - Field application invoice save lacks an auth and role gate

Business impact: direct RPC calls may create, edit, cancel, detach, or retotal field-application invoices without proving the caller is an admin/sales user. This is a billing-integrity risk because the function creates invoice rows, deletes/rebuilds invoice items and shares, updates totals, and logs activity using a caller-supplied user id.

Evidence:
- `save_field_app_invoice` is `SECURITY DEFINER` at `supabase/migrations/20260430200000_field_app_workflow_phase8.sql:27-40`.
- The function performs idempotency and edit/rebuild work without an auth gate at `supabase/migrations/20260430200000_field_app_workflow_phase8.sql:90-130`.
- It can cancel/detach orphan grouped invoices at `supabase/migrations/20260430200000_field_app_workflow_phase8.sql:160-185`.
- It inserts invoices with `created_by = p_performed_by` at `supabase/migrations/20260430200000_field_app_workflow_phase8.sql:224-242`.
- It writes final activity using `p_performed_by` at `supabase/migrations/20260430200000_field_app_workflow_phase8.sql:504-514`.
- I searched this migration for `auth.uid`, `profiles`, `is_admin`, and `is_sales_rep`; none were present.

Recommended fix:
- Add the same actor-match and role gate used by `start_job` and `complete_job`.
- Add regression tests for unauthorized/authenticated non-sales callers and actor mismatch.

### P1 - Blend ticket invoice creation lacks an auth and role gate

Business impact: direct RPC calls may create customer invoices from approved blend tickets and mark the blend ticket billed without proving the caller is authorized. This can create AR records and change billing state from outside the intended UI controls.

Evidence:
- `create_invoice_from_blend_ticket` is `SECURITY DEFINER` at `supabase/migrations/20260429140635_field_app_workflow_phase1.sql:682-690`.
- It validates the ticket status but not the caller at `supabase/migrations/20260429140635_field_app_workflow_phase1.sql:737-750`.
- It inserts invoices using `p_created_by` at `supabase/migrations/20260429140635_field_app_workflow_phase1.sql:817`.
- It marks the blend ticket billed at `supabase/migrations/20260429140635_field_app_workflow_phase1.sql:1018`.
- It writes activity using `p_created_by` at `supabase/migrations/20260429140635_field_app_workflow_phase1.sql:1020-1025`.
- The function is granted to authenticated users at `supabase/migrations/20260429140635_field_app_workflow_phase1.sql:1041`.

Recommended fix:
- Require `auth.uid()`, reject `p_created_by` mismatch, and require admin/sales role before any ticket or invoice state changes.
- Add tests proving non-admin/sales authenticated users cannot create blend-ticket invoices.

### P2 - Inventory deletion is split between frontend audit insert and frontend delete

Business impact: if the transaction insert succeeds but the inventory delete fails, the ledger says stock was removed while the inventory row remains. If the delete succeeds after a stale client-side validation check, the delete is not protected by the same database lock/transaction as the validation and ledger insert. This violates the project rule that inventory math belongs in database RPCs.

Evidence:
- The workflow doc says inventory math must happen in database RPCs/triggers, not React, at `docs/workflows/INVENTORY_RULES.md:88-90`.
- `InventoryPage` validates holds/prebooked/pending deliveries in the browser at `src/pages/InventoryPage.tsx:644-679`.
- It inserts an `inventory_transactions` row from React at `src/pages/InventoryPage.tsx:686-700`.
- It deletes from `inventory` as a separate frontend operation at `src/pages/InventoryPage.tsx:703-710`.

Recommended fix:
- Replace this with a `delete_inventory_item` or `retire_inventory_item` RPC.
- Inside one database transaction: lock the inventory row, re-check active holds/prebooked/pending deliveries, insert the ledger transaction, and delete or soft-retire the row.

### P2 - `post_invoice_group` relies on `post_invoice` for money safety but can spoof the group activity actor

Business impact: the actual posting loop calls `post_invoice`, which has a strong auth/role/period gate, so the money state is protected. However, the group wrapper itself accepts `p_performed_by` and writes group activity using that value without proving it matches the logged-in user.

Evidence:
- `post_invoice` enforces `auth.uid()`, role, accounting period, status, cancelled-order rejection, and `financial_audit_log` at `supabase/migrations/20260330100000_prelaunch_state_machine_and_security.sql:227-283`.
- `post_invoice_group` is `SECURITY DEFINER` at `supabase/migrations/20260429140635_field_app_workflow_phase1.sql:1051-1059`.
- It calls `post_invoice(v_inv.id, NULL)` at `supabase/migrations/20260429140635_field_app_workflow_phase1.sql:1093-1096`.
- It records group activity with `p_performed_by` at `supabase/migrations/20260429140635_field_app_workflow_phase1.sql:1100-1104`.

Recommended fix:
- Add the actor-match check to `post_invoice_group` too, even though `post_invoice` protects the posting itself.

### P2 - Existing reconciliation safety net has a stale payment source

Business impact: the reconciliation helper is a useful safety net, but its live payment check still reads the older `payments` table. Current payment entry uses `allocate_payment`, `allocation_sets`, and `invoice_line_allocations`. If an admin later relies on this reconciliation check, it can produce false confidence or false mismatches around paid invoice balances.

Evidence:
- Current payment UI states `allocate_payment` is the sole payment entry point at `src/pages/PaymentAllocation.tsx:1-8`.
- Payment submit calls `allocate_payment` at `src/pages/PaymentAllocation.tsx:273-287`.
- `allocate_payment` writes `allocation_sets`, `invoice_line_allocations`, prepay credits, invoice paid amounts, activity, and `financial_audit_log` at `supabase/migrations/20260333900000_mega_audit_phase1_fixes.sql:778-887`.
- `runReconciliationChecks()` still selects from `payments` for invoice payment verification at `src/lib/reconciliation.ts:692-710`.
- Search results show `runReconciliationChecks()` is not wired to an app page; it is only in tests and the helper file today.

Recommended fix:
- Rework the reconciliation payment check to sum active `invoice_line_allocations` by invoice, not the old `payments` table.
- Consider adding an admin-only reconciliation page or scheduled report after the check is corrected.

### P3 - Minor UI/accessibility lint warnings in field application chemical entry

Business impact: not a money/inventory correctness issue, but it should be cleaned up during the field-application hardening pass.

Evidence:
- Lint reports clickable noninteractive element warnings at `src/components/field-app/FieldAppChemicalEntry.tsx:204` and `src/components/field-app/FieldAppChemicalEntry.tsx:230`.

Recommended fix:
- Replace the clickable noninteractive elements with real buttons or add appropriate keyboard/role handling.

## Positive Controls Confirmed

- Quote save has actor mismatch protection, role protection, idempotency, and controlled status transitions.
- Quote-to-order has actor mismatch protection, role protection, quote status validation, inventory warning/prebook behavior, and commission creation.
- Direct order creation has actor mismatch protection and warns on inventory pressure.
- Manual inventory adjustment uses an RPC with actor mismatch protection and admin-only authorization.
- Invoice posting enforces auth, admin/sales role, period-open checks, invoice status, cancelled-order rejection, and financial audit logging.
- Job start and job completion now have strong actor/role gates and handle job-applied inventory with review flags for shortages.
- Grouped field-application posting is atomic through `post_invoice_group`, and the actual post operation goes through protected `post_invoice`.

## Recommended Fix Phases

Phase 1 - Actor spoofing and auth gates:
- Fix the RPC actor pattern in all critical money/inventory functions named in P1.
- Add regression tests for actor mismatch and lower-role authenticated users.

Phase 2 - Inventory deletion transaction:
- Replace frontend inventory delete with a single database RPC.
- Add tests for delete blocked by holds, prebooked quantity, pending deliveries, and successful zero-stock delete/retire.

Phase 3 - Field-application billing audit polish:
- Add financial audit entries for grouped invoice orphan cancellation where appropriate.
- Verify direct field-app invoice create/edit, blend-ticket invoice creation, and grouped posting all share the same auth and audit conventions.

Phase 4 - Reconciliation and operational audit dashboard:
- Correct payment reconciliation to the current allocation model.
- Add or expose an admin reconciliation workflow for AR balance, invoice allocations, inventory ledger, prebooked stock, delivery/invoice parity, and quote hold parity.

Phase 5 - Full E2E business flow tests:
- Quote to payment.
- Direct order to payment.
- Quick delivery to invoice.
- Partial delivery and follow-up delivery.
- Blend ticket to grouped invoice.
- Field application invoice split.
- PO receive and reverse receive.
- Cycle count and reversal.

## Current Bottom Line

I would not start broad UI refactors before Phase 1. The first fix should be a focused database hardening pass for actor validation on money and inventory RPCs. That is the area most likely to prevent unauthorized or unauditable business-state changes.
