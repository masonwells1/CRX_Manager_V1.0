# Database Schema Reference (95 Tables)

## Core Business
- `profiles` - Users (id refs auth.users, email, full_name, role, phone, is_active, applicator_license_number, faa_certificate_number)
- `customers` - Farms (farm_name, assigned_sales_rep, assigned_tier 1-4, credit_limit, finance_charge_rate, prepay_balance)
- `customer_addresses` - Multiple addresses per customer (label, address, delivery_notes, is_default)
- `products` - Product master (product_name, sku, category, vendor, tier1-4 pricing, EPA reg, RUP status, signal_word, product_form, notes [grower description], internal_notes [internal only])
- `cost_history` - Cost change audit log (product_id, old/new costs and prices, change_note)
- `fields` - Farm fields (customer_id, field_name, county, acres, FSA numbers, Mapbox polygon geometry)
- `field_billing_defaults` - Per-field billing splits (field_id, customer_id, split_pct)
- `field_polygons` - Multi-polygon support per field (field_id, polygon_geojson jsonb, label, acres, sort_order). Sibling to `fields.parent_field_id` grouping; migration 20260334900000 (Field Management V3)
- `vehicles` - Ground/air application equipment (type, capacity, registration, FAA N-number or DOT#, status)
- `application_services` - Named application services with per-acre pricing (name, vehicle_id, default_rate_per_acre_cents, cost_per_acre_cents, is_active). Services like "Hagie Y-Drop Nitrogen" or "Rogator Application"
- `customer_application_rates` - Per-customer rate overrides for application services (~5% of customers). UNIQUE(customer_id, application_service_id, season)

## Quotes & Orders
- `quotes` - Quote headers (quote_number, customer_id, status, tier, totals, is_planned, expires_at)
- `quote_sections` - Sections within a quote (section_name, sort_order, field_id)
- `quote_items` - Line items (product_id, section_id, pricing, rates, acres, totals)
- `quote_versions` - Frozen snapshots of sent quotes (version_number, snapshot_data jsonb)
- `quote_pdf_templates` - Saved column presets for quote PDF generation (template_name, columns jsonb)
- `quote_templates` - Reusable quote structures (template_name, description, created_by)
- `quote_template_sections` - Sections within a quote template (section_name, sort_order)
- `quote_template_items` - Items within a template section (product_id, pricing defaults)
- `orders` - Confirmed orders (order_number, status, totals, order_date, customer_po_number, is_planned, season, program_notes). Note: `total_paid`/`balance_due` columns were DROPPED — AR is tracked via `invoices.balance_cents`.
- `order_items` - Order line items (quantity_delivered, quantity_remaining, notes, **cost_at_time_cents** bigint — snapshot of `products.current_cost` at insert time, populated by `trg_snapshot_order_item_cost` BEFORE INSERT trigger; migration 20260513050000, audit #32)
- `payments` - Legacy payment records (DEPRECATED — use allocation_sets + invoice_line_allocations instead)
- `commissions` - Per-order per-recipient (split_percentage, commission_amount numeric dollars, status CHECK: pending/paid/cancelled, paid_date)

## Inventory
- `inventory` - Stock per product per location (quantity_available, quantity_prebooked, quantity_on_order, reorder_point, min_stock_level, manufactured_at_delivery — P4-7 phantom-row flag, default false)
- `inventory_transactions` - Audit trail (transaction_type CHECK: received/booked/delivered/returned/adjusted/transferred/job_applied/cancelled_delivery_reversal/void_delivery_reversal/prebooked/released)
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
- `jobs` - Job headers (status: scheduled/in_progress/completed/cancelled/invoiced, customer, applicator, vehicle, recipe, priority, estimated_hours, quote_id, quote_section_id)
- `job_fields` - Fields assigned to a job (many-to-many with sort order)
- `job_chemicals` - Chemicals/products for a job with rates and pricing
- `job_applied_info` - Recorded data when completed: actual times, weather, gallons applied

## Application Records
- `application_records` - Single source of truth for "what was applied, where, when, by whom." Fed from completed jobs AND approved blend tickets. JSONB for products and weather.
- `application_record_fields` - Per-field rows linked to an application_record (application_record_id, field_id, acres, sort_order) — normalizes the fields covered by a single application event

## OCR / Blend Tickets
- `blend_tickets` - OCR ticket records (ticket_number, status, review_status, ocr_confidence_score, raw_ocr_text, job_id, application_service_id)
- `blend_ticket_products` - Extracted products (product_name, quantity, confidence_score, manually_corrected, unit_cost_cents, unit_price_cents)
- `blend_ticket_images` - Uploaded images (storage_path, image_url, file_size)
- `blend_ticket_fields` - Per-field application tracking (field_id, customer_id, planned_acres, actual_acres, applied_at)
- `ocr_processing_queue` - Background queue (status, priority, retry_count)

## Collaboration
- `team_notes` - Notes/todos/announcements (note_type, priority, assigned_to, is_completed, is_pinned, deleted_at, linked_entity_type, linked_entity_id)
- `team_note_comments` - Comments (note_id, content, deleted_at)
- `team_note_attachments` - Photo attachments for notes (note_id, file_url, file_name, file_type, file_size_bytes, uploaded_by). Storage bucket: `team-note-attachments`
- `note_tags` - Tag definitions for team notes (name UNIQUE, color, created_by)
- `team_note_tags` - Junction table linking notes to tags (note_id, tag_id — composite PK)
- `note_activity_log` - Audit trail for note changes (note_id, user_id, action_type, changes jsonb)
- `activity_feed` - Auto-generated event log (event_type, description, related_entity_type/id)
- `notifications` - Per-user notifications (user_id, title, message, notification_type, is_read)

## Billing / Invoices
- `invoices` - Invoice headers (invoice_number, order_id, customer_id, delivery_id [auto-set by complete_delivery, NULL for non-delivery invoices], status: draft/posted/void, balance_cents bigint [GENERATED, CHECK >= 0 added 2026-05-13 audit #19], due_date, invoice_group_id, application_service_id [Phase 1: persists service for fee calculation])
- `invoice_items` - Invoice line items (invoice_id, order_item_id, product_id, quantity, unit_price_cents, line_total_cents, quoted_price_cents, price_source)
- `allocation_sets` - Payment-to-invoice allocation groups (payment_id, allocated_at, customer_id, total_payment_cents, total_allocated_cents, payment_method, reference_number, check_number, payment_date, season)
- `order_line_allocations` - Payment portions applied to order items
- `invoice_line_allocations` - Payment portions applied to invoice items
- `prepay_credits` - Prepayment credits (customer_id, original_amount_cents, remaining_cents, source_payment_id, reference_number, bucket_label, source_type, source_reference)
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

## Blend Recipes
- `blend_recipes` - Saved blend recipe templates (recipe_name, recipe_number, category, total_cost, total_weight, status)
- `blend_recipe_items` - Recipe ingredients (recipe_id, product_id, quantity, unit, sort_order)
- `blend_ticket_to_order_items` - Links blend tickets to order items (blend_ticket_id, order_id, order_item_id, linked_by)

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
- `rebate_claims` - Rebate claims (program_id, claim_number UNIQUE, quantity, claim_amount_cents, paid_amount_cents, status: pending/submitted/approved/paid/rejected). UNIQUE on `claim_number` added by migration 20260513000000 (audit #33).
- `rebate_claim_counters` - Per-year atomic counter for `RC-YYYY-NNNN` claim numbers (year PK, next_value). System table — RLS on, no policies; written only by `create_rebate_claim()` RPC. Migration 20260513000000 (audit #33).

## Email & Notifications
- `email_log` - Email audit trail with idempotency (email_type, recipient, subject, status, idempotency_key)
- `ar_reminder_tracking` - AR reminder deduplication (customer_id, reminder_level, sent_at)
- `failed_notifications` - Failed notification retry queue (notification_type, entity_type, entity_id, error_message, attempts, max_attempts, resolved_at)

## Billing Shares
- `invoice_shares` - Split-bill invoice shares (invoice_id, customer_id, customer_name, split_percentage, acres, amount_cents, is_primary, sort_order)
- `order_shares` - Split-bill order shares (order_id, customer_id, customer_name, split_percentage, amount_cents, is_primary, sort_order)

## Crop History
- `field_crop_history` - Tracks multi-year crop rotation per field per season (id, field_id, season, crop_type, variety, planting_date, harvest_date, yield_per_acre, yield_unit, notes, created_at). Auto-populated via `snapshot_field_crop_history()` trigger on field crop_type changes. RLS enabled for authenticated users.

## Document Processing
- `document_processing_log` - OCR/document processing audit (user_id, document_type CHECK: invoice/purchase_order/price_list/product_list/customer_list/quote_list, file_name, file_size_bytes, page_count, processing_time_ms, confidence, items_extracted, success, error_message)

## System / Infrastructure
- `idempotency_keys` - Idempotent operation cache (idempotency_key UNIQUE, operation, result jsonb, expires_at — auto-cleanup after 24h)
- `rate_limit_log` - Rate limiting tracker (user_id, operation, created_at — accessed only by SECURITY DEFINER functions)
- `rate_limits` - Per-user sliding-window counter (user_id, action_name, window_start, request_count — accessed only by SECURITY DEFINER functions)

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
| team_note_attachments | All authenticated | Own uploaded_by | Own uploaded_by / Admin | - |
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
| blend_ticket_to_order_items | All authenticated | Admin / Sales Rep | - | Admin |
| blend_ticket_fields | All authenticated | All authenticated | All authenticated | All authenticated |
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
| failed_notifications | Admin | Admin | Admin | - |
| invoice_shares | Admin / Sales Rep | Admin / Sales Rep | - | Admin |
| order_shares | Admin / Sales Rep | Admin / Sales Rep | - | Admin |
| document_processing_log | Own user_id | Own user_id | - | - |
| idempotency_keys | - (SECURITY DEFINER only) | - (SECURITY DEFINER only) | - | - |
| rate_limit_log | - (SECURITY DEFINER only) | - (SECURITY DEFINER only) | - | - |
| note_tags | All authenticated | All authenticated | Admin / Own | Admin |
| team_note_tags | All authenticated | All authenticated | - | All authenticated |
| note_activity_log | All authenticated | All authenticated | - | - |
| field_crop_history | All authenticated | All authenticated | All authenticated | - |

| field_app_locations | All authenticated | All authenticated | All authenticated | All authenticated |
| field_app_location_shares | All authenticated | All authenticated | All authenticated | All authenticated |

## Field Application Workflow V2 / Phase 1 (2026-04-29)
- `field_app_locations` - Links fields to invoices or jobs (id uuid PK, invoice_id, job_id, **invoice_group_id**, field_id, map_number, total_acres, planted_acres, applied_acres, crop_type, wind_direction, sort_order). **Phase 1:** added `invoice_group_id` and updated CHECK to allow `invoice_id IS NOT NULL OR job_id IS NOT NULL OR invoice_group_id IS NOT NULL`. For multi-customer grouped invoices, locations live at the group level; single-customer invoices keep `invoice_id`. RLS: all ops for authenticated.
- `field_app_location_shares` - Per-location customer billing splits (id uuid PK, location_id FK, customer_id FK, split_pct numeric, acres numeric, amount_cents bigint). **Phase 1:** carries the TRUE per-customer split for each field — even for grouped invoices, each field has one row per customer with their actual `split_pct`. Canonical audit source for "what fields contributed to which customer's invoice." RLS: all ops for authenticated.

> **Note (Phase 1):** `invoice_shares` is still populated for every invoice (one 100% row per child invoice with `price_per_acre_cents`/`pricing_note` propagated when grower-share mode applies) for PDF/statement compatibility, but it is NOT the AR keying surface — AR is keyed off `invoices.customer_id` directly. For per-field per-customer audit, use `field_app_location_shares`.
