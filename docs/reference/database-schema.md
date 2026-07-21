# Database Schema Reference (135 Tables + 2 views)

> Count as of 2026-07-17, verified live against Supabase project `rhyzpcqhnizqbxphqdkr` (`SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'` / `'VIEW'`). The per-table sections below are a curated tour, not an exhaustive enumeration of all 135 tables; **`.claude/schema-registry.json`** (refreshed from live introspection through ledger `20260717045420`) is the machine-readable source of truth for current columns, constraints, and enum values — prefer it over this prose doc when a fact is load-bearing.

## Core Business
- `profiles` - Users (id refs auth.users, email, full_name, role, phone, is_active, applicator_license_number, faa_certificate_number)
- `customers` - Farms (farm_name, assigned_sales_rep, assigned_tier 1-4, credit_limit, finance_charge_rate, prepay_balance)
- `customer_addresses` - Multiple addresses per customer (label, address, delivery_notes, is_default)
- `products` - Product master (product_name, sku, category, vendor, tier1-4 pricing, EPA reg, RUP status, signal_word, rei_hours [WPS restricted-entry interval], phi_days [pre-harvest interval], product_form, notes [grower description], internal_notes [internal only])
- `cost_history` - Cost change audit log (product_id, old/new costs, margins and prices, source/reason, change-set identity, old/new pricing versions, change_note). The Supplier Pricing Phase 1a additive compatibility bootstrap is live; direct legacy history inserts remain temporarily available until the parked enforcement cutover.
- `fields` - Farm fields (customer_id, field_name, county, acres, FSA numbers, Mapbox polygon geometry)
- `field_obstacles` - Point hazards pinned to fields (kind, optional label, GeoJSON Point, created_by). Readable by admin/sales/applicators (matches fields); maintained by admin/sales reps.
- `job_loader_worksheets` - Saved loader/tank scenarios per job (capacity, balancing mode, per-load acres, loads-done, one selected per job). Reads follow job visibility; office-only writes.
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
- `quote_product_draws` - Per-(quote, product) booking draw-down ledger (quantity_drawn, UNIQUE(quote_id, product_id)). Survives quote edits (save_quote recreates quote_items); written only by `draw_down_quote`/`convert_quote_to_order` SECDEF RPCs. Added `20260610145253`
- `quote_pdf_templates` - Saved column presets for quote PDF generation (template_name, columns jsonb)
- `quote_templates` - Reusable quote structures (template_name, description, created_by)
- `orders` - Confirmed orders (order_number, status, totals, order_date, customer_po_number, is_planned, season, program_notes). Note: `total_paid`/`balance_due` columns were DROPPED — AR is tracked via `invoices.balance_cents`.
- `order_items` - Order line items (quantity_delivered, quantity_remaining, notes, **cost_at_time_cents** bigint — snapshot of `products.current_cost` at insert time, populated by `trg_snapshot_order_item_cost` BEFORE INSERT trigger; migration 20260513050000, audit #32)
- `payments` - Legacy payment records (DEPRECATED — use allocation_sets + invoice_line_allocations instead)
- `commissions` - Per-order OR per-job per-recipient (split_percentage, commission_amount numeric dollars, status CHECK: pending/paid/cancelled, paid_date). **U8 (migration `20260707060000`, APPLIED LIVE 2026-07-06):** `order_id` is now nullable; new nullable `job_id`/`invoice_id` FKs give application-channel (job) commissions the same lineage orders always had — `chk_commission_source` CHECK requires at least one of order_id/job_id. `invoice_id` is generation-precise: it's the exact field_application invoice that minted a job commission, so reversal/payout-liveness checks key on it (not job-level liveness, which can't tell an old generation from a fresh one across a void→re-invoice cycle). Partial indexes on both new columns.

## Inventory
- `inventory` - Stock per product per location (quantity_available, quantity_prebooked, quantity_on_order, reorder_point, min_stock_level, manufactured_at_delivery — P4-7 phantom-row flag, default false)
- `inventory_transactions` - Audit trail (transaction_type CHECK: received/booked/delivered/returned/adjusted/transferred/job_applied/cancelled_delivery_reversal/void_delivery_reversal/prebooked/released/prebook_reconciliation)
- `inventory_holds` - Reserved inventory (quantity, hold_type: manual/crop_program, expires_at, is_active, source_id — links to quote for auto-release on accept/decline/expire)
- `purchase_orders` - Supplier POs (po_number, vendor, status, exact dollar `total_cost`, generated bigint `total_cost_cents`)
- `purchase_order_items` - PO line items (quantity_ordered, quantity_received, exact dollar `unit_cost`, generated bigint `unit_cost_cents`)
- `purchase_order_import_intents` - RPC-owned global vendor-document claim for bulk PO imports (intent_key, purchase_order_id, first actor provenance). RLS is enabled with no authenticated direct table access; the claim cascades only when the admin-only PO delete workflow removes its PO.

## Deliveries
- `deliveries` - Delivery headers (delivery_number, order_id, assigned_driver, scheduled_date, status, signature_url, priority, delivery_window_start/end, cancelled_at/by, cancel_reason, issue_type, issue_notes, is_quick_delivery)
- `delivery_items` - Items on delivery (order_item_id, product_id, quantity, tote_number, is_non_returnable)
- `delivery_photos` - Driver-uploaded delivery photos (delivery_id, storage_path, image_url, uploaded_by)
- `delivery_remainders` - Partial delivery remainder items (delivery_id, order_item_id, product_id, remainder_quantity, status: pending/scheduled/delivered/cancelled)

## Receiving
- `receiving_records` - Per-event receiving records (po_id, po_item_id, product_id, quantity_received, condition, lot_number, notes, storage_location, received_by)
- `receiving_photos` - Photos attached to receiving events (receiving_record_id, storage_path, image_url)

## Job Scheduling
- `jobs` - Job headers (status: scheduled/in_progress/completed/cancelled/invoiced, customer, applicator, vehicle, recipe, priority, estimated_hours, quote_id, quote_section_id). **`commission_split` jsonb (U8, migration `20260707060000`, APPLIED LIVE 2026-07-06):** commission-split snapshot locked at job creation via `BEFORE INSERT` trigger `trg_jobs_snapshot_commission_split` — quote-born jobs copy the quote's split, direct jobs copy the customer default. NULL means a pre-U8 job ONLY (resolved once via fallback at first invoicing, then persisted); the empty sentinel `{"splits":[]}` is a deliberately locked "no commission" result, distinct from NULL.
- `job_fields` - Fields assigned to a job (many-to-many with sort order)
- `job_chemicals` - Chemicals/products for a job with rates and pricing
- `job_applied_info` - Recorded data when completed: actual times, weather, gallons applied
- `job_location_dispatches` *(field-app #36 — migration `20260626120000`)* — per-LOCATION dispatch: one CURRENT dispatch per `job_field` (`UNIQUE (job_field_id)`; re-dispatch upserts) to an applicator OR a crew (`(applicator_id IS NOT NULL) <> (crew_id IS NOT NULL)` XOR CHECK), with `dispatched_at`, `dispatch_status` (`dispatched`/`completed`/`cancelled`), `dispatched_by`, denormalized `job_id` + index. RLS: SELECT for job viewers (admin/sales_rep/whole-job applicator) plus the applicator a location was dispatched to **and members of the dispatched crew**; **writes are RPC-only** (no client INSERT/UPDATE/DELETE policy — direct PostgREST writes are RLS-denied for every role, mirroring `application_record_lots`). The `dispatch_job_locations` RPC (SECURITY DEFINER) is the sole write path and enforces the dispatchable-lifecycle + active-assignee + XOR + applicator-license guards a policy can't; anon denied. Additive `jobs` + `job_fields` + `customers` `_select_location_dispatchee` policies (all via the SECURITY DEFINER `_is_dispatched_to_me()` helper, which breaks the jobs↔dispatches policy recursion and excludes cancelled rows) let a per-location-only assignee read the parent job, its location rows, AND the job's customer (all three are embedded by the board). The RPC also requires the parent job to be LIVE (`deleted_at IS NULL`) since it bypasses RLS. The `_is_dispatched_to_me()` helper + the dispatch-row SELECT policy re-check `profiles.is_active`, so a deactivated assignee loses visibility immediately (mirrors `is_applicator()`). Assignee FKs (`applicator_id`/`crew_id`) are `ON DELETE CASCADE` (not SET NULL — SET NULL would violate the XOR check when the sole assignee is deleted).
- `job_dispatch_preservation` *(U13 assignment-unification — migration `20260707020000`, APPLIED LIVE 2026-07-06)* — internal stash table, not a client-facing feature: `save_job` unconditionally deletes+re-inserts `job_fields` on every save, and `job_location_dispatches.job_field_id` is `ON DELETE CASCADE`, so any unrelated JobDetail edit was silently wiping a dispatcher's per-location assignment. Three new trigger functions preserve the dispatch row into this table on the field delete, then restore/re-sync it onto the freshly re-inserted `job_fields` row (matched by location, since the id is regenerated); a fourth trigger closes dispatch rows when the job reaches a terminal status. RLS on, no client INSERT/UPDATE/DELETE/SELECT grants — it's written and read only by the trigger functions (SECURITY DEFINER, anon EXECUTE revoked on all four).

## Application Records
- `application_records` - Single source of truth for "what was applied, where, when, by whom." Fed from completed jobs AND approved blend tickets. JSONB for products and weather.
- `application_record_fields` - Per-field rows linked to an application_record (application_record_id, field_id, acres, sort_order) — normalizes the fields covered by a single application event
- ✅ `application_record_lots` *(B1 — migration `20260622170000` applied 2026-06-23; counted above)* — one row per (application record, product, lot); **multiple lots per product allowed**. Cols: `application_record_id`→application_records (ON DELETE CASCADE), `product_id`→products, `lot_number` (NOT NULL, non-blank CHECK), `source_receiving_record_id`→receiving_records (ON DELETE SET NULL; set when chosen from a received lot), `quantity_from_lot numeric` (non-negative CHECK; informational, no inventory math), `unit`, `notes`, `created_at`, `created_by`. **No `updated_at`** (rows are replaced, not edited). UNIQUE (application_record_id, product_id, lower(btrim(lot_number))). RLS: SELECT admin/sales or applicator-on-own-record; **writes are RPC-only** (no client write policy — direct PostgREST writes are RLS-denied). Source of truth for the lot recall/compliance trace.

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
- `applicator_licenses` - Applicator license tracking; held by a customer OR a staff profile (customer_id uuid NULL, profile_id uuid NULL REFERENCES profiles — CHECK `applicator_licenses_holder_check` requires one holder; license_number, license_type: private/commercial/public, holder_name, state, expiry_date, certification_categories text[], is_active). Staff-held licenses gate job assignment via the `enforce_applicator_license` trigger on `jobs` (migration 20260610185714).

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

## System / Infrastructure
- `idempotency_keys` - Idempotent operation cache (idempotency_key UNIQUE, operation, result jsonb, expires_at — auto-cleanup after 24h)
- `offline_action_receipts` — **LIVE** (`20260714171331`, `20260714171800`, `20260714172135`, `20260714203709`): permanent server acknowledgement for approved offline `complete_delivery` / `complete_job` actions. Immutable client action UUID + permanent idempotency key + optional queued entity `updated_at` snapshot, statuses `received` / `succeeded` / `needs_review`, sanitized target/payload-drift failures, audited `already_completed` / `abandoned` office-resolution metadata, and target-row locking from the final snapshot check through canonical completion. Office resolution never changes the receipt to `succeeded`, never reruns the business action, and never deletes the receipt. Direct authenticated table access remains denied; clients use sanitized RPCs.

### Supplier Pricing Phase 1a — additive bootstrap LIVE; enforcement cutover PARKED

`supabase/migrations/20260717042803_supplier_pricing_phase1a.sql` is the applied-live additive bootstrap: a dedicated `products.pricing_version`, private/RLS-enabled `pricing_workbook_exports` + export rows, `pricing_change_sets` + approved rows + preview rows, three admin-only pricing RPCs, collision-safe fingerprints, durable apply idempotency, and trigger-owned history for governed writes. Supabase ledger version/name: `20260717042803` / `20260717120000_supplier_pricing_phase1a`; the cent-scale hardening is also live as ledger version/name `20260718154131` / `20260718124517_harden_supplier_pricing_cent_scale_and_trigger`. The Phase 1a frontend and OCR pricing-path retirement are merged and live. `scripts/.staging-migrations/20260717121000_supplier_pricing_phase1a_cutover.sql` remains a separate strict-enforcement cutover that removes residual compatibility grants; it is parked and is not current production schema.

### Supplier Pricing Phase 1b — supplier evidence (database LIVE; admin-only)

`20260718225511_supplier_price_evidence_phase1b.sql` is live. It defines `vendor_aliases`, `legacy_vendor_resolution`, `product_supplier_links`, `supplier_price_imports`, `supplier_price_import_rows`, and append-only `supplier_price_observations`. The evidence workflow is manual only: a protected per-supplier `.xlsx` template is transcribed by a person, staged, reviewed, and approved into integer-cent observations. An optional source PDF is private audit evidence and is never parsed. Supplier comparisons use the human-approved directional `inventory_units_per_supplier_unit`; missing or non-equivalent conversions display `cannot compare` instead of a false best price.

The same live migration adds nullable Gate-0 provenance fields to `purchase_order_items`: `product_supplier_link_id`, `supplier_price_observation_id`, `inventory_units_per_supplier_unit_snapshot`, `cost_provenance`, and `cost_snapshot_at`. These are future costing-engine inputs only; Phase 1b does not populate them automatically or change the selected product cost/sell price. Live migration `20260718235717_stage_supplier_vendor_aliases_phase1b.sql` is the separate non-destructive data step mapping the approved `Van Deist` / `Van Diest` spellings to the active `Van Diest Supply` canonical vendor record, alongside the approved `The Andersons` aliases. It records reviewed aliases/resolutions without rewriting vendor, product, or purchase-order data.
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
| quote_product_draws | Admin / Sales Rep | - (SECDEF RPCs only) | - (SECDEF RPCs only) | - (SECDEF RPCs only) |
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
| field_obstacles | Admin / Sales Rep / Applicator | Admin / Sales Rep | Admin / Sales Rep | Admin / Sales Rep |
| job_loader_worksheets | Job-visible (Admin / Sales / assigned Applicator / dispatched) | Admin / Sales Rep | Admin / Sales Rep | Admin / Sales Rep |
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
| idempotency_keys | - (SECURITY DEFINER only) | - (SECURITY DEFINER only) | - | - |
| offline_action_receipts | Owner / Admin / Sales via sanitized RPC only | - (SECURITY DEFINER RPC only) | - (SECURITY DEFINER RPC only) | - |
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
