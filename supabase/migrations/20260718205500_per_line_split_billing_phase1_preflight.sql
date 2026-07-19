-- Per-Line-Item Split Billing — fail-closed Phase 1 object preflight.
--
-- Phase 1 deliberately remains byte-stable after its separate review. Its new
-- tables and indexes use IF NOT EXISTS, so this earlier migration prevents those
-- clauses from accepting a partial or weaker stale installation by name alone.
-- The feature flag row is handled separately and may already exist; Phase 2
-- refuses to install unless its value is exactly false.
--
-- idempotency-body-check: exempt (read-only catalog assertion)

BEGIN;

DO $$
DECLARE
  v_existing_objects text;
BEGIN
  SELECT string_agg(c.relname || ':' || c.relkind::text, ', ' ORDER BY c.relname)
    INTO v_existing_objects
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = ANY (ARRAY[
       'field_app_billing_sets',
       'field_app_billing_lines',
       'invoice_line_shares',
       'invoice_line_share_post_snapshots',
       'uq_field_app_billing_sets_group',
       'idx_field_app_billing_sets_job',
       'idx_field_app_billing_sets_primary_customer',
       'idx_field_app_billing_sets_created_by',
       'idx_field_app_billing_lines_set',
       'idx_field_app_billing_lines_product',
       'idx_field_app_billing_lines_application_service',
       'idx_invoice_line_shares_line',
       'idx_invoice_line_shares_customer',
       'idx_invoice_line_shares_created_by',
       'idx_invoice_line_share_post_snapshots_invoice',
       'idx_invoice_line_share_post_snapshots_line',
       'idx_invoice_line_share_post_snapshots_customer'
     ]::text[]);

  IF v_existing_objects IS NOT NULL THEN
    RAISE EXCEPTION
      'PER_LINE_PHASE1_SCHEMA_DRIFT: expected new objects to be absent; found %',
      v_existing_objects
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'invoices'
       AND a.attname = 'send_disposition'
       AND a.attnum > 0
       AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION
      'PER_LINE_PHASE1_SCHEMA_DRIFT: public.invoices.send_disposition already exists'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END;
$$;

COMMIT;
