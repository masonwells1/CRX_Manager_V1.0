-- P1-B (review 2026-05-29): add real idempotency to save_job.
--
-- APPLIED LIVE 2026-05-30 as version 20260530020452 (from branch
-- fix/review-2026-05-29, cherry-picked to main). File renamed to the applied
-- version stamp per the B7 rule so tooling never re-applies it.
--
-- Bug: save_job declared p_idempotency_key but the body never read or wrote
-- idempotency_keys (verified live 2026-05-29: declares_param=true,
-- touches_table=false). The create-path does a bare INSERT INTO jobs with
-- next_job_number(), so a double-click / retry created TWO jobs. The
-- rpcContracts.test.ts coverage list marked it "covered" because the test only
-- checked the param existed in the TS interface, not that the body used it —
-- see the companion test hardening in src/lib/rpcContracts.test.ts.
--
-- Fix: canonical check-at-top / save-at-end idempotency against idempotency_keys
-- (same shape as reverse_write_off). On replay with the same key, return the
-- stored result without re-inserting. Function body is otherwise reproduced
-- verbatim from the live definition; auth check left unchanged (already validates
-- is_active + role).

CREATE OR REPLACE FUNCTION public.save_job(
  p_job_id uuid,
  p_job_payload jsonb,
  p_fields jsonb,
  p_chemicals jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_job_id uuid;
  v_is_new boolean := (p_job_id IS NULL);
  v_field jsonb;
  v_chem jsonb;
  v_season integer;
  v_job_date date;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = p_performed_by AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to save jobs';
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
      created_by
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
      p_performed_by
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
      total_price_cents = COALESCE((p_job_payload->>'total_price_cents')::bigint, 0)
    WHERE id = v_job_id;
  END IF;

  DELETE FROM job_fields WHERE job_id = v_job_id;
  FOR v_field IN SELECT * FROM jsonb_array_elements(p_fields) LOOP
    INSERT INTO job_fields (job_id, field_id, acres_to_treat, sort_order)
    VALUES (
      v_job_id,
      (v_field->>'field_id')::uuid,
      (v_field->>'acres_to_treat')::numeric,
      COALESCE((v_field->>'sort_order')::integer, 0)
    );
  END LOOP;

  DELETE FROM job_chemicals WHERE job_id = v_job_id;
  FOR v_chem IN SELECT * FROM jsonb_array_elements(p_chemicals) LOOP
    INSERT INTO job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit, cost_per_unit_cents, price_per_unit_cents, sort_order)
    VALUES (
      v_job_id,
      (v_chem->>'product_id')::uuid,
      COALESCE((v_chem->>'quantity')::numeric, 0),
      v_chem->>'unit',
      (v_chem->>'rate_per_acre')::numeric,
      v_chem->>'rate_unit',
      COALESCE((v_chem->>'cost_per_unit_cents')::bigint, 0),
      COALESCE((v_chem->>'price_per_unit_cents')::bigint, 0),
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
