-- idempotency-body-check: exempt
-- ============================================================================
-- transfer_job_to_invoice — fix the v_conversion "record not assigned yet" crash
-- ----------------------------------------------------------------------------
-- Phase 1b of the As-Applied / Field-Invoice build
-- (docs/plans/2026-06-18-as-applied-application-invoices-plan.md). Proving the
-- applied->invoice loop end-to-end against live surfaced a REAL, reproducible
-- crash that has been latent since the function shipped (the loop had never run
-- in production — 0 field-app invoices exist live):
--
--   ERROR 55000: record "v_conversion" is not assigned yet
--   CONTEXT: INSERT INTO invoice_items (... total_applied_gl_lb, gl_lb_unit ...)
--            VALUES (... v_conversion.converted_value, v_conversion.converted_unit ...)
--
-- ROOT CAUSE: the chemical loop did
--     v_conversion := NULL;
--     IF v_total_applied IS NOT NULL AND v_chem.rate_unit IS NOT NULL THEN
--       SELECT * INTO v_conversion FROM convert_to_gl_lb(...);
--     END IF;
--     INSERT INTO invoice_items (... v_conversion.converted_value ...);
--   `v_conversion := NULL` does NOT give a RECORD variable a tuple structure, so
--   whenever a chemical line has NO per-acre rate (rate_per_acre / rate_unit
--   NULL — extremely common: any flat-priced or hand-entered line), the IF is
--   skipped, v_conversion stays unassigned, and the very next INSERT raises
--   55000. The whole job -> field-invoice rail dies for that job.
--
-- FIX (single delta): call convert_to_gl_lb UNCONDITIONALLY. The helper already
--   returns exactly one row even for NULL inputs:
--     IF p_total_applied IS NULL OR p_rate_unit IS NULL THEN
--       RETURN QUERY SELECT NULL::numeric, NULL::text; RETURN;
--     END IF;
--   so `SELECT * INTO v_conversion FROM convert_to_gl_lb(...)` always assigns a
--   tuple structure (NULL values for unrated lines — identical end result for
--   the columns: total_applied_gl_lb / gl_lb_unit become NULL, exactly as the
--   guarded path intended). No other behaviour changes.
--
-- EVIDENCE (live, project rhyzpcqhnizqbxphqdkr, 2026-06-18):
--   * Reproduced the crash against the LIVE function with the existing
--     transfer-smoke fixture (rated chem first, unrated chem second) AND with a
--     fresh full-loop fixture — both raise 55000 on the invoice_items INSERT.
--   * Pre-fix live md5(prosrc) = a361586e3dc79032563634a0d41b4ecd (single
--     overload, prosecdef = true, search_path = public, pg_temp).
--   * convert_to_gl_lb(numeric,text,text) RETURNS TABLE(converted_value numeric,
--     converted_unit text), IMMUTABLE, always RETURN NEXT exactly one row.
--
-- BASELINE: body below is the live function VERBATIM (post-20260611002255,
--   which carries DELTA-1..5) EXCEPT the single sentinel-delimited DELTA-6.
--   CREATE OR REPLACE preserves the existing ACL (authenticated + service_role
--   EXECUTE; no anon / PUBLIC) — grants are NOT restated, so no grant change is
--   made; the self-verification block below asserts the ACL is intact.
--
-- DELTA-6 (this migration): replace the guarded `v_conversion := NULL; IF ...
--   SELECT * INTO v_conversion ...; END IF;` block with an UNCONDITIONAL
--   `SELECT * INTO v_conversion FROM convert_to_gl_lb(...)`.
--
-- NOT CHANGED (deliberately out of scope, tracked for Phase 1c — the rail
--   converge onto save_field_app_invoice + post_invoice_group):
--   * G1 dropped machine fee (no is_application_fee line from
--     jobs.application_service_id).
--   * G3 strict-actor: p_performed_by is still attribution-only (role-gated on
--     auth.uid(), but no ACTOR_MISMATCH binding).
--   * The duplicate client-side job_invoiced activity_feed log (JobDetail.tsx).
--   These remain Phase-1c work so this Phase-1b fix stays a minimal, safe,
--   single-delta crash repair that Mason can approve on its own.
--
-- PARKED: do NOT apply without Mason's explicit OK.
-- ============================================================================

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
  v_existing jsonb;
  v_result jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin','sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized: requires admin,sales_rep role';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'transfer_job_to_invoice');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
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
    -- BEGIN DELTA-1 (transfer_job_invoice_column_fixes): insert as 'draft' —
    -- trg_invoice_draft_insert rejects any non-draft, non-credit_memo insert;
    -- DELTA-4 flips to 'unposted' (legal draft->unposted) once fully built.
    -- Live literal was 'unposted'.
    v_invoice_number, v_job.customer_id, 'field_application', 'draft',
    -- END DELTA-1
    CURRENT_DATE, (CURRENT_DATE + interval '30 days')::date,
    COALESCE(v_job.total_price_cents, 0), 0, 0, 0,
    v_field_names, v_crop_type, v_total_acres, v_applicator_name, v_vehicle_name,
    -- BEGIN DELTA-2 (transfer_job_invoice_column_fixes): jobs has no
    -- "scheduled" date column — the real date column is job_date (42703 fix;
    -- original expression recorded in the migration header).
    v_job.job_date, v_job.notes,
    -- END DELTA-2
    CASE WHEN extract(month FROM CURRENT_DATE) >= 10
         THEN extract(year FROM CURRENT_DATE)::integer + 1
         ELSE extract(year FROM CURRENT_DATE)::integer END,
    p_performed_by, p_job_id
  ) RETURNING id INTO v_invoice_id;

  FOR v_chem IN
    SELECT jc.product_id, jc.rate_per_acre,
           -- BEGIN DELTA-3 (transfer_job_invoice_column_fixes): job_chemicals
           -- has no rolled-up money columns — line totals are per-unit cents
           -- x quantity (the create_job_from_quote_section rollup math), via
           -- safe_cents_qty (42703 fix; resolves the 5 v_chem cascades;
           -- original expressions recorded in the migration header).
           safe_cents_qty(jc.cost_per_unit_cents, jc.quantity) AS chem_cost,
           safe_cents_qty(jc.price_per_unit_cents, jc.quantity) AS chem_price,
           -- END DELTA-3
           p.product_name, p.unit_size, p.epa_registration, p.product_form,
           COALESCE(jc.rate_unit, p.unit_size) AS rate_unit
    FROM job_chemicals jc JOIN products p ON p.id = jc.product_id
    WHERE jc.job_id = p_job_id ORDER BY p.product_name
  LOOP
    v_item_order := v_item_order + 1;
    v_total_cost_cents := v_total_cost_cents + COALESCE(v_chem.chem_cost, 0);
    v_total_applied := CASE WHEN v_chem.rate_per_acre IS NOT NULL AND v_total_acres > 0
      THEN v_chem.rate_per_acre * v_total_acres ELSE NULL END;
    -- BEGIN DELTA-6 (transfer_job_invoice_conversion_record_fix): call
    -- convert_to_gl_lb UNCONDITIONALLY so v_conversion always receives a tuple
    -- structure. The helper returns exactly one row even for NULL inputs, so an
    -- unrated line yields (NULL, NULL) — the same end result the old guarded
    -- branch intended — WITHOUT leaving v_conversion unassigned. The previous
    -- block reset v_conversion to a bare scalar NULL and then re-assigned it
    -- (via SELECT ... INTO) ONLY inside an "IF rate present" guard, so any
    -- chemical line without a per-acre rate crashed the invoice_items INSERT
    -- below with 55000 "record not assigned yet". (NB: this comment must NOT
    -- contain the literal executable reset string the self-verify scans for.)
    SELECT * INTO v_conversion
      FROM convert_to_gl_lb(v_total_applied, v_chem.rate_unit, v_chem.product_form);
    -- END DELTA-6
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
          v_amount := safe_cents_qty(v_share.price_override_cents, v_share.share_acres);
          v_ppa := v_share.price_override_cents;
        ELSE
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

  -- BEGIN DELTA-4 (transfer_job_invoice_column_fixes): restore the live
  -- body's intended end state. The invoice was inserted as 'draft' (DELTA-1,
  -- to satisfy trg_invoice_draft_insert); flip to 'unposted' now that items,
  -- shares and totals are final. draft -> unposted is explicitly allowed by
  -- _enforce_invoice_status_transition; trg_sync_blend_ticket_payment no-ops
  -- (blend_ticket_id IS NULL).
  UPDATE invoices SET status = 'unposted' WHERE id = v_invoice_id;
  -- END DELTA-4

  -- BEGIN DELTA-5 (transfer_job_invoice_column_fixes): the relation the live
  -- body logged to does not exist (42P01) — log to activity_feed using its
  -- real shape, per the live precedent in convert_quote_to_order /
  -- create_direct_order / save_blend_ticket. performed_by is NOT NULL:
  -- COALESCE to auth.uid(), which the role gate guarantees is an active
  -- profile. (Original statement recorded in the migration header.)
  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('job_invoiced',
    'Job ' || v_job.job_number || ' transferred to invoice ' || v_invoice_number,
    COALESCE(p_performed_by, auth.uid()), 'job', p_job_id, v_job.customer_id);
  -- END DELTA-5

  v_result := jsonb_build_object('success', true, 'job_id', p_job_id, 'invoice_id', v_invoice_id, 'invoice_number', v_invoice_number);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'transfer_job_to_invoice', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

-- ============================================================================
-- SELF-VERIFICATION — raises (rolling back the migration) on any failure.
-- ============================================================================
DO $$
DECLARE
  v_count int;
  v_src text;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc WHERE proname = 'transfer_job_to_invoice' AND pronamespace = 'public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'transfer_job_to_invoice overload count = %, expected 1', v_count;
  END IF;

  SELECT prosrc INTO v_src
  FROM pg_proc WHERE proname = 'transfer_job_to_invoice' AND pronamespace = 'public'::regnamespace;

  -- The crash-causing guard MUST be gone …
  IF v_src LIKE '%v_conversion := NULL%' THEN
    RAISE EXCEPTION 'transfer_job_to_invoice still resets v_conversion to NULL (crash not fixed)';
  END IF;
  -- … replaced by DELTA-6's unconditional convert_to_gl_lb call …
  IF v_src NOT LIKE '%BEGIN DELTA-6%'
     OR v_src NOT LIKE '%SELECT * INTO v_conversion%FROM convert_to_gl_lb(v_total_applied, v_chem.rate_unit, v_chem.product_form)%' THEN
    RAISE EXCEPTION 'transfer_job_to_invoice: DELTA-6 unconditional convert_to_gl_lb missing';
  END IF;

  -- Prior deltas (1..5) must still be present (full body preserved)
  IF v_src NOT LIKE '%BEGIN DELTA-1%' OR v_src NOT LIKE '%BEGIN DELTA-2%'
     OR v_src NOT LIKE '%BEGIN DELTA-3%' OR v_src NOT LIKE '%BEGIN DELTA-4%'
     OR v_src NOT LIKE '%BEGIN DELTA-5%' THEN
    RAISE EXCEPTION 'transfer_job_to_invoice: a prior delta sentinel went missing';
  END IF;

  -- SECDEF + search_path retained
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'transfer_job_to_invoice' AND pronamespace = 'public'::regnamespace
      AND prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path%'
  ) THEN
    RAISE EXCEPTION 'transfer_job_to_invoice must be SECURITY DEFINER with search_path';
  END IF;

  -- ACL preserved by CREATE OR REPLACE: authenticated + service_role yes, anon no.
  IF NOT has_function_privilege('authenticated', 'public.transfer_job_to_invoice(uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'transfer_job_to_invoice: authenticated lost EXECUTE';
  END IF;
  IF has_function_privilege('anon', 'public.transfer_job_to_invoice(uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'transfer_job_to_invoice: anon has EXECUTE';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.transfer_job_to_invoice(uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'transfer_job_to_invoice: service_role lost EXECUTE';
  END IF;
END $$;
