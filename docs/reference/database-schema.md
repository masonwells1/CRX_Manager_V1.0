# Database Schema Reference (76+ Tables)

## Core Business
- `profiles` - Users (id refs auth.users, email, full_name, role, phone, is_active, applicator_license_number, faa_certificate_number)
- `customers` - Farms (farm_name, assigned_sales_rep, assigned_tier 1-4, credit_limit, finance_charge_rate, prepay_balance)
- `customer_addresses` - Multiple addresses per customer (label, address, delivery_notes, is_default)
- `products` - Product master (product_name, sku, category, vendor, tier1-4 pricing, EPA reg, RUP status, signal_word, product_form)
- `cost_history` - Cost change audit log (product_id, old/new costs and prices, change_note)
- `fields` - Farm fields (customer_id, field_name, county, acres, FSA numbers, Mapbox polygon geometry)
- `field_billing_defaults` - Per-field billing splits (field_id, customer_id, split_pct)
- `vehicles` - Ground/air application equipment (type, capacity, registration, FAA N-number or DOT#, status)

## Quotes & Orders
- `quotes` - Quote headers (quote_number, customer_id, status, tier, totals, is_planned, expires_at)
- `quote_sections` - Sections within a quote (section_name, sort_order)
- `quote_items` - Line items (product_id, section_id, pricing, rates, acres, totals)
- `quote_versions` - Frozen snapshots of sent quotes (version_number, snapshot_data jsonb)
- `orders` - Confirmed orders (order_number, status, totals, order_date). Note: total_paid/balance_due columns are DEPRECATED — AR is tracked via invoices.
- `order_items` - Order line items (quantity_delivered, quantity_remaining)
- `payments` - Legacy payment records (DEPRECATED — use allocation_sets + invoice_line_allocations instead)
- `commissions` - Per-order per-recipient (split_percentage, commission_amount, status, paid_date)

## Inventory
- `inventory` - Stock per product per location (quantity_available, quantity_prebooked, quantity_on_order, reorder_point, min_stock_level)
- `inventory_transactions` - Audit trail (transaction_type: received/booked/delivered/returned/adjusted/transferred)
- `inventory_holds` - Reserved inventory (quantity, hold_type: manual/crop_program, expires_at, is_active, source_id — links to quote for auto-release on accept/decline/expire)
- `purchase_orders` - Supplier POs (po_number, vendor, status, total_cost)
- `purchase_order_items` - PO line items (quantity_ordered, quantity_received, unit_cost)

## Deliveries
- `deliveries` - Delivery headers (delivery_number, order_id, assigned_driver, scheduled_date, status, signature_url, priority, delivery_window_start/end, cancelled_at/by, cancel_reason, issue_type, issue_notes, is_quick_delivery)
- `delivery_items` - Items on delivery (order_item_id, product_id, quantity, tote_number, is_non_returnable)
- `delivery_photos` - Driver-uploaded delivery photos (delivery_id, storage_path, image_url, uploaded_by)
- `delivery_remainders` - Partial delivery remainder items (delivery_id, order_item_id, product_id, remainder_quantity, status: pending/scheduled/delivered/cancelled)

## Receiving
- `receiving_records` - Per-event receiving records (po_id, po_item_id, product_id, quantity_received, condition, lot_number, notes, storage_location, received_by)
- `receiving_photos` - Photos attached to receiving events (receiving_record_id, storage_path, image_url)

## Job Scheduling
- `jobs` - Job headers (status: scheduled/in_progress/completed/cancelled/invoiced, customer, applicator, vehicle, recipe)
- `job_fields` - Fields assigned to a job (many-to-many with sort order)
- `job_chemicals` - Chemicals/products for a job with rates and pricing
- `job_applied_info` - Recorded data when completed: actual times, weather, gallons applied

## Application Records
- `application_records` - Single source of truth for "what was applied, where, when, by whom." Fed from completed jobs AND approved blend tickets. JSONB for products and weather.

## OCR / Blend Tickets
- `blend_tickets` - OCR ticket records (ticket_number, status, review_status, ocr_confidence_score, raw_ocr_text)
- `blend_ticket_products` - Extracted products (product_name, quantity, confidence_score, manually_corrected)
- `blend_ticket_images` - Uploaded images (storage_path, image_url, file_size)
- `ocr_processing_queue` - Background queue (status, priority, retry_count)

## Collaboration
- `team_notes` - Notes/todos/announcements (note_type, priority, assigned_to, is_completed, is_pinned, deleted_at)
- `team_note_comments` - Comments (note_id, content, deleted_at)
- `activity_feed` - Auto-generated event log (event_type, description, related_entity_type/id)
- `notifications` - Per-user notifications (user_id, title, message, notification_type, is_read)

## Billing / Invoices
- `invoices` - Invoice headers (invoice_number, order_id, customer_id, status: draft/posted/void, balance_cents bigint, due_date)
- `invoice_items` - Invoice line items (invoice_id, order_item_id, product_id, quantity, unit_price_cents, line_total_cents)
- `allocation_sets` - Payment-to-invoice allocation groups (payment_id, allocated_at)
- `order_line_allocations` - Payment portions applied to order items
- `invoice_line_allocations` - Payment portions applied to invoice items
- `prepay_credits` - Prepayment credits (customer_id, original_amount_cents, remaining_cents, source_payment_id, reference_number, bucket_label)
- `prepay_applications` - Prepay credit applications to invoices (credit_id, invoice_id, applied_cents)
- `financial_audit_log` - Immutable audit trail (entity_type, entity_id, action, old_data/new_data jsonb, performed_by)

## Accounts Payable
- `vendors` - Vendor master (name UNIQUE, contact_name, phone, email, address, default_payment_terms, default_payment_terms_days, notes, deleted_at)
- `vendor_bills` - AP bills (vendor_id, purchase_order_id nullable, bill_number, bill_date, due_date, payment_terms, subtotal_cents, adjustment_cents, total_cents, paid_cents, balance_cents, status: unpaid/partially_paid/paid/voided, notes, created_by, deleted_at)
- `vendor_payments` - Payments against vendor bills (vendor_bill_id, payment_date, amount_cents, payment_method: check/ach/wire/credit_card, reference_number, notes, created_by)
- `rup_sales_records` - RUP compliance records auto-generated from invoices (invoice_id, invoice_item_id, order_id, customer_id, product_id, sale_date, product_name, epa_registration, quantity, unit, unit_price_cents, total_cents, buyer_name, buyer_certification_number/type/expiry, signal_word, compliance_status: compliant/warning/non_compliant, compliance_notes, season)

## Financial
- `accounting_periods` - Month-end close tracking (status: open/closed)
- `commission_payments` - Commission payment headers (status: unposted/posted)
- `commission_payment_items` - Individual commissions included in a payment
- `write_offs` - Invoice write-off records with reason and approval
- `finance_charges` - Interest charges on overdue invoices
- `prepay_credits` - Customer prepayment credit balances (prepay bucket system)

## Blend Recipes
- `blend_recipes` - Saved blend recipe templates (recipe_name, recipe_number, category, total_cost, total_weight, status)
- `blend_recipe_items` - Recipe ingredients (recipe_id, product_id, quantity, unit, sort_order)
- `blend_ticket_to_order_item` - Links blend tickets to order items (ticket_id, order_item_id)

## Warehouses & Cycle Counts
- `warehouses` - Storage locations (warehouse_name, code, address, is_active, is_default)
- `cycle_counts` - Count sessions (count_number, warehouse_id, status: in_progress/completed/cancelled, counted_by)
- `cycle_count_items` - Individual count lines (cycle_count_id, product_id, expected_qty, counted_qty, variance, variance_pct, resolved)

## Returns
- `returns` - Return/RMA headers (return_number, order_id, customer_id, status: requested/approved/received/credited/rejected, return_type, reason_category)
- `return_items` - Return line items (return_id, order_item_id, product_id, quantity, unit_price, restocked, sort_order)

## Compliance
- `applicator_licenses` - Applicator license tracking (customer_id, license_number, license_type: private/commercial/public, holder_name, state, expiry_date, certification_categories text[])

## Rebates
- `rebate_programs` - Manufacturer rebate programs (program_name, manufacturer, season, product_id, rebate_type, rebate_amount, start_date, end_date, status)
- `rebate_claims` - Rebate claims (program_id, claim_number, quantity, claim_amount_cents, status: pending/submitted/approved/paid/rejected)

## Config
- `app_settings` - Key-value settings (setting_key, setting_value)
- `ingredient_map` - Brand to generic product mapping
- `unit_conversions` - Unit conversion factors (unit, factor_oz)

---

## RLS Policy Matrix

| Table | SELECT | INSERT | UPDATE | DELETE |
|-------|--------|--------|--------|--------|
| profiles | All authenticated | Own/Admin | Own/Admin | - |
| products | All authenticated | Admin | Admin | Admin |
| cost_history | Admin | Admin | - | - |
| customers | Admin / Sales Rep (assigned) / Driver (has delivery) | Admin / Sales Rep | Admin / Sales Rep (assigned) | Admin |
| customer_addresses | All authenticated | Admin / Sales Rep (own customer) | Admin / Sales Rep (own customer) | Admin |
| quotes | Admin / Sales Rep | Admin / Sales Rep (own) | Admin / Sales Rep (own) | Admin |
| quote_sections | All authenticated | Admin / Sales Rep (quote owner) | Admin / Sales Rep (quote owner) | Admin / Sales Rep (quote owner) |
| quote_items | All authenticated | Admin / Sales Rep (quote owner) | Admin / Sales Rep (quote owner) | Admin / Sales Rep (quote owner) |
| quote_versions | All authenticated | Admin / Sales Rep (quote owner) | - | - |
| orders | Admin / Sales Rep | Admin / Sales Rep | Admin | Admin |
| order_items | Admin / Sales Rep | Admin / Sales Rep | Admin | Admin |
| inventory | Admin / Sales Rep / Driver | Admin | Admin | Admin |
| inventory_transactions | Admin / Sales Rep | Admin / Sales Rep | - | - |
| inventory_holds | Admin / Sales Rep | Admin / Sales Rep | Admin | Admin |
| purchase_orders | Admin / Sales Rep | Admin | Admin | Admin |
| purchase_order_items | Admin / Sales Rep | Admin | Admin | Admin |
| receiving_records | Admin / Sales Rep | Admin / Sales Rep | - | Admin |
| receiving_photos | Admin / Sales Rep | Admin / Sales Rep | - | Admin |
| deliveries | Admin / Sales Rep / Driver (assigned) | Admin / Sales Rep | Admin / Sales Rep / Driver (assigned) | Admin |
| delivery_items | Admin / Sales Rep / Driver (via delivery) | Admin / Sales Rep | Admin / Sales Rep | Admin / Sales Rep |
| delivery_photos | Admin / Sales Rep / Driver | Admin / Sales Rep / Driver | - | Admin |
| delivery_remainders | Admin / Sales Rep / Driver | Admin / Sales Rep | Admin / Sales Rep | Admin |
| commissions | Admin / Sales Rep (own recipient) | Admin | Admin | - |
| payments | Admin / Sales Rep | Admin / Sales Rep | Admin | Admin |
| team_notes | All authenticated | Own created_by | Own created_by / Admin | Admin |
| team_note_comments | All authenticated | Own created_by | - | - |
| activity_feed | All authenticated | Own performed_by | - | - |
| notifications | Own user_id | All authenticated | Own user_id | - |
| app_settings | All authenticated | Admin | Admin | - |
| blend_tickets | All authenticated | Own uploaded_by | Own uploaded_by / Admin | - |
| ingredient_map | All authenticated | Admin | Admin | Admin |
| unit_conversions | All authenticated | Admin | Admin | - |
| invoices | Admin / Sales Rep | Admin / Sales Rep | Admin | Admin |
| invoice_items | Admin / Sales Rep | Admin / Sales Rep | Admin | Admin |
| allocation_sets | Admin / Sales Rep | Admin / Sales Rep | - | Admin |
| order_line_allocations | Admin / Sales Rep | Admin / Sales Rep | - | Admin |
| invoice_line_allocations | Admin / Sales Rep | Admin / Sales Rep | - | Admin |
| prepay_credits | Admin / Sales Rep | Admin / Sales Rep | Admin | - |
| prepay_applications | Admin / Sales Rep | Admin / Sales Rep | - | Admin |
| financial_audit_log | Admin | All authenticated | - | - |
| blend_recipes | All authenticated | Admin / Sales Rep | Admin / Sales Rep | Admin |
| blend_recipe_items | All authenticated | Admin / Sales Rep | Admin / Sales Rep | Admin / Sales Rep |
| blend_ticket_to_order_item | All authenticated | Admin / Sales Rep | - | Admin |
| warehouses | All authenticated | Admin | Admin | Admin |
| cycle_counts | Admin | Admin | Admin | Admin |
| cycle_count_items | Admin | Admin | Admin | Admin |
| fields | Admin / Sales Rep (assigned customer) | Admin / Sales Rep | Admin / Sales Rep | Admin |
| field_billing_defaults | Admin / Sales Rep | Admin / Sales Rep | Admin / Sales Rep | Admin / Sales Rep |
| returns | Admin / Sales Rep | Admin / Sales Rep | Admin | Admin |
| return_items | Admin / Sales Rep | Admin / Sales Rep | Admin | Admin |
| applicator_licenses | Admin / Sales Rep | Admin | Admin | Admin |
| rebate_programs | Admin | Admin | Admin | Admin |
| rebate_claims | Admin | Admin | Admin | Admin |
| vendors | All authenticated | Admin | Admin | Admin |
| vendor_bills | Admin | Admin | Admin | Admin |
| vendor_payments | Admin | Admin | - | - |
| rup_sales_records | Admin | Admin | - | - |
| email_log | Admin | Admin | - | - |
| ar_reminder_tracking | Admin | - | - | - |
