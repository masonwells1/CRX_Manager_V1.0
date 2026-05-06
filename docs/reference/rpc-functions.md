# RPC Functions Reference (~172 unique functions)

> **IMPORTANT:** As of migration 20260331600000, all mutating RPCs have exactly ONE overload with `p_idempotency_key text DEFAULT NULL`. Never create function overloads — see SAFE_DEVELOPMENT_RULES.md.

> **Audit (2026-03-16):** Round 3 idempotency fix applied via migration 20260332700000. All public functions verified to use correct `idempotency_keys` columns (`idempotency_key`, `operation`, `result`). Pre-commit hook now blocks wrong patterns.

---

## Atomic Save/Delete
- `save_quote()` — upsert quote + items; validates commission splits sum to 100%
- `save_job()` — upsert job + chemicals
- `save_customer()` — upsert customer; validates commission splits sum to 100%
- `save_blend_ticket()` — upsert blend ticket + items
- `save_purchase_order()` — upsert PO + items
- `save_invoice()` — upsert invoice + items
- `save_field()` — upsert field record
- `delete_purchase_order()` — soft-delete PO (must be draft)
- `duplicate_quote()` — deep-clone quote + items with new number
- `create_quote_version(p_quote_id uuid, p_performed_by uuid)` — snapshots full quote state (sections + items) for version history. SECURITY DEFINER, search_path = public, pg_temp
- `restore_quote_version(p_version_id uuid, p_performed_by uuid)` — restores quote from a version snapshot as revised draft. SECURITY DEFINER, search_path = public, pg_temp
- `admin_update_profile()` — admin-only profile updates (name, role, email, active flag)
- `save_quote_template()` — Saves quote template with sections and items
- `create_quote_from_template()` — Creates a new quote from a saved template

## Order & Delivery
- `convert_quote_to_order()` — also releases inventory holds linked to the quote. Copies `qi.notes` to `order_items.notes` and aggregates section_header_notes into `orders.program_notes`
- `create_direct_order()` — create order without a quote; warns (not blocks) on low inventory using net position
- `create_order_from_blend_ticket()` — create order from linked blend ticket
- `cancel_order()` — cancels order, releases prebooked inventory
- `update_order_items()` — update items on an existing order
- `confirm_delivery()` — scheduled -> in_progress transition
- `complete_delivery()` — requires in_progress, creates remainder rows for partial deliveries, copies `tote_number` from delivery items
- `edit_delivery()` — logistics always editable; items (add/remove/adjust) editable only when status = 'scheduled'. Validates quantities against order_items.quantity_remaining minus other active deliveries.
- `cancel_delivery()` — cancels delivery, releases prebooked inventory
- `batch_cancel_deliveries()` — batch cancel multiple deliveries
- `batch_reschedule_deliveries()` — batch reschedule deliveries to new dates
- `reassign_delivery()` — reassign delivery to different driver
- `create_followup_delivery()` — create follow-up delivery for remaining items
- `get_customer_delivery_remainders()` — get undelivered remainder items for a customer
- `create_quick_delivery()` — atomic order + delivery + draft invoice in one transaction; includes inventory pre-check with `FOR UPDATE` locks to prevent overselling
- `check_duplicate_delivery()` — check if a duplicate delivery exists for an order
- `void_delivery()` — void a completed delivery, reversing inventory transactions

## Invoice & Payments
- `create_invoice_from_order()` — create invoice from order items
- `create_invoice_from_delivery()` — create invoice from delivery items
- `create_invoice_from_blend_ticket(p_blend_ticket_id, p_created_by, p_idempotency_key)` → jsonb `{invoice_ids[], invoice_group_id}` — creates draft invoice(s) from approved blend ticket. **Phase 1 (2026-04-29):** return type changed from `uuid` to `jsonb`. Multi-customer fields produce grouped split invoices via `invoice_group_id`. Acres come from `blend_ticket_fields.actual_acres → planned_acres → fields.total_acres → 0`. Mode A (grower-share `price_override_cents`) bills $/ac, Mode B bills line items + tier/quoted/manual + service fee.
- `create_split_invoices_from_order(p_order_id, p_salesman_id, p_invoice_type, p_idempotency_key)` → uuid[] — creates proportional split invoices based on field billing splits for an order
- `post_invoice()` — posts invoice; calls `check_period_open()` before posting; raises error if accounting period is closed. Also triggers `generate_rup_sales_records()` for RUP products.
- `void_invoice()` — void a posted invoice, reversing all related records
- `batch_post_invoices()` — batch post multiple invoices at once
- `batch_void_invoices()` — batch void multiple invoices
- `record_invoice_payment()` — record payment against a specific invoice
- `record_payment()` — record a payment and allocate across invoices
- `allocate_payment()` — allocate/re-allocate payment amounts across invoices

## Inventory & Receiving
- `adjust_inventory()` — manual inventory adjustment with reason
- `manual_inventory_add()` — add inventory manually (does not override product unit cost)
- `receive_po_items()` — per-item condition/lot/notes/storage, creates receiving_records
- `release_inventory_hold()` — release a specific inventory hold
- `create_planned_holds()` — Creates inventory holds for planned quote sections
- `complete_cycle_count()` — finalize cycle count, create adjustment transactions
- `get_receiving_log()` — paginated, filterable receiving history
- `get_receiving_summary()` — dashboard stats (expected_today, pending_receipt, received_this_week, items_ytd, damaged_this_week)
- `match_quick_receive_items()` — auto-allocate products to oldest open POs for Quick Receive
- `validate_product_units()` — trigger function that validates product unit consistency
- `convert_to_gl_lb()` — convert quantity from any unit to gallons or pounds for standardized reporting

## Job Scheduling
- `complete_job()` — marks completed, creates application_record, deducts inventory
- `transfer_job_to_invoice()` — creates invoice from job, sets status='invoiced'
- `load_recipe_into_job()` — copies recipe items into job chemicals
- `create_application_record_from_blend_ticket(p_blend_ticket_id, p_performed_by, p_idempotency_key)` → uuid[] — create application records from blend ticket data (one per field, returns array of record IDs)

## Blend Ticket Linkage
- `link_blend_ticket_to_order()` — link a blend ticket to an existing order
- `unlink_blend_ticket_from_order()` — remove blend ticket / order linkage

## Blend Ticket Phase 1
- `batch_approve_blend_tickets(p_ticket_ids, p_approved_by, p_idempotency_key)` — bulk approve completed+unreviewed tickets
- `batch_reject_blend_tickets(p_ticket_ids, p_rejected_by, p_idempotency_key)` → jsonb — bulk reject completed+unreviewed tickets, returns `rejected_count`
- `save_blend_ticket_fields(p_blend_ticket_id, p_fields, p_performed_by, p_idempotency_key)` — save per-field application assignments (delete+reinsert)
- `check_duplicate_blend_ticket(p_ticket_number, p_ticket_date)` — check for duplicate ticket by number+date

## Returns & Credits
- `approve_return()` — approve a return request
- `receive_return()` — receive returned items, update inventory
- `issue_return_credit()` — issue credit memo for a return, integrated with AR
- `create_prepay_credit()` — create prepay credit for a customer
- `reconcile_prepay_balances()` — reconcile prepay balances across all customers

## Sequential Numbers (advisory locks)
- `next_delivery_number()` -> DEL-YYYY-NNNN
- `next_po_number()` -> PO-YYYY-NNNN
- `next_application_record_number()` -> APP-YYYY-NNNN
- `next_job_number()` -> JOB-YYYY-NNNN
- `next_invoice_number()` -> INV-YYYY-NNNN (accepts invoice type param)
- `next_cycle_count_number()` -> CC-YYYY-NNNN
- `next_return_number()` -> RET-YYYY-NNNN
- `next_commission_payment_number()` -> CP-YYYY-NNNN
- `generate_order_number()` — auto-generate order number
- `generate_quote_number()` — auto-generate quote number
- `generate_ticket_number()` — auto-generate blend ticket number

## Reporting (13 RPCs)
- `get_logbook_by_customer()`, `get_logbook_by_applicator()`, `get_logbook_by_field()`, `get_logbook_faa()`
- `get_bottom_line_pnl()`, `get_gross_sales_report()`, `get_customer_balance_listing()`
- `get_chemical_history()`, `get_commission_balance_report()`, `get_inventory_cost_report()`

## Sales Reports (3 RPCs)
- `get_sales_detail_report(p_start_date, p_end_date, p_product_id, p_customer_ids uuid[], p_sales_rep_id, p_category, p_season)` — line-item sales detail with LATERAL JOIN to invoices for invoice_number. Joins order_items -> orders -> customers -> products -> profiles. All filters optional
- `get_sales_summary_report(p_group_by, p_start_date, p_end_date, p_product_id, p_customer_ids uuid[], p_sales_rep_id, p_category, p_season)` — aggregated sales grouped by dimension (product/customer/sales_rep/month/category). CTE-based with same filter set
- `get_customer_farm_group(p_customer_id)` — recursive CTE that walks up parent_customer_id chain to find root parent, then returns parent + all direct children. Powers multi-customer farm group reporting

## AR & Statements
- `get_ar_aging()` — AR aging report with current/30/60/90+ day buckets
- `get_customer_statement()` — customer statement with invoice/payment history
- `get_detailed_statement_data()` — detailed statement data for PDF generation. Includes both 'posted' and 'overdue' invoices. Aging buckets: current(0-30), 31-60, 61-90, 91-120, over-120 (non-overlapping).
- `generate_batch_statements()` — generate batch PDF statements for multiple customers
- `get_season_comparison()` — compare two seasons side-by-side

## Financial
- `close_accounting_period()`, `check_period_open()`, `get_monthly_summary()`
- `create_commission_payment()`, `post_commission_payment()`
- `apply_write_off(invoice_id, amount_cents, reason, performed_by, idempotency_key?)` — writes off balance with idempotency guard, creates write-off record and audit log entry. Auto-sets status='paid' when write-off brings balance to 0. Accepts 'posted' or 'overdue' invoices.
- `reverse_write_off(write_off_id, reason, performed_by?, idempotency_key?)` — admin-only. Marks write-off `reversed_at`/`reversed_by`/`reversed_reason`, decrements `invoices.write_off_cents` (balance_cents is GENERATED — never written directly), and re-derives status from 'paid' to 'posted' when reversal lifts balance > 0. Returns `{ success, write_off_id, amount_cents, invoice_id, new_balance_cents, status_changed }`. Idempotent: replays return the previously stored result. Wave A.1 / migration 20260506170000.
- `generate_finance_charges(performed_by, ...)` — admin-only (role check enforced in RPC body), generates finance charge invoices excluding prior charges
- `get_customer_transaction_review()`, `apply_remaining_prepayments()`
- `apply_prepay_to_invoice(credit_id, invoice_id, amount_cents, performed_by)` — atomic single allocation with `FOR UPDATE` locks, creates `prepay_applications` record, deducts from both balances, writes `financial_audit_log` entry
- `batch_apply_prepayments(allocations jsonb, performed_by, idempotency_key?)` — batch wrapper with idempotency guard, iterates over JSON array, calls `apply_prepay_to_invoice` for each, returns total count and amount
- `calculate_billing_splits()` — calculate billing splits for an order
- `check_customer_credit_limit()` — check if customer has exceeded credit limit
- `mark_overdue_invoices()` — batch scan: sets posted invoices past due_date to 'overdue', logs to financial_audit_log, returns `{ invoices_marked_overdue, run_at }`

## Pricing
- `calculate_prices_from_margin()` — trigger: auto-calculate tier prices from margin target

## Season Helpers
- `compute_season(p_date)` — returns season year for a given date (Oct 1 - Sep 30)
- `current_season()` — returns current season year
- `season_start_date(p_season)` — returns Oct 1 of the season
- `season_end_date(p_season)` — returns Sep 30 of the following year

## Geo / Maps
- `get_fields_with_geojson()`, `get_field_geojson()`, `save_field_geometry()` — use `SET search_path = public, extensions` for PostGIS

## Dashboard
- `dashboard_summary()` — legacy operational summary (inventory levels, deliveries, recent activity, integrity alerts). Slimmed from original 8-query version; financial KPIs moved to `financial_dashboard_summary()`
- `operational_dashboard_summary()` — comprehensive 25-CTE RPC powering the Operational Dashboard. Returns KPIs (active orders, open quotes, pending deliveries, open POs), team board action items, inventory position, upcoming deliveries, delivery stats, sales pipeline, 9 operational alert counts, 12-month activity chart data, season progress, accounting period status, and recent activity feed
- `financial_dashboard_summary()` — admin-only RPC returning all financial KPIs: AR aging buckets, revenue totals, payment activity, prepay balances, finance charge summary, period status. Includes 3 margin alert fields: `bottom_products_by_margin`, `bottom_customers_by_margin`, `monthly_margin_trend`. Total CTEs: 16.
- `get_customer_summary(p_customer_id uuid)` → jsonb — Returns 5 KPIs for CustomerDetail summary bar: `ar_balance_cents`, `order_count`, `delivery_count`, `credit_tier`, `last_activity`. Season-aware (Oct 1 - Sep 30).
- `get_dashboard_action_items(p_limit int DEFAULT 5)` → jsonb — Returns specific actionable items per category for Dashboard Action Queue: overdue invoices, cancelled+posted orders, overdue deliveries, low stock items, expiring quotes, unassigned deliveries. Each item includes entity ID, primary text, secondary text, and category-specific details.

## Accounts Payable
- `create_vendor_bill(p_vendor_id, p_purchase_order_id, p_bill_number, p_bill_date, p_payment_terms, p_subtotal_cents, p_adjustment_cents, p_notes)` — creates vendor bill with auto-calculated due_date from payment terms (Net 15/30/45/60/90/Due on Receipt). Returns bill UUID. Backfills vendor from existing PO data if needed
- `record_vendor_payment(p_vendor_bill_id, p_payment_date, p_amount_cents, p_payment_method, p_reference_number, p_notes)` — records payment against a bill, updates paid_cents/balance_cents, auto-transitions status (unpaid -> partially_paid -> paid). Validates amount <= balance
- `void_vendor_bill(p_vendor_bill_id, p_reason)` — voids a bill (must not be 'paid'), sets status='voided', appends reason to notes
- `get_ap_aging(p_as_of_date)` — AP aging report: Current / 31-60 / 61-90 / 90+ day buckets with vendor breakdown. Returns totals and per-vendor detail
- `get_ap_dashboard_summary()` — KPI totals: total_owed, due_this_week, due_this_month, overdue_amount, bill counts, recent vendor bills
- `cancel_purchase_order()` — cancel a PO (soft delete with status change)

## RUP Sales Reporting
- `generate_rup_sales_records(p_invoice_id)` — auto-called after `post_invoice()` for invoices with RUP products. Creates rup_sales_records for each RUP line item, snapshots product/customer/license data, flags compliance_status (compliant/warning/non_compliant based on applicator license validity)
- `get_rup_sales_register(p_start_date, p_end_date, p_product_id, p_customer_id, p_compliance_status)` — filterable register query for state reporting. Returns all FIFRA-required fields (date, product, EPA reg, qty, buyer cert)

## Email Infrastructure
- `get_ar_reminder_candidates()` — admin-only. Returns customers with overdue invoices (30+ days) grouped by customer, with invoice details array, total_balance, and max_days_past_due. Only includes customers with email addresses on file. Called by "Send AR Reminders" button on ARaging.tsx

## Team Board V2
- `get_team_board_deliveries()` — SECURITY DEFINER, role-aware. Returns `{ today: [...], tomorrow: [...], unassigned_count, today_total }`. Drivers see only their assigned deliveries; admin/sales_rep see all. Sorted by scheduled_time, then priority (urgent->low).
- `get_yesterday_delivery_recap()` — SECURITY DEFINER, role-aware. Returns `{ completed: [...], issues: [...], summary: { total_completed, total_with_issues, total_cancelled } }`. Same role filtering as above.
- `get_notes_for_entity(p_entity_type text, p_entity_id uuid)` — SECURITY DEFINER. Returns all non-deleted team_notes linked to a specific entity, ordered by is_pinned DESC, created_at DESC.
- `get_team_workload()` — SECURITY DEFINER. Returns jsonb array of team members with `id`, `full_name`, `role`, `open_tasks`, `overdue_tasks`, `today_deliveries`, `week_deliveries`. Aggregates from team_notes and deliveries tables.

## Inventory Forecasting
- `get_inventory_forecast(p_months_ahead integer DEFAULT 6)` → Returns jsonb array of planned demand vs supply by product and month. SECURITY DEFINER, search_path = public, pg_temp

## Seasonal Rollover
- `rollover_quote_to_season(p_quote_id uuid, p_new_season integer, p_performed_by uuid, p_idempotency_key text DEFAULT NULL)` → Returns jsonb with new quote_id, quote_number, season. Creates duplicate quote with updated pricing for the new season. SECURITY DEFINER, search_path = public, pg_temp

## Field Billing Splits
- `get_field_billing_splits_for_order(p_order_id)` → table — returns billing splits for all fields associated with an order
- `get_field_billing_splits_for_blend_ticket(p_blend_ticket_id)` → table — returns billing splits for all fields associated with a blend ticket

## Automation
- `auto_expire_quotes()` — cron-callable: expires quotes past their expiration date, releases inventory holds
- `check_remainder_reminders()` — cron-callable: checks for delivery remainders needing follow-up reminders

## Helper Functions (SQL)
```sql
is_admin()      -- SECURITY DEFINER STABLE
is_sales_rep()  -- SECURITY DEFINER STABLE
is_driver()     -- SECURITY DEFINER STABLE
is_applicator() -- SECURITY DEFINER STABLE
is()            -- base role-check helper
```

---

## Internal / Trigger Functions

These are NOT called directly from the frontend. They power triggers, guards, and infrastructure.

### Status Transition Enforcement (trigger functions)
- `_enforce_delivery_status_transition()` — enforces delivery status state machine
- `_enforce_invoice_status_transition()` — enforces invoice status state machine
- `_enforce_job_status_transition()` — enforces job status state machine
- `_enforce_order_status_transition()` — enforces order status state machine
- `_enforce_po_status_transition()` — enforces PO status state machine
- `_enforce_quote_status_transition()` — enforces quote status state machine
- `_enforce_return_status_transition()` — enforces return status state machine
- `enforce_invoice_draft_on_insert()` — ensures new invoices start as draft

### Delete Guards (trigger functions)
- `_guard_delivery_delete()` — prevents deletion of non-draft deliveries
- `_guard_invoice_delete()` — prevents deletion of non-draft invoices
- `_guard_order_delete()` — prevents deletion of non-draft orders
- `_guard_po_delete()` — prevents deletion of non-draft POs
- `prevent_order_shares_edit_after_post()` — blocks `order_shares` INSERT/UPDATE/DELETE when any invoice on the order is `posted`/`paid`/`overdue`. Wired by `trg_order_shares_lock_when_posted` (added 2026-05-04, OPEN_ITEMS #1)

### Auth & Security
- `_is_admin_override()` — internal admin check for RLS policies
- `handle_new_user()` — triggered on `auth.users` INSERT, auto-creates `profiles` row
- `check_idempotency()` — check if an idempotency key has been used
- `save_idempotency()` — persist an idempotency key result
- `check_rate_limit()` — rate limiting check

### Status Change Triggers
- `trg_delivery_status_change()` — fires on delivery status change (notifications, side effects)
- `trg_inventory_significant_change()` — fires on significant inventory changes (alerts)
- `trg_order_status_change()` — fires on order status change (commission creation, etc.)
- `trg_payment_update_order()` — fires on payment changes to update order totals
- `trg_po_status_change()` — fires on PO status change
- `trg_recalc_order_totals()` — recalculates order totals when items change
- `release_holds_on_quote_status_change()` — deactivates inventory holds when quote is declined/expired/accepted
- `release_expired_quote_holds()` — releases holds from expired quotes

### Inventory Helpers
- `_prebook_quick_delivery_inventory()` — internal: prebooks inventory during quick delivery creation

### Timestamp Update Triggers
- `update_updated_at()` — generic updated_at timestamp trigger
- `update_blend_ticket_updated_at()` — blend ticket timestamp trigger
- `update_fields_updated_at()` — fields timestamp trigger
- `update_note_comment_timestamp()` — note/comment timestamp trigger
- `update_allocation_set()` — update allocation set on payment changes

### Activity Logging Triggers
- `log_comment_activity()` — log comment activity to activity feed
- `log_note_activity()` — log note activity to activity feed

### Notification Triggers
- `notify_damaged_receiving()` — notify on damaged item receipt
- `notify_mentioned_users_in_comment()` — notify users @mentioned in comments

### Blend Ticket Helpers
- `update_blend_ticket_billing_status()` — update billing status on blend ticket changes
- `sync_blend_ticket_payment_status()` → trigger — auto-syncs blend ticket payment_status when linked invoice is voided

### Crop History
- `snapshot_field_crop_history()` → trigger — auto-snapshots crop_type changes on fields to field_crop_history table

### Field Dashboard
- `get_field_dashboard(p_field_id, p_season)` — returns JSONB: field data + season summary + application records + recent activity

### Global Search
- `global_search(p_query text, p_limit int DEFAULT 5)` → TABLE(entity_type text, id uuid, primary_text text, secondary_text text) — Searches customers, orders, invoices, deliveries, products with ILIKE. Used by Command Palette (Ctrl+K).

### Custom Application Workflow
- `create_job_from_quote_section(p_quote_id, p_section_id, p_performed_by, p_idempotency_key)` -> jsonb {job_id} -- Creates scheduled job from planned quote section with pre-filled chemicals and fields
- `get_program_completion(p_season)` -> jsonb array -- Returns planned vs actual acres per program section for the Program Tracker dashboard

### Field Application Workflow V2 / Phase 1 (2026-04-29 rewrite)
- `derive_customer_shares_from_fields(p_field_ids uuid[], p_applied_acres_map jsonb DEFAULT NULL)` -> jsonb `{rows[], customers[], total_applied_acres, field_count, fallback_used_field_ids[]}` — **Phase 1 rewrite:** returns per-(field × customer) detail in `rows` and per-customer aggregate in `customers`. Falls back to `fields.customer_id` at 100% when a field has no `field_billing_defaults` rows.
- `save_field_app_invoice(p_invoice_id, p_invoice, p_locations, p_chemicals, p_performed_by, p_application_service_id, p_idempotency_key)` -> jsonb `{invoice_ids[], invoice_group_id}` — **Phase 1 rewrite:** creates one invoice per customer (grouped via `invoice_group_id` when 2+). Per customer chooses Mode A (grower-share $/ac for fields with `price_override_cents`) or Mode B (line items + tier/quoted/manual pricing + application service fee). Posted-invoice edit lock covers the whole group. `field_app_locations` keyed at group level. `field_app_location_shares` carries TRUE per-customer split for audit. `invoice_shares` populated for PDF/statement compat (one 100% row per child invoice).
- `post_invoice_group(p_invoice_group_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL)` -> jsonb `{posted_invoice_ids[], invoice_group_id, total_posted_cents, member_count}` — **Phase 1 new:** atomically posts every invoice in a group. Pre-checks all members are in `draft`/`unposted` and that each `invoice_date` falls in an open period; rolls back the entire transaction on any failure.
- `preview_field_app_invoice_split(p_locations jsonb, p_chemicals jsonb, p_application_service_id uuid DEFAULT NULL)` -> jsonb `{per_customer[], grand_total_cents, customer_count, shares_detail}` — **Phase 1 new:** read-only preview returning the same per-customer breakdown that `save_field_app_invoice` would produce, without writing anything. Backs the "Preview" button on the field app invoice page.

### Field App Workflow Phases 7-22 (Audit-driven hardening, 2026-04-30 → 2026-05-01)

**Auth-gate hardening (Phases 7, 9-14):** all 12 P1 actor-spoofing SECURITY DEFINER RPCs got the strict pattern `auth.uid()` not null + `p_performed_by` mismatch reject + role check. Affected RPCs: `start_job`, `complete_job`, `save_field_app_invoice`, `create_invoice_from_blend_ticket`, `post_invoice_group`, `save_invoice`, `create_invoice_from_order`, `confirm_delivery`, `complete_delivery`, `create_quick_delivery`, `save_purchase_order`, `receive_po_items`, `void_commission_payment`, `allocate_payment`.

**Sprint D-policy (Phase 15):** drivers can complete deliveries they're assigned to (matches `confirm_delivery` pattern). `complete_delivery` auto-creates a draft invoice when `order_id IS NOT NULL` and no active invoice exists for the order.

**Sprint E inventory transactional integrity (Phases 16-18):**
- `retire_inventory_item(p_inventory_id, p_performed_by, p_idempotency_key)` -> jsonb — atomic delete-with-validation; replaces the multi-step direct-write flow in `InventoryPage.tsx`. Locks inventory row with `FOR UPDATE`, re-validates active holds + prebooked + pending deliveries post-lock, inserts audit ledger row, deletes. Admin-only.
- `complete_cycle_count(p_cycle_count_id, p_completed_by, p_idempotency_key)` -> void — **rewritten:** replaced `GREATEST(0, ...)` clamp with `RAISE EXCEPTION` when math would drive on-hand negative (E2a — "block, don't drift"). Closes the audit's "ledger ↔ on-hand permanent disagreement" finding. Now properly accepts idempotency key (was previously dropped silently by PostgREST).
- `reverse_completed_cycle_count(p_cycle_count_id, p_reversed_by, p_idempotency_key)` -> void — same E2a fix mirrored on the reversal path.
- `update_cycle_count_item(p_item_id, p_counted_qty, p_notes, p_performed_by, p_idempotency_key)` -> jsonb — locks parent `cycle_counts` row, validates `status='in_progress'`, computes variance + variance_pct server-side. Replaces direct PostgREST `.update()` from React. Admin-only.
- `cancel_cycle_count(p_cycle_count_id, p_performed_by, p_idempotency_key)` -> jsonb — replaces the bare `.update({ status: 'cancelled' })` in CycleCounts. Validates `status='in_progress'` before flipping. RLS WITH CHECK guards added to `cycle_count_items` to block direct PostgREST writes when parent is not `in_progress`.

**Sprint F operations hardening (Phases 19-22):**
- `release-expired-quote-holds` and `check-remainder-reminders` now run on pg_cron schedule (Phase 19) at 6:15 / 6:30 UTC daily. Frontend Dashboard.tsx still triggers both — belt-and-suspenders since RPCs are idempotent.
- Edge Function lockdown: `send-email` now requires `customer_id`, validates `to` matches customer email, allowlists `email_type` per role (driver = `delivery_completed` only), drivers must supply `resource_type='delivery'` + assigned-driver auth, attachment cap 5/10MB, rate limit 50/hour. `process-blend-ticket` now requires applicator to be the ticket uploader. Both gain Sentry alerting via `_shared/sentry.ts`.
- `create_commission_payment(p_commission_ids, p_payment_method, p_reference, p_payment_date, p_notes, p_performed_by, p_idempotency_key)` -> uuid — **Phase 20 rewrite:** no longer flips commissions to `paid` status. The `paid` transition now happens in `post_commission_payment`. Double-pay guard replaced with check against `commission_payment_items` membership in non-voided payments.
- `post_commission_payment(p_payment_id, p_performed_by, p_idempotency_key)` -> jsonb `{success, payment_id, payment_number, commissions_paid}` — **Phase 20 rewrite:** now sets `commissions.status = 'paid'` and `paid_date = payment_date`. Now properly accepts idempotency key (was missing despite frontend passing it). Returns jsonb instead of void.
- `reconcile_negative_inventory(p_inventory_id, p_new_quantity, p_reason, p_performed_by, p_idempotency_key)` -> jsonb — **Phase 22 cleanup:** admin sets correct on-hand for a row in negative state; delta becomes paired `inventory_transactions` audit row with reason. Used by `/integrity-cleanup` page.
- `create_invoice_for_unbilled_delivery(p_delivery_id, p_performed_by, p_idempotency_key)` -> jsonb `{success, delivery_id, invoice_id, invoice_number, total_cents}` — **Phase 22 cleanup:** factors Phase 15's auto-invoice logic into a manual-trigger RPC for the 60 historical completed deliveries that pre-date Phase 15. Refuses if delivery is not `completed`, has no `order_id`, or order already has an active invoice.
