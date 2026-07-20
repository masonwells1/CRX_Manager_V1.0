-- Per-line split billing Phase 3: atomic plan-driven save writer.
-- Feature flag remains OFF. This migration is intentionally not applied live.
-- idempotency-body-check: exempt (payload-bound idempotency is implemented inline).

BEGIN;

DO $preflight$
BEGIN
  IF to_regprocedure(
    'public.save_field_app_invoice_per_line(uuid,jsonb,jsonb,jsonb,uuid,uuid,uuid,jsonb,text)'
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'PER_LINE_PHASE3_FUNCTION_DRIFT: save writer already exists'
      USING ERRCODE = 'duplicate_function';
  END IF;
  IF to_regprocedure('public._transfer_job_to_invoice_legacy_20260720(uuid,uuid,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'PER_LINE_PHASE3_FUNCTION_DRIFT: transfer helper already exists'
      USING ERRCODE = 'duplicate_function';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.app_settings
     WHERE setting_key = 'feature_per_line_split_billing'
       AND setting_value = 'false'
  ) THEN
    RAISE EXCEPTION 'PER_LINE_PHASE3_REQUIRES_DISABLED_FLAG'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END;
$preflight$;

CREATE FUNCTION public.save_field_app_invoice_per_line(
  p_invoice_id uuid,
  p_invoice jsonb,
  p_locations jsonb,
  p_chemicals jsonb,
  p_performed_by uuid,
  p_application_service_id uuid,
  p_job_id uuid,
  p_options jsonb DEFAULT '{}'::jsonb,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $writer$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_flag text;
  v_payload_hash text;
  v_cached jsonb;
  v_plan jsonb;
  v_customer jsonb;
  v_line jsonb;
  v_share jsonb;
  v_loc jsonb;
  v_loc_share jsonb;
  v_customer_id uuid;
  v_invoice_id uuid;
  v_invoice_ids uuid[] := '{}';
  v_new_invoice_ids uuid[] := '{}';
  v_invoice_map jsonb := '{}'::jsonb;
  v_existing_group_id uuid;
  v_group_id uuid;
  v_locked_group_id uuid;
  v_locked_status text;
  v_customer_count integer;
  v_billing_set_id uuid;
  v_billing_line_id uuid;
  v_invoice_item_id uuid;
  v_location_id uuid;
  v_invoice_total bigint;
  v_invoice_cost bigint;
  v_invoice_acres numeric;
  v_primary_customer_id uuid;
  v_is_new boolean;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  SELECT role INTO v_actor_role FROM public.profiles
   WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;
  IF p_job_id IS NULL THEN RAISE EXCEPTION 'PER_LINE_JOB_ID_REQUIRED'; END IF;
  IF jsonb_typeof(COALESCE(p_locations, 'null'::jsonb)) <> 'array'
     OR jsonb_array_length(p_locations) = 0 THEN
    RAISE EXCEPTION 'PER_LINE_LOCATIONS_REQUIRED';
  END IF;
  IF jsonb_typeof(COALESCE(p_chemicals, 'null'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'PER_LINE_CHEMICALS_INVALID';
  END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'PER_LINE_IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  IF COALESCE(jsonb_array_length(COALESCE(p_options->'grower_share_field_ids', '[]'::jsonb)), 0) > 0
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_locations) x
        WHERE COALESCE((x->>'grower_share')::boolean, false)
     ) THEN
    RAISE EXCEPTION 'PER_LINE_MODE_A_UNSUPPORTED';
  END IF;

  SELECT setting_value INTO v_flag FROM public.app_settings
   WHERE setting_key = 'feature_per_line_split_billing';
  IF v_flag IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'PER_LINE_FEATURE_DISABLED';
  END IF;

  -- The writer constructs the parent, lines, items, and shares as one graph.
  -- Do not inherit an IMMEDIATE constraint mode from an outer transaction;
  -- validate the completed graph explicitly at the end instead.
  SET CONSTRAINTS ALL DEFERRED;

  v_payload_hash := encode(extensions.digest(
    jsonb_build_object(
      'invoice_id', p_invoice_id,
      'invoice', COALESCE(p_invoice, '{}'::jsonb),
      'locations', p_locations,
      'chemicals', p_chemicals,
      'application_service_id', p_application_service_id,
      'job_id', p_job_id,
      'options', COALESCE(p_options, '{}'::jsonb)
    )::text,
    'sha256'
  ), 'hex');

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('save_field_app_invoice_per_line:' || p_idempotency_key, 0)
    );
    SELECT result INTO v_cached FROM public.idempotency_keys
     WHERE idempotency_key = p_idempotency_key
       AND operation = 'save_field_app_invoice_per_line';
    IF v_cached IS NOT NULL THEN
      IF v_cached->>'payload_hash' IS DISTINCT FROM v_payload_hash THEN
        RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_CONFLICT';
      END IF;
      RETURN v_cached - 'payload_hash';
    END IF;
  END IF;

  IF p_invoice_id IS NOT NULL THEN
    SELECT invoice_group_id INTO v_existing_group_id
      FROM public.invoices
     WHERE id = p_invoice_id AND deleted_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'INVOICE_NOT_FOUND'; END IF;
    IF v_existing_group_id IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(hashtextextended(v_existing_group_id::text, 0));
      PERFORM 1 FROM public.invoices
       WHERE invoice_group_id = v_existing_group_id AND deleted_at IS NULL
       ORDER BY id FOR UPDATE;
    ELSE
      PERFORM 1 FROM public.invoices
       WHERE id = p_invoice_id AND deleted_at IS NULL FOR UPDATE;
    END IF;
    SELECT status, invoice_group_id INTO v_locked_status, v_locked_group_id
      FROM public.invoices WHERE id = p_invoice_id AND deleted_at IS NULL;
    IF v_locked_group_id IS DISTINCT FROM v_existing_group_id THEN
      RAISE EXCEPTION 'INVOICE_GROUP_CHANGED';
    END IF;
    IF v_locked_status NOT IN ('draft', 'unposted') OR (
      v_existing_group_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.invoices
         WHERE invoice_group_id = v_existing_group_id
           AND deleted_at IS NULL
           AND status NOT IN ('draft', 'unposted')
      )
    ) THEN
      RAISE EXCEPTION 'PER_LINE_INVOICE_NOT_EDITABLE';
    END IF;
  END IF;

  v_plan := public._calculate_per_line_split_billing_plan(
    p_job_id, p_locations, p_chemicals, p_application_service_id,
    p_invoice_id, COALESCE(p_options, '{}'::jsonb)
  );
  v_customer_count := jsonb_array_length(v_plan->'per_customer');
  IF v_customer_count < 1 THEN RAISE EXCEPTION 'PER_LINE_PLAN_EMPTY'; END IF;
  SELECT (x->>'customer_id')::uuid INTO v_primary_customer_id
    FROM jsonb_array_elements(v_plan->'per_customer') x
   ORDER BY COALESCE((x->>'is_primary')::boolean, false) DESC,
            (x->>'customer_id')::uuid
   LIMIT 1;
  v_group_id := CASE WHEN v_customer_count > 1
    THEN COALESCE(v_existing_group_id, gen_random_uuid()) ELSE NULL END;

  IF v_existing_group_id IS NOT NULL THEN
    DELETE FROM public.field_app_billing_sets WHERE invoice_group_id = v_existing_group_id;
    DELETE FROM public.field_app_location_shares WHERE location_id IN (
      SELECT id FROM public.field_app_locations WHERE invoice_group_id = v_existing_group_id
    );
    DELETE FROM public.field_app_locations WHERE invoice_group_id = v_existing_group_id;
    DELETE FROM public.invoice_shares WHERE invoice_id IN (
      SELECT id FROM public.invoices WHERE invoice_group_id = v_existing_group_id AND deleted_at IS NULL
    );
    DELETE FROM public.invoice_items WHERE invoice_id IN (
      SELECT id FROM public.invoices WHERE invoice_group_id = v_existing_group_id AND deleted_at IS NULL
    );
  ELSIF p_invoice_id IS NOT NULL THEN
    DELETE FROM public.field_app_billing_sets billing_set
     WHERE billing_set.invoice_group_id IS NULL
       AND EXISTS (
         SELECT 1
           FROM public.field_app_billing_lines billing_line
           JOIN public.invoice_line_shares line_share
             ON line_share.billing_line_id = billing_line.id
           JOIN public.invoice_items item
             ON item.id = line_share.invoice_item_id
          WHERE billing_line.billing_set_id = billing_set.id
            AND item.invoice_id = p_invoice_id
       );
    DELETE FROM public.field_app_location_shares WHERE location_id IN (
      SELECT id FROM public.field_app_locations WHERE invoice_id = p_invoice_id
    );
    DELETE FROM public.field_app_locations WHERE invoice_id = p_invoice_id;
    DELETE FROM public.invoice_shares WHERE invoice_id = p_invoice_id;
    DELETE FROM public.invoice_items WHERE invoice_id = p_invoice_id;
  END IF;

  FOR v_customer IN SELECT value FROM jsonb_array_elements(v_plan->'per_customer')
  LOOP
    v_customer_id := (v_customer->>'customer_id')::uuid;
    IF v_actor_role = 'sales_rep' AND NOT EXISTS (
      SELECT 1 FROM public.customers
       WHERE id = v_customer_id AND assigned_sales_rep = v_actor
    ) THEN
      RAISE EXCEPTION 'CUSTOMER_SCOPE_DENIED';
    END IF;
    v_invoice_id := NULL;
    IF v_existing_group_id IS NOT NULL THEN
      SELECT id INTO v_invoice_id FROM public.invoices
       WHERE invoice_group_id = v_existing_group_id
         AND customer_id = v_customer_id AND deleted_at IS NULL LIMIT 1;
    ELSIF p_invoice_id IS NOT NULL AND v_customer_count = 1 THEN
      v_invoice_id := p_invoice_id;
    END IF;
    v_is_new := v_invoice_id IS NULL;
    IF v_is_new THEN
      INSERT INTO public.invoices (
        invoice_number, customer_id, invoice_type, status, invoice_date,
        salesman_id, header_notes, created_by, total_amount_cents,
        total_cost_cents, invoice_group_id, application_service_id, job_id,
        send_disposition, season
      ) VALUES (
        public.next_invoice_number(), v_customer_id, 'field_application', 'draft',
        COALESCE((p_invoice->>'invoice_date')::date, CURRENT_DATE),
        CASE WHEN v_actor_role = 'admin' THEN (p_invoice->>'salesman_id')::uuid ELSE v_actor END,
        p_invoice->>'header_notes', v_actor, 0, 0, v_group_id,
        p_application_service_id, p_job_id, 'sendable', public.current_season()
      ) RETURNING id INTO v_invoice_id;
      v_new_invoice_ids := array_append(v_new_invoice_ids, v_invoice_id);
    ELSE
      UPDATE public.invoices SET
        invoice_date = COALESCE((p_invoice->>'invoice_date')::date, invoice_date),
        header_notes = COALESCE(p_invoice->>'header_notes', header_notes),
        application_service_id = p_application_service_id,
        job_id = p_job_id,
        invoice_group_id = v_group_id,
        total_amount_cents = 0,
        total_cost_cents = 0,
        send_disposition = 'sendable',
        updated_at = now()
      WHERE id = v_invoice_id;
    END IF;
    v_invoice_ids := array_append(v_invoice_ids, v_invoice_id);
    v_invoice_map := v_invoice_map || jsonb_build_object(v_customer_id::text, v_invoice_id);
  END LOOP;

  IF v_existing_group_id IS NOT NULL THEN
    UPDATE public.invoices SET
      status = 'cancelled', invoice_group_id = NULL,
      total_amount_cents = 0, total_cost_cents = 0,
      send_disposition = 'sendable', updated_at = now()
    WHERE invoice_group_id = v_existing_group_id
      AND deleted_at IS NULL
      AND NOT (customer_id = ANY(ARRAY(
        SELECT (x->>'customer_id')::uuid
          FROM jsonb_array_elements(v_plan->'per_customer') x
      )));
  END IF;

  INSERT INTO public.field_app_billing_sets (
    invoice_group_id, job_id, primary_customer_id, status,
    rounding_policy_version, created_by
  ) VALUES (
    v_group_id, p_job_id, v_primary_customer_id, 'draft',
    (v_plan->>'rounding_policy_version')::integer, v_actor
  ) RETURNING id INTO v_billing_set_id;

  FOR v_line IN SELECT value FROM jsonb_array_elements(v_plan->'billing_lines')
  LOOP
    INSERT INTO public.field_app_billing_lines (
      billing_set_id, line_kind, price_basis, source_job_chemical_id,
      product_id, application_service_id, description, source_quantity,
      source_acres, source_unit_size, source_cost_cents,
      source_total_cost_cents, source_unit_price_cents,
      source_amount_cents, sort_order
    ) VALUES (
      v_billing_set_id, v_line->>'line_kind', v_line->>'price_basis',
      NULLIF(v_line->>'source_job_chemical_id', '')::uuid,
      NULLIF(v_line->>'product_id', '')::uuid,
      NULLIF(v_line->>'application_service_id', '')::uuid,
      v_line->>'description', NULLIF(v_line->>'source_quantity', '')::numeric,
      NULLIF(v_line->>'source_acres', '')::numeric,
      v_line->>'source_unit_size', (v_line->>'source_cost_cents')::bigint,
      (v_line->>'source_total_cost_cents')::bigint,
      NULLIF(v_line->>'source_unit_price_cents', '')::bigint,
      NULLIF(v_line->>'source_amount_cents', '')::bigint,
      (v_line->>'sort_order')::integer
    ) RETURNING id INTO v_billing_line_id;

    FOR v_share IN SELECT value FROM jsonb_array_elements(v_line->'shares')
    LOOP
      v_customer_id := (v_share->>'customer_id')::uuid;
      v_invoice_id := (v_invoice_map->>v_customer_id::text)::uuid;
      INSERT INTO public.invoice_items (
        invoice_id, product_id, description, quantity, unit_size,
        unit_price_cents, extended_cents, cost_cents, sort_order,
        acres, rate_per_acre, rate_unit, is_application_fee, price_source
      ) VALUES (
        v_invoice_id, NULLIF(v_line->>'product_id', '')::uuid,
        v_line->>'description',
        CASE WHEN v_line->>'line_kind' = 'flat_fee' THEN 1
             WHEN v_line->>'line_kind' = 'service' THEN (v_share->>'allocated_acres')::numeric
             ELSE (v_share->>'allocated_quantity')::numeric END,
        v_line->>'source_unit_size', (v_share->>'unit_price_cents')::bigint,
        (v_share->>'amount_cents')::bigint,
        (v_line->>'source_cost_cents')::bigint,
        (v_line->>'sort_order')::integer,
        round(NULLIF(v_share->>'allocated_acres', '')::numeric, 2),
        CASE WHEN v_line->>'line_kind' = 'service' THEN (v_share->>'unit_price_cents')::numeric ELSE NULL END,
        CASE WHEN v_line->>'line_kind' = 'service' THEN 'acre' ELSE NULL END,
        v_line->>'line_kind' = 'service', v_share->>'base_price_source'
      ) RETURNING id INTO v_invoice_item_id;

      INSERT INTO public.invoice_line_shares (
        billing_line_id, invoice_item_id, customer_id, split_mode,
        split_micro_pct, allocated_quantity, allocated_acres,
        allocated_cost_cents, base_unit_price_cents, base_price_source,
        price_mode, unit_price_cents, amount_cents,
        split_override_reason, price_override_reason,
        calculation_hash, vector_hash, created_by
      ) VALUES (
        v_billing_line_id, v_invoice_item_id, v_customer_id,
        v_share->>'split_mode', (v_share->>'split_micro_pct')::integer,
        (v_share->>'allocated_quantity')::numeric,
        (v_share->>'allocated_acres')::numeric,
        (v_share->>'allocated_cost_cents')::bigint,
        (v_share->>'base_unit_price_cents')::bigint,
        v_share->>'base_price_source', v_share->>'price_mode',
        (v_share->>'unit_price_cents')::bigint,
        (v_share->>'amount_cents')::bigint,
        v_share->>'split_override_reason', v_share->>'price_override_reason',
        v_share->>'calculation_hash', v_share->>'vector_hash', v_actor
      );
    END LOOP;
  END LOOP;

  FOR v_customer IN SELECT value FROM jsonb_array_elements(v_plan->'per_customer')
  LOOP
    v_customer_id := (v_customer->>'customer_id')::uuid;
    v_invoice_id := (v_invoice_map->>v_customer_id::text)::uuid;
    v_invoice_total := (v_customer->>'total_cents')::bigint;
    SELECT COALESCE(sum((s->>'allocated_cost_cents')::bigint), 0),
           COALESCE(sum((s->>'allocated_acres')::numeric), 0)
      INTO v_invoice_cost, v_invoice_acres
      FROM jsonb_array_elements(v_plan->'billing_lines') l
      CROSS JOIN LATERAL jsonb_array_elements(l->'shares') s
     WHERE (s->>'customer_id')::uuid = v_customer_id;
    UPDATE public.invoices SET
      total_amount_cents = v_invoice_total,
      total_cost_cents = v_invoice_cost,
      send_disposition = CASE WHEN v_invoice_total = 0
        THEN 'suppressed_zero_total' ELSE 'sendable' END,
      updated_at = now()
    WHERE id = v_invoice_id;
    INSERT INTO public.invoice_shares (
      invoice_id, customer_id, customer_name, split_percentage,
      acres, amount_cents, is_primary, sort_order
    ) VALUES (
      v_invoice_id, v_customer_id, v_customer->>'customer_name', 100,
      v_invoice_acres, v_invoice_total,
      COALESCE((v_customer->>'is_primary')::boolean, false), 0
    );
  END LOOP;

  INSERT INTO public.financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, actor_role,
    new_values, total_impact_cents, description
  )
  SELECT
    'invoice_created', 'invoice', invoice.id, v_actor, v_actor_role,
    jsonb_build_object(
      'invoice_number', invoice.invoice_number,
      'job_id', invoice.job_id,
      'customer_id', invoice.customer_id,
      'total_cents', invoice.total_amount_cents,
      'invoice_group_id', invoice.invoice_group_id
    ),
    invoice.total_amount_cents,
    'Per-line field application invoice created'
  FROM public.invoices invoice
  WHERE invoice.id = ANY(v_new_invoice_ids);

  FOR v_loc IN SELECT value FROM jsonb_array_elements(p_locations)
  LOOP
    INSERT INTO public.field_app_locations (
      invoice_id, invoice_group_id, field_id, map_number, total_acres,
      planted_acres, applied_acres, crop_type, wind_direction, sort_order
    ) VALUES (
      CASE WHEN v_group_id IS NULL THEN v_invoice_ids[1] ELSE NULL END,
      v_group_id, (v_loc->>'field_id')::uuid,
      NULLIF(v_loc->>'map_number', '')::integer,
      NULLIF(v_loc->>'total_acres', '')::numeric,
      NULLIF(v_loc->>'planted_acres', '')::numeric,
      (v_loc->>'applied_acres')::numeric,
      v_loc->>'crop_type', v_loc->>'wind_direction',
      COALESCE((v_loc->>'sort_order')::integer, 0)
    ) RETURNING id INTO v_location_id;
    FOR v_loc_share IN
      SELECT value FROM jsonb_array_elements(v_plan->'shares_detail'->'rows')
       WHERE (value->>'field_id')::uuid = (v_loc->>'field_id')::uuid
    LOOP
      INSERT INTO public.field_app_location_shares (
        location_id, customer_id, split_pct, acres, amount_cents
      ) VALUES (
        v_location_id, (v_loc_share->>'customer_id')::uuid,
        (v_loc_share->>'split_pct')::numeric,
        (v_loc_share->>'share_acres')::numeric, 0
      );
    END LOOP;
  END LOOP;

  PERFORM public._assert_per_line_split_billing_integrity(v_billing_set_id);
  SET CONSTRAINTS ALL IMMEDIATE;

  INSERT INTO public.activity_feed (
    event_type, description, performed_by, related_entity_type, related_entity_id
  ) VALUES (
    CASE WHEN p_invoice_id IS NULL THEN 'field_app_invoice_created' ELSE 'field_app_invoice_updated' END,
    'Per-line field application invoice saved from server calculator plan',
    v_actor, 'invoice', v_invoice_ids[1]
  );

  v_result := jsonb_build_object(
    'invoice_ids', to_jsonb(v_invoice_ids),
    'invoice_group_id', v_group_id,
    'billing_set_id', v_billing_set_id,
    'calculation_hash', v_plan->>'calculation_hash'
  );
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO public.idempotency_keys (idempotency_key, operation, result)
    VALUES (
      p_idempotency_key, 'save_field_app_invoice_per_line',
      v_result || jsonb_build_object('payload_hash', v_payload_hash)
    );
  END IF;
  RETURN v_result;
END;
$writer$;

REVOKE ALL ON FUNCTION public.save_field_app_invoice_per_line(
  uuid,jsonb,jsonb,jsonb,uuid,uuid,uuid,jsonb,text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_field_app_invoice_per_line(
  uuid,jsonb,jsonb,jsonb,uuid,uuid,uuid,jsonb,text
) TO authenticated, service_role;

-- transfer_job_to_invoice cannot use per-line vectors. Preserve the exact mature
-- implementation for flag-OFF behavior and refuse the divergent path when ON.
DO $transfer_preflight$
DECLARE
  v_fn regprocedure := to_regprocedure('public.transfer_job_to_invoice(uuid,uuid,text)');
  v_md5 text;
  v_owner name;
  v_definer boolean;
  v_config text[];
BEGIN
  IF v_fn IS NULL THEN RAISE EXCEPTION 'PER_LINE_TRANSFER_FUNCTION_MISSING'; END IF;
  SELECT md5(p.prosrc), r.rolname, p.prosecdef, p.proconfig
    INTO v_md5, v_owner, v_definer, v_config
    FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE p.oid = v_fn;
  IF v_md5 IS DISTINCT FROM '78b827f8509a2740ea9879364747c372'
     OR v_owner <> 'postgres' OR NOT v_definer
     OR v_config IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[] THEN
    RAISE EXCEPTION 'PER_LINE_TRANSFER_FUNCTION_DRIFT';
  END IF;
END;
$transfer_preflight$;

ALTER FUNCTION public.transfer_job_to_invoice(uuid,uuid,text)
  RENAME TO _transfer_job_to_invoice_legacy_20260720;
REVOKE ALL ON FUNCTION public._transfer_job_to_invoice_legacy_20260720(uuid,uuid,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._transfer_job_to_invoice_legacy_20260720(uuid,uuid,text)
  TO service_role;

CREATE FUNCTION public.transfer_job_to_invoice(
  p_job_id uuid,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $transfer$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.app_settings
     WHERE setting_key = 'feature_per_line_split_billing' AND setting_value = 'true'
  ) THEN
    RAISE EXCEPTION 'PER_LINE_TRANSFER_REQUIRES_FIELD_APP_SAVE';
  END IF;
  RETURN public._transfer_job_to_invoice_legacy_20260720(
    p_job_id, p_performed_by, p_idempotency_key
  );
END;
$transfer$;

REVOKE ALL ON FUNCTION public.transfer_job_to_invoice(uuid,uuid,text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transfer_job_to_invoice(uuid,uuid,text)
  TO authenticated, service_role;

DO $security_guard$
DECLARE
  v_bad text;
BEGIN
  WITH expected(signature, browser_exec) AS (
    VALUES
      ('public.save_field_app_invoice_per_line(uuid,jsonb,jsonb,jsonb,uuid,uuid,uuid,jsonb,text)', true),
      ('public.transfer_job_to_invoice(uuid,uuid,text)', true),
      ('public._transfer_job_to_invoice_legacy_20260720(uuid,uuid,text)', false)
  )
  SELECT string_agg(e.signature, ', ' ORDER BY e.signature) INTO v_bad
    FROM expected e
    LEFT JOIN pg_proc p ON p.oid = to_regprocedure(e.signature)
    LEFT JOIN pg_roles r ON r.oid = p.proowner
    LEFT JOIN pg_language l ON l.oid = p.prolang
   WHERE p.oid IS NULL OR r.rolname <> 'postgres' OR NOT p.prosecdef
      OR p.provolatile <> 'v' OR l.lanname <> 'plpgsql'
      OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
      OR has_function_privilege('anon', p.oid, 'EXECUTE')
      OR has_function_privilege('authenticated', p.oid, 'EXECUTE') IS DISTINCT FROM e.browser_exec;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'PER_LINE_PHASE3_FUNCTION_SECURITY_DRIFT: %', v_bad;
  END IF;
END;
$security_guard$;

COMMIT;
