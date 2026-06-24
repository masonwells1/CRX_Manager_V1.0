-- ============================================================================
-- FIELD-APP PARITY #1: Job list + tabbed editor parity
-- CRX Manager V1.0
-- Date: 2026-06-24
--
-- Brings the job scheduling tables up to ChemMan's "Manage Job Scheduling"
-- parity. ALL changes here are ADDITIVE (new columns / one new table / an
-- extended save_job that keeps its strict-actor + idempotency contract).
-- No existing column, table, RLS policy, or RPC body is removed or weakened.
--
-- What this adds:
--   1. jobs: scheduling dates (call/proposed/schedule/expires + time_proposed),
--      consultant, three memo fields (loader_comment, additional_info,
--      internal_memo), applied_acres, and a GENERATED remaining_acres column.
--   2. job_fields: per-field agronomy (planted_acres, crop, strip, pests).
--   3. job_field_shares: NEW table — per-job, per-field customer share %.
--      Mirrors field_app_location_shares. Defaults from the canonical
--      field_billing_defaults; lets the office override per job. This is the
--      share model section #26 (auto-split a job into per-customer invoices)
--      will read.
--   4. job_chemicals: chemical extras (diluent_rate, rei_hours, phi_days,
--      warehouse, vendor) — auto-filled in the UI from products where possible.
--   5. save_job: extended to persist all of the above. Strict-actor +
--      idempotency logic preserved verbatim; signature UNCHANGED (one overload).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. jobs: scheduling + memo + applied/remaining acres
-- ----------------------------------------------------------------------------
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS call_date       date,
  ADD COLUMN IF NOT EXISTS date_proposed   date,
  ADD COLUMN IF NOT EXISTS time_proposed   time,
  ADD COLUMN IF NOT EXISTS schedule_date   date,
  ADD COLUMN IF NOT EXISTS date_expires    date,
  ADD COLUMN IF NOT EXISTS consultant_id   uuid REFERENCES profiles(id),
  ADD COLUMN IF NOT EXISTS loader_comment  text,
  ADD COLUMN IF NOT EXISTS additional_info text,
  -- "Internal Job/Invoice Memo — NOT printed" (ChemMan). Free text; the UI flags
  -- it as not-printed and downstream PDF builders must never include it.
  ADD COLUMN IF NOT EXISTS internal_memo   text,
  -- Acres actually treated so far. Stays 0 until the as-applied sections
  -- (#10/#18) land; remaining_acres derives from it.
  ADD COLUMN IF NOT EXISTS applied_acres   numeric NOT NULL DEFAULT 0,
  -- ChemMan list columns: who last edited (set by save_job) + printed status
  -- (stamped when the WPS notice / applicator printout is generated).
  ADD COLUMN IF NOT EXISTS updated_by      uuid REFERENCES profiles(id),
  ADD COLUMN IF NOT EXISTS printed_at      timestamptz;

-- Remaining acres = scheduled total − applied, clamped at 0. GENERATED so it is
-- always consistent and never hand-set (mirrors the invoices.balance_cents
-- generated-column convention). Section #10/#18 update applied_acres; this
-- follows automatically.
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS remaining_acres numeric
    GENERATED ALWAYS AS (GREATEST(COALESCE(total_acres, 0) - COALESCE(applied_acres, 0), 0)) STORED;

-- ----------------------------------------------------------------------------
-- 2. job_fields: per-field agronomy
-- ----------------------------------------------------------------------------
ALTER TABLE job_fields
  ADD COLUMN IF NOT EXISTS planted_acres numeric,
  ADD COLUMN IF NOT EXISTS crop          text,
  ADD COLUMN IF NOT EXISTS strip         text,
  ADD COLUMN IF NOT EXISTS pests         text;

-- ----------------------------------------------------------------------------
-- 3. job_field_shares: per-job, per-field customer share %
--    (mirrors field_app_location_shares; the share model #26 splits a job by)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_field_shares (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  field_id    uuid NOT NULL REFERENCES fields(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  split_pct   numeric(9,6) NOT NULL CHECK (split_pct > 0 AND split_pct <= 100),
  is_primary  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, field_id, customer_id)
);

CREATE INDEX IF NOT EXISTS idx_job_field_shares_job ON job_field_shares(job_id);
CREATE INDEX IF NOT EXISTS idx_job_field_shares_field ON job_field_shares(field_id);
CREATE INDEX IF NOT EXISTS idx_job_field_shares_customer ON job_field_shares(customer_id);

ALTER TABLE job_field_shares ENABLE ROW LEVEL SECURITY;

-- Shares inherit the parent job's visibility. Admin + sales_rep manage; an
-- applicator on the job can read (consistent with job_fields / job_chemicals).
DROP POLICY IF EXISTS job_field_shares_select ON job_field_shares;
CREATE POLICY job_field_shares_select ON job_field_shares
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM jobs WHERE jobs.id = job_field_shares.job_id AND (
    is_admin() OR is_sales_rep()
    OR (is_applicator() AND jobs.applicator_id = (SELECT auth.uid()))
  )));

DROP POLICY IF EXISTS job_field_shares_insert ON job_field_shares;
CREATE POLICY job_field_shares_insert ON job_field_shares
  FOR INSERT TO authenticated
  WITH CHECK (is_admin() OR is_sales_rep());

DROP POLICY IF EXISTS job_field_shares_update ON job_field_shares;
CREATE POLICY job_field_shares_update ON job_field_shares
  FOR UPDATE TO authenticated
  USING (is_admin() OR is_sales_rep())
  WITH CHECK (is_admin() OR is_sales_rep());

DROP POLICY IF EXISTS job_field_shares_delete ON job_field_shares;
CREATE POLICY job_field_shares_delete ON job_field_shares
  FOR DELETE TO authenticated
  USING (is_admin() OR is_sales_rep());

-- ----------------------------------------------------------------------------
-- 4. job_chemicals: chemical extras
-- ----------------------------------------------------------------------------
ALTER TABLE job_chemicals
  ADD COLUMN IF NOT EXISTS diluent_rate numeric,
  ADD COLUMN IF NOT EXISTS rei_hours    integer,
  ADD COLUMN IF NOT EXISTS phi_days     integer,
  -- products has no warehouse column, so warehouse is free text on the line.
  ADD COLUMN IF NOT EXISTS warehouse    text,
  ADD COLUMN IF NOT EXISTS vendor       text;

-- ----------------------------------------------------------------------------
-- 5. save_job() — extended to persist scheduling, memos, agronomy, chemical
--    extras, and per-field customer shares. Strict-actor + idempotency block
--    is preserved verbatim from 20260609190820_save_job_strict_actor.sql.
--    Signature UNCHANGED (one overload).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.save_job(p_job_id uuid, p_job_payload jsonb, p_fields jsonb, p_chemicals jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_job_id uuid;
  v_is_new boolean := (p_job_id IS NULL);
  v_field jsonb;
  v_chem jsonb;
  v_share jsonb;
  v_field_id uuid;
  v_season integer;
  v_job_date date;
  v_existing jsonb;
  v_result jsonb;
  v_share_total numeric;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  -- Idempotency: replay with the same key returns the original result without
  -- creating a second job (the create-path double-submit hazard).
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key
       AND operation = 'save_job';
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  v_job_date := (p_job_payload->>'job_date')::date;
  v_season := CASE
    WHEN EXTRACT(MONTH FROM v_job_date) >= 7
    THEN EXTRACT(YEAR FROM v_job_date) + 1
    ELSE EXTRACT(YEAR FROM v_job_date)
  END;

  IF v_is_new THEN
    INSERT INTO jobs (
      job_number, customer_id, status, job_date, scheduled_time,
      applicator_id, vehicle_id, recipe_id,
      notes, tags, batch_id, season,
      total_acres, total_cost_cents, total_price_cents,
      call_date, date_proposed, time_proposed, schedule_date, date_expires,
      consultant_id, loader_comment, additional_info, internal_memo,
      created_by, updated_by
    ) VALUES (
      next_job_number(),
      (p_job_payload->>'customer_id')::uuid,
      COALESCE(p_job_payload->>'status', 'scheduled'),
      v_job_date,
      CASE WHEN p_job_payload->>'scheduled_time' IS NOT NULL
        THEN (p_job_payload->>'scheduled_time')::time ELSE NULL END,
      CASE WHEN p_job_payload->>'applicator_id' IS NOT NULL AND p_job_payload->>'applicator_id' != ''
        THEN (p_job_payload->>'applicator_id')::uuid ELSE NULL END,
      CASE WHEN p_job_payload->>'vehicle_id' IS NOT NULL AND p_job_payload->>'vehicle_id' != ''
        THEN (p_job_payload->>'vehicle_id')::uuid ELSE NULL END,
      CASE WHEN p_job_payload->>'recipe_id' IS NOT NULL AND p_job_payload->>'recipe_id' != ''
        THEN (p_job_payload->>'recipe_id')::uuid ELSE NULL END,
      p_job_payload->>'notes',
      CASE WHEN p_job_payload->'tags' IS NOT NULL
        THEN ARRAY(SELECT jsonb_array_elements_text(p_job_payload->'tags'))
        ELSE NULL END,
      p_job_payload->>'batch_id',
      v_season,
      COALESCE((p_job_payload->>'total_acres')::numeric, 0),
      COALESCE((p_job_payload->>'total_cost_cents')::bigint, 0),
      COALESCE((p_job_payload->>'total_price_cents')::bigint, 0),
      NULLIF(p_job_payload->>'call_date','')::date,
      NULLIF(p_job_payload->>'date_proposed','')::date,
      NULLIF(p_job_payload->>'time_proposed','')::time,
      NULLIF(p_job_payload->>'schedule_date','')::date,
      NULLIF(p_job_payload->>'date_expires','')::date,
      CASE WHEN p_job_payload->>'consultant_id' IS NOT NULL AND p_job_payload->>'consultant_id' != ''
        THEN (p_job_payload->>'consultant_id')::uuid ELSE NULL END,
      p_job_payload->>'loader_comment',
      p_job_payload->>'additional_info',
      p_job_payload->>'internal_memo',
      p_performed_by,
      v_actor
    )
    RETURNING id INTO v_job_id;
  ELSE
    SELECT id INTO v_job_id FROM jobs WHERE id = p_job_id FOR UPDATE;
    IF v_job_id IS NULL THEN
      RAISE EXCEPTION 'Job not found: %', p_job_id;
    END IF;

    UPDATE jobs SET
      customer_id = (p_job_payload->>'customer_id')::uuid,
      job_date = v_job_date,
      scheduled_time = CASE WHEN p_job_payload->>'scheduled_time' IS NOT NULL
        THEN (p_job_payload->>'scheduled_time')::time ELSE NULL END,
      applicator_id = CASE WHEN p_job_payload->>'applicator_id' IS NOT NULL AND p_job_payload->>'applicator_id' != ''
        THEN (p_job_payload->>'applicator_id')::uuid ELSE NULL END,
      vehicle_id = CASE WHEN p_job_payload->>'vehicle_id' IS NOT NULL AND p_job_payload->>'vehicle_id' != ''
        THEN (p_job_payload->>'vehicle_id')::uuid ELSE NULL END,
      recipe_id = CASE WHEN p_job_payload->>'recipe_id' IS NOT NULL AND p_job_payload->>'recipe_id' != ''
        THEN (p_job_payload->>'recipe_id')::uuid ELSE NULL END,
      notes = p_job_payload->>'notes',
      tags = CASE WHEN p_job_payload->'tags' IS NOT NULL
        THEN ARRAY(SELECT jsonb_array_elements_text(p_job_payload->'tags'))
        ELSE NULL END,
      batch_id = p_job_payload->>'batch_id',
      season = v_season,
      total_acres = COALESCE((p_job_payload->>'total_acres')::numeric, 0),
      total_cost_cents = COALESCE((p_job_payload->>'total_cost_cents')::bigint, 0),
      total_price_cents = COALESCE((p_job_payload->>'total_price_cents')::bigint, 0),
      call_date = NULLIF(p_job_payload->>'call_date','')::date,
      date_proposed = NULLIF(p_job_payload->>'date_proposed','')::date,
      time_proposed = NULLIF(p_job_payload->>'time_proposed','')::time,
      schedule_date = NULLIF(p_job_payload->>'schedule_date','')::date,
      date_expires = NULLIF(p_job_payload->>'date_expires','')::date,
      consultant_id = CASE WHEN p_job_payload->>'consultant_id' IS NOT NULL AND p_job_payload->>'consultant_id' != ''
        THEN (p_job_payload->>'consultant_id')::uuid ELSE NULL END,
      loader_comment = p_job_payload->>'loader_comment',
      additional_info = p_job_payload->>'additional_info',
      internal_memo = p_job_payload->>'internal_memo',
      updated_by = v_actor
    WHERE id = v_job_id;
  END IF;

  -- Replace fields (now incl. agronomy: planted_acres, crop, strip, pests)
  DELETE FROM job_fields WHERE job_id = v_job_id;
  FOR v_field IN SELECT * FROM jsonb_array_elements(p_fields) LOOP
    INSERT INTO job_fields (job_id, field_id, acres_to_treat, planted_acres, crop, strip, pests, sort_order)
    VALUES (
      v_job_id,
      (v_field->>'field_id')::uuid,
      (v_field->>'acres_to_treat')::numeric,
      NULLIF(v_field->>'planted_acres','')::numeric,
      v_field->>'crop',
      v_field->>'strip',
      v_field->>'pests',
      COALESCE((v_field->>'sort_order')::integer, 0)
    );
  END LOOP;

  -- Replace per-field customer shares. Each field's shares must total 100%
  -- (mirrors the field-app split invariant so section #26 can split cleanly).
  -- A share whose field_id is NOT one of the job's fields (a stale defaults
  -- response or a hand-built payload) is REJECTED — otherwise the Jobs list /
  -- the #26 split would surface a customer/field that is not on the job (Codex P2).
  DELETE FROM job_field_shares WHERE job_id = v_job_id;
  IF p_job_payload->'field_shares' IS NOT NULL THEN
    -- Reject any share pointing at a field not in p_fields.
    IF EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_job_payload->'field_shares') s
       WHERE (s->>'field_id')::uuid NOT IN (
         SELECT (f->>'field_id')::uuid FROM jsonb_array_elements(p_fields) f
       )
    ) THEN
      RAISE EXCEPTION 'SHARE_FIELD_NOT_ON_JOB';
    END IF;

    -- Validate: per field, the sum of split_pct == 100 (within rounding).
    FOR v_field_id IN
      SELECT DISTINCT (s->>'field_id')::uuid
      FROM jsonb_array_elements(p_job_payload->'field_shares') s
    LOOP
      SELECT COALESCE(SUM((s->>'split_pct')::numeric), 0)
        INTO v_share_total
        FROM jsonb_array_elements(p_job_payload->'field_shares') s
       WHERE (s->>'field_id')::uuid = v_field_id;
      IF ROUND(v_share_total, 2) <> 100 THEN
        RAISE EXCEPTION 'SHARE_NOT_100' USING DETAIL = 'Field shares must total 100%; got ' || v_share_total;
      END IF;
    END LOOP;

    FOR v_share IN SELECT * FROM jsonb_array_elements(p_job_payload->'field_shares') LOOP
      INSERT INTO job_field_shares (job_id, field_id, customer_id, split_pct, is_primary)
      VALUES (
        v_job_id,
        (v_share->>'field_id')::uuid,
        (v_share->>'customer_id')::uuid,
        (v_share->>'split_pct')::numeric,
        COALESCE((v_share->>'is_primary')::boolean, false)
      );
    END LOOP;
  END IF;

  -- Replace chemicals (now incl. extras: diluent_rate, rei_hours, phi_days,
  -- warehouse, vendor)
  DELETE FROM job_chemicals WHERE job_id = v_job_id;
  FOR v_chem IN SELECT * FROM jsonb_array_elements(p_chemicals) LOOP
    INSERT INTO job_chemicals (
      job_id, product_id, quantity, unit, rate_per_acre, rate_unit,
      cost_per_unit_cents, price_per_unit_cents,
      diluent_rate, rei_hours, phi_days, warehouse, vendor,
      sort_order
    )
    VALUES (
      v_job_id,
      (v_chem->>'product_id')::uuid,
      COALESCE((v_chem->>'quantity')::numeric, 0),
      v_chem->>'unit',
      (v_chem->>'rate_per_acre')::numeric,
      v_chem->>'rate_unit',
      COALESCE((v_chem->>'cost_per_unit_cents')::bigint, 0),
      COALESCE((v_chem->>'price_per_unit_cents')::bigint, 0),
      NULLIF(v_chem->>'diluent_rate','')::numeric,
      NULLIF(v_chem->>'rei_hours','')::integer,
      NULLIF(v_chem->>'phi_days','')::integer,
      v_chem->>'warehouse',
      v_chem->>'vendor',
      COALESCE((v_chem->>'sort_order')::integer, 0)
    );
  END LOOP;

  v_result := jsonb_build_object('success', true, 'job_id', v_job_id, 'is_new', v_is_new);

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at)
    VALUES (p_idempotency_key, 'save_job', v_result, now() + interval '24 hours')
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.save_job(uuid, jsonb, jsonb, jsonb, uuid, text) TO authenticated;
