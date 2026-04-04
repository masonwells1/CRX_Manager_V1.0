# Migration History (234 migrations)

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
| 12 | 20260207090000 | Additional gap fixes (gap_analysis_fixes_2) |
| 13 | 20260208194203 | Soft delete for team notes |
| 14 | 20260209040254 | Fix soft delete activity logging |
| 15 | 20260209040325 | Fix payment RLS policies |
| 16 | 20260209143537 | Inventory overhaul (holds, is_planned) |
| 17 | 20260209200000 | Tier 1 audit fixes — 6 atomic RPCs, CHECK constraints on numeric columns, order total verification trigger, is_active enforcement in RLS helpers |
| 18 | 20260210000000 | Tier 3 hardening — idempotency keys table + activity feed triggers on critical tables |
| 19 | 20260210_fix_rls_critical_issues | Sales rep INSERT permissions |
| 20 | 20260211000000 | Unit tracking & pricing overhaul — product_form, inventory_unit, container_unit/type, fl oz fix, cross-table validation trigger, best-effort backfill |
| 21 | 20260211100000 | Atomic inventory RPCs — `adjust_inventory()` and `create_direct_order()` replace client-side read-then-write patterns |
| 22 | 20260211110000 | Fix column mismatches — RPCs referencing non-existent columns (updated_at on order_items, notes/sort_order on order_items) |
| 23 | 20260211120000 | Blend ticket fields — job_number, invoice_number, ticket_time, vehicle_info, mixer_name, field_names, total_acres, application_rate, rate_per_acre on blend_ticket_products |
| 24 | 20260211130000 | Admin update profile RPC — admin-only function to update any user's role, name, phone, active status |
| 25 | 20260211200000 | Sprint 0 emergency fixes — inventory availability check, UNIQUE(product_id, location) on inventory, over-delivery detection in complete_delivery |
| 26 | 20260211210000 | Atomic quote save RPC — `save_quote()` replaces dangerous delete-all-then-reinsert pattern |
| 27 | 20260211220000 | Sprint 1 data integrity — atomic PO save/delete RPCs, tighten RLS + SET search_path, fix admin_update_profile is_active check |
| 28 | 20260211230000 | Atomic customer/blend/quote duplication — `save_customer()`, `save_blend_ticket()`, `duplicate_quote()` RPCs |
| 29 | 20260211240000 | Normalize net_margin to percentage — converts fraction-based values (0.20) to percentage (20.0) across quote_items |
| 30 | 20260211250000 | Sprint 2 validation fixes — restrict driver UPDATE on deliveries (drivers use complete_delivery RPC only) |
| 31 | 20260211260000 | Number generation sequences — `next_delivery_number()`, `next_po_number()` with advisory locks (replaces client-side count+1) |
| 32 | 20260211270000 | Dashboard summary RPC — consolidates 8+ separate dashboard queries into single `dashboard_summary()` function |
| 33 | 20260211280000 | Commission recipient FK — adds `recipient_user_id` UUID FK to commissions (replaces text name matching), backfill from profiles |
| 34 | 20260211290000 | Partial delivery support — `p_quantities` JSONB parameter on `complete_delivery`, `quantity_delivered` column on delivery_items |
| 35 | 20260213000000 | Phase 1: Fields foundation — PostGIS extension, fields + field_billing_defaults tables, parent_customer_id, season/salesman_id/deleted_at columns |
| 36 | 20260213100000 | Phase 2: Billing architecture — invoice system, allocation sets, billing splits, prepay credits, financial audit log, core RPCs |
| 37 | 20260213120000 | Phase 3: Blend ticket-order linkage — connects blend tickets to orders/invoices for billing workflows |
| 38 | 20260213140000 | Phase 4A: Blend recipes — saved blend recipe/program tables for one-click application during blend ticket creation |
| 39 | 20260213160000 | Phase 5: Inventory enhancements — warehouses table, cycle counting, improved receiving workflow |
| 40 | 20260213180000 | Phase 6: Returns/RMA system — returns + return_items tables, status lifecycle, credit generation |
| 41 | 20260213200000 | Phase 7: Reporting, compliance & rebates |
| 42 | 20260214000000 | Phase 4B: Mapbox integration (geo RPCs, PostGIS) |
| 43 | 20260214200000 | Vehicles table |
| 44 | 20260214210000 | Applicator role expansion |
| 45 | 20260214220000 | Application records table + RPCs |
| 46 | 20260215200000 | Job scheduling tables |
| 47 | 20260216200000 | Reporting RPCs (10 report functions) |
| 48 | 20260217200000 | Accounting periods (month-end close) |
| 49 | 20260217210000 | Commission payments |
| 50 | 20260218200000 | Financial workflows (write-offs, finance charges, prepayments) |
| 51 | 20260219200000 | Invoice/statement enrichment |
| 52 | 20260219210000 | Invoice/statement RPCs |
| 53 | 20260220200000 | Finance charge intelligence |
| 54 | 20260221200000 | Grower share pricing |
| 55 | 20260221200000 | Rate limiting — rate_limit_log table + index for critical RPC abuse prevention |
| 56 | 20260222200000 | Batch operations |
| 57 | 20260222200000 | Fix allocate_payment double-count — trigger + manual UPDATE both incrementing orders.total_paid; remove manual UPDATE, repair corrupted balances |
| 58 | 20260223200000 | Payment allocation |
| 59 | 20260223200000 | Pre-launch bug fixes — batch_void_invoices delegation, next_cycle_count_number() generator, receive_return silent restock fix |
| 60 | 20260223210000 | Add commissions denormalized columns — order_number + customer_name on commissions table, backfill from orders/customers |
| 61 | 20260223220000 | Fix cycle_counts FK to profiles — change FK from auth.users to public.profiles for PostgREST embedding |
| 62 | 20260224200000 | Year-end summary |
| 63 | 20260225200000 | Delivery system enhancements |
| 64 | 20260226200000 | Receiving system enhancements |
| 65 | 20260227200000 | Delivery integrity & quick delivery |
| 66 | 20260228200000 | Safety audit hardening — 21 vulnerabilities: dangerous RLS UPDATE policies, server-side recalculation in save_invoice/save_quote, price floor in create_quick_delivery, FOR UPDATE lock in post_invoice |
| 67 | 20260228200000 | Season calendar Oct-Sep convention |
| 68 | 20260228210000 | Failed notifications table (failed_at, retry_count) |
| 69 | 20260228220000 | Server-authoritative quote math (`calculate_quote_totals()` RPC with NUMERIC(15,4)) |
| 70 | 20260228230000 | Signature privacy — `create_signed_url()` RPC for time-limited delivery photo access |
| 71 | 20260228300000 | Critical prelaunch fixes — prepay batch wrong overload, tote regression, status transition enforcement |
| 72 | 20260228310000 | High priority fixes — period check in allocate_payment, audit log for allocate_payment, FOR UPDATE in receive_po_items, BEFORE DELETE guards, non-negative money CHECKs, idempotency in complete_delivery |
| 73 | 20260228320000 | Medium priority fixes — transaction review deprecated payments table, adjust_inventory negative qty guard, convert_quote_to_order FOR UPDATE, idempotency_keys RLS |
| 74 | 20260301000000 | Audit Phase 0 fixes: finance charge compounding exclusion, billing split `FOR UPDATE` locks |
| 75 | 20260301100000 | Tote tracking: `tote_number` and `is_non_returnable` columns on `delivery_items` |
| 76 | 20260301100001 | Complete delivery tote copy: threads `tote_number` through `complete_delivery` and `create_quick_delivery` RPCs |
| 77 | 20260301200000 | Prepay bucket system: `bucket_label` column on `prepay_credits`, 8 seeded bucket categories in `app_settings`, reference index |
| 78 | 20260301200000 | User page permissions — `denied_pages` text[] column on profiles, updated `admin_update_profile()` with denied_pages support + applicator role fix |
| 79 | 20260301200001 | Prepay application RPCs: `apply_prepay_to_invoice()` atomic allocation + `batch_apply_prepayments()` batch wrapper |
| 80 | 20260301300000 | New RPC `financial_dashboard_summary()` for Financial Dashboard — returns all financial KPIs (AR aging, revenue, payments, prepay balances, finance charges) |
| 81 | 20260301300001 | Slim `dashboard_summary()` to operational-only — removes financial KPIs (now served by `financial_dashboard_summary()`) |
| 82 | 20260302100000 | Quote items: add `calc_mode` (rate_acres/units_direct) and `price_unit` columns for bidirectional calc + price unit override |
| 83 | 20260302110000 | Orders: add `order_name` column, recreate `create_direct_order()` with auto-generated order numbers and order name support |
| 84 | 20260302120000 | Save quote bidirectional calc: `save_quote()` branches on `calc_mode`, persists `calc_mode` + `price_unit` on items |
| 85 | 20260302200000 | Business logic enhancements — draft invoice enforcement trigger, quick delivery commissions, order cancellation cascade, partial delivery invoice auto-adjustment, delivery remainder auto-reminders |
| 86 | 20260303200000 | Dashboard integrity alerts — 4 new alert counts (driver issues, customers over credit, expired holds, cancelled posted) + credit limit check helper RPC |
| 87 | 20260304200000 | Quick Receive — `match_quick_receive_items()` RPC + `receive_po_items` updated with `p_allow_over_receive` param |
| 88 | 20260304210000 | Add MG/g inventory units + Jar container type |
| 89 | 20260305200000 | Audit safety fixes — 16 findings: inventory transaction_type CHECK, balance_cents GENERATED column, void_invoice column/arithmetic bugs, atomic manual inventory add, blend ticket prebooking, finance charge idempotency, prepay reconciliation, receive_return audit/locks |
| 90 | 20260306200000 | Add idempotency key parameter to all mutating RPCs — `p_idempotency_key text DEFAULT NULL` injected via pg_get_functiondef() |
| 91 | 20260306200001 | Delivery & invoice inventory hardening — create_quick_delivery inventory prebooking, transfer_job_to_invoice FOR UPDATE on field_billing_defaults |
| 92 | 20260307100000 | **Accounts Payable + RUP Sales Reporting** — 4 new tables (`vendors`, `vendor_bills`, `vendor_payments`, `rup_sales_records`), 7 RPCs (`create_vendor_bill`, `record_vendor_payment`, `void_vendor_bill`, `get_ap_aging`, `get_ap_dashboard_summary`, `generate_rup_sales_records`, `get_rup_sales_register`), RLS policies, vendor backfill from existing PO/product data, `post_invoice()` enhanced to auto-generate RUP records |
| 93 | 20260307200000 | Pre-launch hardening — 13 findings: batch_cancel_deliveries inventory restoration, cancel_delivery prebooked release, idempotency enforcement in 7 RPCs, blend ticket prebooking double-deduct |
| 94 | 20260307200000 | **Sales & Chemical History Reporting** — 3 new RPCs (`get_sales_detail_report` with LATERAL JOIN to invoices, `get_sales_summary_report` with CTE-based GROUP BY dimension, `get_customer_farm_group` recursive CTE for parent/child farm grouping). Powers new `/sales-reports` page |
| 95 | 20260308100000 | **Email Infrastructure** — `email_type` enum (8 types), `email_log` table (audit trail with idempotency_key, resend_message_id, status tracking), `ar_reminder_tracking` table (dedup: max one reminder per customer per level per day), `get_ar_reminder_candidates()` RPC (customers with 30+ day overdue invoices). RLS: admin SELECT/INSERT on both tables |
| 96 | 20260308200000 | **Dashboard Margin Alerts** — extends `financial_dashboard_summary()` with 3 new CTEs: bottom 10 products by margin % this season, bottom 10 customers by margin % this season, monthly margin % trend (last 12 months). Uses `compute_season()` for current season filter. Total function now has 16 CTEs |
| 97 | 20260308200000 | Production fixes V2 — receive_po_items idempotency column fix, next_return_number() generator, storage buckets + RLS policies, check_duplicate_delivery() advisory helper |
| 98 | 20260309100000 | Order PO number & shares — `customer_po_number` column on orders + `order_shares` table for bill splitting between customers |
| 99 | 20260309200000 | Document OCR — `document-uploads` storage bucket + processing log table for OCR infrastructure |
| 100 | 20260309210000 | Fix complete_delivery prebooked inventory — pre-check now considers available + prebooked, deducts prebooked first; allow sales_rep role to complete deliveries |
| 101 | 20260310200000 | Go-live remediation — save_customer() missing fields (parent_customer_id, credit_limit_cents, finance_charge_rate, etc.), take_delivery role fix |
| 102 | 20260310210000 | Browser smoke test fixes — complete_delivery auto-updates delivery_remainders status, receive_po_items now()::text cast fix |
| 103 | 20260311000000 | Audit cancel state machine fixes — drop orphan cancel_order overload, unify cancel_order, fix cancel_delivery trigger bypass for completed deliveries + auth.uid() enforcement, GRANT EXECUTE for void_invoice |
| 104 | 20260311000001 | Audit financial fixes — allocate_payment season calc (month >= 10 not >= 7), allocate_payment period check, save_customer commission split validation restore, additional financial bug fixes |
| 105 | 20260311000002 | Audit inventory fixes — create_quick_delivery missing prebooking, convert_quote_to_order overload consolidation, complete_delivery duplicate invoice prevention, receive_return/complete_cycle_count FOR UPDATE locks, create_quick_delivery idempotency |
| 106 | 20260311000003 | Audit RLS fixes — financial_audit_log INSERT restriction, team_note_comments UPDATE/DELETE policies, ar_reminder_tracking INSERT policy, ocr_processing_queue cleanup, team_note_tags restriction to owner/admin |
| 107 | 20260311100000 | Fix reassign_delivery — allow admin and sales_rep users as delivery targets (not just drivers) |
| 108 | 20260311200000 | Invoice as AR single source of truth — DROP trg_payment_update_order, rewrite trg_recalc_order_totals, rewrite dashboard_summary AR from invoices, deprecate orders.total_paid/balance_due |
| 109 | 20260311200000 | Wave 2 audit fixes — role checks on SECURITY DEFINER RPCs, return cancel transitions, quote revert/cancelled transitions, void_vendor_bill guard, idempotency guards, search_path fixes, drop 11 stale overloads |
| 110 | 20260312100000 | Wave 3 audit fixes — 5 broken RPCs missing p_idempotency_key, invoice CHECK constraint missing paid/overdue, complete_delivery stale overloads, void_invoice lost admin check + needs commission reversal, allocate_payment stale overload |
| 111 | 20260312200000 | Business logic audit fixes: inventory hold auto-release trigger (declined/expired/accepted), `post_invoice()` period enforcement via `check_period_open()`, `save_customer()` commission split validation (must sum to 100%), `create_quick_delivery()` inventory pre-check with `FOR UPDATE` locks, `convert_quote_to_order()` explicit hold release |
| 112 | 20260312200000 | Deploy reverse_receiving_record — RPC to reverse inventory when deleting receiving entries + BEFORE DELETE safety trigger on receiving_records |
| 113 | 20260312300000 | Void order RPC — admin-only `void_order()` for fulfilled orders: restores inventory, voids draft invoices, cancels/flags commissions, financial audit log |
| 114 | 20260313004449 | **PO Receive: stop auto-updating product cost** — flips `p_skip_cost_update` default from `false` to `true` in `receive_po_items()`. Product master cost (pricing basis) is now admin-controlled only. Supplier cost still tracked on `purchase_order_items.unit_cost` and `receiving_records.unit_cost` |
| 115 | 20260313200000 | Add items to existing order — extends `update_order_items` to insert NEW items; also expands transaction_type CHECK to include prebooked/released |
| 116 | 20260313200001 | Add inventory_transactions FK constraints — purchase_order_id and delivery_id foreign keys for PostgREST joins |
| 117 | 20260313200002 | Add orders is_planned — display-only boolean flag for planned/tentative vs committed orders |
| 118 | 20260314100000 | Fix create_direct_order — remove references to deprecated total_paid/balance_due columns |
| 119 | 20260314100001 | Fix generate_rup_sales_records — column refs (use p.product_name from joined products, ii.unit_size) |
| 120 | 20260314100002 | Fix void_invoice — invoice_line_allocations uses amount_cents not allocated_cents |
| 121 | 20260314100003 | Fix save_quote — activity_feed uses event_type/related_entity_type/related_entity_id (not action/entity_type/entity_id), fix search_path |
| 122 | 20260315004110 | **Fix idempotency_key column refs in save_quote** — Corrects `save_quote` RPC to use `idempotency_key` column (not `key`) and `(idempotency_key, operation)` INSERT (not `key, entity_type, entity_id`). Fixes "column 'key' does not exist" error when idempotency keys are provided. 9 other admin RPCs with same bug deferred to future migration |
| 123 | 20260315100000 | **Fix ALL idempotency column refs in 11 RPCs** — Uses pg_get_functiondef() + replace() to patch save_quote, receive_po_items, reopen_accounting_period, reverse_write_off, void_commission_payment, revert_quote_status, restore_cancelled_order, restore_cancelled_delivery, unapply_credit_memo, reverse_blend_ticket_approval, void_delivery. Fixes `key` -> `idempotency_key`, `entity_type`/`entity_id` -> `operation`/`result`, `result_id` -> `result`. Includes verification block |
| 124 | 20260315200000 | Emergency RPC fixes: 9 broken functions with wrong column references (allocate_payment, cancel_delivery, auto_expire_quotes, cancel_order, check_customer_credit_limit, create_quick_delivery schema fixes) |
| 125 | 20260315200000 | **Team Board V2: Entity Linking, Attachments, Delivery RPCs** — (1) Adds `linked_entity_type text` + `linked_entity_id uuid` to `team_notes` with partial index. (2) Creates `team_note_attachments` table with RLS (authenticated read, own insert/delete, admin delete). (3) Creates `team-note-attachments` storage bucket with upload/view/delete policies. (4) New RPC `get_team_board_deliveries()` — role-aware today/tomorrow deliveries with priority sorting. (5) New RPC `get_yesterday_delivery_recap()` — completed/issues/cancelled summary. (6) New RPC `get_notes_for_entity()` — notes linked to a specific entity |
| 126 | 20260315200001 | Accounting integrity & hardening: expand audit log CHECK constraints, period enforcement in 10 financial RPCs, FOR UPDATE locks, void_invoice 4-bug fix, commission season convention, cycle count guards, return processing dedup |
| 127 | 20260316100000 | RPC state machine enforcement — save_quote status transition validation, complete_job require in_progress, receive_po_items PO header status gate + FOR UPDATE, close_accounting_period admin role check |
| 128 | 20260316100001 | Inventory hold restoration — release_holds_on_quote_status_change restores quantity_available, cancel_order hold release fix (holds linked to quotes not orders) |
| 129 | 20260316100002 | Return credit AR integration — real `issue_return_credit()` creates credit memo invoices (negative totals), credit memo number sequence, invoice_type CHECK expanded |
| 130 | 20260316100003 | Batch year-end summaries + storage policy auth fix — `get_batch_year_end_summaries()` RPC, document-uploads storage policies use (select auth.uid()) |
| 131 | 20260316200000 | Additional audit gap fixes: idempotency on `apply_write_off` + `batch_apply_prepayments`, admin role check on `generate_finance_charges` |
| 132 | 20260316200000 | Fix allocation_sets entity_type CHECK — add 'payment' to allowed values (was blocking all payment processing) |
| 133 | 20260316200000 | Fix receive_po_items ambiguity — drop 3-param overload, keep 4-param with DEFAULT false for p_allow_over_receive |
| 134 | 20260316200001 | Fix allocate_payment missing columns — invoice_line_allocations missing bill_to_customer_id/split_percentage, allocation_sets version always 1 causing unique violation |
| 135 | 20260317200000 | Security audit auth.uid() enforcement — 9 SECURITY DEFINER RPCs get auth.uid() checks, save_invoice posted immutability guard, ROUND fix in save_invoice, orphan overload cleanup |
| 136 | 20260317200001 | PO cancel soft delete — cancel metadata columns on purchase_orders, `cancel_purchase_order()` RPC with auth.uid() enforcement |
| 137 | 20260318100000 | Fix close_accounting_period — payments.amount_cents does not exist; replace with (sum(amount) * 100)::bigint |
| 138 | 20260318200000 | Fix record_invoice_payment — invoice_line_allocations.allocated_cents does not exist; correct column is amount_cents |
| 139 | 20260318300000 | Fix close_accounting_period — deliveries.delivery_date does not exist; correct column is scheduled_date |
| 140 | 20260318400000 | Fix record_invoice_payment — switch from allocation_sets to payments table (allocation_sets NOT NULL/UNIQUE constraints preventing multi-payment) |
| 141 | 20260319000000 | Fix trigger functions search_path for security |
| 142 | 20260320100000 | Workflow quote/order/invoice fixes — convert_quote_to_order warns instead of blocks on inventory shortfalls, new `create_invoice_from_delivery()`, complete_delivery auto-creates draft invoice |
| 143 | 20260320200000 | Manual inventory add unit cost — optional `p_unit_cost` parameter for setting/overriding product unit cost on manual add |
| 144 | 20260320210000 | Manual inventory no cost override — stop manual_inventory_add from overwriting products.current_cost; unit cost recorded in transaction notes only |
| 145 | 20260321100000 | Dashboard inventory position cards |
| 146 | 20260321200000 | Prepay edit/delete RPCs |
| 147 | 20260321300000 | Void payment RPC |
| 148 | 20260322100000 | Inventory warn-not-block with net position (available - prebooked + on_order) |
| 149 | 20260323100000 | New RPC `operational_dashboard_summary()` — comprehensive 25-CTE function powering the rebuilt Operational Dashboard (KPIs, team board, inventory, deliveries, alerts, monthly chart, season progress, activity feed) |
| 150 | 20260323200000 | Fix search_path security — SET search_path on 7 functions flagged by Supabase security advisor (_is_admin_override, compute_season, current_season, get_ar_aging, get_season_comparison, season_end_date, season_start_date) |
| 151 | 20260324100000 | Fix RPC overload mismatches — drop stale overloads created by dynamic p_idempotency_key injection, add missing increment_customer_prepay function |
| 152 | 20260325100000 | Sprint 1 fix critical overloads — complete_job, convert_quote_to_order, create_quick_delivery, cancel_order: drop all overloads + recreate with correct logic |
| 153 | 20260325200000 | Sprint 1 financial compliance — get_ap_aging/get_ap_dashboard_summary column name fixes, void_invoice zero paid_amount_cents, generate_rup_sales_records column fix, post_invoice auto-RUP, save_purchase_order status guard |
| 154 | 20260326100000 | Deep audit fixes — purchase_order_items missing product_name column + backfill, invalid status transition fix, stale overload drop |
| 155 | 20260327100000 | Wave 4 bug fixes — void_payment GENERATED ALWAYS column fix, RETURNING value bug, admin role checks on void_payment/edit_prepay_credit/delete_prepay_credit/batch_void_invoices, period check fixes |
| 156 | 20260327200000 | Wave 4 security & integrity — create_commission_payment/create_prepay_credit admin role checks, customers.prepay_balance_cents non-negative CHECK, order_items.quantity non-negative CHECK, create_prepay_check_splits atomic batch |
| 157 | 20260327210000 | Wave 4 critical fixes A — void_payment corrected: GENERATED ALWAYS column, RETURNING captures post-UPDATE value, add role check |
| 158 | 20260327220000 | Wave 4 medium fixes — receive_po_items weighted average cost, update_order_items delete removed items, next_invoice_number advisory lock |
| 159 | 20260328000000 | Wave 4 remaining fixes — complete_delivery pre-check (Net Free), create_application_record inventory deduction, record_invoice_payment CHECK status, receive_po_items over-receive validation, create_quick_delivery credit limit check |
| 160 | 20260329100000 | Fix inventory on-order & receive — receive_po_items restore quantity_on_order decrement, PO submission increments quantity_on_order |
| 161 | 20260330000000 | **Pre-Launch Critical Fixes** — 7 bug fixes: (1) `complete_delivery` inventory inflation (prebooked deliveries now deduct physical stock), (2) `receive_po_items` auth check restored + `p_skip_cost_update` default re-fixed to true, (3) `void_invoice` fixed wrong column name + deleted-row query + added admin auth + period check, (4) `create_direct_order` now creates commission records, (5) `calculate_prices_from_margin` SET search_path added, (6) `receive_return` LATERAL subquery location filter added, (7) `create_commission_payment` season calc fixed (>=10 not >=7) |
| 162 | 20260330100000 | **Pre-Launch State Machine & Security** — 21 fixes: (A) 4 state machine guards: `convert_quote_to_order` rejects non-sent/accepted quotes, `post_invoice` rejects cancelled-order invoices, `save_purchase_order` enforces forward-only status transitions, `_require_auth()` helper. (B) 11 `SET search_path` fixes via ALTER FUNCTION for trigger/billing/blend functions. (C) 6 financial RPC role guards: `get_ar_aging`, `get_sales_detail_report`, `get_sales_summary_report`, `get_commission_balance_report`, `get_inventory_cost_report`, `get_customer_statement` — all now require admin or sales_rep role |
| 163 | 20260330200000 | **Pre-Launch Final Fixes** — (1) `record_invoice_payment` now sets `status='paid'` when fully paid (matches `allocate_payment` behavior; stale H3 comment removed), also accepts `overdue` invoices for payment. (2) `_check_credit_limit()` helper function created — checks draft+posted+overdue invoices for AR balance (existing `create_quick_delivery` inline check only checked posted) |
| 164 | 20260331100000 | Admin corrections Phase 1 — `reopen_accounting_period()` allows admin to reopen closed period, `reverse_write_off()` marks write-off reversed and restores AR |
| 165 | 20260331110000 | Void delivery — `void_delivery()` reverses completed delivery: restores inventory, order_items, removes delivery_remainders. Expands deliveries status CHECK to include 'voided' |
| 166 | 20260331120000 | Void commission payment — `void_commission_payment()` reverses posted commission payment, resets commissions to 'pending'. Expands commission_payments status CHECK to include 'voided' |
| 167 | 20260331130000 | Admin corrections Phase 3 — `revert_quote_status()`, `restore_cancelled_order()`, `restore_cancelled_delivery()`, `unapply_credit_memo()`, `reverse_blend_ticket_approval()`. Also expands financial_audit_log operation_type CHECK |
| 168 | 20260331200000 | Fix complete_delivery pre-check — uses quantity_available (physical stock) instead of net_free; prebooked is a reservation tracker, not a physical constraint |
| 169 | 20260331200001 | Fix PO edit partially received — save_purchase_order UPDATE items in-place instead of delete/re-insert (FK violation when receiving_records exist) |
| 170 | 20260331200002 | Fix order edit product swap inventory — update_order_items handles product_id changes: release old prebooked qty, add new prebooked qty, update product_name/cost/unit_size |
| 171 | 20260331300000 | Fix product data for quote calculations — backfill inventory_unit from unit_size, set product_form, normalize rate_unit 'oz' -> 'fl oz', add 'oz' to unit_conversions (prevents 128x price inflation bug) |
| 172 | 20260331400000 | Consolidate receive_po_items overloads + fix tier price fallback in save_quote — drop unused 5-param overload, add security audit fix to 4-param version, COALESCE tier fallback |
| 173 | 20260331500000 | Drop unused overloads — convert_quote_to_order + record_invoice_payment: drop stale versions without p_idempotency_key, apply bug fixes from unused versions into active ones |
| 174 | 20260331600000 | **Consolidate All RPC Overloads** — Comprehensive fix for the systemic overload bug. Part 1: Explicit recreation of 4 missing functions (create_vendor_bill, record_vendor_payment, void_vendor_bill, receive_return). Part 2: Dynamic consolidation of 33 functions (find best overload, drop all, inject idempotency, recreate unified). Part 3: Verification that all 42 RPCs have exactly 1 overload |
| 175 | 20260331700000 | **Fix inventory_transactions transaction_type CHECK** — Restores 'prebooked' and 'released' values that were accidentally removed by 20260331110000 (void delivery). These values are used by update_order_items(), cancel_order(), create_quick_delivery() |
| 176 | 20260331800000 | **Restore commissions status CHECK** — Re-adds CHECK constraint with 'pending', 'paid', 'cancelled'. Was dropped in 20260302200000 to add 'cancelled' but never recreated |
| 177 | 20260331900000 | Fix cancel_delivery prebooked release — scheduled delivery cancel should NOT release prebooked (belongs to order); completed delivery cancel must re-increment prebooked |
| 178 | 20260332000000 | Fix void_delivery/batch_cancel_deliveries/cancel_order — void_delivery must restore prebooked, batch_cancel_deliveries same class of bugs, cancel_order logs negative quantity fix |
| 179 | 20260332100000 | Drop deprecated order columns — removes orders.total_paid and orders.balance_due (deprecated since 20260311200000; AR now on invoices.balance_cents) |
| 180 | 20260332200000 | **Fix idempotency column refs (Round 2)** — 10 RPCs had wrong idempotency_keys column names re-introduced by Mar 31 migrations (which overwrote the 20260315004110 fix). Fixes: `key`→`idempotency_key`, `result_id`→`result`, `entity_type`/`entity_id`→`operation`/`result` in reopen_accounting_period, reverse_write_off, void_delivery, void_commission_payment, revert_quote_status, restore_cancelled_order, restore_cancelled_delivery, unapply_credit_memo, reverse_blend_ticket_approval, save_quote |
| 181 | 20260316300000 | **Wire confirm_delivery idempotency logic** — The consolidation migration (20260331600000) added p_idempotency_key parameter but never wired up check_idempotency/save_idempotency calls inside the function body. Frontend was already passing the key (DeliveryDetail.tsx:550) but server was ignoring it. Drivers on mobile could create duplicate activity_feed + notification entries. |
| 182 | 20260316115721 | **Add mark_overdue_invoices()** — Batch function to auto-detect posted invoices past due_date and transition them to 'overdue' status. Logs each transition to financial_audit_log. Designed for cron/scheduled execution. |
| 183 | 20260316121800 | **Drop stale confirm_delivery overload + enable pg_cron** — Removes the broken `confirm_delivery(uuid, text)` overload from consolidation. Enables `pg_cron` extension and schedules `mark_overdue_invoices()` to run daily at 6 AM UTC. |
| 184 | 20260332300000 | **Fix void_delivery — 4 bugs** — (1) `quantity` → `total_units_needed` in order status check, (2) adds `app.admin_override` for reverse status transitions (fulfilled→confirmed), (3) includes `actor_user_id` in financial_audit_log INSERT, (4) fixes idempotency_keys column refs (`key`→`idempotency_key`, `result_id`→`result`) |
| 185 | 20260332400000 | **Fix audit_log actor + column bugs across 24 RPCs** — (1) cancel_delivery: move admin_override BEFORE order status updates, (2) mark_overdue_invoices: fix wrong column names + NULL actor, (3) link/unlink_blend_ticket: fix wrong column names, (4) BEFORE INSERT trigger on financial_audit_log to fill actor_user_id when NULL (safety net for 20 other functions) |
| 186 | 20260332500000 | **Fix receive_po_items + expand financial_audit_log CHECK constraints** — (1) remove `updated_at = now()` from purchase_order_items UPDATE (column doesn't exist), (2) add 5 missing operation_type values: `invoice_marked_overdue`, `prepay_reconciliation`, `batch_prepay_apply`, `blend_ticket_linked`, `blend_ticket_unlinked`, (3) add `blend_ticket` to entity_type CHECK |
| 187 | 20260332600000 | **Fix commission payment RPCs** — `create_commission_payment` and `void_commission_payment` both referenced non-existent `updated_at` column on `commissions` table, causing crashes when paying or voiding commission payments |
| 188 | 20260316100000 | **Add product internal_notes** — Adds `internal_notes` (text, nullable) column to `products` table. Copies existing `notes` content to `internal_notes` for all products. Existing `notes` column stays as-is (relabeled "Grower Description" in UI). |
| 189 | 20260316200000 | **Quote versioning V2** — Creates `create_quote_version` and `restore_quote_version` RPCs for snapshot/restore of full quote state (sections + items). SECURITY DEFINER, search_path = public, pg_temp |
| 190 | 20260316300000 | **Quote section header notes** — Adds `section_header_notes` column to `quote_sections` table. Displays above items table, below section name in PDF. |
| 191 | 20260316400000 | **Quote PDF templates** — Creates `quote_pdf_templates` table for saved column presets, with RLS policies. |
| 192 | 20260316500000 | **Planned programs** — Adds `needed_by_date` to `quote_sections` for planned programs. Creates RPCs for inventory hold management and expiring holds alerts. |
| 193 | 20260316600000 | **Quote templates** — Creates `quote_templates` and `quote_template_sections`/`quote_template_items` tables for reusable quote structures. RLS policies included. |
| 194 | 20260316700000 | **Notes pipeline flow** — Adds `notes` column to `order_items`, `program_notes` column to `orders`. Rewrites `convert_quote_to_order` to copy `qi.notes` from quote_items to order_items and aggregate section_header_notes into `orders.program_notes` |
| 195 | 20260316800000 | **Inventory forecasting** — Creates `get_inventory_forecast` RPC for planned demand aggregation by product/month. SECURITY DEFINER, search_path = public, pg_temp |
| 196 | 20260316900000 | **Seasonal rollover** — Creates `rollover_quote_to_season` RPC to duplicate quotes with updated pricing for a new season. SECURITY DEFINER, search_path = public, pg_temp |
| 197 | 20260316950000 | **Team Board Phase 2** — Adds `last_escalated_at` column to `team_notes`, creates `get_team_workload()` RPC (aggregates open tasks, overdue tasks, today's/week's deliveries per team member). SECURITY DEFINER, search_path = public, pg_temp |
| 198 | 20260317100000 | **Fix idempotency + search_path final** — Final comprehensive fix of idempotency column names and search_path on all affected functions |
| 199 | 20260319100000 | **Reverse cycle count RPC** — Creates `reverse_completed_cycle_count()` to undo inventory adjustments from completed cycle counts |
| 200 | 20260319200000 | **Cleanup fake cycle counts & rebates** — One-time cleanup: reverses all completed cycle counts and deletes fake test rebates |
| 201 | 20260319200000 | **Remove delivery inventory block** — Removes blocking inventory pre-check from `complete_delivery()` to allow negative inventory |
| 202 | 20260320100000 | **Add idempotency to remaining RPCs** — Adds `p_idempotency_key` to 5 mutation RPCs that were missing it |
| 203 | 20260320100000 | **Workflow quote/order/invoice fixes** — Fixes for quote-to-order conversion, order fulfillment, and invoice posting workflows |
| 204 | 20260332700000 | Fix idempotency column refs round 3 — surgical fix of 4 RPCs + safety-net scan of all public functions + self-testing verification |
| 205 | 20260332800000 | **pg_temp search_path fix** — ALTER FUNCTION on ALL SECURITY DEFINER functions to add `pg_temp` to search_path. Verification block raises EXCEPTION if any functions still missing. Prevents temp schema hijacking attacks |
| 206 | 20260332900000 | **Data validation & cleanup** — Fixes negative inventory quantities, recalculates prebooked from actual pending orders, verifies commission splits sum to 100%, checks invoice paid_amount_cents integrity, fixes invalid commission statuses |
| 207 | 20260333000000 | **Fix reverse_cycle_count** — Adds `pg_temp` to search_path, fixes idempotency column refs (`key`→`idempotency_key`, `entity_type`/`entity_id`→`operation`/`result`) |
| 208 | 20260333100000 | **Fix save_quote idempotency + activity_feed columns** — Corrects idempotency_keys refs (`key`→`idempotency_key`, `entity_type`/`entity_id`→`operation`/`result`), fixes `v_server_totals` field aliases (`.sum`→`.total_price`), fixes activity_feed column names (`action`→`event_type`, `entity_type`→`related_entity_type`, `entity_id`→`related_entity_id`), adds `pg_temp` to search_path |
| 209 | 20260333200000 | **Fix save_quote search_path + idempotency type** — Surgical fix for save_quote search_path and idempotency key column type mismatch |
| 210 | 20260333300000 | **Fix 5 RPCs missing p_idempotency_key** — Adds p_idempotency_key to reverse_receiving_record, void_payment, edit_prepay_credit, delete_prepay_credit. Recreates batch_post_invoices (was dropped in 20260311200000). All created after consolidation migration so never got the parameter. Restores set_config trigger awareness in reverse_receiving_record. |
| 211 | 20260333400000 | **Fix reverse_receiving and idempotency bugs** — Fixes reverse_receiving_record and other idempotency-related issues |
| 212 | 20260333500000 | **Allow PO reverse transitions** — Enables purchase order status rollback for admin corrections |
| 213 | 20260333600000 | **Quick delivery optional invoice** — Adds `p_skip_invoice boolean DEFAULT false` to `create_quick_delivery`. Fixes missing `save_idempotency()` call (was checking but never saving). Fixes `search_path` missing `pg_temp`. Wraps invoice creation in conditional. Frontend adds "Create draft invoice" checkbox (ON by default) + confirmation dialog |
| 214 | 20260333700000 | **Rate limit log RLS** — Deny-all policy on `rate_limit_log` table to prevent unauthorized access |
| 215 | 20260333800000 | **Drop inventory qty_available CHECK** — Removes `chk_inventory_qty_available` CHECK constraint that blocked the "allow negative inventory" design in `complete_delivery()` |
| 216 | 20260333900000 | **Mega audit Phase 1 & 2 fixes** — 12 RPC fixes: get_ar_aging (include overdue), get_monthly_summary (commission cents), financial_dashboard_summary (overdue AR + order filters), apply_prepay_to_invoice (update customer balance), cancel_delivery (save idempotency), generate_finance_charges (season >= 10), allocate_payment (audit log), convert_quote_to_order (release holds), create_invoice_from_order (filter duplicates), update_order_items (recalc cost/profit/margin), save_quote (preserve is_planned), void_invoice (cancel commissions). 6 frontend fixes: CSV cents conversion, deleted_at filters, soft delete, regex replace |
| 217 | 20260334000000 | **Fix order_item delete FK checks** — Adjusts FK constraints for order item deletion |
| 218 | 20260334100000 | **Fix save_customer_address FK** — Fixes FK validation in save_customer_address RPC |
| 219 | 20260334200000 | **Edit delivery items when scheduled** — Replaces `edit_delivery()` to honor `p_items` when status = 'scheduled'. Validates quantities against `order_items.quantity_remaining` minus other active deliveries. Blocks item editing on in_progress. Includes overload verification. |
| 220 | 20260334300000 | **App settings OCR thresholds** — Extends `app_settings` with `description` and `created_at` columns. Seeds `ocr_confidence_threshold` setting with `auto_approve=85, needs_review=50`. |
| 221 | 20260334400000 | **Blend ticket fields table** — Creates `blend_ticket_fields` for per-field application tracking. Supports multi-field loads, multi-customer billing (Q6-B), and planned vs actual acres. RLS enabled. |
| 222 | 20260334500000 | **Blend tickets Phase 1 columns** — Adds `applicator_id` (FK→profiles), `vehicle_id` (FK→vehicles), `source` ('ocr'\|'manual'\|'digital') to `blend_tickets`. Indexed. |
| 223 | 20260334600000 | **Batch approve blend tickets** — `batch_approve_blend_tickets(p_ticket_ids, p_approved_by, p_idempotency_key)` RPC. Bulk approves completed+unreviewed tickets. |
| 224 | 20260334700000 | **Save blend ticket fields** — `save_blend_ticket_fields(p_blend_ticket_id, p_fields, p_performed_by, p_idempotency_key)` RPC. Replaces all field assignments for a blend ticket atomically. |
| 225 | 20260334800000 | **Duplicate blend ticket detection** — `check_duplicate_blend_ticket(p_ticket_number, p_ticket_date)` RPC. Returns matching tickets for duplicate warning. |
| 226 | 20260330032232 | **get_field_dashboard RPC** — Returns comprehensive JSONB for field dashboard: field data with customer/billing defaults/geometry, season summary stats, application records with applicator/vehicle/weather, and recent activity feed. |
| 227 | 20260335000000 | **Workflow gaps Phase 1: broken connections** — Adds `unit_cost_cents`/`unit_price_cents` to `blend_ticket_products`, updates `create_application_record_from_blend_ticket` to return `uuid[]` (one per field), adds `blend_tickets.job_id` FK column |
| 228 | 20260335100000 | **Workflow gaps Phase 2: blend ticket invoice** — `create_invoice_from_blend_ticket` RPC + `sync_blend_ticket_payment_status()` trigger for auto-syncing payment_status when invoice voided |
| 229 | 20260335200000 | **Workflow gaps Phase 3: field billing splits** — Adds `quote_sections.field_id`, `invoices.invoice_group_id`, field billing split helper RPCs + `create_split_invoices_from_order` RPC |
| 230 | 20260335300000 | **Workflow gaps Phase 4: dispatch columns** — Adds `jobs.priority` and `jobs.estimated_hours` columns |
| 231 | 20260335400000 | **Workflow gaps Phase 5: crop history** — Creates `field_crop_history` table with auto-snapshot trigger (`snapshot_field_crop_history`) for tracking multi-year crop rotation |
| 232 | 20260335500000 | **Invoice audit fixes** — (1) Adds `trg_guard_audit_log_immutable` trigger to block UPDATE/DELETE on `financial_audit_log`. (2) Fixes `apply_write_off` to auto-set status='paid' when write-off brings balance to 0. (3) Fixes `get_detailed_statement_data` to include 'overdue' invoices and corrects aging bucket overlap (over_90 → over_120). |
| 233 | 20260404040100 | **Add global_search() RPC** — `global_search(p_query, p_limit)` for Command Palette entity search across customers, orders, invoices, deliveries, products with ILIKE |
| 234 | 20260404040200 | **Add get_customer_summary() RPC** — `get_customer_summary(p_customer_id)` for Customer 360 KPI bar |
| 235 | 20260404040300 | **Add get_dashboard_action_items() RPC** — Returns specific actionable items per category for Dashboard Action Queue |
