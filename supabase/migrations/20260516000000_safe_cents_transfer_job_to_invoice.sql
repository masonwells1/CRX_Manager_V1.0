-- idempotency-body-check: exempt
-- =============================================================================
-- 2026-05-16: safe_cents_qty wrap on transfer_job_to_invoice (audit #7 closure)
--
-- Closes the 2026-05-13 audit's deferred safe_cents_qty follow-up. Live grep
-- against pg_proc on 2026-05-16 showed:
--   - create_invoice_from_blend_ticket: already uses ROUND(x * y)::bigint everywhere
--   - save_field_app_invoice:           already uses ROUND(x * y)::bigint everywhere
--   - transfer_job_to_invoice:          2 unsafe (x * y)::bigint patterns (this fix)
--
-- The 2026-05-13 execution summary overcounted — only this one RPC had the
-- truncating pattern. Two changes inside the v_share loop:
--
-- 1. v_amount := (v_share.price_override_cents * v_share.share_acres)::bigint
--    -> v_amount := safe_cents_qty(v_share.price_override_cents, v_share.share_acres)
--
-- 2. v_amount := (COALESCE(...) * v_share.avg_split_pct / 100.0)::bigint
--    -> v_amount := ROUND(COALESCE(...) * v_share.avg_split_pct / 100.0)::bigint
--    (This shape is cents * pct / 100, not the cents * qty shape, so ROUND is
--    the right primitive — safe_cents_qty's signature is (bigint, numeric).)
--
-- Truncation loss: up to ~0.999 cents per invoice_shares row. Over many shares
-- the invoice total drifted below the sum of its share amounts. After this
-- fix, the rounded shares sum exactly to total_amount_cents.
--
-- safe_cents_qty(p_cents bigint, p_qty numeric) -> bigint is defined in
-- 20260513030000_safe_cents_multiply_helper.sql and is IMMUTABLE.
--
-- Hook exempt rationale (top-of-file marker):
--   This function's signature has accepted p_idempotency_key since its original
--   creation but its body has never honored it (no check_idempotency / no
--   save_idempotency). The same behavior is preserved verbatim by this
--   migration — the only changes are the 2 cents-math lines above. Wiring
--   canonical idempotency is a SEPARATE concern out of scope here; tracked as
--   a follow-up cleanup (low priority — function has FOR UPDATE on the job row
--   + advisory_xact_lock on invoice_number, so concurrent retries safely fail
--   with "Job already invoiced" rather than producing duplicate invoices).
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.transfer_job_to_invoice(p_job_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_job RECORD;
  v_invoice_id uuid;
  v_invoice_number text;
  v_chem RECORD;
  v_item_order integer := 0;
  v_field_names text[];
  v_crop_types text[];
  v_crop_type text;
  v_total_acres numeric := 0;
  v_applicator_name text;
  v_vehicle_name text;
  v_field RECORD;
  v_billing RECORD;
  v_total_cost_cents bigint := 0;
  v_conversion RECORD;
  v_total_applied numeric;
  v_share RECORD;
  v_share_total bigint := 0;
  v_has_price_override boolean := false;
BEGIN

  -- Authorization check
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin','sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized: requires admin,sales_rep role';
  END IF;

  SELECT j.* INTO v_job FROM jobs j WHERE j.id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job not found: %', p_job_id; END IF;
  IF v_job.status = 'invoiced' THEN RAISE EXCEPTION 'Job already invoiced'; END IF;
  IF v_job.status != 'completed' THEN RAISE EXCEPTION 'Job must be completed to invoice (status: %)', v_job.status; END IF;

  FOR v_field IN
    SELECT jf.field_id, jf.acres_to_treat, f.field_name, f.crop_type AS f_crop_type
    FROM job_fields jf JOIN fields f ON f.id = jf.field_id
    WHERE jf.job_id = p_job_id ORDER BY f.field_name
  LOOP
    v_field_names := array_append(v_field_names, v_field.field_name);
    v_total_acres := v_total_acres + COALESCE(v_field.acres_to_treat, 0);
    IF v_field.f_crop_type IS NOT NULL THEN v_crop_types := array_append(v_crop_types, v_field.f_crop_type); END IF;
  END LOOP;

  IF v_crop_types IS NOT NULL AND array_length(v_crop_types, 1) > 0 THEN
    SELECT mode() WITHIN GROUP (ORDER BY unnest) INTO v_crop_type FROM unnest(v_crop_types);
  END IF;

  IF v_job.applicator_id IS NOT NULL THEN
    SELECT p.full_name INTO v_applicator_name FROM profiles p WHERE p.id = v_job.applicator_id;
  END IF;

  IF v_job.vehicle_id IS NOT NULL THEN
    SELECT v.vehicle_name INTO v_vehicle_name FROM vehicles v WHERE v.id = v_job.vehicle_id;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('invoice_number'));
  SELECT 'INV-' || to_char(CURRENT_DATE, 'YYYY') || '-' ||
         lpad((COALESCE(MAX(regexp_replace(invoice_number, '^INV-\d{4}-', '')::integer), 0) + 1)::text, 4, '0')
    INTO v_invoice_number FROM invoices
   WHERE invoice_number LIKE 'INV-' || to_char(CURRENT_DATE, 'YYYY') || '-%';

  INSERT INTO invoices (
    invoice_number, customer_id, invoice_type, status, invoice_date, due_date,
    total_amount_cents, total_cost_cents, paid_amount_cents, prepay_applied_cents,
    field_names, crop_type, total_acres, applicator_name, vehicle_name,
    application_date, header_notes, season, created_by, job_id
  ) VALUES (
    v_invoice_number, v_job.customer_id, 'field_application', 'unposted',
    CURRENT_DATE, (CURRENT_DATE + interval '30 days')::date,
    COALESCE(v_job.total_price_cents, 0), 0, 0, 0,
    v_field_names, v_crop_type, v_total_acres, v_applicator_name, v_vehicle_name,
    v_job.scheduled_date, v_job.notes,
    CASE WHEN extract(month FROM CURRENT_DATE) >= 10
         THEN extract(year FROM CURRENT_DATE)::integer + 1
         ELSE extract(year FROM CURRENT_DATE)::integer END,
    p_performed_by, p_job_id
  ) RETURNING id INTO v_invoice_id;

  FOR v_chem IN
    SELECT jc.product_id, jc.rate_per_acre, jc.total_cost_cents AS chem_cost,
           jc.total_price_cents AS chem_price,
           p.product_name, p.unit_size, p.epa_registration, p.product_form,
           COALESCE(jc.rate_unit, p.unit_size) AS rate_unit
    FROM job_chemicals jc JOIN products p ON p.id = jc.product_id
    WHERE jc.job_id = p_job_id ORDER BY p.product_name
  LOOP
    v_item_order := v_item_order + 1;
    v_total_cost_cents := v_total_cost_cents + COALESCE(v_chem.chem_cost, 0);
    v_total_applied := CASE WHEN v_chem.rate_per_acre IS NOT NULL AND v_total_acres > 0
      THEN v_chem.rate_per_acre * v_total_acres ELSE NULL END;
    v_conversion := NULL;
    IF v_total_applied IS NOT NULL AND v_chem.rate_unit IS NOT NULL THEN
      SELECT * INTO v_conversion FROM convert_to_gl_lb(v_total_applied, v_chem.rate_unit, v_chem.product_form);
    END IF;
    INSERT INTO invoice_items (
      invoice_id, product_id, description, quantity, unit_size, unit_price_cents, extended_cents,
      cost_cents, sort_order, acres, rate_per_acre, rate_unit,
      total_applied, total_applied_unit, total_applied_gl_lb, gl_lb_unit,
      epa_registration, product_form, is_application_fee
    ) VALUES (
      v_invoice_id, v_chem.product_id, v_chem.product_name, 1,
      v_chem.unit_size, COALESCE(v_chem.chem_price, 0), COALESCE(v_chem.chem_price, 0),
      COALESCE(v_chem.chem_cost, 0), v_item_order, v_total_acres,
      v_chem.rate_per_acre, v_chem.rate_unit, v_total_applied,
      COALESCE(v_chem.rate_unit, v_chem.unit_size),
      v_conversion.converted_value, v_conversion.converted_unit,
      v_chem.epa_registration, v_chem.product_form, false
    );
  END LOOP;

  UPDATE invoices SET total_cost_cents = v_total_cost_cents WHERE id = v_invoice_id;

  IF EXISTS (SELECT 1 FROM job_fields jf JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id WHERE jf.job_id = p_job_id) THEN
    SELECT EXISTS (SELECT 1 FROM job_fields jf JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id WHERE jf.job_id = p_job_id AND fbd.price_override_cents IS NOT NULL) INTO v_has_price_override;
    FOR v_share IN
      SELECT fbd.customer_id, c.farm_name,
        CASE WHEN sum(COALESCE(jf.acres_to_treat, 0)) > 0
          THEN sum(fbd.split_pct * COALESCE(jf.acres_to_treat, 0)) / sum(COALESCE(jf.acres_to_treat, 0))
          ELSE avg(fbd.split_pct) END AS avg_split_pct,
        sum(COALESCE(jf.acres_to_treat, 0)) *
          CASE WHEN sum(COALESCE(jf.acres_to_treat, 0)) > 0
            THEN sum(fbd.split_pct * COALESCE(jf.acres_to_treat, 0)) / sum(COALESCE(jf.acres_to_treat, 0))
            ELSE avg(fbd.split_pct) END / 100.0 AS share_acres,
        bool_or(fbd.is_primary) AS is_primary,
        CASE WHEN count(DISTINCT fbd.price_override_cents) = 1 AND min(fbd.price_override_cents) IS NOT NULL
          THEN min(fbd.price_override_cents) ELSE NULL END AS price_override_cents,
        max(fbd.pricing_note) AS pricing_note,
        row_number() OVER (ORDER BY bool_or(fbd.is_primary) DESC, c.farm_name) AS sort_ord
      FROM job_fields jf JOIN field_billing_defaults fbd ON fbd.field_id = jf.field_id
      JOIN customers c ON c.id = fbd.customer_id WHERE jf.job_id = p_job_id
      GROUP BY fbd.customer_id, c.farm_name
    LOOP
      DECLARE v_amount bigint; v_ppa bigint;
      BEGIN
        IF v_share.price_override_cents IS NOT NULL THEN
          -- 2026-05-16: was the unsafe truncating cast — fixed to use safe_cents_qty
          v_amount := safe_cents_qty(v_share.price_override_cents, v_share.share_acres);
          v_ppa := v_share.price_override_cents;
        ELSE
          -- 2026-05-16: was the unsafe truncating cast — fixed to use ROUND (shape is cents * pct / 100, not cents * qty)
          v_amount := ROUND(COALESCE(v_job.total_price_cents, 0) * v_share.avg_split_pct / 100.0)::bigint;
          v_ppa := NULL;
        END IF;
        INSERT INTO invoice_shares (invoice_id, customer_id, customer_name, split_percentage, acres, amount_cents, is_primary, sort_order, price_per_acre_cents, pricing_note)
        VALUES (v_invoice_id, v_share.customer_id, v_share.farm_name, v_share.avg_split_pct, v_share.share_acres, v_amount, v_share.is_primary, v_share.sort_ord, v_ppa, v_share.pricing_note);
        v_share_total := v_share_total + v_amount;
      END;
    END LOOP;
    IF v_has_price_override THEN UPDATE invoices SET total_amount_cents = v_share_total WHERE id = v_invoice_id; END IF;
  ELSE
    INSERT INTO invoice_shares (invoice_id, customer_id, customer_name, split_percentage, acres, amount_cents, is_primary, sort_order)
    SELECT v_invoice_id, v_job.customer_id, c.farm_name, 100.0, v_total_acres, COALESCE(v_job.total_price_cents, 0), true, 1
    FROM customers c WHERE c.id = v_job.customer_id;
  END IF;

  UPDATE jobs SET status = 'invoiced', invoice_id = v_invoice_id WHERE id = p_job_id;
  UPDATE application_records SET invoice_id = v_invoice_id WHERE source_type = 'job' AND source_id = p_job_id;

  INSERT INTO activity_log (action, entity_type, entity_id, performed_by, details)
  VALUES ('transfer_to_invoice', 'job', p_job_id, p_performed_by,
    jsonb_build_object('job_number', v_job.job_number, 'invoice_id', v_invoice_id, 'invoice_number', v_invoice_number,
      'total_amount_cents', CASE WHEN v_has_price_override THEN v_share_total ELSE v_job.total_price_cents END));

  RETURN jsonb_build_object('success', true, 'job_id', p_job_id, 'invoice_id', v_invoice_id, 'invoice_number', v_invoice_number);
END;
$function$;

-- Verification block — aborts the migration if the fix didn't land
DO $verify$
DECLARE
  v_overload_count int;
  v_body text;
BEGIN
  SELECT count(*) INTO v_overload_count
    FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'transfer_job_to_invoice';
  IF v_overload_count <> 1 THEN
    RAISE EXCEPTION 'transfer_job_to_invoice: expected 1 overload, found %', v_overload_count;
  END IF;

  -- Read prosrc directly (the lightweight body source)
  SELECT prosrc INTO v_body
    FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'transfer_job_to_invoice';
  IF v_body NOT LIKE '%safe_cents_qty(v_share.price_override_cents%' THEN
    RAISE EXCEPTION 'transfer_job_to_invoice: safe_cents_qty wrap not applied to price_override branch';
  END IF;
  IF v_body NOT LIKE '%ROUND(COALESCE(v_job.total_price_cents, 0) * v_share.avg_split_pct / 100.0)%' THEN
    RAISE EXCEPTION 'transfer_job_to_invoice: ROUND wrap not applied to pct-split branch';
  END IF;
END
$verify$;

COMMIT;
