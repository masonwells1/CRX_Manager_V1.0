-- =============================================================================
-- Migration: 20260430170000_field_app_workflow_phase4.sql
-- Phase 4 of the Field Application Workflow rewrite — Application Service Fees.
--
-- See: docs/audits/2026-04-28-field-application-workflow-response-to-codex.md
-- Bundles fixes for codex audit item: #8.
--
-- Problem: blend_tickets and invoices both carry application_service_id, but
-- jobs do not. So a Y-Drop job has no place to express the service used, and
-- transfer_job_to_invoice / save_field_app_invoice can't carry the fee
-- forward consistently. Each flow has its own inline rate-lookup + fee math,
-- which has drifted (codex #8).
--
-- Fix:
--   1. jobs.application_service_id column (parity with blend_tickets/invoices)
--   2. compute_application_service_fee() helper RPC: shared rate lookup
--      (customer override → service default → 0) + acres math, returns
--      jsonb { rate_per_acre_cents, total_fee_cents, source }. Existing
--      inline blocks in save_field_app_invoice and create_invoice_from_blend_ticket
--      continue to work; future cleanup can refactor them onto the helper.
-- =============================================================================


ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS application_service_id uuid REFERENCES application_services(id);

CREATE INDEX IF NOT EXISTS idx_jobs_app_service
  ON jobs(application_service_id) WHERE application_service_id IS NOT NULL;

COMMENT ON COLUMN jobs.application_service_id IS
  'Phase 4 (2026-04-30): application service used for this job (Y-Drop, plane, etc.). Drives per-acre fee on transfer_job_to_invoice.';


CREATE OR REPLACE FUNCTION compute_application_service_fee(
  p_service_id   uuid,
  p_customer_id  uuid,
  p_acres        numeric,
  p_season       int DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_service  record;
  v_override bigint;
  v_rate     bigint;
  v_source   text;
  v_total    bigint;
  v_season   int;
BEGIN
  IF p_service_id IS NULL OR p_acres IS NULL OR p_acres <= 0 THEN
    RETURN jsonb_build_object(
      'rate_per_acre_cents', 0,
      'total_fee_cents',     0,
      'cost_per_acre_cents', 0,
      'total_cost_cents',    0,
      'source',              'none',
      'service_name',        NULL
    );
  END IF;

  SELECT * INTO v_service FROM application_services WHERE id = p_service_id;
  IF NOT FOUND OR NOT v_service.is_active THEN
    RETURN jsonb_build_object(
      'rate_per_acre_cents', 0,
      'total_fee_cents',     0,
      'cost_per_acre_cents', 0,
      'total_cost_cents',    0,
      'source',              'inactive',
      'service_name',        v_service.name
    );
  END IF;

  v_season := COALESCE(p_season, current_season());
  v_override := NULL;

  IF p_customer_id IS NOT NULL THEN
    SELECT car.rate_per_acre_cents INTO v_override
      FROM customer_application_rates car
     WHERE car.customer_id            = p_customer_id
       AND car.application_service_id = p_service_id
       AND car.season                 = v_season
     LIMIT 1;
  END IF;

  IF v_override IS NOT NULL THEN
    v_rate   := v_override;
    v_source := 'customer_override';
  ELSE
    v_rate   := COALESCE(v_service.default_rate_per_acre_cents, 0);
    v_source := 'service_default';
  END IF;

  v_total := ROUND(v_rate * p_acres)::bigint;

  RETURN jsonb_build_object(
    'rate_per_acre_cents', v_rate,
    'total_fee_cents',     v_total,
    'cost_per_acre_cents', COALESCE(v_service.cost_per_acre_cents, 0),
    'total_cost_cents',    ROUND(COALESCE(v_service.cost_per_acre_cents, 0) * p_acres)::bigint,
    'source',              v_source,
    'service_name',        v_service.name
  );
END;
$$;

GRANT EXECUTE ON FUNCTION compute_application_service_fee(uuid, uuid, numeric, int) TO authenticated;

COMMENT ON FUNCTION compute_application_service_fee(uuid, uuid, numeric, int) IS
  'Phase 4 (2026-04-30): single source of truth for application service fee math. Looks up customer_application_rates override, falls back to service default. Returns { rate_per_acre_cents, total_fee_cents, cost_per_acre_cents, total_cost_cents, source, service_name }.';


DO $$
DECLARE
  c1 int;
BEGIN
  SELECT count(*) INTO c1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'compute_application_service_fee';
  IF c1 != 1 THEN
    RAISE EXCEPTION 'VERIFICATION FAILED: compute_application_service_fee has % overloads (expected 1)', c1;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='jobs' AND column_name='application_service_id') THEN
    RAISE EXCEPTION 'VERIFICATION FAILED: jobs.application_service_id missing';
  END IF;

  RAISE NOTICE 'Phase 4 verified';
END $$;
