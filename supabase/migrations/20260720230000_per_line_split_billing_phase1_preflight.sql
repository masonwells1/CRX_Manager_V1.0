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
  v_existing_functions text;
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

  -- Every function below is introduced by the Phase 1/relational-guard/Phase 2
  -- migration chain. CREATE OR REPLACE preserves an existing function's owner,
  -- so accepting a same-signature object here could leave privileged billing
  -- code owned by an untrusted role even after its body is replaced.
  WITH expected(signature) AS (
    VALUES
      ('public.trg_invoice_line_share_post_snapshots_immutable()'),
      ('public.trg_invoice_line_shares_sum_100()'),
      ('public.trg_field_app_billing_line_has_shares()'),
      ('public.trg_invoice_line_shares_frozen_when_posted()'),
      ('public.trg_invoice_items_shared_parent_frozen_when_posted()'),
      ('public.trg_invoices_send_disposition_server_only()'),
      ('public.can_read_field_app_billing_set(uuid)'),
      ('public.trg_capture_invoice_line_share_post_snapshot()'),
      ('public._assert_per_line_split_billing_integrity(uuid)'),
      ('public.trg_field_app_billing_lines_frozen_when_posted()'),
      ('public.trg_assert_per_line_share_integrity()'),
      ('public.trg_assert_per_line_billing_line_integrity()'),
      ('public.trg_assert_per_line_item_integrity()'),
      ('public.trg_assert_per_line_invoice_integrity()'),
      ('public.trg_assert_per_line_billing_set_integrity()'),
      ('public.trg_assert_per_line_integrity_before_post()'),
      ('public._calculate_per_line_split_billing_plan(uuid,jsonb,jsonb,uuid,uuid,jsonb)'),
      ('public._preview_field_app_invoice_split_legacy_20260718(jsonb,jsonb,uuid,uuid)'),
      ('public.preview_field_app_invoice_split(jsonb,jsonb,uuid,uuid,uuid,jsonb)')
  )
  SELECT string_agg(signature, ', ' ORDER BY signature)
    INTO v_existing_functions
    FROM expected
   WHERE to_regprocedure(signature) IS NOT NULL;

  IF v_existing_functions IS NOT NULL THEN
    RAISE EXCEPTION
      'PER_LINE_PHASE1_FUNCTION_DRIFT: expected new functions to be absent; found %',
      v_existing_functions
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
