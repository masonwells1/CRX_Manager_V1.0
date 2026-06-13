-- idempotency-body-check: exempt
-- ============================================================================
-- transfer_job_to_invoice — latent-break column fixes (plpgsql_check sweep,
-- 2026-06-10 error-prevention follow-up queue item #1; see
-- docs/audits/2026-06-10-error-prevention-execution-log.md §4.1)
-- ----------------------------------------------------------------------------
-- BUG (the function is dead on arrival — FIVE independent runtime breaks):
--   B-a  42703: the invoices INSERT reads v_job.scheduled_date — jobs has NO
--        scheduled_date column. The real column is job_date (date, NOT NULL);
--        jobs also has scheduled_time (time) but the value feeds
--        invoices.application_date (a date) and save_job writes the payload's
--        date into job_date — job_date is the rename target, not
--        scheduled_time.
--   B-b  42703: the job_chemicals loop reads jc.total_cost_cents and
--        jc.total_price_cents — job_chemicals has NEITHER. Its money columns
--        are cost_per_unit_cents (bigint) + price_per_unit_cents (bigint) +
--        quantity (numeric). Line total = per-unit cents x quantity — the
--        exact math create_job_from_quote_section uses to roll up
--        jobs.total_cost_cents / total_price_cents (price_per_unit *
--        total_units_needed * 100), implemented here via the house helper
--        safe_cents_qty(p_cents bigint, p_qty numeric) =
--        ROUND(cents * qty)::bigint (same helper the live body already uses
--        for invoice_shares amounts).
--   B-c  5x cascade "v_chem not assigned": pure downstream of B-b — the loop
--        SELECT fails to parse against the catalog, so every v_chem.* read is
--        flagged. Fixing the SELECT resolves all five; the loop body is
--        UNTOUCHED.
--   B-d  42P01: INSERT INTO activity_log — no such relation. The live feed
--        table is activity_feed (event_type / description / performed_by
--        [NOT NULL, FK profiles] / related_entity_type / related_entity_id /
--        customer_id). Mapped per the live precedent inserts in
--        convert_quote_to_order / create_direct_order / save_blend_ticket.
--        activity_feed has no details jsonb column — the old details payload
--        (job_number, invoice_number) is folded into the description text.
--        event_type 'job_invoiced' matches the frontend vocabulary for this
--        exact action (JobDetail.tsx:472 logActivity event).
--   B-e  (found during this draft, NOT in the plpgsql_check list — trigger
--        interaction, invisible to static check): the invoices INSERT uses
--        status 'unposted', but trg_invoice_draft_insert
--        (enforce_invoice_draft_on_insert) raises on ANY non-draft insert
--        unless invoice_type = 'credit_memo'. Even with B-a..B-d fixed the
--        function would crash at the INSERT. Fix: insert as 'draft' (the
--        status every sibling invoice-creating RPC inserts —
--        create_invoice_from_order / create_invoice_from_blend_ticket /
--        create_quick_delivery), then flip draft -> 'unposted' AFTER the
--        invoice is fully built — a transition explicitly allowed by
--        _enforce_invoice_status_transition (draft -> unposted/posted/
--        cancelled), preserving the live body's intended end state. The
--        AFTER UPDATE trg_sync_blend_ticket_payment no-ops when
--        blend_ticket_id IS NULL (verified live prosrc).
--
-- EVIDENCE (all read from live catalog 2026-06-10, project rhyzpcqhnizqbxphqdkr):
--   * jobs columns: id, job_number, customer_id, status, job_date,
--     scheduled_time, applicator_id, vehicle_id, recipe_id, notes, tags,
--     batch_id, season, total_acres, total_cost_cents, total_price_cents,
--     invoice_id, created_by, deleted_at, created_at, updated_at, priority,
--     estimated_hours, quote_id, quote_section_id, application_service_id.
--     NO scheduled_date.
--   * job_chemicals columns: id, job_id, product_id, quantity, unit,
--     rate_per_acre, rate_unit, cost_per_unit_cents, price_per_unit_cents,
--     sort_order. NO total_cost_cents / total_price_cents.
--   * activity_feed columns: id, event_type, description, performed_by,
--     related_entity_type, related_entity_id, customer_id, created_at.
--     No CHECK on event_type; performed_by NOT NULL FK -> profiles(id).
--   * enforce_invoice_draft_on_insert (BEFORE INSERT ON invoices): raises
--     unless NEW.status = 'draft' OR NEW.invoice_type = 'credit_memo'.
--   * _enforce_invoice_status_transition: draft -> unposted allowed.
--   * 'draft'/'unposted' are both in invoices_status_check;
--     'field_application' is in invoices_invoice_type_check;
--     'invoiced' is in jobs_status_check (completed -> invoiced allowed by
--     _enforce_job_status_transition).
--   * safe_cents_qty(p_cents bigint, p_qty numeric) exists, executable by
--     authenticated; called as owner inside this SECDEF anyway.
--
-- BASELINE (verbatim-from-live):
--   md5(prosrc) of live public.transfer_job_to_invoice(uuid, uuid, text)
--   pre-apply = 2603774c9d5175cf17481a700d3616cc  (single overload,
--   prosecdef = true, proconfig = search_path=public, pg_temp,
--   proacl = {postgres=X, authenticated=X, service_role=X}).
--   Body below is byte-faithful to pg_get_functiondef output EXCEPT the
--   sentinel-delimited deltas.
--
-- EXHAUSTIVE DELTA LIST (everything else is verbatim live):
--   DELTA-1  invoices INSERT status literal 'unposted' -> 'draft'   (B-e)
--   DELTA-2  v_job.scheduled_date -> v_job.job_date                 (B-a)
--   DELTA-3  loop SELECT: jc.total_cost_cents AS chem_cost ->
--            safe_cents_qty(jc.cost_per_unit_cents, jc.quantity) AS chem_cost;
--            jc.total_price_cents AS chem_price ->
--            safe_cents_qty(jc.price_per_unit_cents, jc.quantity) AS chem_price
--                                                                   (B-b, B-c)
--   DELTA-4  NEW statement after the share writes / before the feed insert:
--            UPDATE invoices SET status = 'unposted' WHERE id = v_invoice_id
--                                                                   (B-e)
--   DELTA-5  INSERT INTO activity_log (action, entity_type, entity_id,
--            performed_by, details) -> INSERT INTO activity_feed (event_type,
--            description, performed_by, related_entity_type,
--            related_entity_id, customer_id); performed_by =
--            COALESCE(p_performed_by, auth.uid()) (column is NOT NULL; the
--            role gate guarantees auth.uid() maps to a live profile)  (B-d)
--
-- DELIBERATELY NOT CHANGED (out of scope, noted for the record):
--   * The role gate / lack of strict-actor ACTOR_MISMATCH binding on
--     p_performed_by (attribution-only here; auth.uid() role-gated).
--   * The MAX(invoice_number)+1 generation (advisory-lock-serialized; the
--     2026-06-08 review LOW).
--   * create_job_from_quote_section's own activity_log insert (sibling
--     plpgsql_check finding — its own /ship).
--   * Frontend JobDetail.tsx also logs a 'job_invoiced' feed row client-side
--     after success; with DELTA-5 a transfer now produces two similar feed
--     rows. Cosmetic; candidate frontend follow-up (remove the client log).
--
-- GRANTS: restated below exactly as live (authenticated + service_role
-- EXECUTE; nothing for anon/PUBLIC). CREATE OR REPLACE preserves the ACL;
-- the REVOKE/GRANT pair makes the intent explicit and the DO block asserts it.
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

-- Grants restated exactly as live (proacl pre-apply:
-- {postgres=X, authenticated=X, service_role=X} — no anon, no PUBLIC).
REVOKE ALL ON FUNCTION public.transfer_job_to_invoice(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transfer_job_to_invoice(uuid, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.transfer_job_to_invoice(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.transfer_job_to_invoice(uuid, uuid, text) TO service_role;

-- ============================================================================
-- SELF-VERIFICATION — raises (rolling back the migration) on any failure.
-- ============================================================================
DO $$
DECLARE
  v_count int;
  v_src text;
BEGIN
  -- Exactly one overload
  SELECT count(*) INTO v_count
  FROM pg_proc WHERE proname = 'transfer_job_to_invoice' AND pronamespace = 'public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'transfer_job_to_invoice overload count = %, expected 1', v_count;
  END IF;

  SELECT prosrc INTO v_src
  FROM pg_proc WHERE proname = 'transfer_job_to_invoice' AND pronamespace = 'public'::regnamespace;

  -- All five delta sentinels present in the deployed body
  IF v_src NOT LIKE '%BEGIN DELTA-1%' OR v_src NOT LIKE '%BEGIN DELTA-2%'
     OR v_src NOT LIKE '%BEGIN DELTA-3%' OR v_src NOT LIKE '%BEGIN DELTA-4%'
     OR v_src NOT LIKE '%BEGIN DELTA-5%' THEN
    RAISE EXCEPTION 'transfer_job_to_invoice: missing delta sentinel marker(s)';
  END IF;

  -- The broken references must be GONE
  IF v_src LIKE '%v_job.scheduled_date%' THEN
    RAISE EXCEPTION 'transfer_job_to_invoice still reads v_job.scheduled_date';
  END IF;
  IF v_src LIKE '%jc.total_cost_cents%' OR v_src LIKE '%jc.total_price_cents%' THEN
    RAISE EXCEPTION 'transfer_job_to_invoice still reads job_chemicals total_* columns';
  END IF;
  IF v_src LIKE '%activity_log%' THEN
    RAISE EXCEPTION 'transfer_job_to_invoice still references activity_log';
  END IF;

  -- The fixes must be PRESENT
  IF v_src NOT LIKE '%v_job.job_date%' THEN
    RAISE EXCEPTION 'transfer_job_to_invoice: job_date fix missing';
  END IF;
  IF v_src NOT LIKE '%safe_cents_qty(jc.cost_per_unit_cents, jc.quantity)%'
     OR v_src NOT LIKE '%safe_cents_qty(jc.price_per_unit_cents, jc.quantity)%' THEN
    RAISE EXCEPTION 'transfer_job_to_invoice: job_chemicals line-total fix missing';
  END IF;
  IF v_src NOT LIKE '%INSERT INTO activity_feed%' THEN
    RAISE EXCEPTION 'transfer_job_to_invoice: activity_feed insert missing';
  END IF;
  IF v_src NOT LIKE '%UPDATE invoices SET status = ''unposted'' WHERE id = v_invoice_id%' THEN
    RAISE EXCEPTION 'transfer_job_to_invoice: draft->unposted flip missing';
  END IF;

  -- SECDEF + search_path retained
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'transfer_job_to_invoice' AND pronamespace = 'public'::regnamespace
      AND prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path%'
  ) THEN
    RAISE EXCEPTION 'transfer_job_to_invoice must be SECURITY DEFINER with search_path';
  END IF;

  -- ACL exactly as live: authenticated + service_role yes, anon no.
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
