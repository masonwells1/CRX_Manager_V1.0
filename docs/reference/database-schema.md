# Database Schema Reference (156 tables + 2 views)

> Count as of 2026-08-09, verified live against Supabase project `rhyzpcqhnizqbxphqdkr` (`SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'` / `'VIEW'`). The per-table sections below are a curated tour, not an exhaustive enumeration of all 156 tables; **`.claude/schema-registry.json`** is the machine-readable source of truth for current columns, constraints, and enum values — prefer it over this prose doc when a fact is load-bearing.

## Core Business
- `profiles` - Users (id refs auth.users, email, full_name, role, phone, is_active, applicator_license_number, faa_certificate_number)
- `customers` - Farms (farm_name, assigned_sales_rep, assigned_tier 1-4, credit_limit, finance_charge_rate, prepay_balance, `row_version bigint`). Existing-customer whole-record saves fail closed when the loaded version is stale. Applied live 2026-07-30 as ledger version `20260730235031` (history row 847, submitted as `20260730201230_quote_customer_row_version_guard`); the "LOCAL ONLY pending apply" marker that stood here was stale from that date.
- `customer_addresses` - Multiple addresses per customer (label, address, delivery_notes, is_default)
- `products` - Product master (product_name, sku, category, vendor, tier1-4 pricing, EPA reg, RUP status, signal_word, rei_hours [WPS restricted-entry interval], phi_days [pre-harvest interval], product_form, notes [grower description], internal_notes [internal only])
- `cost_history` - Cost change audit log (product_id, old/new costs, margins and prices, source/reason, change-set identity, old/new pricing versions, change_note). Supplier Pricing Phase 1a is live through its strict enforcement cutover: app roles cannot insert history directly, and the governed pricing trigger is the single writer.
- `fields` - Farm fields (customer_id, field_name, county, acres, FSA numbers, Mapbox polygon geometry)
- `field_obstacles` - Point hazards pinned to fields (kind, optional label, GeoJSON Point, created_by). Readable by admin/sales/applicators (matches fields); maintained by admin/sales reps.
- `job_loader_worksheets` - Saved loader/tank scenarios per job (capacity, balancing mode, per-load acres, loads-done, one selected per job). Reads follow job visibility; office-only writes.
- `field_billing_defaults` - Per-field billing splits (field_id, customer_id, split_pct)
- `field_polygons` - Multi-polygon support per field (field_id, polygon_geojson jsonb, label, acres, sort_order). Sibling to `fields.parent_field_id` grouping; migration 20260334900000 (Field Management V3)
- `vehicles` - Ground/air application equipment (type, capacity, registration, FAA N-number or DOT#, status)
- `application_services` - Named application services with per-acre pricing (name, vehicle_id, default_rate_per_acre_cents, cost_per_acre_cents, is_active). Services like "Hagie Y-Drop Nitrogen" or "Rogator Application". **`cost_per_acre_cents` is admin-only at the column-grant level** (migration `20260729015706`): `authenticated` holds SELECT/INSERT/UPDATE on the other nine columns only, so an ordinary table read never returns cost and `select('*')` on this table fails outright. Admins read it through `admin_get_application_service_costs` and save the whole row — name, rate, cost, vehicle, sort order, active flag — through `admin_save_application_service` (migration `20260729035923`), which writes everything in one transaction so a create can never commit the row without its cost. `admin_set_application_service_cost` still exists but is retained only for one release; see `docs/manual/KNOWN_ISSUES.md` §0d. RLS is untouched — every active profile still reads the row, because drivers need the service name and customer-facing rate. Adding a column to this table means adding it to that grant, or `authenticated` will not see it.
- `customer_application_rates` - Per-customer rate overrides for application services (~5% of customers). UNIQUE(customer_id, application_service_id, season)

## Quotes & Orders
- `quotes` - Quote headers (quote_number, customer_id, status, tier, totals, is_planned, expires_at, `row_version bigint`). The trigger increments the stored version on every quote update; clients use the value returned by `save_quote`, never calculate an increment. Applied live 2026-07-30 alongside the `customers` half above — same migration, same ledger version `20260730235031`.
- `quote_sections` - Sections within a quote (section_name, sort_order, field_id)
- `quote_items` - Line items (product_id, section_id, pricing, rates, acres, totals)
- `quote_versions` - Frozen snapshots of sent quotes (version_number, snapshot_data jsonb). Client-writable no longer: `20260813080000_lock_quote_versions_writes_to_rpc` (**CRX-SEC-1**) applied live as ledger version `20260816174353` and dropped the `qversions_insert` policy, leaving `qversions_select` as the only policy and `create_quote_version` as the only **browser-reachable** writer. `service_role` and `postgres` retain direct INSERT/UPDATE/DELETE grants and bypass RLS, so an edge function or the table owner can still write directly — verified live 2026-08-19 against `information_schema.role_table_grants`. Re-read live 2026-08-18: `has_table_privilege('authenticated', …, 'INSERT'/'UPDATE'/'DELETE')` all false. The "LOCAL ONLY pending apply" marker that stood on the RLS matrix row below was stale from that apply. **Pending (`20260826220000`, PR #401, NOT APPLIED):** adds nullable `restore_trusted_at timestamptz`, a server-issued marker stamped by `create_quote_version` on its own first successful insert and by no other **browser-reachable** writer. The migration adds no trigger or column-level restriction, so the same `service_role`/`postgres` RLS bypass noted above can set `restore_trusted_at` directly — the marker constrains the browser path, not the privileged one. `restore_quote_version` then refuses an unmarked version with `QUOTE_VERSION_LEGACY_UNTRUSTED` before any quote or money row is rebuilt. Existing rows are deliberately NOT backfilled, so pre-boundary snapshots stay readable but non-restorable.
- `quote_product_draws` - Per-(quote, product) booking draw-down ledger (quantity_drawn, UNIQUE(quote_id, product_id)). Survives quote edits (save_quote recreates quote_items); written only by `draw_down_quote`/`convert_quote_to_order` SECDEF RPCs. Added `20260610145253`
- `quote_pdf_templates` - Saved column presets for quote PDF generation (template_name, columns jsonb)
- `quote_templates` - Reusable quote structures (template_name, description, created_by)
- `orders` - Confirmed orders (order_number, status, totals, order_date, customer_po_number, is_planned, season, program_notes). Note: `total_paid`/`balance_due` columns were DROPPED — AR is tracked via `invoices.balance_cents`.
- `order_items` - Order line items (quantity_delivered, quantity_remaining, notes, **cost_at_time_cents** bigint — snapshot of `products.current_cost` at insert time, populated by `trg_snapshot_order_item_cost` BEFORE INSERT trigger; migration 20260513050000, audit #32)
- `payments` - Legacy payment records (DEPRECATED — use allocation_sets + invoice_line_allocations instead)
- `commissions` - Per-order OR per-job per-recipient (split_percentage, commission_amount numeric dollars, status CHECK: pending/paid/cancelled, paid_date). **LOCAL CANDIDATE `20260903150100`, NOT LIVE:** nullable `cancelled_at` plus `cancelled_amount_cents bigint` preserve the cancellation time and exact pre-zero amount; one trigger stamps every transition to cancelled and prevents reopening a cancelled row. The two legacy zero-dollar cancellations remain NULL-stamped. **U8 (migration `20260707060000`, APPLIED LIVE 2026-07-06):** `order_id` is now nullable; new nullable `job_id`/`invoice_id` FKs give application-channel (job) commissions the same lineage orders always had — `chk_commission_source` CHECK requires at least one of order_id/job_id. `invoice_id` is generation-precise: it's the exact field_application invoice that minted a job commission, so reversal/payout-liveness checks key on it (not job-level liveness, which can't tell an old generation from a fresh one across a void→re-invoice cycle). Partial indexes on both new columns.

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
- `commission_payments` - Commission payment headers (status: unposted/posted/voided). **LOCAL CANDIDATE `20260903150100`, NOT LIVE:** `voided_at timestamptz` and `voided_by uuid` are stamped by the existing void lifecycle so historical reports can keep a payment before its later void and exclude it afterward.
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
- `returns` - Return/RMA headers (return_number, order_id, customer_id, status: requested/approved/received/credited/rejected/cancelled, reason, reason_notes, total_credit_cents, credit_invoice_id, cancelled_at, cancelled_by, cancellation_reason, credited_by)
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
- `idempotency_keys` - Idempotent operation cache (idempotency_key UNIQUE, operation, result jsonb, expires_at — auto-cleanup after 24h). **LIVE** via ledger version `20260803010917` (`bind_idempotency_to_mutation_intent`): optional server-derived `request_fingerprint` + `request_actor_id` bindings.
- `offline_action_receipts` — **LIVE** (`20260714171331`, `20260714171800`, `20260714172135`, `20260714203709`): permanent server acknowledgement for approved offline `complete_delivery` / `complete_job` actions. Immutable client action UUID + permanent idempotency key + optional queued entity `updated_at` snapshot, statuses `received` / `succeeded` / `needs_review`, sanitized target/payload-drift failures, audited `already_completed` / `abandoned` office-resolution metadata, and target-row locking from the final snapshot check through canonical completion. Office resolution never changes the receipt to `succeeded`, never reruns the business action, and never deletes the receipt. Direct authenticated table access remains denied; clients use sanitized RPCs.

### Supplier Pricing Phase 1a — additive bootstrap and enforcement cutover LIVE

`supabase/migrations/20260717042803_supplier_pricing_phase1a.sql` is the applied-live additive bootstrap: a dedicated `products.pricing_version`, private/RLS-enabled `pricing_workbook_exports` + export rows, `pricing_change_sets` + approved rows + preview rows, three admin-only pricing RPCs, collision-safe fingerprints, durable apply idempotency, and trigger-owned history for governed writes. Supabase ledger version/name: `20260717042803` / `20260717120000_supplier_pricing_phase1a`; the cent-scale hardening is also live as ledger version/name `20260718154131` / `20260718124517_harden_supplier_pricing_cent_scale_and_trigger`. The strict cutover is live as `supabase/migrations/20260718190000_supplier_pricing_phase1a_cutover.sql`: direct Product pricing and `cost_history` writes are denied to app roles, while Product-page, Products-list, and worksheet edits continue through the governed preview/apply RPCs. The Phase 1a frontend and OCR pricing-path retirement are also merged and live. `scripts/.staging-migrations/SUPERSEDED-20260717121000_supplier_pricing_phase1a_cutover.sql` is the historical pre-promotion artifact and must not be applied.

### Supplier Pricing Phase 1b — supplier evidence (database LIVE; admin-only)

`20260718225511_supplier_price_evidence_phase1b.sql` is live. It defines `vendor_aliases`, `legacy_vendor_resolution`, `product_supplier_links`, `supplier_price_imports`, `supplier_price_import_rows`, and append-only `supplier_price_observations`. The evidence workflow is manual only: a protected per-supplier `.xlsx` template is transcribed by a person, staged, reviewed, and approved into integer-cent observations. An optional source PDF is private audit evidence and is never parsed. Supplier comparisons use the human-approved directional `inventory_units_per_supplier_unit`; missing or non-equivalent conversions display `cannot compare` instead of a false best price.

The same live migration adds nullable Gate-0 provenance fields to `purchase_order_items`: `product_supplier_link_id`, `supplier_price_observation_id`, `inventory_units_per_supplier_unit_snapshot`, `cost_provenance`, and `cost_snapshot_at`. These are future costing-engine inputs only; Phase 1b does not populate them automatically or change the selected product cost/sell price. Live migration `20260718235717_stage_supplier_vendor_aliases_phase1b.sql` is the separate non-destructive data step mapping the approved `Van Deist` / `Van Diest` spellings to the active `Van Diest Supply` canonical vendor record, alongside the approved `The Andersons` aliases. It records reviewed aliases/resolutions without rewriting vendor, product, or purchase-order data.

### Supplier Pricing Phase 2 — governed Product cost basis (database LIVE; rollout flag off)

Live migration `20260722015019_supplier_cost_basis_phase2.sql` adds two RPC-only, RLS-enabled tables. `product_cost_basis` is the append-only selected-cost ledger with one active row per Product and explicit supplier-observation, received-PO-item, or manual provenance. `product_cost_basis_change_rows` binds that provenance plus the expected Product pricing version and active-basis identity to an existing Phase 1a preview, preventing both pricing drift and same-dollar concurrent-selection overwrite. The migration fills the PO conversion snapshot with `1` and persists the effective Product inventory-unit identity only when a PO line matches the Product inventory unit. Insert and first-receipt triggers derive only that safe same-unit fact; mismatched supplier/package units remain unresolved. Preview, apply, workspace, and history normalization reject stale unit evidence. Money remains bigint cents.

The live feature flag `app_settings.supplier_cost_basis_enabled` remains `false`. The migration baseline copied governed Product costs into history without changing Product cost, tier prices, or `cost_history`. While the global flag remains off, Phase 1a Product edits stay compatible and atomically append matching manual basis rows. The schema and RPCs are live through ledger high-water `20260722064814`; supplier/actual-purchase selection is enabled only for the exact ten Wells canary Products through the private allowlist.

Live migration `20260722064814_wells_cost_basis_rollout_gate.sql` (submitted as `20260722060644_wells_cost_basis_rollout_gate`) enables a Product-scoped canary without turning on the global flag. Its private `product_cost_basis_rollout` table contains only the ten reviewed Wells pilot Products and has RLS plus a deny-all policy with no direct browser-role grants. Supplier/actual-purchase selection is enabled for those ten Products through the allowlist; non-pilot Products retain Phase 1a quick edits. A later global flag enable remains a separate full-rollout decision. Live postflight confirmed the exact 10-row allowlist and helper answers, with Product money unchanged.

Release order is fail-closed: the migration requires the global flag to be exactly `false`, then enables only the ten locked and revalidated Wells Products through the private allowlist. Global enablement remains a separate owner-approved full-rollout action.

Live migration `20260722091359_supplier_pricing_workbook_v2_product_info.sql` completes the Phase 2 workbook fast-follow. `products.quoting_notes` supplies customer-facing quote-line/PDF guidance, `pricing_workbook_exports.format_version = 'crx-product-pricing-phase2-v2'` identifies the new fixed workbook contract, and each export row snapshots the six editable fields: suggested rate, per-acre rate/unit, use timing, internal notes, and quoting notes. Product name/category/SKU/package identity remain protected manifest fields. Private `product_info_change_set_rows` records approved before/after metadata beside the existing pricing change set without granting browser roles direct table access. Format-v1 exports are expired and rejected. Product information and pricing apply atomically through the governed RPC; information-only changes create no cost-history or cost-basis record.

### Supplier Pricing Phase 3 Stage A — return-policy foundation (database LIVE; dormant)

Submitted migration `20260722222743_product_families_return_policy_foundation` is live under Supabase ledger version `20260723193312`; the reconciled disk file is `20260723193312_product_families_return_policy_foundation.sql`. It adds the RLS-enabled, authenticated-select-only `product_families` table and four dormant Product metadata columns: `product_family_id`, `return_policy`, `packaging_variant`, and `is_full_tote_only`. All Products retain the compatibility defaults (`product_family_id NULL`, `return_policy='unknown'`, `packaging_variant NULL`, `is_full_tote_only=false`), so returns continue as before until a separately approved classification stage. The governed metadata setter, return-policy checks, and return lifecycle lock/validation triggers are live, but app roles cannot mutate Phase 3 metadata and the setter is not executable by `anon`, `authenticated`, or `service_role`. Postflight confirmed 604 Products unchanged, zero classifications and family rows, enabled Phase 3 triggers, and helper functions pinned to `search_path=public, pg_temp`; `supplier_cost_basis_enabled` remains `false`. **The "zero classifications" statement above is a Stage A postflight fact, not a standing one — see Stage C immediately below.**

### Supplier Pricing Phase 3 Stage C — owner-approved classification (APPLIED LIVE 2026-07-29)

Migration `20260729213733_supplier_pricing_phase3c_return_policy_classification.sql` is **applied live** (authored `20260729195901`, B7-renamed to the server-assigned ledger version; rename only, body unchanged). It is data-only — no DDL, no CHECK change, no function or grant change — and supplies the classification data that activates the already-live Stage B guard `assert_phase3_return_policy()`. Of 604 Products: 21 move to `return_policy='no_return'` (each states NO RETURN in its own product name and carries a supplier SKU ending in `NR`), 10 of those 21 also get `is_full_tote_only=true`, 2 move to `return_policy='returnable'` as explicit owner overrides, and the remaining 581 stay at `'unknown'` and are not touched. Rows are addressed by primary key rather than SKU because one supplier SKU is duplicated across two rows that receive opposite policies, and because keying on id keeps catalog names and SKUs out of version control. `product_family_id` and `packaging_variant` are deliberately left untouched — family grouping is parked.

The migration cannot call `set_product_phase3_metadata()` (that RPC requires `auth.uid()` plus a mandatory idempotency key, and a migration has no authenticated actor), so it reproduces the RPC's protocol step for step against the same helpers and in the same order: `lock_phase3_product_policy_products()` → verify expected prior state → `assert_phase3_product_metadata_change_safe()` → authorize → UPDATE → de-authorize. It is fail-closed and re-runnable: `PHASE3C_TARGET_DRIFT` if the reviewed 23 rows are not all present, `PHASE3C_UNEXPECTED_PRIOR_STATE` if any target was already classified by another path, and four `PHASE3C_POSTCHECK_FAILED` assertions on the end state including a catalog-wide check that no unreviewed product ends up `no_return`. Note that `is_full_tote_only` has no enforcement anywhere in the schema — it drives only a UI badge in `src/components/products/ProductOptionPresentation.tsx`.

Live postflight: catalog 604 Products → `no_return`=21, `returnable`=2, `unknown`=581, `not_applicable`=0, and `is_full_tote_only`=10 with all ten inside the `no_return` set. The Stage B guard is no longer dormant — `assert_phase3_return_policy()` raises `P0001 RETURN_POLICY_NO_RETURN` for a classified Product and returns cleanly for both `returnable` overrides and an untouched `unknown` Product.
- `rate_limit_log` - Rate limiting tracker (user_id, operation, created_at — accessed only by SECURITY DEFINER functions)
- `rate_limits` - Per-user sliding-window counter (user_id, action_name, window_start, request_count — accessed only by SECURITY DEFINER functions)

## Config
- `app_settings` - Key-value settings (setting_key, setting_value)
- `ingredient_map` - Brand to generic product mapping
- `unit_conversions` - Unit conversion factors (unit, factor_oz)

---

## RLS Policy Matrix

> ⚠️ **Hand-kept snapshot — `pg_policies` on live is the source of truth.** If you
> are debugging a silent RLS denial, believe live, not this table, and never
> "fix" reality to match a row here (re-adding a revoked permissive policy
> re-opens a closed hole).
>
> **Last full reconcile: 2026-08-19 UTC** (
> UTC runs one calendar day ahead here). All 79 rows were compared against
> live `pg_policies` (read-only), per command — 75 of them mechanically, and
> the 4 deny-all tables by reading their policy bodies instead, for the reason
> given below. 29 rows disagreed with live and were corrected from the live
> policy expressions: 12 shared with the matrix in
> `docs/workflows/RLS_SECURITY_GUIDE.md` (`cost_history`, `quote_items`,
> `quote_versions`, `inventory_holds`, `receiving_records`, `delivery_photos`,
> `commissions`, `payments`, `team_note_comments`, `notifications`, `returns`,
> `return_items`) and 17 appearing only here (`receiving_photos`,
> `team_note_attachments`, `blend_tickets`, `allocation_sets`,
> `order_line_allocations`, `invoice_line_allocations`, `prepay_credits`,
> `prepay_applications`, `blend_ticket_to_order_items`, `vendors`,
> `vendor_payments`, `ar_reminder_tracking`, `failed_notifications`,
> `invoice_shares`, `order_shares`, `rate_limit_log`, `field_crop_history`).
>
> Three further rows changed here for **notation only, with no change in
> access**: `idempotency_keys`, `product_cost_basis` and
> `product_cost_basis_change_rows` were each stating their deny-all shape one
> way in some commands and another way in the rest, and now state it
> consistently across all four. That is 32 rows from the presence pass — 29
> corrections plus 3 notation fixes. The role-wording pass described below
> then changed 12 rows, 7 of them *further* rows (the other 5 were already
> among the 32), and the hand-triage after it changed 31 rows, 22 of them new
> again. Re-measured by keying both matrices on table name and comparing all
> four command cells, this file's matrix carries **62 changed rows against
> `main` overall**, out of 79. Two earlier revisions of this banner were
> wrong: **39** counted only the presence and role-wording passes and stopped
> before the hand-triage, and **61** came from summing the per-pass figures
> 32 + 7 + 22 rather than re-running the comparison. That sum is one short of
> the measured total, so one changed row is not attributable to a named pass.
> **The 62 is the measurement and is what to trust**; the per-pass split is
> approximate bookkeeping. No row was *added or removed* by any pass:
> `main` and this revision carry the same 79 table rows, every one of them
> rewritten in place or left alone. One caveat, because an earlier revision of
> this banner rejected a review finding too broadly: on `main` a **blank line**
> sat between `field_crop_history` and `field_app_locations`, and a blank line
> terminates a Markdown table — so `main` *rendered* 77 rows and showed the last
> two as loose text. This revision removed it, so all 79 render. The reviewer who
> reported "77 → 79" was reading the rendered table and was right about that; the
> claim that two rows were newly *added* is what does not hold. It is the same
> defect this PR fixes in the guide's roles table.
>
> Two shapes to read carefully. A cell reading `-` **or** `RPC only` means the
> same thing: **no direct browser-role path**. That is true both when no
> policy exists and when a deny-all policy (`USING (false)` / `WITH CHECK
> (false)`) exists. `idempotency_keys` and the three `product_cost_basis*`
> tables are the deny-all kind — one `ALL` policy is present, and it grants
> nothing — so a mechanical presence-diff would have "corrected" them into
> appearing to grant access. They were excluded from the mechanical pass and
> checked by reading their policy bodies against live instead.
>
> **The same trap has a second form, and the presence-diff fell into it.** A
> policy row in `pg_policies` carries a `permissive` column, and a
> **RESTRICTIVE** policy never grants anything — it only subtracts from what
> permissive policies already allow. `rate_limit_log` carries exactly one
> permissive policy (`SELECT`, admin) plus one restrictive `FOR ALL`
> (`rate_limit_log_restrictive_admin_only`). A diff keyed on `cmd` alone
> read that restrictive row as four granted commands and "corrected" the row
> to `Admin` across all four; in fact no browser role can insert, update or
> delete. That is fixed above, and it is the only row affected: a live read on
> 2026-08-19 UTC confirms this is the **only** restrictive policy in the whole
> `public` schema.
>
> **Role wording — mechanically re-derived, then hand-verified.** Policy
> *presence* per command is what the original sweep compared. The role wording
> inside each cell was transcribed by hand. A later mechanical pass re-derived
> each cell's role set from live `USING`/`WITH CHECK` expressions and corrected
> every cell in both matrices that claimed **"All authenticated"** where live
> is role-gated, plus the `rate_limit_log` row above and the `blend_recipes`
> INSERT/UPDATE cells, where live is `is_admin() OR created_by = auth.uid()` —
> narrower than the `Admin / Sales Rep` those two cells had claimed. Every flag
> that pass left standing has since been read against live `pg_policies` by
> hand and either corrected or confirmed, so as of **2026-08-19 UTC** both the
> presence shape *and* the named roles are verified.
>
> **What the classifier cannot see, and how those were found.** It compares
> role *names*, so a cell that names the right roles but omits a condition
> live *also* enforces raises no flag at all — the roles match. Those were
> found by reading live expressions directly rather than from the flag list:
> `field_obstacles` INSERT (live also requires `created_by = auth.uid()`, so
> an admin cannot insert a row attributed to someone else), `vendors` and
> `vendor_bills` SELECT (live also requires `deleted_at IS NULL`, with a
> second policy handing admin the soft-deleted `vendors` rows),
> `invoice_shares` and `order_shares` SELECT (the parent invoice or order must
> also be un-deleted), and `team_notes` INSERT (live requires an active
> profile as well as ownership). All six are corrected in the matrix above.
> Only three of them — `field_obstacles` INSERT, `vendors` SELECT,
> `vendor_bills` SELECT — were *bare* role lists, which is all an automated
> bare-cell sweep can match on. The other three already named a qualifier
> alongside the roles, so no sweep flagged them; they were found by reading the
> neighbouring policies while fixing the first three.
>
> The classifier's flag count across both matrices, measured at each revision:
> **162** on `origin/main`, **89** measured at `7d5d5d80` (the presence pass
> itself is `a4b4e9ce`; nothing between them touched a role word), **61**
> after the role-wording pass (`21f29c4a`), **33** now. Read that as a *proxy*,
> not a defect count: correcting `rup_sales_records` SELECT from `Admin` to
> `Admin / Sales Rep` — live is `role = ANY (ARRAY['admin','sales_rep'])`, so
> the fix is real — *raised* it by one, because the classifier matches
> helper-function names (`is_admin()`, `is_sales_rep()`, `is_applicator()`,
> `is_driver()`) and that policy inlines its role test as a scalar subquery.
>
> All **33** surviving flags are false positives of three kinds. (1) A policy
> that inlines a `profiles.role` test rather than calling `is_admin()` or
> `is_sales_rep()` reads as "no role named". The inlined form is
> `= 'admin'` on `ar_reminder_tracking`, `email_log`, `failed_notifications`,
> `team_note_attachments`, `vendor_bills`, `vendor_payments` and the
> soft-deleted-rows policy on `vendors`; it is
> `= ANY (ARRAY['admin','sales_rep'])` on `rup_sales_records`,
> `offline_action_receipts` and the main `vendors` SELECT policy. (2) A cell
> that names a role by *how the row is reached* rather than by a role check —
> the `Driver` cells on `deliveries`, `delivery_items`, `delivery_photos` and
> `delivery_remainders`, where live is `assigned_driver = auth.uid()`. (3) A
> cell that defers to another table's RLS — `invoice_items`, whose `EXISTS`
> carries exactly the `invoices_select` predicate and no auth test of its own.
> That third family has exactly one member: an earlier revision of this banner
> also listed `offline_action_receipts` there, but its `EXISTS` is over
> `profiles` with the role test inlined, which makes it family 1. The per-cell
> working is in the now-CLOSED entry in `docs/manual/KNOWN_ISSUES.md`.
>
> **"All authenticated"** in these matrices is shorthand for live
> `is_active_profile()`: any signed-in user whose `profiles.is_active` is true.
> A deactivated profile is authenticated but denied, so "all authenticated" is
> the looser of the two readings. **One** cell here newly reads it:
> `inventory_holds` SELECT, which read `Admin / Sales Rep` on `origin/main`.
> `team_note_attachments` and `team_note_comments` SELECT already read
> `All authenticated` there, so the term is not new to them.
>
> An earlier revision of this banner named all three and said they "used to
> render that identical live expression as *Any active profile*". **Both halves
> are withdrawn** — the second and third cells did not change at all, and the
> provenance is not this file's history: `git log -S"Any active profile" origin/main`
> returns nothing: the phrase never appeared in any committed version of either
> matrix. It existed only in banner prose on an intermediate commit of this
> branch (`76e755d2`), never in a matrix cell. On `origin/main` those three
> cells read `Admin / Sales Rep`, `All authenticated` and `All
> authenticated`. In a banner whose whole purpose is auditable provenance,
> presenting an intra-branch scratch state as file history was the wrong error
> to make.
>
> Counting the defined term itself: **17** cells in this file's matrix use it, of which 8 also
> appear in the `RLS_SECURITY_GUIDE.md` matrix — 25 cell instances across the
> two matrices, covering the same 17 table/command pairs. Every one was
> re-read on 2026-08-19 UTC and is governed by exactly one policy whose
> `USING` is `( SELECT is_active_profile() )`. That does not depend on the
> classifier and can be re-checked directly:
>
> ```sql
> select tablename, policyname, cmd, qual from pg_policies
>  where schemaname = 'public' and cmd = 'SELECT'
>    and qual like '%is_active_profile%';
> ```
>
> That query returns **27** rows live (read 2026-08-19 UTC), not 17. It finds
> every SELECT policy in `public` built on `is_active_profile()`; the 17 cells
> counted above are the subset whose tables this matrix carries. All 17 are in
> the result — the extra 10 are on tables the matrix does not list.

| Table | SELECT | INSERT | UPDATE | DELETE |
|-------|--------|--------|--------|--------|
| profiles | Own/Admin | Own/Admin | Own/Admin | - |
| products | All authenticated | Admin | Admin | Admin |
| cost_history | Admin | - (no INSERT policy) | - | - |
| product_cost_basis *(Phase 2 live)* | RPC only | RPC only | RPC only (close active row) | RPC only |
| product_cost_basis_change_rows *(Phase 2 live)* | RPC only | RPC only | RPC only | RPC only |
| product_cost_basis_rollout *(live Wells canary)* | RPC only | RPC only | RPC only | RPC only |
| customers | Admin / Sales Rep (assigned) / Driver (recent delivery) / Applicator (recent job) / dispatched to a job location | Admin / Sales Rep (assigned) | Admin / Sales Rep (assigned) | Admin |
| customer_addresses | All authenticated | Admin / Sales Rep (own customer) | Admin / Sales Rep (own customer) | Admin |
| quotes | Admin / Sales Rep | Admin / Sales Rep (own) | Admin / Sales Rep (own) | Admin |
| quote_sections | All authenticated | Admin / Sales Rep (quote owner) | Admin / Sales Rep (quote owner) | Admin / Sales Rep (quote owner) |
| quote_product_draws | Admin / Sales Rep | - (SECDEF RPCs only) | - (SECDEF RPCs only) | - (SECDEF RPCs only) |
| quote_items | Admin / Sales Rep | - (RPC only, since `20260812115236` dropped `qitems_insert`/`qitems_update`/`qitems_delete`) | - (RPC only) | - (RPC only) |
| quote_versions | Admin / Sales Rep | - for browser roles (`create_quote_version` RPC only, since `20260813080000`, ledger version `20260816174353`; `service_role` and `postgres` retain direct write grants and bypass RLS) | - (same scope) | - (same scope) |
| orders | Admin / Sales Rep | Admin / Sales Rep | Admin | Admin |
| order_items | Admin / Sales Rep | Admin / Sales Rep | Admin | Admin |
| inventory | Admin / Sales Rep / Driver | Admin | Admin | Admin |
| inventory_transactions | Admin / Sales Rep | Admin / Sales Rep | - | - |
| inventory_holds | All authenticated | - (no write policy; SECDEF RPCs only) | - (no write policy) | - (no write policy) |
| purchase_orders | Admin / Sales Rep | Admin | Admin | Admin |
| purchase_order_items | Admin / Sales Rep | Admin | Admin | Admin |
| receiving_records | Admin / Sales Rep | Admin / Sales Rep | Admin | Admin |
| receiving_photos | Admin / Sales Rep | Admin / Sales Rep | Admin | Admin |
| deliveries | Admin / Sales Rep / Driver (assigned) | Admin / Sales Rep | Admin / Sales Rep / Driver (assigned, while in_progress or completed) | Admin |
| delivery_items | Admin / Sales Rep / Driver (assigned) | Admin / Sales Rep | Admin | Admin / Sales Rep |
| delivery_photos | Admin / Sales Rep / Driver (assigned) | Admin / Sales Rep / active Driver (assigned) | Admin | Admin |
| delivery_remainders | Admin / Sales Rep / Driver (assigned to the original delivery) | Admin / Sales Rep | Admin / Sales Rep | Admin |
| commissions | Admin / Sales Rep (own recipient) | Admin | Admin | Admin |
| payments | Admin / Sales Rep | - (RPC only, since `20260714223000`) | - (RPC only) | - (RPC only) |
| team_notes | All authenticated | Own created_by (active profile) | Own created_by / Admin | Admin |
| team_note_attachments | All authenticated | Own uploaded_by | - (no UPDATE policy) | Own uploaded_by / Admin |
| team_note_comments | All authenticated | Own created_by | Own created_by / Admin | Own created_by / Admin |
| activity_feed | All authenticated | Own performed_by | - | - |
| notifications | Own user_id | Admin / Sales Rep / own user_id | Own user_id | Admin |
| app_settings | All authenticated | Admin | Admin | - |
| blend_tickets | Admin / Sales Rep | - (no INSERT policy) | Admin / Sales Rep | - |
| ingredient_map | All authenticated | Admin | Admin | Admin |
| unit_conversions | All authenticated | Admin | Admin | - |
| invoices | Admin / Own created_by / Assigned salesman | Admin / Sales Rep | Admin | Admin |
| invoice_items | Any visible invoice (inherits `invoices` RLS) | Admin / Sales Rep | Admin | Admin |
| allocation_sets | Admin / Sales Rep | Admin / Sales Rep | Admin | Admin |
| order_line_allocations | Admin / Sales Rep | Admin / Sales Rep | - | - (no DELETE policy) |
| invoice_line_allocations | Admin / Sales Rep | Admin / Sales Rep | - | - (no DELETE policy) |
| prepay_credits | Admin / Sales Rep | Admin | Admin | Admin |
| prepay_applications | Admin / Sales Rep | Admin | - | - (no DELETE policy) |
| financial_audit_log | Admin | Admin / own actor_user_id | - | - |
| blend_recipes | Admin / Sales Rep / Applicator | Admin / own created_by | Admin / own created_by | Admin |
| blend_recipe_items | All authenticated | Admin / Recipe creator | Admin / Recipe creator | Admin / Recipe creator |
| blend_ticket_to_order_items | Admin / Sales Rep | - (no INSERT policy) | - | - (no DELETE policy) |
| blend_ticket_fields | Admin / Sales Rep | Admin / Sales Rep | Admin / Sales Rep | Admin / Sales Rep |
| warehouses | All authenticated | Admin | Admin | Admin |
| cycle_counts | Admin / Sales Rep | Admin | Admin | Admin |
| cycle_count_items | Admin / Sales Rep | Admin (count in progress) | Admin (count in progress) | Admin (count in progress) |
| fields | Admin / Sales Rep / Applicator | Admin / Sales Rep | Admin / Sales Rep | Admin |
| field_obstacles | Admin / Sales Rep / Applicator | Admin / Sales Rep (own created_by) | Admin / Sales Rep | Admin / Sales Rep |
| job_loader_worksheets | Job-visible (Admin / Sales Rep / assigned Applicator / dispatched) | Admin / Sales Rep (own created_by) | Admin / Sales Rep | Admin / Sales Rep |
| field_billing_defaults | All authenticated | Admin / Sales Rep | Admin / Sales Rep | Admin / Sales Rep |
| returns | Admin / Sales Rep / requester | - (RPC only, since `20260715203911`) | Admin / requester | Admin |
| return_items | Admin / Sales Rep / return requester | - (RPC only, since `20260715203911`) | - (RPC only) | - (RPC only) |
| applicator_licenses | All authenticated | Admin / Sales Rep | Admin / Sales Rep | Admin |
| rebate_programs | Admin / Sales Rep | Admin | Admin | Admin |
| rebate_claims | Admin / Sales Rep | Admin / Sales Rep | Admin | Admin |
| vendors | Admin / Sales Rep (not soft-deleted) / Admin (soft-deleted) | - (no write policy) | - (no write policy) | - (no write policy) |
| vendor_bills | Admin (not soft-deleted) | Admin | Admin | Admin |
| vendor_payments | Admin | Admin | - | Admin |
| rup_sales_records | Admin / Sales Rep | Admin | - | - |
| email_log | Admin / Own created_by | Admin | - | - |
| ar_reminder_tracking | Admin | Admin | - | - |
| failed_notifications | Admin | Admin | Admin | Admin |
| invoice_shares | Admin / invoice creator / salesman (invoice not soft-deleted) | Admin / Sales Rep | Admin | Admin |
| order_shares | Admin / order salesman (order not soft-deleted) | Admin / Sales Rep | Admin / Sales Rep | Admin / Sales Rep |
| idempotency_keys | - (policy exists but is `USING (false)`; SECURITY DEFINER only) | - (same) | - (same) | - (same) |
| offline_action_receipts | Owner / Admin / Sales Rep (app reads via a sanitized RPC) | - (SECURITY DEFINER RPC only) | - (SECURITY DEFINER RPC only) | - |
| rate_limit_log | Admin | - (restrictive only) | - (restrictive only) | - (restrictive only) |
| note_tags | All authenticated | Own created_by | Own created_by | Own created_by |
| team_note_tags | Any visible team note (inherits `team_notes` RLS) | Note creator / Admin | - | Note creator / Admin |
| note_activity_log | All authenticated | Own user_id | - | - |
| field_crop_history | Admin / Sales Rep / Applicator | Admin / Sales Rep | Admin / Sales Rep | Admin |
| field_app_locations | Admin / Sales Rep / Applicator | Admin / Sales Rep | Admin / Sales Rep | Admin / Sales Rep |
| field_app_location_shares | Admin / Sales Rep / Applicator | Admin / Sales Rep | Admin / Sales Rep | Admin / Sales Rep |

## Field Application Workflow V2 / Phase 1 (2026-04-29)
- `field_app_locations` - Links fields to invoices or jobs (id uuid PK, invoice_id, job_id, **invoice_group_id**, field_id, map_number, total_acres, planted_acres, applied_acres, crop_type, wind_direction, sort_order). **Phase 1:** added `invoice_group_id` and updated CHECK to allow `invoice_id IS NOT NULL OR job_id IS NOT NULL OR invoice_group_id IS NOT NULL`. For multi-customer grouped invoices, locations live at the group level; single-customer invoices keep `invoice_id`. RLS: SELECT admin / sales rep / applicator; INSERT, UPDATE and DELETE admin / sales rep — see the matrix above.
- `field_app_location_shares` - Per-location customer billing splits (id uuid PK, location_id FK, customer_id FK, split_pct numeric, acres numeric, amount_cents bigint). **Phase 1:** carries the TRUE per-customer split for each field — even for grouped invoices, each field has one row per customer with their actual `split_pct`. Canonical audit source for "what fields contributed to which customer's invoice." RLS: SELECT admin / sales rep / applicator; INSERT, UPDATE and DELETE admin / sales rep — see the matrix above.

> **Note (Phase 1):** `invoice_shares` is still populated for every invoice (one 100% row per child invoice with `price_per_acre_cents`/`pricing_note` propagated when grower-share mode applies) for PDF/statement compatibility, but it is NOT the AR keying surface — AR is keyed off `invoices.customer_id` directly. For per-field per-customer audit, use `field_app_location_shares`.
