# Six-Phase Deep Audit Findings

Date: 2026-04-30  
Scope: follow-up audit across live data damage, accounting close, quote pricing, mobile/offline work, Edge Functions/OCR/email, and testing coverage.  
Mode: read-only code audit. No app behavior, migrations, or production data were changed.

## Executive Summary

The highest business risk is still in the handoff between field work, inventory, billing, and commissions. The code has many good safeguards, but several important locks are either missing, bypassable, or only covered by happy-path tests.

Top risks found:

1. Completed deliveries can bypass the required start/confirm state, while the UI and docs still describe a stricter workflow.
2. Delivery completion no longer creates a draft invoice, but the UI and training content still tell users that it does.
3. The same order can produce multiple active invoices because `create_invoice_from_order()` always inserts a new invoice when called with a new idempotency key.
4. Commission rows are marked `paid` when an unposted commission payment is created, not when the payment is actually posted.
5. Failed offline actions can be auto-deleted from the browser queue, which can hide failed delivery/payment/receiving work.
6. `send-email`, `process-document`, and `process-blend-ticket` are privileged Edge Functions with broad role access and limited business-object ownership checks.
7. Reconciliation and several recurring operations exist, but they are not wired as reliable scheduled production controls.
8. Tests cover many contracts, but the exact negative cases that would catch the above failures are missing or too forgiving.

Severity key:

- P1: can cause money, inventory, AR, or field-work damage.
- P2: important production control gap or likely operational pain.
- P3: hardening, monitoring, or coverage improvement.

## Phase 1: Live Data Damage Assessment

### Status

This Codex session did not expose a live Supabase SQL/query tool, so I could not directly query production data. This phase is therefore a code-grounded damage-assessment checklist plus SQL starter queries to run in Supabase SQL Editor or through a verified Supabase MCP connection.

### P1 - Check for completed deliveries without active invoices

Why it matters: current delivery completion does not create a draft invoice, even though older behavior and UI messaging still imply it does. A completed delivery without an active invoice is delivered product that may never become AR.

Evidence:

- Current `complete_delivery()` only rejects already completed or cancelled deliveries, then sets status to completed: `supabase/migrations/20260331200000_fix_complete_delivery_precheck.sql:55-95`.
- Current `complete_delivery()` returns `status`, `delivery_id`, and `order_fulfilled`; it does not return/create `auto_invoice`: `supabase/migrations/20260331200000_fix_complete_delivery_precheck.sql:204-208`.
- The UI still reads `completeResult.auto_invoice` and says draft invoices are created: `src/pages/DeliveryDetail.tsx:812-825`.

Starter query:

```sql
select d.id, d.delivery_number, d.order_id, d.completed_at
from deliveries d
where d.status = 'completed'
  and d.order_id is not null
  and not exists (
    select 1
    from invoices i
    where i.order_id = d.order_id
      and i.status <> 'voided'
  )
order by d.completed_at desc;
```

### P1 - Check for duplicate active invoices per order

Why it matters: duplicate active invoices can overbill a customer and overstate AR.

Evidence:

- `create_invoice_from_order()` checks only the idempotency key, then inserts a new invoice: `supabase/migrations/20260311200000_wave2_audit_fixes.sql:1080-1102`.
- The same function copies all order items into the new invoice: `supabase/migrations/20260311200000_wave2_audit_fixes.sql:1104-1128`.

Starter query:

```sql
select order_id, count(*) as active_invoice_count, array_agg(invoice_number order by invoice_date) as invoice_numbers
from invoices
where order_id is not null
  and status <> 'voided'
group by order_id
having count(*) > 1
order by active_invoice_count desc;
```

### P1 - Check commissions marked paid without a posted payment

Why it matters: commissions can disappear from pending lists before a payment is actually posted, and latest code no longer sets `paid_date`.

Evidence:

- `create_commission_payment()` inserts a payment with status `unposted`: `supabase/migrations/20260332600000_fix_commission_functions_updated_at.sql:94-101`.
- The same create function immediately updates commission rows to `paid`: `supabase/migrations/20260332600000_fix_commission_functions_updated_at.sql:117-121`.
- Reports page "mark paid" calls only `create_commission_payment()`, not `post_commission_payment()`: `src/pages/Reports.tsx:441-457`.

Starter queries:

```sql
select id, order_id, recipient_user_id, commission_amount, status, paid_date
from commissions
where status = 'paid'
  and paid_date is null;
```

```sql
select c.id, c.order_id, c.recipient_user_id, c.status,
       cp.payment_number, cp.status as payment_status
from commissions c
left join commission_payment_items cpi on cpi.commission_id = c.id
left join commission_payments cp on cp.id = cpi.commission_payment_id
where c.status = 'paid'
  and (cp.id is null or cp.status <> 'posted');
```

### P1 - Check cycle count adjustments that can make ledger history disagree with inventory

Why it matters: inventory gets clamped to zero, but the ledger logs the full variance. That means on-hand inventory and transaction history can disagree.

Evidence:

- Cycle count completion clamps inventory with `GREATEST(0, quantity_available + variance)`: `supabase/migrations/20260315200001_accounting_and_integrity_fixes.sql:887-900`.
- It still logs the full `v_item.variance` in `inventory_transactions`: `supabase/migrations/20260315200001_accounting_and_integrity_fixes.sql:902-910`.
- Reverse cycle count also clamps inventory but logs the full reversed variance: `supabase/migrations/20260333000000_fix_reverse_cycle_count_search_path_and_idempotency.sql:56-76`.

Starter query:

```sql
select cc.count_number, cci.product_id, cci.inventory_id,
       cci.expected_qty, cci.counted_qty, cci.variance,
       i.quantity_available
from cycle_count_items cci
join cycle_counts cc on cc.id = cci.cycle_count_id
left join inventory i on i.id = cci.inventory_id
where cci.is_counted = true
  and cci.variance is not null
  and cci.quantity_available + cci.variance < 0
order by cc.created_at desc;
```

## Phase 2: Accounting and Month-End Close Audit

### Controls that look strong

- `post_invoice()` checks the accounting period before posting, rejects non-draft/non-unposted invoices, and writes financial audit log entries: `supabase/migrations/20260330100000_prelaunch_state_machine_and_security.sql:214-283`.
- Field app invoice groups also check period state before posting each invoice: `supabase/migrations/20260430210000_field_app_workflow_phase9.sql:955-963`.
- `allocate_payment()` checks positive totals, prevents allocating above invoice balance, checks period state, updates balances/status, handles overpayment, and logs the financial impact: `supabase/migrations/20260333900000_mega_audit_phase1_fixes.sql:728-892`.
- `void_invoice()` and write-off paths check period state before changing money records: `supabase/migrations/20260315200001_accounting_and_integrity_fixes.sql:119-120`, `supabase/migrations/20260315200001_accounting_and_integrity_fixes.sql:294-295`.

### P1 - Commission payment state is not accounting-safe

Business risk: commissions can be marked paid while the commission payment is still unposted. Month-end reports can understate unpaid commission liability, and users can believe a commission was paid when the actual payment is not posted.

Evidence:

- The commission payment is created as `unposted`: `supabase/migrations/20260332600000_fix_commission_functions_updated_at.sql:94-101`.
- The related commissions are immediately set to `paid`: `supabase/migrations/20260332600000_fix_commission_functions_updated_at.sql:117-121`.
- The Reports page labels this as "marked as paid" after only creating the payment: `src/pages/Reports.tsx:441-457`.

Recommended fix:

- Change `create_commission_payment()` so it creates the payment and payment items, but leaves commissions `pending` or moves them to a clear intermediate status such as `in_payment`.
- Move `commissions.status = 'paid'` and `paid_date = payment_date` into `post_commission_payment()`.
- Remove or rework the quick-pay path on the Reports page so it cannot label unposted payments as paid.

### P2 - Month-end has good database locks, but no complete operating runbook

Business risk: finance charges, reconciliation, unposted invoice review, commission payment review, and period close can be performed inconsistently if they rely on user memory.

Evidence:

- `generate_finance_charges()` exists and checks the accounting period, but it is manual UI-driven work: `supabase/migrations/20260333900000_mega_audit_phase1_fixes.sql:587-723`.
- The finance charge UI calls `generate_finance_charges()` from a modal flow: `src/components/invoices/FinanceChargePreviewModal.tsx:99-142`.
- No backup/restore or month-end incident runbook was found in the repo docs during this audit.

Recommended fix:

- Add a `docs/operations/month-end-close-runbook.md` with exact steps and sign-offs.
- Include: run reconciliation, review completed uninvoiced deliveries, review duplicate invoices, post/void unposted invoices, generate finance charges, review commission liabilities, back up/export reports, then close period.

## Phase 3: Quote Pricing, Margin, and Commission Audit

### Controls that look strong

- Quote conversion only allows `sent` or `accepted` quotes: `supabase/migrations/20260330100000_prelaunch_state_machine_and_security.sql:53-55`.
- Quote conversion carries totals and commission splits into the order: `supabase/migrations/20260330100000_prelaunch_state_machine_and_security.sql:112-121`.
- Commission creation from quote conversion uses profit and split percentage, clamped at zero: `supabase/migrations/20260330100000_prelaunch_state_machine_and_security.sql:169-180`.
- Smart pricing added `quoted_price_cents` and `price_source` so manual, quoted, and tier pricing can be tracked: `supabase/migrations/20260405200000_smart_pricing_flow.sql:3-14`.

### P1 - Duplicate invoice creation can duplicate quote/order revenue

Business risk: order revenue can be billed more than once because invoice creation has no active-invoice guard per order.

Evidence:

- `create_invoice_from_order()` inserts a new draft invoice each time it is called with a fresh idempotency key: `supabase/migrations/20260311200000_wave2_audit_fixes.sql:1080-1102`.
- It copies every order item into that invoice: `supabase/migrations/20260311200000_wave2_audit_fixes.sql:1104-1128`.

Recommended fix:

- Add a database guard that prevents more than one active invoice for an order unless a deliberate split/partial invoice mode is being used.
- Return the existing active invoice when the same order is invoiced twice, or require an explicit override with an audit reason.

### P2 - Pricing still has dollar-to-cent conversion points that need locked tests

Business risk: persisted money should be cents, but quote/order conversion still depends on dollar-valued numeric fields in places before converting to invoice cents.

Evidence:

- `create_invoice_from_order()` converts `price_per_unit`, `total_price`, and `cost_per_unit` by multiplying by 100 and rounding: `supabase/migrations/20260311200000_wave2_audit_fixes.sql:1113-1124`.
- Project rules say money should be stored as bigint cents: `docs/workflows/SAFE_DEVELOPMENT_RULES.md:151-160`.

Recommended fix:

- Keep the current behavior only if legacy schema requires it, but add tests for rounding, margin, commission, partial invoices, and zero/negative profit cases.
- Prefer cent fields at the database boundary for new work.

### P1 - Commission lifecycle issue also affects quote margin reporting

Business risk: commission records created from quote/order profit can become "paid" without a posted payment, so quote profitability and paid-commission reporting can drift.

Evidence and fix are the same as Phase 2.

## Phase 4: Mobile and Offline Workflow Audit

### P1 - Offline completion does not preserve signature/email/photo side effects

Business risk: a driver can complete a delivery offline, but the queued action only stores the RPC params. Signature upload, customer email, notifications, and PDF/email details happen only in the online path after the RPC succeeds.

Evidence:

- Offline path queues only `operation: 'complete_delivery'` with `rpcParams`: `src/pages/DeliveryDetail.tsx:759-767`.
- Online path separately uploads the signature after RPC success: `src/pages/DeliveryDetail.tsx:781-809`.
- Online path separately sends customer email after completion: `src/pages/DeliveryDetail.tsx:858-928`.

Recommended fix:

- Treat offline delivery completion as a full package: RPC params, signature blob, email preference, photo metadata, and notification state.
- After sync, run the same post-completion side effects or clearly mark them as "needs review" in an admin recovery queue.

### P1 - Failed offline actions can be deleted before a user fixes them

Business risk: a delivery completion, payment allocation, or receiving action can fail three times and then be removed from the local queue. That can hide field work that never reached the server.

Evidence:

- Offline sync deletes failed and stale actions before processing current pending actions: `src/lib/offlineSync.ts:23-27`.
- `clearFailedActions()` deletes actions at or above max retries: `src/lib/offlineQueue.ts:121-128`.
- `clearStaleActions()` deletes actions older than seven days: `src/lib/offlineQueue.ts:134-141`.
- Tests currently verify that failed/stale actions are deleted: `src/lib/offlineQueue.test.ts:213-233`.

Recommended fix:

- Replace auto-delete with a durable dead-letter queue for high-impact actions.
- Show failed offline actions in an admin/user recovery screen.
- Require explicit discard with reason for deliveries, payments, receiving, and inventory adjustments.

### P1 - Driver workflow conflicts with the database completion role check

Business risk: the app lets assigned drivers work deliveries, and offline sync queues `complete_delivery`, but the current completion RPC only allows admin and sales reps.

Evidence:

- Starting/confirming a delivery allows admin, sales rep, or assigned driver: `supabase/migrations/20260316300000_confirm_delivery_idempotency.sql:48-64`.
- Current `complete_delivery()` allows only admin or sales rep: `supabase/migrations/20260331200000_fix_complete_delivery_precheck.sql:44-48`.
- Offline sync includes `complete_delivery` as a supported queued operation: `src/lib/offlineSync.ts:117-127`.

Recommended fix:

- Decide the business rule: either drivers can complete assigned deliveries, or the UI must not show driver completion.
- Align live UI, offline queue, and RPC permissions to that rule.

### P2 - Offline sync does not use the app's RPC result validation

Business risk: if an RPC returns a business-level failure in JSON without a transport error, offline sync removes the action as successfully synced.

Evidence:

- Online delivery completion calls `assertRpcResult()`: `src/pages/DeliveryDetail.tsx:775-780`.
- Offline sync only checks `{ error }` from `supabase.rpc()` and does not inspect returned data: `src/lib/offlineSync.ts:134-135`.

Recommended fix:

- Add operation-specific result validation in offline sync.
- Use the same success/failure contract as the live path.

### P2 - Browser online status is too weak for rural field use

Business risk: `navigator.onLine` can say "online" when Supabase is unreachable or the connection is too unstable to finish the action.

Evidence:

- `useOnlineStatus()` relies on browser online/offline events: `src/hooks/useOnlineStatus.ts:8-16`.
- Delivery completion chooses live RPC vs offline queue based on that value: `src/pages/DeliveryDetail.tsx:759-777`.

Recommended fix:

- Add a lightweight Supabase connectivity check before critical field actions.
- If the live call times out or fails from network instability, queue the action with a clear local receipt instead of leaving the driver unsure.

## Phase 5: Edge Function, OCR, and Email Abuse Audit

### P1 - `send-email` is a broad privileged email sender

Business risk: any admin, sales rep, or driver can call a service-role-backed function with caller-provided recipient, subject, HTML, email type, customer ID, idempotency key, and attachments. If a lower-privilege account is compromised, this can become customer spam, data leakage, or brand abuse.

Evidence:

- The function validates JWT, then uses a service-role client: `supabase/functions/send-email/index.ts:33-60`.
- It accepts caller-provided `to`, `subject`, `html`, `email_type`, `customer_id`, `idempotency_key`, and `attachments`: `supabase/functions/send-email/index.ts:63-76`.
- It sends the caller HTML to Resend and stores full HTML in `email_log`: `supabase/functions/send-email/index.ts:104-150`.

Recommended fix:

- Replace free-form HTML with server-side templates per approved email type.
- Enforce recipient ownership/business-object checks.
- Add per-user and per-customer rate limits.
- Limit drivers to delivery receipts for assigned deliveries only.

### P1 - OCR/blend-ticket processing uses service role after broad role checks

Business risk: OCR functions can mutate/read blend ticket records through service role after checking only broad role membership. They should also verify the caller is allowed to process the specific ticket.

Evidence:

- `process-blend-ticket` allows admin, sales rep, or applicator, then accepts only `blend_ticket_id`: `supabase/functions/process-blend-ticket/index.ts:776-811`.
- It uses the service-role client to update queue/ticket status and read images: `supabase/functions/process-blend-ticket/index.ts:813-847`.
- `process-document` allows admin, sales rep, or applicator, then processes caller-provided pages through OCR: `supabase/functions/process-document/index.ts:792-848`.

Recommended fix:

- Check the caller against the specific blend ticket, application job, customer, or assignment before service-role work.
- Add idempotency keys and audit rows for every processing request.
- Add size/rate limits that are enforced server-side, not only in the browser.

### P2 - OCR cost controls are incomplete

Business risk: the browser limits PDF processing to 20 pages, and the Edge Function also rejects more than 20 pages, but there is no per-user/day or per-ticket quota visible in the function.

Evidence:

- Browser OCR invokes `process-document` with extracted pages: `src/lib/documentOCR.ts:178-185`.
- Unit tests verify the browser only renders 20 pages: `src/lib/documentOCR.test.ts:251-263`.
- Edge Function rejects requests over 20 pages: `supabase/functions/process-document/index.ts:823-848`.
- OCR pages are processed in batches of five concurrent Vision API calls: `supabase/functions/process-document/index.ts:159-175`.

Recommended fix:

- Add a server-side quota table keyed by user/customer/document type/day.
- Log cost-driving inputs: page count, file type, user, document type, and processing time.
- Alert on spikes or repeated failures.

### P2 - Recurring operations depend on dashboard visits

Business risk: reminders and expired quote hold release run when the dashboard loads. If nobody opens the dashboard, recurring business cleanup can lag.

Evidence:

- Dashboard load runs `check_remainder_reminders()` and `release_expired_quote_holds()`: `src/pages/Dashboard.tsx:344-367`.
- Only overdue invoice cron setup was found in the cron migration reviewed during the prior production audit.

Recommended fix:

- Move recurring business cleanup into scheduled functions or Supabase cron.
- Keep dashboard calls read-only or "refresh now" only.

### P2 - Reconciliation exists but is not wired as a production control

Business risk: the app has reconciliation code for order totals, inventory ledger, invoice payments, and balances, but it is not run automatically or surfaced as an operational exception report.

Evidence:

- `runReconciliationChecks()` is defined in `src/lib/reconciliation.ts:614`.
- Search found only the definition/usage comment, not a production call site.

Recommended fix:

- Run reconciliation nightly and after month-end close preparation.
- Save results to a reconciliation table.
- Show P1 discrepancies on an admin dashboard and include them in the month-end runbook.

## Phase 6: Testing Coverage Audit

### What is already covered

- Schema and RPC contract tests list major mutating RPCs and idempotency expectations: `src/lib/schemaIntegrity.test.ts:550-566`, `src/lib/schemaIntegrity.test.ts:731-743`.
- Period close E2E tests cover important accounting areas in intent: `tests/e2e/period-close-accounting.spec.ts:7-15`.
- Commission split creation has at least one E2E path that checks pending commissions and 100 percent split totals: `tests/e2e/period-close-accounting.spec.ts:511-575`.
- Offline queue and offline sync unit tests exist: `src/lib/offlineSync.test.ts:39-75`, `src/lib/offlineQueue.test.ts:213-288`.

### P1 - Missing negative tests for delivery state locks

Business risk: tests complete deliveries in normal or forgiving flows, but they do not lock in "scheduled delivery cannot complete" or "driver can/cannot complete assigned delivery" as a required rule.

Evidence:

- E2E double-complete accepts either an `already_completed` response or an error as acceptable: `tests/e2e/concurrent-operations.spec.ts:591-608`.
- Current RPC allows completion unless status is completed/cancelled: `supabase/migrations/20260331200000_fix_complete_delivery_precheck.sql:55-59`.

Tests to add:

- Completing a `scheduled` delivery must fail if the business rule requires `in_progress`.
- Assigned driver completion must either succeed or be hidden/forbidden consistently.
- Offline queued driver completion must not disappear after repeated permission failures.

### P1 - Missing tests for duplicate active invoices

Business risk: current tests call `create_invoice_from_order()` in many places, but there is no hard failure test that the same order cannot produce two active invoices.

Evidence:

- Seed and workflow tests call `create_invoice_from_order()`: `tests/e2e/00-seed-test-data.spec.ts:214-242`.
- The database function currently inserts a new invoice with no active-invoice guard: `supabase/migrations/20260311200000_wave2_audit_fixes.sql:1092-1102`.

Tests to add:

- Calling `create_invoice_from_order()` twice for the same order with different idempotency keys should return the existing invoice or fail with a clear error.
- The UI should hide or disable invoice creation when an active invoice already exists.

### P1 - Missing tests for commission payment posting state

Business risk: the test suite checks commission creation but not the create-payment vs post-payment state transition that is currently wrong.

Evidence:

- Commission creation test allows a non-failing note if no commission records are created: `tests/e2e/period-close-accounting.spec.ts:556-575`.
- No test found that verifies `create_commission_payment()` leaves commissions unpaid until `post_commission_payment()` succeeds.

Tests to add:

- After `create_commission_payment()`, payment is `unposted` and commissions are not `paid`.
- After `post_commission_payment()`, commissions are `paid` and `paid_date` is populated.
- Voiding an unposted or posted commission payment returns commissions to the correct state.

### P1 - Missing tests for offline RPC result validation and dead-letter behavior

Business risk: offline sync tests currently assert that a `{ error: null }` RPC response removes the queued action. They do not cover business-level failed JSON responses.

Evidence:

- Offline sync success test removes a `complete_delivery` action after `{ error: null }`: `src/lib/offlineSync.test.ts:39-50`.
- Offline sync implementation ignores returned data and checks only `error`: `src/lib/offlineSync.ts:134-135`.
- Queue tests verify failed/stale cleanup deletes actions: `src/lib/offlineQueue.test.ts:213-233`.

Tests to add:

- RPC returns `{ success: false, error: "..." }` with no transport error and the action remains failed, not removed.
- Failed high-impact actions move to a durable recovery state, not deletion.
- Offline delivery completion with signature and email preference replays all completion side effects or creates an admin recovery task.

### P2 - SQL validators are local-only, not CI-enforced

Business risk: important migration safety checks can be bypassed if a commit or PR does not run local hooks.

Evidence:

- Local pre-commit runs SQL and frontend validators: `.husky/pre-commit:3-23`.
- CI runs audit, lint, typecheck, tests, and build, but not the SQL/frontend validators: `.github/workflows/ci.yml:39-59`.

Recommended fix:

- Add `bash scripts/validate-sql.sh` and `bash scripts/validate-frontend.sh` to CI before tests/build.

## Recommended Fix Order

1. Fix delivery completion state locks and decide driver completion permissions.
2. Fix delivery-to-invoice behavior: either restore auto draft invoice creation or remove all UI/docs that promise it and add a required billing queue.
3. Add active-invoice guard for orders.
4. Fix commission payment lifecycle so commissions are paid only after payment posting.
5. Fix cycle count ledger math so transactions match the actual inventory delta after clamping.
6. Replace offline auto-delete with a durable recovery queue and validate RPC result bodies.
7. Lock down `send-email`, `process-document`, and `process-blend-ticket` with object-level authorization, templates, quotas, and audit logs.
8. Move dashboard-triggered recurring operations to scheduled jobs.
9. Wire reconciliation as a nightly/month-end production control.
10. Add the negative tests listed in Phase 6 and move validators into CI.

## Suggested Next Agent Prompt

Use this prompt if another agent will implement fixes:

```text
You are working in C:\CRX_Manager_V1.0. Read CLAUDE.md, AGENTS.md, docs/workflows/SAFE_DEVELOPMENT_RULES.md, docs/workflows/QUOTE_TO_DELIVERY.md, docs/workflows/INVENTORY_RULES.md, and docs/audits/2026-04-30-six-phase-deep-audit-findings.md before editing.

Implement fixes in phases. Do not change old migrations; add new migration files only. Preserve unrelated user changes.

Phase 1 priority:
1. Align delivery completion state locks and driver permission rules across RPC, UI, and offline sync.
2. Fix delivery-to-invoice behavior and remove stale auto-invoice messaging if auto invoice is not restored.
3. Prevent duplicate active invoices per order.
4. Fix commission payment lifecycle so create payment does not mark commissions paid until post payment succeeds.

For every change, add focused tests for the exact failure described in the audit. Run typecheck and the narrowest useful tests, then update docs/reference files and CHANGELOG if behavior or schema changes.
```

