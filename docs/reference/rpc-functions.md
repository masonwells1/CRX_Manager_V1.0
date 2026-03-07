# RPC Functions Reference (~126 total)

## Atomic Save/Delete
- `save_quote()`, `save_job()`, `save_customer()` — validates commission splits sum to 100%, `save_blend_ticket()`, `save_purchase_order()`, `delete_purchase_order()`, `duplicate_quote()`

## Order & Delivery
- `convert_quote_to_order()` — also releases inventory holds linked to the quote, `create_direct_order()`, `cancel_order()`, `update_order_items()`
- `confirm_delivery()` — scheduled -> in_progress transition
- `complete_delivery()` — requires in_progress, creates remainder rows for partial deliveries, copies `tote_number` from delivery items
- `edit_delivery()` — logistics only, items param ignored (locked to order)
- `cancel_delivery()`, `batch_cancel_deliveries()`, `reassign_delivery()`
- `create_followup_delivery()`, `get_customer_delivery_remainders()`
- `create_quick_delivery()` — atomic order + delivery + draft invoice in one transaction; includes inventory pre-check with `FOR UPDATE` locks to prevent overselling

## Inventory & Receiving
- `adjust_inventory()`, `receive_po_items()` — per-item condition/lot/notes/storage, creates receiving_records
- `complete_cycle_count()`
- `get_receiving_log()` — paginated, filterable receiving history
- `get_receiving_summary()` — dashboard stats (expected_today, pending_receipt, received_this_week, items_ytd, damaged_this_week)
- `match_quick_receive_items()` — auto-allocate products to oldest open POs for Quick Receive

## Job Scheduling
- `complete_job()` — marks completed, creates application_record, deducts inventory
- `transfer_job_to_invoice()` — creates invoice from job, sets status='invoiced'
- `load_recipe_into_job()` — copies recipe items into job chemicals

## Sequential Numbers (advisory locks)
- `next_delivery_number()` -> DEL-YYYY-NNNN
- `next_po_number()` -> PO-YYYY-NNNN
- `next_application_record_number()` -> APP-YYYY-NNNN
- `next_job_number()` -> JOB-YYYY-NNNN
- `next_commission_payment_number()` -> CP-YYYY-NNNN

## Reporting (13 RPCs)
- `get_logbook_by_customer()`, `get_logbook_by_applicator()`, `get_logbook_by_field()`, `get_logbook_faa()`
- `get_bottom_line_pnl()`, `get_gross_sales_report()`, `get_customer_balance_listing()`
- `get_chemical_history()`, `get_commission_balance_report()`, `get_inventory_cost_report()`

## Sales Reports (3 RPCs)
- `get_sales_detail_report(p_start_date, p_end_date, p_product_id, p_customer_ids uuid[], p_sales_rep_id, p_category, p_season)` — line-item sales detail with LATERAL JOIN to invoices for invoice_number. Joins order_items → orders → customers → products → profiles. All filters optional
- `get_sales_summary_report(p_group_by, p_start_date, p_end_date, p_product_id, p_customer_ids uuid[], p_sales_rep_id, p_category, p_season)` — aggregated sales grouped by dimension (product/customer/sales_rep/month/category). CTE-based with same filter set
- `get_customer_farm_group(p_customer_id)` — recursive CTE that walks up parent_customer_id chain to find root parent, then returns parent + all direct children. Powers multi-customer farm group reporting

## Financial
- `close_accounting_period()`, `check_period_open()`, `generate_batch_statements()`, `get_monthly_summary()`
- `create_commission_payment()`, `post_commission_payment()`
- `apply_write_off(invoice_id, amount_cents, reason, performed_by, idempotency_key?)` — writes off balance with idempotency guard, creates write-off record and audit log entry
- `generate_finance_charges(performed_by, ...)` — admin-only (role check enforced in RPC body), generates finance charge invoices excluding prior charges
- `get_customer_transaction_review()`, `apply_remaining_prepayments()`
- `apply_prepay_to_invoice(credit_id, invoice_id, amount_cents, performed_by)` — atomic single allocation with `FOR UPDATE` locks, creates `prepay_applications` record, deducts from both balances, writes `financial_audit_log` entry
- `batch_apply_prepayments(allocations jsonb, performed_by, idempotency_key?)` — batch wrapper with idempotency guard, iterates over JSON array, calls `apply_prepay_to_invoice` for each, returns total count and amount

## Geo / Maps
- `get_fields_with_geojson()`, `get_field_geojson()`, `save_field_geometry()` — use `SET search_path = public, extensions` for PostGIS

## Dashboard
- `dashboard_summary()` — legacy operational summary (inventory levels, deliveries, recent activity, integrity alerts). Slimmed from original 8-query version; financial KPIs moved to `financial_dashboard_summary()`
- `operational_dashboard_summary()` — comprehensive 25-CTE RPC powering the Operational Dashboard. Returns KPIs (active orders, open quotes, pending deliveries, open POs), team board action items, inventory position, upcoming deliveries, delivery stats, sales pipeline, 9 operational alert counts, 12-month activity chart data, season progress, accounting period status, and recent activity feed
- `financial_dashboard_summary()` — admin-only RPC returning all financial KPIs: AR aging buckets, revenue totals, payment activity, prepay balances, finance charge summary, period status. Powers the `/financial-dashboard` page

## Helper Functions (SQL)
```sql
is_admin()      -- SECURITY DEFINER STABLE
is_sales_rep()  -- SECURITY DEFINER STABLE
is_driver()     -- SECURITY DEFINER STABLE
is_applicator() -- SECURITY DEFINER STABLE
```

## Database Triggers
- **`on_auth_user_created`** - After INSERT on `auth.users`, calls `handle_new_user()` which auto-creates a `profiles` row using `raw_user_meta_data` (full_name, role defaults to 'sales_rep').
- **`release_holds_on_quote_status_change`** - After UPDATE on `quotes`, fires when status changes to `declined`, `expired`, or `accepted`. Deactivates linked inventory holds (via `source_id`). For declined/expired: also restores `quantity_available`. For accepted: deactivates holds only (inventory stays allocated for the resulting order).

## Accounts Payable
- `create_vendor_bill(p_vendor_id, p_purchase_order_id, p_bill_number, p_bill_date, p_payment_terms, p_subtotal_cents, p_adjustment_cents, p_notes)` — creates vendor bill with auto-calculated due_date from payment terms (Net 15/30/45/60/90/Due on Receipt). Returns bill UUID. Backfills vendor from existing PO data if needed
- `record_vendor_payment(p_vendor_bill_id, p_payment_date, p_amount_cents, p_payment_method, p_reference_number, p_notes)` — records payment against a bill, updates paid_cents/balance_cents, auto-transitions status (unpaid → partially_paid → paid). Validates amount ≤ balance
- `void_vendor_bill(p_vendor_bill_id, p_reason)` — voids a bill (must not be 'paid'), sets status='voided', appends reason to notes
- `get_ap_aging(p_as_of_date)` — AP aging report: Current / 31-60 / 61-90 / 90+ day buckets with vendor breakdown. Returns totals and per-vendor detail
- `get_ap_dashboard_summary()` — KPI totals: total_owed, due_this_week, due_this_month, overdue_amount, bill counts, recent vendor bills

## RUP Sales Reporting
- `generate_rup_sales_records(p_invoice_id)` — auto-called after `post_invoice()` for invoices with RUP products. Creates rup_sales_records for each RUP line item, snapshots product/customer/license data, flags compliance_status (compliant/warning/non_compliant based on applicator license validity)
- `get_rup_sales_register(p_start_date, p_end_date, p_product_id, p_customer_id, p_compliance_status)` — filterable register query for state reporting. Returns all FIFRA-required fields (date, product, EPA reg, qty, buyer cert)

## Invoice Posting
- `post_invoice()` — now calls `check_period_open()` before posting; raises error if the invoice's accounting period is closed. Also triggers `generate_rup_sales_records()` for invoices containing RUP products.
