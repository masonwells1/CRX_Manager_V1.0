# Additional Audit Sprints for Claude Review

Date: 2026-05-01  
Mode: read-only code audit. No application behavior, migrations, or production data were changed.  
Purpose: give Claude a targeted review packet before any fix work is started.

## Working Tree Note

At verification time, the repo has unrelated staged/modified work that this audit did not create. Claude should preserve it and should not assume it is deployed:

Tracked files shown as modified:

- `CLAUDE.md`
- `docs/CHANGELOG.md`
- `docs/reference/migration-history.md`
- `src/pages/InventoryPage.tsx`

Added/staged file not created by this audit:

- `supabase/migrations/20260501110000_field_app_workflow_phase16.sql`

Other untracked files:

- `docs/audits/2026-04-30-six-phase-deep-audit-findings.md`

Do not delete, overwrite, or assume these are deployed. Phase 16 appears to add `retire_inventory_item()` for atomic inventory retirement, but it was not part of this audit and should be reviewed/applied intentionally before relying on it.

## Executive Summary

The app has many strong controls: admin-only finance routes, AP payment locking, idempotency keys in the major money flows, invoice AR fields in cents, RUP sales generation from posted invoices, and role-aware navigation.

The next audit/fix work should focus on operational correctness rather than adding features. The biggest remaining risk areas are:

1. Live data may already contain AP, return, RUP, inventory, and reporting drift that code review alone cannot prove or clear.
2. Purchase receiving allows over-receive from the UI by default, which can hide vendor shipment mistakes as normal receiving.
3. PO submit/reject/cancel-style workflow changes are still partly direct table updates instead of one locked state-machine RPC.
4. Customer returns calculate credit price from today’s product tier price, not from the original invoice/order price.
5. Product and regulatory master data allow active RUP products without required EPA/signal-word completeness.
6. Several reports still use legacy order dollar totals or frontend-selected rows instead of invoice/ledger source-of-truth totals.
7. Reconciliation exists but is not wired into a scheduled or admin-visible production control.
8. There is no full repo runbook for backup, restore drills, incident response, and month-end operating steps.

## Sprint 0 - Live Production Data Integrity

### Goal

Before fixing code, find out whether production data is already wrong. This Codex session did not expose a live Supabase SQL tool, so these are code-grounded SQL checks for Claude or Supabase SQL Editor.

### Checks to Run

```sql
-- AP: duplicate active vendor bill numbers per vendor
select vendor_id, bill_number, count(*) as bill_count, array_agg(id) as bill_ids
from vendor_bills
where deleted_at is null
  and status <> 'voided'
  and nullif(trim(bill_number), '') is not null
group by vendor_id, bill_number
having count(*) > 1
order by bill_count desc;
```

```sql
-- AP: vendor bill balances that do not match payments
select vb.id, vb.bill_number, vb.total_cents, vb.paid_cents, vb.balance_cents,
       coalesce(sum(vp.amount_cents), 0) as payment_sum
from vendor_bills vb
left join vendor_payments vp on vp.vendor_bill_id = vb.id
where vb.deleted_at is null
group by vb.id, vb.bill_number, vb.total_cents, vb.paid_cents, vb.balance_cents
having vb.paid_cents <> coalesce(sum(vp.amount_cents), 0)
    or vb.balance_cents <> vb.total_cents - vb.paid_cents;
```

```sql
-- PO: item received quantity does not match receiving records
select poi.id, po.po_number, poi.product_name, poi.quantity_ordered, poi.quantity_received,
       coalesce(sum(rr.quantity_received), 0) as receiving_record_sum
from purchase_order_items poi
join purchase_orders po on po.id = poi.purchase_order_id
left join receiving_records rr on rr.po_item_id = poi.id
group by poi.id, po.po_number, poi.product_name, poi.quantity_ordered, poi.quantity_received
having poi.quantity_received <> coalesce(sum(rr.quantity_received), 0)
order by po.po_number;
```

```sql
-- PO: over-received items
select po.po_number, poi.product_name, poi.quantity_ordered, poi.quantity_received
from purchase_order_items poi
join purchase_orders po on po.id = poi.purchase_order_id
where poi.quantity_received > poi.quantity_ordered
order by po.po_number;
```

```sql
-- Returns: credited/received returns with suspicious price source
select r.return_number, r.status, ri.product_name, ri.quantity, ri.unit_price_cents, ri.extended_cents,
       r.order_id, r.created_at
from returns r
join return_items ri on ri.return_id = r.id
where r.deleted_at is null
  and r.status in ('received', 'credited')
order by r.created_at desc;
```

```sql
-- Master data: active RUP products missing compliance fields
select id, product_name, sku, epa_registration, signal_word
from products
where is_active = true
  and is_rup = true
  and (epa_registration is null or trim(epa_registration) = '' or signal_word is null);
```

```sql
-- RUP register: posted invoices with RUP items but no RUP sales record
select i.id as invoice_id, i.invoice_number, ii.product_id, p.product_name
from invoices i
join invoice_items ii on ii.invoice_id = i.id
join products p on p.id = ii.product_id
where i.status in ('posted', 'paid', 'overdue')
  and p.is_rup = true
  and not exists (
    select 1 from rup_sales_records r
    where r.invoice_id = i.id and r.product_id = ii.product_id
  );
```

```sql
-- Application records: field-app records missing product detail
select id, record_number, application_date, source_type, source_id, product_data
from application_records
where product_data is null
   or jsonb_typeof(product_data) <> 'array'
   or jsonb_array_length(product_data) = 0;
```

## Sprint 1 - Purchasing, Receiving, Vendor Bills, and AP

### Controls That Look Strong

- New vendor bills use `create_vendor_bill()` with cents fields and idempotency from `src/pages/NewVendorBill.tsx:117-128`.
- Vendor payment entry uses `record_vendor_payment()` with idempotency from `src/pages/VendorBillDetail.tsx:120-129`.
- `record_vendor_payment()` locks the bill row, rejects overpayment, rejects non-positive payments, updates paid/balance/status, and returns the payment id in `supabase/migrations/20260331600000_consolidate_all_rpc_overloads.sql:158-203`.
- AP dashboard reads from database RPCs, not frontend math, in `src/pages/AccountsPayable.tsx:33-49`.

### P1 - Receiving Over-Receives by Default

Business risk: a vendor can ship more than ordered and the app records it as normal receiving instead of an exception that needs a reason/approval. This can inflate inventory and PO receiving totals.

Evidence:

- `receive_po_items()` blocks over-receive only when `p_allow_over_receive` is false in `supabase/migrations/20260430250000_field_app_workflow_phase13.sql:292-296`.
- PO detail always passes `p_allow_over_receive: true` in `src/pages/PurchaseOrderDetail.tsx:196-201`.
- Quick Receive also always passes `p_allow_over_receive: true` in `src/pages/QuickReceive.tsx:281-288`.

Recommended fix:

- Default normal PO receiving to `p_allow_over_receive: false`.
- Add an explicit admin-only over-receive path requiring a reason, visible UI warning, and audit log entry.
- Add live data check for `quantity_received > quantity_ordered` before changing behavior.

### P1 - PO Submit Is Still a Direct Table Update

Business risk: submitting a PO controls on-order inventory and receiving eligibility. It should be a single database function with authorization, idempotency, activity/audit logging, and transition checks.

Evidence:

- Editing/creating POs uses `save_purchase_order()` RPC in `src/pages/PurchaseOrderDetail.tsx:399-412`.
- Cancelling POs uses `cancel_purchase_order()` RPC in `src/pages/PurchaseOrderDetail.tsx:454-460`.
- Submitting a PO directly updates `purchase_orders.status` and `submitted_date` from React in `src/pages/PurchaseOrderDetail.tsx:434-439`.

Recommended fix:

- Add `submit_purchase_order(p_po_id, p_performed_by, p_idempotency_key)` RPC.
- Move transition validation, on-order inventory side effects, and audit logging into the RPC.
- Keep `checkMutationResult()` only for non-critical direct edits.

### P1 - Reverse Receiving Can Hide Stock That Was Already Consumed

Business risk: reversing a receiving record subtracts stock with `GREATEST(quantity_available - qty, 0)`. If that received stock was already sold/applied, inventory will clamp to zero while the receiving record is deleted, leaving history hard to reconcile.

Evidence:

- Reverse receiving subtracts with `GREATEST(quantity_available - v_rec.quantity_received, 0)` in `supabase/migrations/20260333500000_allow_po_reverse_transitions.sql:102-107`.
- It then deletes the receiving record in `supabase/migrations/20260333500000_allow_po_reverse_transitions.sql:145-147`.
- The UI warns the action deletes the receiving record and cannot be undone in `src/pages/PurchaseOrderDetail.tsx:1069-1072`.

Recommended fix:

- Block reversal when it would take available stock negative unless an explicit inventory adjustment workflow is used.
- Preserve the receiving record with a reversed flag instead of deleting it, or insert a reversal record that keeps the original event auditable.

### P1 - Return Credits Use Today’s Tier Price Instead of Original Sale Price

Business risk: customer credits can be too high or too low if prices changed after the original order/invoice.

Evidence:

- Return creation inserts return rows directly from React in `src/pages/Returns.tsx:210-241`.
- Return item price is set from the selected customer’s current product tier price in `src/pages/Returns.tsx:690-694`.
- Receive and credit are RPC-backed in `src/pages/Returns.tsx:357-387`, but the original item pricing is already baked into `return_items` before those RPCs run.

Recommended fix:

- Create a `create_return()` RPC that can source price from the original invoice item or order item when `order_id` is provided.
- Require an explicit override reason if staff enters a manual credit price.

## Sprint 2 - Customer, Product, Pricing, and Master Data

### Controls That Look Strong

- Customer save uses `save_customer()` with idempotency in `src/pages/CustomerDetail.tsx:419-426`.
- Customer commission split must total 100 percent in the UI in `src/pages/CustomerDetail.tsx:371-380`, and database migrations also validate customer split totals.
- Product save logs price/cost changes into `cost_history` in `src/pages/ProductDetail.tsx:173-203`.
- Product negative cost/tier prices are constrained in `supabase/migrations/20260209200000_tier1_audit_fixes.sql:38-41`.
- Application service and customer-specific app rates store cents fields, and `customer_application_rates` has a uniqueness constraint from `supabase/migrations/20260405000000_application_services.sql:57-74`.

### P1 - Product Master Still Allows Active RUP Products With Missing Compliance Data

Business risk: a product can be sold or applied as RUP without the EPA registration or signal word needed for compliance reports and invoices.

Evidence:

- `epa_registration` was added as nullable text in `supabase/migrations/20260206195903_add_epa_registration_to_products.sql:18-24`.
- `signal_word` only checks the allowed values when present, but allows null in `supabase/migrations/20260213200000_phase7_reporting_compliance_rebates.sql:13-14`.
- Product detail lets admins mark `is_rup` and leave EPA/signal word empty in `src/pages/ProductDetail.tsx:306-330`.

Recommended fix:

- Add a database check or save RPC validation: active `is_rup = true` products must have non-empty EPA registration and signal word.
- Add a remediation query and cleanup task before enabling the stricter rule.

### P2 - Application Service Rate Changes Are Direct Table Writes

Business risk: application service rates affect invoice totals. Direct table writes make it easier to miss idempotency, before/after audit detail, and period-aware billing impact review.

Evidence:

- Service create/update writes directly to `application_services` from React in `src/pages/ApplicationServiceDetail.tsx:87-99`.
- Customer override insert/delete writes directly to `customer_application_rates` in `src/pages/ApplicationServiceDetail.tsx:107-129`.
- These rates are later used by field-app smart pricing RPCs through `customer_application_rates` in migrations such as `supabase/migrations/20260430170000_field_app_workflow_phase4.sql:65-113`.

Recommended fix:

- Add `save_application_service()` and `save_customer_application_rate()` RPCs with idempotency and audit logging.
- Keep the unique constraint, but make the database function the only app path for money-impacting rate edits.

### P2 - Legacy Dollar Numeric Totals Still Feed New Cent-Based Workflows

Business risk: the project rule is “money as bigint cents,” but quotes/orders/products still have many dollar numeric fields. That is a legacy schema reality, but new work must not expand it.

Evidence:

- Product tier prices are numeric dollar fields in `supabase/migrations/20260206172436_create_full_schema_v2.sql:70-78`.
- Order list converts `orders.total_price` to cents for invoice percentage comparison in `src/pages/Orders.tsx:154-160`.
- Quote/order/reporting code still uses `total_price` dollar values throughout `src/pages/Reports.tsx:159-233` and `src/pages/SalesReports.tsx:175-190`.

Recommended fix:

- Do not attempt a broad conversion in one pass.
- For new database work, add cents fields or source from invoices.
- Add regression tests around every dollar-to-cent boundary that still exists.

## Sprint 3 - Regulatory and Compliance

### Controls That Look Strong

- RUP sales records are generated from posted invoices; `post_invoice()` calls `generate_rup_sales_records()` in `supabase/migrations/20260330100000_prelaunch_state_machine_and_security.sql:214-282`.
- The RUP register page uses `get_rup_sales_register()` in `src/pages/Compliance.tsx:144-157`.
- Invoice PDFs pull EPA registration from invoice/product data in `src/pages/InvoiceDetail.tsx:545-595`.
- RUP warnings are shown before some transactions through `checkRUPCompliance()`.

### P1 - RUP Compliance Warnings Do Not Block Transactions

Business risk: staff can proceed with RUP products even when the customer has no valid license. That may be an intentional business decision, but it must be explicit.

Evidence:

- `checkRUPCompliance()` states it returns warnings and does not block the transaction in `src/lib/rupCompliance.ts:13-18`.
- The function checks RUP products and licenses, then returns warning messages in `src/lib/rupCompliance.ts:34-83`.
- It is used in quote/delivery surfaces including `src/pages/QuoteBuilder.tsx`, `src/pages/NewDelivery.tsx`, and `src/pages/DeliveryDetail.tsx`.

Recommended fix:

- Decide policy: warning-only, manager override, or hard block.
- If warning-only is intentional, add “override acknowledged by user” tracking to the resulting quote/order/delivery/invoice.
- If hard-block/manager override is required, enforce it in the database/RPC path, not just UI.

### P1 - RUP Register Depends on Product Master Completeness

Business risk: RUP register rows are created from invoice items and product fields. Missing product EPA/signal data flows directly into compliance records.

Evidence:

- `generate_rup_sales_records()` selects `p.epa_registration` and `p.signal_word` from products in `supabase/migrations/20260314100001_fix_generate_rup_sales_records_column_refs.sql:39-47`.
- It inserts those fields into `rup_sales_records` in `supabase/migrations/20260314100001_fix_generate_rup_sales_records_column_refs.sql:71-89`.
- Compliance page displays missing EPA/signal word as a dash, not as a blocking data-quality failure, in `src/pages/Compliance.tsx:353-383`.

Recommended fix:

- Add a “RUP Product Readiness” report that lists active RUP products missing EPA/signal word before any new compliance enforcement.

### P2 - Application Record Export Is Too Thin for Audit Defense

Business risk: an applicator-facing/exported record that only shows product count is not enough if the business needs full product, EPA, rate, and field detail for an audit.

Evidence:

- Application Records list loads `application_records` and derives only `product_count` from `product_data` in `src/pages/ApplicationRecords.tsx:64-101`.
- CSV export includes record/date/customer/field/applicator/acres/product count/source, but not product names, EPA registrations, rates, or multi-field detail in `src/pages/ApplicationRecords.tsx:122-137`.
- The empty state says records are created from completed jobs or approved blend tickets in `src/pages/ApplicationRecords.tsx:280-282`.

Recommended fix:

- Expand export/PDF packet to include product details, EPA numbers, applied rates, acres, weather if available, and all `application_record_fields` rows.

## Sprint 4 - Reporting Accuracy and Exports

### Controls That Look Strong

- Invoice list/reporting uses `total_amount_cents` and `balance_cents` in `src/pages/Invoices.tsx:139-142` and `src/pages/Invoices.tsx:557-565`.
- AR Aging and statements use invoice balances, which matches the stated AR source of truth.
- AP aging uses RPC data and cents formatting in `src/pages/AccountsPayable.tsx:213-224`.

### P1 - Reconciliation Exists but Is Not Operationalized

Business risk: order total drift, inventory ledger drift, and invoice balance drift can exist until a person notices.

Evidence:

- `runReconciliationChecks()` exists and is documented for use in `src/lib/reconciliation.ts:1-16`.
- It performs order, inventory, invoice payment, and balance checks in `src/lib/reconciliation.ts:614-710`.
- Search found no call site besides its own definition in `src/lib/reconciliation.ts:8` and `src/lib/reconciliation.ts:614`.
- The payment check still reads the legacy `payments` table in `src/lib/reconciliation.ts:692-703`, while newer payment history reads `invoice_line_allocations`.

Recommended fix:

- Add an admin-only Integrity Report page or scheduled job that runs reconciliation.
- Update the payment-source check to use current allocation tables.
- Store each run result and notify admins/Sentry on discrepancies.

### P1 - Sales and Customer History Reports Still Use Order Dollar Totals

Business risk: sales/profit reports can differ from posted invoice reality, especially after partial deliveries, voids, returns, credit memos, field-app split invoices, or manual invoice edits.

Evidence:

- Reports page groups revenue from `orders.total_price` and `order_items.total_price` in `src/pages/Reports.tsx:159-233`.
- SalesReports totals reduce `total_price` from detail rows in `src/pages/SalesReports.tsx:175-190`.
- Customer purchase history sums `order_items.total_price` in `src/pages/CustomerDetail.tsx:300-317`.
- Order list exports `total_price` in `src/pages/Orders.tsx:201-210`.

Recommended fix:

- Define each report as either “ordered value” or “posted invoice revenue.”
- Customer-facing financial reports should source from posted invoice lines and balances.
- Keep order-value reports clearly labeled as operational/order pipeline reports, not AR/sales-book reports.

### P2 - Frontend Exports Can Export Filtered/Selected UI State Without Requerying Source-of-Truth

Business risk: CSV/PDF exports can look official while only representing currently selected or loaded rows, usually limited to 500 rows in some pages.

Evidence:

- Price list query limits to 500 rows in `src/pages/Reports.tsx:311-317`.
- Application records query limits to 500 rows in `src/pages/ApplicationRecords.tsx:66-76`.
- Many list exports export `selectedRows` or current UI data rather than a fresh report RPC.

Recommended fix:

- For official financial/compliance exports, add report RPCs with explicit filters and row counts.
- Keep UI-selected exports for convenience, but label them as selected-row exports where appropriate.

## Sprint 5 - Backup, Recovery, Incidents, and Production Operations

### Controls That Look Strong

- Vercel security headers and CI were covered in the production operations audit.
- Sentry client setup and request correlation exist.
- `seed-admin` is production-blocked and secret-gated.

### P1 - No Full Production Runbook Exists in the Repo

Business risk: if a migration breaks production, a bad invoice batch posts, or inventory data is corrupted, the recovery steps are not written down for a non-developer owner to follow.

Evidence:

- Repo search found only `docs/audits/2026-04-30-production-operations-audit-findings.md` for backup/restore/runbook topics.
- That audit also found no backup/restore or incident runbook in `docs/audits/2026-04-30-production-operations-audit-findings.md:141-155`.

Recommended fix:

- Add `docs/operations/production-runbook.md`.
- Include backup policy, restore drill cadence, emergency contacts, Supabase/Vercel/Sentry log locations, deploy rollback, migration rollback strategy, month-end close steps, and “who approves what.”

### P1 - Live Production Controls Need Manual Verification

Business risk: repo config can look safe while production settings differ.

Items to verify with live access:

- Supabase Point-in-Time Recovery/backups enabled for project `rhyzpcqhnizqbxphqdkr`.
- A restore drill has been run into a non-production Supabase project.
- Supabase Security Advisor and Performance Advisor are clean or ticketed.
- Vercel production environment variables match expected keys only.
- Sentry is receiving production client errors and Edge Function errors.
- pg_cron jobs exist in production, not just migrations.

## Sprint 6 - UX, Roles, and Workflow Access

### Controls That Look Strong

- `ProtectedRoute` blocks unauthenticated, inactive, disallowed-role, and per-user denied-page access in `src/components/auth/ProtectedRoute.tsx:24-46`.
- Finance/AP/month-end/settings routes are admin-only in `src/App.tsx:219-230`.
- Sidebar role visibility matches major route groups in `src/components/layout/Sidebar.tsx:100-180`.
- Search found no direct `window.confirm()` or `window.alert()` usage in main React components; existing confirm flows use modal callbacks.

### P1 - Sales Reps Can Access Purchase Orders and Receiving

Business risk: sales reps may need visibility, but PO submission/receiving changes inventory and AP-adjacent records. If that access is intentional, the database and UI should make the permission model explicit.

Evidence:

- Purchase orders, receiving log, and Quick Receive routes allow `admin` and `sales_rep` in `src/App.tsx:187-191`.
- `receive_po_items()` allows `admin` and `sales_rep` in `supabase/migrations/20260430250000_field_app_workflow_phase13.sql:263-266`.
- AP vendor bills are admin-only in `src/App.tsx:226-229`.

Recommended fix:

- Decide whether sales reps should receive inventory or only view PO/receiving records.
- If sales reps can receive, add explicit audit notes and exception handling for over-receive/damaged/wrong product.
- If not, narrow receiving mutation RPCs to admin and leave read-only receiving views for sales.

### P2 - Denied Pages Are Route/Nav Based, Not Business-Action Based

Business risk: per-user denied pages can hide navigation, but high-impact actions still need database authorization at the RPC level.

Evidence:

- `ProtectedRoute` checks a page deny-list from `profile.denied_pages` in `src/components/auth/ProtectedRoute.tsx:42-46`.
- Sidebar also filters using denied pages in `src/components/layout/Sidebar.tsx:213-225`.

Recommended fix:

- Keep denied pages for UX, but do not rely on them for business permission.
- For every high-impact RPC, verify `auth.uid()` and role/ownership in the function body.

## Sprint 7 - Docs, Training, and Stale Claims

### P1 - Counts and Workflow Docs Are Drifting

Business risk: Claude or future agents may follow stale docs and reintroduce old assumptions.

Evidence:

- `CLAUDE.md` says 128 unit test files and 93 E2E files in `CLAUDE.md:12`.
- `AGENTS.md` still says 246 migrations, 119 unit test files, and 92 E2E specs in `AGENTS.md:12`.
- Current repo count during this audit: 261 migration files, 128 unit test files, 93 E2E spec files.
- `docs/reference/migration-history.md` currently says 246 migrations in its title, while it contains newer entries up to 259 at `docs/reference/migration-history.md:1` and `docs/reference/migration-history.md:265`.

Recommended fix:

- Recompute counts and update `AGENTS.md`, `docs/reference/migration-history.md`, and any workflow docs after deciding which untracked migration files are real.
- Add a short “counts can drift, recompute before citing” note where agents are most likely to look.

### P2 - Training Content Must Match Final Delivery-to-Invoice Policy

Business risk: if docs say invoices are auto-created but production behavior changes, users may stop checking the billing queue.

Evidence:

- Older audit docs flagged the delivery auto-invoice mismatch.
- Current tracked migration `supabase/migrations/20260501100000_field_app_workflow_phase15.sql:15-30` appears to restore auto-invoice behavior in code, and migration history documents that at `docs/reference/migration-history.md:265`.
- This still needs live deployment verification before training content can be treated as true production behavior.

Recommended fix:

- After deployment verification, update training docs to say exactly what happens:
  - delivery completion creates a draft invoice when no active invoice exists, or
  - delivery completion sends the order to a billing queue.

## Suggested Fix Order

1. Run Sprint 0 live data checks and save results.
2. Decide the sales-rep receiving policy and over-receive policy.
3. Fix PO submit and receiving exception handling.
4. Fix return credit source pricing.
5. Add RUP master-data completeness guard after cleanup.
6. Wire reconciliation as an admin-visible/scheduled control.
7. Convert official reports to source-of-truth RPCs or clearly label order-value reports.
8. Create production runbook and restore-drill checklist.
9. Update stale docs/counts after deciding what untracked migrations are accepted.

## Claude Handoff Prompt

Use this prompt with Claude before implementing:

```text
You are reviewing CRX Manager. Do not change code yet.

Read:
- CLAUDE.md
- AGENTS.md
- docs/audits/2026-05-01-additional-audit-sprints-claude-review.md
- docs/audits/2026-04-30-production-operations-audit-findings.md
- docs/audits/2026-04-30-money-inventory-audit-findings.md
- docs/audits/2026-04-30-data-integrity-workflow-locks-audit-findings.md

Task:
1. Validate each sprint finding against current repo code and latest migrations.
2. Pay special attention to untracked files before assuming they are part of production.
3. Run or provide the Sprint 0 SQL checks against Supabase if you have live access.
4. Return a fix plan only. Do not implement until Mason approves a sprint.

Prioritize business risk:
- money/AR/AP errors
- inventory quantity errors
- compliance record gaps
- workflows that allow state changes without database locks
- stale docs that could mislead future agents

When proposing fixes, use new migrations only, keep unrelated changes untouched, use RPCs for money/inventory workflow changes, and include exact tests to add.
```
