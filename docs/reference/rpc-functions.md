# RPC Functions Reference (~115 total)

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

## Reporting (10 RPCs)
- `get_logbook_by_customer()`, `get_logbook_by_applicator()`, `get_logbook_by_field()`, `get_logbook_faa()`
- `get_bottom_line_pnl()`, `get_gross_sales_report()`, `get_customer_balance_listing()`
- `get_chemical_history()`, `get_commission_balance_report()`, `get_inventory_cost_report()`

## Financial
- `close_accounting_period()`, `check_period_open()`, `generate_batch_statements()`, `get_monthly_summary()`
- `create_commission_payment()`, `post_commission_payment()`
- `apply_write_off()`, `generate_finance_charges()`
- `get_customer_transaction_review()`, `apply_remaining_prepayments()`
- `apply_prepay_to_invoice(credit_id, invoice_id, amount_cents, performed_by)` — atomic single allocation with `FOR UPDATE` locks, creates `prepay_applications` record, deducts from both balances, writes `financial_audit_log` entry
- `batch_apply_prepayments(allocations jsonb, performed_by)` — batch wrapper iterating over JSON array, calls `apply_prepay_to_invoice` for each, returns total count and amount

## Geo / Maps
- `get_fields_with_geojson()`, `get_field_geojson()`, `save_field_geometry()` — use `SET search_path = public, extensions` for PostGIS

## Dashboard
- `dashboard_summary()` — 8 queries consolidated into 1 RPC

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

## Invoice Posting
- `post_invoice()` — now calls `check_period_open()` before posting; raises error if the invoice's accounting period is closed.
