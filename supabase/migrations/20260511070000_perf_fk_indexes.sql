-- Migration: perf_fk_indexes
-- Source: Supabase performance advisor unindexed_foreign_keys (72 INFO).
-- Goal: create a btree index on every unindexed FK column to avoid full-table
--       scans on JOINs and cascading deletes.
--
-- supabase-no-transaction
--
-- CONCURRENTLY is used so existing reads/writes are NOT blocked while the index
-- is built. This requires the migration to run OUTSIDE a transaction, so this
-- file is applied via per-statement execute_sql in the MCP path (the file is the
-- canonical record; applied behavior matches).
--
-- IF NOT EXISTS makes the migration re-runnable. If a build fails partway, just
-- re-apply — the completed indexes are skipped.

-- ============================================================
-- 71 indexes (advisor flagged 72; one already covered as leading column of a composite)
-- ============================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_accounting_periods_closed_by ON public.accounting_periods (closed_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_allocation_sets_created_by ON public.allocation_sets (created_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_allocation_sets_customer_id ON public.allocation_sets (customer_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_application_records_created_by ON public.application_records (created_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_application_records_invoice_id ON public.application_records (invoice_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_application_services_created_by ON public.application_services (created_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ar_reminder_tracking_email_log_id ON public.ar_reminder_tracking (email_log_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_blend_ticket_fields_applied_by ON public.blend_ticket_fields (applied_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_blend_ticket_to_order_items_created_by ON public.blend_ticket_to_order_items (created_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_blend_tickets_reviewed_by ON public.blend_tickets (reviewed_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_commission_payments_created_by ON public.commission_payments (created_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_commission_payments_posted_by ON public.commission_payments (posted_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_customer_application_rates_created_by ON public.customer_application_rates (created_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cycle_count_items_counted_by ON public.cycle_count_items (counted_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cycle_count_items_inventory_id ON public.cycle_count_items (inventory_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cycle_counts_completed_by ON public.cycle_counts (completed_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_deliveries_cancelled_by ON public.deliveries (cancelled_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_deliveries_last_edited_by ON public.deliveries (last_edited_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_delivery_photos_uploaded_by ON public.delivery_photos (uploaded_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_delivery_remainders_followup_delivery_id ON public.delivery_remainders (followup_delivery_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_delivery_remainders_order_item_id ON public.delivery_remainders (order_item_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_delivery_remainders_product_id ON public.delivery_remainders (product_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_email_log_created_by ON public.email_log (created_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_finance_charges_created_by ON public.finance_charges (created_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_finance_charges_invoice_id ON public.finance_charges (invoice_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_inventory_transactions_delivery_id ON public.inventory_transactions (delivery_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_inventory_transactions_purchase_order_id ON public.inventory_transactions (purchase_order_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_invoice_items_order_item_id ON public.invoice_items (order_item_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_invoice_line_allocations_bill_to_customer_id ON public.invoice_line_allocations (bill_to_customer_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_invoice_line_allocations_split_invoice_id ON public.invoice_line_allocations (split_invoice_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_invoices_blend_ticket_id ON public.invoices (blend_ticket_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_invoices_posted_by ON public.invoices (posted_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_invoices_salesman_id ON public.invoices (salesman_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_invoices_voided_by ON public.invoices (voided_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_job_chemicals_product_id ON public.job_chemicals (product_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_job_fields_field_id ON public.job_fields (field_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_created_by ON public.jobs (created_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_invoice_id ON public.jobs (invoice_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_jobs_recipe_id ON public.jobs (recipe_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_note_tags_created_by ON public.note_tags (created_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_order_line_allocations_bill_to_customer_id ON public.order_line_allocations (bill_to_customer_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_salesman_id ON public.orders (salesman_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payments_recorded_by ON public.payments (recorded_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_prepay_applications_applied_by ON public.prepay_applications (applied_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_prepay_credits_created_by ON public.prepay_credits (created_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_purchase_orders_cancelled_by ON public.purchase_orders (cancelled_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_quote_pdf_templates_created_by ON public.quote_pdf_templates (created_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_quote_templates_created_by ON public.quote_templates (created_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_quotes_pdf_template_id ON public.quotes (pdf_template_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_quotes_salesman_id ON public.quotes (salesman_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rebate_claims_created_by ON public.rebate_claims (created_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rebate_claims_customer_id ON public.rebate_claims (customer_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rebate_claims_product_id ON public.rebate_claims (product_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rebate_programs_created_by ON public.rebate_programs (created_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_receiving_photos_uploaded_by ON public.receiving_photos (uploaded_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_return_items_order_item_id ON public.return_items (order_item_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_returns_approved_by ON public.returns (approved_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_returns_cancelled_by ON public.returns (cancelled_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_returns_credit_invoice_id ON public.returns (credit_invoice_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_returns_received_by ON public.returns (received_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rup_sales_records_created_by ON public.rup_sales_records (created_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rup_sales_records_order_id ON public.rup_sales_records (order_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_team_note_attachments_uploaded_by ON public.team_note_attachments (uploaded_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_team_notes_deleted_by ON public.team_notes (deleted_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vehicles_created_by ON public.vehicles (created_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vendor_bills_created_by ON public.vendor_bills (created_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vendor_bills_voided_by ON public.vendor_bills (voided_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vendor_payments_created_by ON public.vendor_payments (created_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vendor_payments_voided_by ON public.vendor_payments (voided_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_write_offs_approved_by ON public.write_offs (approved_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_write_offs_created_by ON public.write_offs (created_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_write_offs_reversed_by ON public.write_offs (reversed_by);

-- Verification: run separately as a regular SELECT
-- SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname LIKE 'idx_%' AND ...
