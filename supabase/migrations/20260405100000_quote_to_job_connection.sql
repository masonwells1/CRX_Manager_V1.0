-- =============================================================================
-- Migration: Quote → Job Connection
-- Purpose:
--   1. Add quote_id + quote_section_id to jobs table for traceability
--   2. Create create_job_from_quote_section() RPC
-- =============================================================================

-- ─── 1. Add FK columns to jobs ──────────────────────────────────────────────

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS quote_id uuid REFERENCES quotes(id),
  ADD COLUMN IF NOT EXISTS quote_section_id uuid REFERENCES quote_sections(id);

CREATE INDEX IF NOT EXISTS idx_jobs_quote_id
  ON jobs(quote_id) WHERE quote_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_quote_section_id
  ON jobs(quote_section_id) WHERE quote_section_id IS NOT NULL;


-- ─── 2. create_job_from_quote_section() ─────────────────────────────────────
-- Creates a new scheduled job pre-filled from a planned quote section.
-- The user can then edit the job before executing (products may change).

CREATE OR REPLACE FUNCTION create_job_from_quote_section(
  p_quote_id uuid,
  p_section_id uuid,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing text;
  v_quote RECORD;
  v_section RECORD;
  v_item RECORD;
  v_job_id uuid;
  v_job_number text;
  v_job_date date;
  v_season integer;
  v_total_acres numeric := 0;
  v_total_cost_cents bigint := 0;
  v_total_price_cents bigint := 0;
  v_sort integer := 0;
BEGIN
  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN
      RETURN jsonb_build_object('job_id', v_existing::uuid);
    END IF;
  END IF;

  -- Validate quote
  SELECT q.* INTO v_quote
    FROM quotes q WHERE q.id = p_quote_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quote not found: %', p_quote_id;
  END IF;
  IF NOT v_quote.is_planned THEN
    RAISE EXCEPTION 'Quote must be marked as planned to schedule a job';
  END IF;

  -- Validate section
  SELECT qs.* INTO v_section
    FROM quote_sections qs
    WHERE qs.id = p_section_id AND qs.quote_id = p_quote_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Section not found or does not belong to quote';
  END IF;

  -- Calculate job date and season
  v_job_date := COALESCE(v_section.needed_by_date, CURRENT_DATE);
  v_season := CASE
    WHEN EXTRACT(MONTH FROM v_job_date) >= 10
    THEN EXTRACT(YEAR FROM v_job_date)::integer + 1
    ELSE EXTRACT(YEAR FROM v_job_date)::integer
  END;

  -- Generate job number
  v_job_number := next_job_number();

  -- Create the job
  INSERT INTO jobs (
    job_number, customer_id, status, job_date,
    notes, season, quote_id, quote_section_id,
    total_acres, total_cost_cents, total_price_cents,
    created_by
  ) VALUES (
    v_job_number,
    v_quote.customer_id,
    'scheduled',
    v_job_date,
    v_section.section_name || COALESCE(': ' || v_section.section_header_notes, ''),
    v_season,
    p_quote_id,
    p_section_id,
    0, 0, 0,
    p_performed_by
  ) RETURNING id INTO v_job_id;

  -- Add field if section has one
  IF v_section.field_id IS NOT NULL THEN
    -- Get max acres from quote items in this section
    SELECT COALESCE(MAX(qi.acres), 0) INTO v_total_acres
      FROM quote_items qi WHERE qi.section_id = p_section_id;

    INSERT INTO job_fields (job_id, field_id, acres_to_treat, sort_order)
    VALUES (v_job_id, v_section.field_id, v_total_acres, 1);
  END IF;

  -- Add chemicals from quote items
  FOR v_item IN
    SELECT qi.product_id, qi.total_units_needed, qi.price_unit,
           qi.actual_rate, qi.rate_unit, qi.price_per_unit, qi.current_cost,
           qi.acres, qi.sort_order,
           p.unit_size
    FROM quote_items qi
    JOIN products p ON p.id = qi.product_id
    WHERE qi.section_id = p_section_id
    ORDER BY qi.sort_order
  LOOP
    v_sort := v_sort + 1;

    INSERT INTO job_chemicals (
      job_id, product_id, quantity, unit,
      rate_per_acre, rate_unit,
      cost_per_unit_cents, price_per_unit_cents,
      sort_order
    ) VALUES (
      v_job_id,
      v_item.product_id,
      COALESCE(v_item.total_units_needed, 0),
      COALESCE(v_item.price_unit, v_item.unit_size),
      v_item.actual_rate,
      v_item.rate_unit,
      ROUND(COALESCE(v_item.current_cost, 0) * 100)::bigint,
      ROUND(COALESCE(v_item.price_per_unit, 0) * 100)::bigint,
      v_sort
    );

    -- Accumulate totals: price = price_per_unit * total_units_needed (dollars, then to cents)
    v_total_cost_cents := v_total_cost_cents +
      ROUND(COALESCE(v_item.current_cost, 0) * COALESCE(v_item.total_units_needed, 0) * 100)::bigint;
    v_total_price_cents := v_total_price_cents +
      ROUND(COALESCE(v_item.price_per_unit, 0) * COALESCE(v_item.total_units_needed, 0) * 100)::bigint;
  END LOOP;

  -- Update totals from items (more accurate than upfront calc)
  IF v_total_acres = 0 THEN
    SELECT COALESCE(MAX(qi.acres), 0) INTO v_total_acres
      FROM quote_items qi WHERE qi.section_id = p_section_id;
  END IF;

  UPDATE jobs SET
    total_acres = v_total_acres,
    total_cost_cents = v_total_cost_cents,
    total_price_cents = v_total_price_cents
  WHERE id = v_job_id;

  -- Activity log
  INSERT INTO activity_log (action, entity_type, entity_id, performed_by, details)
  VALUES (
    'job_created_from_quote', 'job', v_job_id, p_performed_by,
    jsonb_build_object(
      'job_number', v_job_number,
      'quote_id', p_quote_id,
      'quote_number', v_quote.quote_number,
      'section_name', v_section.section_name
    )
  );

  -- Idempotency record
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'create_job_from_quote_section', v_job_id::text);
  END IF;

  RETURN jsonb_build_object('job_id', v_job_id);
END;
$$;

GRANT EXECUTE ON FUNCTION create_job_from_quote_section(uuid, uuid, uuid, text) TO authenticated;
