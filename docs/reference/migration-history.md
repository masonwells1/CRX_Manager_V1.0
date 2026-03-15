# Migration History (170 migrations)

Migrations are in `supabase/migrations/` ordered by timestamp prefix.

| # | Timestamp | Description |
|---|-----------|-------------|
| 1 | 20260206172436 | Full schema creation (all tables, indexes, RLS) |
| 2 | 20260206174345 | Security & performance fixes (consolidated RLS, auth.uid() optimization) |
| 3 | 20260206174743 | Profile auto-creation trigger |
| 4 | 20260206191309 | Automatic price calculation |
| 5 | 20260206191700 | Gross margin display fields |
| 6 | 20260206192224 | Fix margin terminology |
| 7 | 20260206195903 | EPA registration field |
| 8 | 20260206201328 | Team board collaboration features |
| 9 | 20260206203908 | Blend tickets system |
| 10 | 20260207000001 | Fix customer RLS for sales_rep |
| 11 | 20260207_gap_analysis_fixes | Payments table, reorder_point, commission paid fields |
| 12 | 20260207_gap_analysis_fixes_2 | Additional gap fixes |
| 13 | 20260208194203 | Soft delete for team notes |
| 14 | 20260209040254 | Fix soft delete activity logging |
| 15 | 20260209040325 | Fix payment RLS policies |
| 16 | 20260209143537 | Inventory overhaul (holds, is_planned) |
| 17 | 20260210_fix_rls_critical_issues | Sales rep INSERT permissions |
| 18 | 20260211190000 | Billing & invoicing system |
| 19 | 20260212000000 | Fields & geospatial |
| 20 | 20260212100000 | Blend recipes system |
| 21 | 20260213000000 | Inventory enhancements (warehouses, cycle counts) |
| 22 | 20260213100000 | Returns/RMA system |
| 23 | 20260213200000 | Reporting, compliance & rebates |
| 24 | 20260214000000 | Phase 4B Mapbox integration (geo RPCs, PostGIS) |
| 25 | 20260214200000 | Vehicles table |
| 26 | 20260214210000 | Applicator role expansion |
| 27 | 20260214220000 | Application records table + RPCs |
| 28 | 20260215200000 | Job scheduling tables |
| 29 | 20260216200000 | Reporting RPCs (10 report functions) |
| 30 | 20260217200000 | Accounting periods (month-end close) |
| 31 | 20260217210000 | Commission payments |
| 32 | 20260218200000 | Financial workflows (write-offs, finance charges, prepayments) |
| 33 | 20260219200000 | Invoice/statement enrichment |
| 34 | 20260219210000 | Invoice/statement RPCs |
| 35 | 20260220200000 | Finance charge intelligence |
| 36 | 20260221200000 | Grower share pricing |
| 37 | 20260222200000 | Batch operations |
| 38 | 20260223200000 | Payment allocation |
| 39 | 20260224200000 | Year-end summary |
| 40 | 20260225200000 | Delivery system enhancements |
| 41 | 20260226200000 | Receiving system enhancements |
| 42 | 20260227200000 | Delivery integrity & quick delivery |
| 43+ | Various | Safety audit, page permissions, business logic, dashboard alerts, Quick Receive |
| 44 | 20260312200000 | Business logic audit fixes: inventory hold auto-release trigger (declined/expired/accepted), `post_invoice()` period enforcement via `check_period_open()`, `save_customer()` commission split validation (must sum to 100%), `create_quick_delivery()` inventory pre-check with `FOR UPDATE` locks, `convert_quote_to_order()` explicit hold release |
| 45 | 20260315200000 | Emergency RPC fixes: 9 broken functions with wrong column references (allocate_payment, cancel_delivery, auto_expire_quotes, cancel_order, check_customer_credit_limit, create_quick_delivery schema fixes) |
| 46 | 20260315200001 | Accounting integrity & hardening: expand audit log CHECK constraints, period enforcement in 10 financial RPCs, FOR UPDATE locks, void_invoice 4-bug fix, commission season convention, cycle count guards, return processing dedup |
| 47 | 20260228200000 | Season calendar Oct-Sep convention |
| 48 | 20260228210000 | Failed notifications table (failed_at, retry_count) |
| 49 | 20260228220000 | Server-authoritative quote math (`calculate_quote_totals()` RPC with NUMERIC(15,4)) |
| 50 | 20260228230000 | Signature privacy — `create_signed_url()` RPC for time-limited delivery photo access |
| 51 | 20260301000000 | Audit Phase 0 fixes: finance charge compounding exclusion, billing split `FOR UPDATE` locks |
| 52 | 20260301100000 | Tote tracking: `tote_number` and `is_non_returnable` columns on `delivery_items` |
| 53 | 20260301100001 | Complete delivery tote copy: threads `tote_number` through `complete_delivery` and `create_quick_delivery` RPCs |
| 54 | 20260301200000 | Prepay bucket system: `bucket_label` column on `prepay_credits`, 8 seeded bucket categories in `app_settings`, reference index |
| 55 | 20260301200001 | Prepay application RPCs: `apply_prepay_to_invoice()` atomic allocation + `batch_apply_prepayments()` batch wrapper |
| 56 | 20260301300000 | New RPC `financial_dashboard_summary()` for Financial Dashboard — returns all financial KPIs (AR aging, revenue, payments, prepay balances, finance charges) |
| 57 | 20260301300001 | Slim `dashboard_summary()` to operational-only — removes financial KPIs (now served by `financial_dashboard_summary()`) |
| 58 | 20260316200000 | Additional audit gap fixes: idempotency on `apply_write_off` + `batch_apply_prepayments`, admin role check on `generate_finance_charges` |
| 59 | 20260302100000 | Quote items: add `calc_mode` (rate_acres/units_direct) and `price_unit` columns for bidirectional calc + price unit override |
| 60 | 20260302110000 | Orders: add `order_name` column, recreate `create_direct_order()` with auto-generated order numbers and order name support |
| 61 | 20260302120000 | Save quote bidirectional calc: `save_quote()` branches on `calc_mode`, persists `calc_mode` + `price_unit` on items |
| 62 | 20260323100000 | New RPC `operational_dashboard_summary()` — comprehensive 25-CTE function powering the rebuilt Operational Dashboard (KPIs, team board, inventory, deliveries, alerts, monthly chart, season progress, activity feed) |
| 63 | 20260304210000 | Add MG/g inventory units + Jar container type |
| 64 | 20260319000000 | Fix trigger functions search_path for security |
| 65 | 20260321100000 | Dashboard inventory position cards |
| 66 | 20260321200000 | Prepay edit/delete RPCs |
| 67 | 20260321300000 | Void payment RPC |
| 68 | 20260322100000 | Inventory warn-not-block with net position (available - prebooked + on_order) |
| 69 | 20260307100000 | **Accounts Payable + RUP Sales Reporting** — 4 new tables (`vendors`, `vendor_bills`, `vendor_payments`, `rup_sales_records`), 7 RPCs (`create_vendor_bill`, `record_vendor_payment`, `void_vendor_bill`, `get_ap_aging`, `get_ap_dashboard_summary`, `generate_rup_sales_records`, `get_rup_sales_register`), RLS policies, vendor backfill from existing PO/product data, `post_invoice()` enhanced to auto-generate RUP records |
| 70 | 20260307200000 | **Sales & Chemical History Reporting** — 3 new RPCs (`get_sales_detail_report` with LATERAL JOIN to invoices, `get_sales_summary_report` with CTE-based GROUP BY dimension, `get_customer_farm_group` recursive CTE for parent/child farm grouping). Powers new `/sales-reports` page |
| 71 | 20260308100000 | **Email Infrastructure** — `email_type` enum (8 types), `email_log` table (audit trail with idempotency_key, resend_message_id, status tracking), `ar_reminder_tracking` table (dedup: max one reminder per customer per level per day), `get_ar_reminder_candidates()` RPC (customers with 30+ day overdue invoices). RLS: admin SELECT/INSERT on both tables |
| 72 | 20260308200000 | **Dashboard Margin Alerts** — extends `financial_dashboard_summary()` with 3 new CTEs: bottom 10 products by margin % this season, bottom 10 customers by margin % this season, monthly margin % trend (last 12 months). Uses `compute_season()` for current season filter. Total function now has 16 CTEs |
| 73 | 20260313004449 | **PO Receive: stop auto-updating product cost** — flips `p_skip_cost_update` default from `false` to `true` in `receive_po_items()`. Product master cost (pricing basis) is now admin-controlled only. Supplier cost still tracked on `purchase_order_items.unit_cost` and `receiving_records.unit_cost` |
| 74–109 | 20260315–20260329 | *Multiple audit + hardening migrations* — RPC fixes, state machine enforcement, inventory holds, return credit AR integration, security audit auth.uid enforcement, workflow fixes, operational dashboard, search_path security, overload fixes, financial compliance, deep audit, wave4 bug fixes (4 migrations), inventory on-order tracking. Run `/update-docs` for full reconciliation. |
| 110 | 20260330000000 | **Pre-Launch Critical Fixes** — 7 bug fixes: (1) `complete_delivery` inventory inflation (prebooked deliveries now deduct physical stock), (2) `receive_po_items` auth check restored + `p_skip_cost_update` default re-fixed to true, (3) `void_invoice` fixed wrong column name + deleted-row query + added admin auth + period check, (4) `create_direct_order` now creates commission records, (5) `calculate_prices_from_margin` SET search_path added, (6) `receive_return` LATERAL subquery location filter added, (7) `create_commission_payment` season calc fixed (>=10 not >=7) |
| 111 | 20260330100000 | **Pre-Launch State Machine & Security** — 21 fixes: (A) 4 state machine guards: `convert_quote_to_order` rejects non-sent/accepted quotes, `post_invoice` rejects cancelled-order invoices, `save_purchase_order` enforces forward-only status transitions, `_require_auth()` helper. (B) 11 `SET search_path` fixes via ALTER FUNCTION for trigger/billing/blend functions. (C) 6 financial RPC role guards: `get_ar_aging`, `get_sales_detail_report`, `get_sales_summary_report`, `get_commission_balance_report`, `get_inventory_cost_report`, `get_customer_statement` — all now require admin or sales_rep role |
| 112 | 20260330200000 | **Pre-Launch Final Fixes** — (1) `record_invoice_payment` now sets `status='paid'` when fully paid (matches `allocate_payment` behavior; stale H3 comment removed), also accepts `overdue` invoices for payment. (2) `_check_credit_limit()` helper function created — checks draft+posted+overdue invoices for AR balance (existing `create_quick_delivery` inline check only checked posted) |
| 113–162 | 20260331*–various | *Multiple audit, hardening, and drift-fix migrations* — void delivery/commission payment, inventory on-order tracking, product data fixes, receive_po tier fallback, overload cleanup |
| 163 | 20260331600000 | **Consolidate All RPC Overloads** — Comprehensive fix for the systemic overload bug. Part 1: Explicit recreation of 4 missing functions (create_vendor_bill, record_vendor_payment, void_vendor_bill, receive_return). Part 2: Dynamic consolidation of 33 functions (find best overload, drop all, inject idempotency, recreate unified). Part 3: Verification that all 42 RPCs have exactly 1 overload |
| 164 | 20260331700000 | **Fix inventory_transactions transaction_type CHECK** — Restores 'prebooked' and 'released' values that were accidentally removed by 20260331110000 (void delivery). These values are used by update_order_items(), cancel_order(), create_quick_delivery() |
| 165 | 20260331800000 | **Restore commissions status CHECK** — Re-adds CHECK constraint with 'pending', 'paid', 'cancelled'. Was dropped in 20260302200000 to add 'cancelled' but never recreated |
| 166 | 20260315004110 | **Fix idempotency_key column refs in save_quote** — Corrects `save_quote` RPC to use `idempotency_key` column (not `key`) and `(idempotency_key, operation)` INSERT (not `key, entity_type, entity_id`). Fixes "column 'key' does not exist" error when idempotency keys are provided. 9 other admin RPCs with same bug deferred to future migration |
