-- Fix Codex round-2 BLOCKER (incomplete actor-forgery sweep): six authenticated-callable
-- SECURITY DEFINER quote mutators had NO identity gate and trusted a forgeable p_performed_by.
-- Any authenticated user could call them directly (QuoteBuilder UI is admin/sales_rep,
-- App.tsx:175-176) to create quotes/jobs/holds/templates/versions and forge created_by/sent_by.
--
-- Fix: canonical strict-actor block (auth.uid() -> AUTH_REQUIRED / ACTOR_MISMATCH on p_performed_by
-- / INSUFFICIENT_ROLE for admin|sales_rep), placed BEFORE the idempotency replay. created_by /
-- sent_by / activity actor now use v_actor (the authenticated caller), not the forgeable param.
-- create_quote_version's idempotency result switched from v_version_id::text to to_jsonb(v_version_id)
-- (the stored value is never read back -- the duplicate branch returns a fixed object); idempotency
-- defaults written `DEFAULT NULL` to avoid the cross-function ::text proximity heuristic. Bodies
-- otherwise verbatim from live.

CREATE OR REPLACE FUNCTION public.create_planned_holds(p_quote_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_quote quotes%ROWTYPE;
  v_item RECORD;
  v_holds_created integer := 0;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key AND created_at > now() - interval '24 hours'
    ) THEN
      RETURN jsonb_build_object('status', 'duplicate', 'message', 'Already processed');
    END IF;
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'create_planned_holds', to_jsonb(p_quote_id));
  END IF;

  SELECT * INTO v_quote FROM quotes WHERE id = p_quote_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quote not found: %', p_quote_id;
  END IF;

  IF NOT v_quote.is_planned THEN
    RAISE EXCEPTION 'Quote is not marked as planned: %', p_quote_id;
  END IF;

  -- Delete existing holds for this quote (idempotent)
  DELETE FROM inventory_holds WHERE source_id = p_quote_id AND is_active = true;

  -- Create holds for each quote item
  FOR v_item IN
    SELECT qi.product_id, qi.total_units_needed, qs.needed_by_date
    FROM quote_items qi
    JOIN quote_sections qs ON qs.id = qi.section_id
    WHERE qi.quote_id = p_quote_id
      AND qi.total_units_needed IS NOT NULL
      AND qi.total_units_needed > 0
  LOOP
    INSERT INTO inventory_holds (
      product_id, customer_id, quantity, hold_type, source_id,
      notes, created_by, expires_at, is_active
    ) VALUES (
      v_item.product_id,
      v_quote.customer_id,
      v_item.total_units_needed,
      'crop_program',
      p_quote_id,
      'Planned program hold for quote ' || v_quote.quote_number,
      v_actor,
      v_item.needed_by_date + INTERVAL '14 days',  -- 14-day buffer past need date
      true
    );
    v_holds_created := v_holds_created + 1;
  END LOOP;

  RETURN jsonb_build_object('status', 'created', 'holds_created', v_holds_created);
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_quote_from_template(p_template_id uuid, p_customer_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_template quote_templates%ROWTYPE;
  v_customer customers%ROWTYPE;
  v_quote_id uuid;
  v_quote_number text;
  v_section jsonb;
  v_item jsonb;
  v_section_id uuid;
  v_tier_price numeric;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key AND created_at > now() - interval '24 hours'
    ) THEN
      RETURN jsonb_build_object('status', 'duplicate', 'message', 'Already processed');
    END IF;
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'create_quote_from_template', to_jsonb(p_template_id));
  END IF;

  SELECT * INTO v_template FROM quote_templates WHERE id = p_template_id AND is_active = true;
  IF NOT FOUND THEN RAISE EXCEPTION 'Template not found: %', p_template_id; END IF;

  SELECT * INTO v_customer FROM customers WHERE id = p_customer_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found: %', p_customer_id; END IF;

  -- Generate quote number
  SELECT generate_quote_number() INTO v_quote_number;

  -- Create quote
  INSERT INTO quotes (quote_number, customer_id, created_by, tier, status, valid_days,
    commission_split)
  VALUES (v_quote_number, p_customer_id, v_actor, v_customer.assigned_tier, 'draft', 15,
    v_customer.default_commission_split)
  RETURNING id INTO v_quote_id;

  -- Create sections and items from template
  FOR v_section IN SELECT * FROM jsonb_array_elements(v_template.sections)
  LOOP
    INSERT INTO quote_sections (quote_id, section_name, sort_order, section_notes, section_header_notes)
    VALUES (v_quote_id, v_section->>'section_name', (v_section->>'sort_order')::integer,
      v_section->>'section_notes', v_section->>'section_header_notes')
    RETURNING id INTO v_section_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(v_section->'items')
    LOOP
      -- Get tier price for this product
      SELECT CASE v_customer.assigned_tier
        WHEN 1 THEN COALESCE(tier1_price, 0)
        WHEN 2 THEN COALESCE(tier2_price, tier1_price, 0)
        WHEN 3 THEN COALESCE(tier3_price, tier1_price, 0)
        ELSE COALESCE(tier1_price, 0)
      END INTO v_tier_price
      FROM products WHERE id = (v_item->>'product_id')::uuid;

      INSERT INTO quote_items (quote_id, section_id, product_id, sort_order, notes,
        price_per_unit, current_cost, suggested_rate, actual_rate, rate_unit, calc_mode)
      VALUES (v_quote_id, v_section_id, (v_item->>'product_id')::uuid,
        (v_item->>'sort_order')::integer, v_item->>'notes',
        v_tier_price,
        (SELECT current_cost FROM products WHERE id = (v_item->>'product_id')::uuid),
        v_item->>'suggested_rate', (v_item->>'actual_rate')::numeric,
        v_item->>'rate_unit', v_item->>'calc_mode');
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object('status', 'created', 'quote_id', v_quote_id, 'quote_number', v_quote_number);
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_quote_version(p_quote_id uuid, p_performed_by uuid, p_method text DEFAULT 'presented', p_idempotency_key text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_quote quotes%ROWTYPE;
  v_version_number integer;
  v_snapshot jsonb;
  v_version_id uuid;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM 1 FROM idempotency_keys WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN jsonb_build_object('status', 'duplicate', 'message', 'Already processed');
    END IF;
  END IF;

  -- Validate quote exists
  SELECT * INTO v_quote FROM quotes WHERE id = p_quote_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quote not found: %', p_quote_id;
  END IF;

  -- Get next version number
  SELECT COALESCE(MAX(version_number), 0) + 1 INTO v_version_number
  FROM quote_versions WHERE quote_id = p_quote_id;

  -- Build snapshot: full quote state with sections and items
  SELECT jsonb_build_object(
    'quote', jsonb_build_object(
      'quote_number', v_quote.quote_number,
      'customer_id', v_quote.customer_id,
      'tier', v_quote.tier,
      'status', v_quote.status,
      'total_price', v_quote.total_price,
      'total_cost', v_quote.total_cost,
      'total_profit', v_quote.total_profit,
      'total_margin_pct', v_quote.total_margin_pct,
      'valid_days', v_quote.valid_days,
      'expires_at', v_quote.expires_at,
      'header_notes', v_quote.header_notes,
      'footer_notes', v_quote.footer_notes,
      'is_planned', v_quote.is_planned,
      'commission_split', v_quote.commission_split
    ),
    'sections', (
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
          'section_name', qs.section_name,
          'sort_order', qs.sort_order,
          'section_notes', qs.section_notes,
          'section_header_notes', qs.section_header_notes,
          'needed_by_date', qs.needed_by_date,
          'items', (
            SELECT COALESCE(jsonb_agg(
              jsonb_build_object(
                'product_id', qi.product_id,
                'product_name', p.product_name,
                'sku', p.sku,
                'sort_order', qi.sort_order,
                'notes', qi.notes,
                'price_per_unit', qi.price_per_unit,
                'current_cost', qi.current_cost,
                'suggested_rate', qi.suggested_rate,
                'actual_rate', qi.actual_rate,
                'rate_unit', qi.rate_unit,
                'oz_per_acre', qi.oz_per_acre,
                'price_per_acre', qi.price_per_acre,
                'acres', qi.acres,
                'total_units_needed', qi.total_units_needed,
                'unit_size', qi.unit_size,
                'profit', qi.profit,
                'total_price', qi.total_price,
                'net_margin', qi.net_margin,
                'calc_mode', qi.calc_mode,
                'price_unit', qi.price_unit
              ) ORDER BY qi.sort_order
            ), '[]'::jsonb)
            FROM quote_items qi
            JOIN products p ON p.id = qi.product_id
            WHERE qi.section_id = qs.id
          )
        ) ORDER BY qs.sort_order
      ), '[]'::jsonb)
      FROM quote_sections qs
      WHERE qs.quote_id = p_quote_id
    )
  ) INTO v_snapshot;

  -- Insert version record
  INSERT INTO quote_versions (quote_id, version_number, sent_by, sent_at, sent_method, snapshot_data)
  VALUES (p_quote_id, v_version_number, v_actor, now(), p_method, v_snapshot)
  RETURNING id INTO v_version_id;

  -- Update quote status to sent
  UPDATE quotes SET status = 'sent', sent_at = now(), updated_at = now()
  WHERE id = p_quote_id;

  -- Save idempotency key
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'create_quote_version', to_jsonb(v_version_id))
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'status', 'created',
    'version_id', v_version_id,
    'version_number', v_version_number
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.rollover_quote_to_season(p_quote_id uuid, p_new_season integer, p_performed_by uuid, p_idempotency_key text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_old_quote quotes%ROWTYPE;
  v_new_quote_id uuid;
  v_new_quote_number text;
  v_section RECORD;
  v_new_section_id uuid;
  v_item RECORD;
  v_tier_price numeric;
  v_current_cost numeric;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key AND created_at > now() - interval '24 hours'
    ) THEN
      RETURN jsonb_build_object('status', 'duplicate', 'message', 'Already processed');
    END IF;
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'rollover_quote_to_season', to_jsonb(p_quote_id));
  END IF;

  SELECT * INTO v_old_quote FROM quotes WHERE id = p_quote_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found: %', p_quote_id; END IF;

  SELECT generate_quote_number() INTO v_new_quote_number;

  -- Create new quote (reset dates, status, season)
  INSERT INTO quotes (
    quote_number, customer_id, created_by, tier, status, is_planned,
    commission_split, valid_days, header_notes, footer_notes, season, salesman_id
  ) VALUES (
    v_new_quote_number, v_old_quote.customer_id, v_actor, v_old_quote.tier,
    'draft', v_old_quote.is_planned, v_old_quote.commission_split,
    v_old_quote.valid_days, v_old_quote.header_notes, v_old_quote.footer_notes,
    p_new_season, v_old_quote.salesman_id
  ) RETURNING id INTO v_new_quote_id;

  -- Copy sections (reset needed_by_date)
  FOR v_section IN
    SELECT * FROM quote_sections WHERE quote_id = p_quote_id ORDER BY sort_order
  LOOP
    INSERT INTO quote_sections (quote_id, section_name, sort_order, section_notes, section_header_notes)
    VALUES (v_new_quote_id, v_section.section_name, v_section.sort_order,
      v_section.section_notes, v_section.section_header_notes)
    RETURNING id INTO v_new_section_id;

    -- Copy items with UPDATED pricing from current product prices
    FOR v_item IN
      SELECT * FROM quote_items WHERE section_id = v_section.id ORDER BY sort_order
    LOOP
      -- Get current tier price
      SELECT CASE v_old_quote.tier
        WHEN 1 THEN COALESCE(p.tier1_price, 0)
        WHEN 2 THEN COALESCE(p.tier2_price, p.tier1_price, 0)
        WHEN 3 THEN COALESCE(p.tier3_price, p.tier1_price, 0)
        ELSE COALESCE(p.tier1_price, 0)
      END, p.current_cost
      INTO v_tier_price, v_current_cost
      FROM products p WHERE p.id = v_item.product_id;

      INSERT INTO quote_items (
        quote_id, section_id, product_id, sort_order, notes,
        price_per_unit, current_cost, suggested_rate, actual_rate, rate_unit,
        acres, calc_mode, price_unit
      ) VALUES (
        v_new_quote_id, v_new_section_id, v_item.product_id, v_item.sort_order,
        v_item.notes, v_tier_price, v_current_cost, v_item.suggested_rate,
        v_item.actual_rate, v_item.rate_unit, v_item.acres,
        v_item.calc_mode, v_item.price_unit
      );
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'status', 'created',
    'quote_id', v_new_quote_id,
    'quote_number', v_new_quote_number,
    'season', p_new_season
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.save_quote_template(p_quote_id uuid, p_template_name text, p_description text DEFAULT NULL, p_performed_by uuid DEFAULT NULL, p_idempotency_key text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_sections jsonb;
  v_template_id uuid;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key AND created_at > now() - interval '24 hours'
    ) THEN
      RETURN jsonb_build_object('status', 'duplicate', 'message', 'Already processed');
    END IF;
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'save_quote_template', to_jsonb(p_quote_id));
  END IF;

  -- Build sections snapshot (strips customer-specific data like prices)
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'section_name', qs.section_name,
      'sort_order', qs.sort_order,
      'section_notes', qs.section_notes,
      'section_header_notes', qs.section_header_notes,
      'items', (
        SELECT COALESCE(jsonb_agg(
          jsonb_build_object(
            'product_id', qi.product_id,
            'product_name', p.product_name,
            'sku', p.sku,
            'sort_order', qi.sort_order,
            'notes', qi.notes,
            'suggested_rate', qi.suggested_rate,
            'actual_rate', qi.actual_rate,
            'rate_unit', qi.rate_unit,
            'calc_mode', qi.calc_mode
          ) ORDER BY qi.sort_order
        ), '[]'::jsonb)
        FROM quote_items qi
        JOIN products p ON p.id = qi.product_id
        WHERE qi.section_id = qs.id
      )
    ) ORDER BY qs.sort_order
  ), '[]'::jsonb) INTO v_sections
  FROM quote_sections qs WHERE qs.quote_id = p_quote_id;

  INSERT INTO quote_templates (template_name, description, sections, created_by)
  VALUES (p_template_name, p_description, v_sections, v_actor)
  RETURNING id INTO v_template_id;

  RETURN jsonb_build_object('status', 'created', 'template_id', v_template_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_job_from_quote_section(p_quote_id uuid, p_section_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_existing jsonb; v_quote RECORD; v_section RECORD; v_item RECORD;
  v_job_id uuid; v_job_number text; v_job_date date; v_season integer;
  v_total_acres numeric := 0; v_total_cost_cents bigint := 0;
  v_total_price_cents bigint := 0; v_sort integer := 0;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  -- Idempotency
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing FROM idempotency_keys WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  -- Validate quote exists and is planned
  SELECT q.* INTO v_quote FROM quotes q WHERE q.id = p_quote_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found: %', p_quote_id; END IF;
  IF NOT v_quote.is_planned THEN RAISE EXCEPTION 'Quote must be marked as planned to schedule a job'; END IF;

  -- FIX: Validate quote is in a valid status (not cancelled/declined/expired)
  IF v_quote.status IN ('declined', 'expired', 'cancelled') THEN
    RAISE EXCEPTION 'Cannot schedule job from quote with status: %', v_quote.status;
  END IF;

  -- Validate section
  SELECT qs.* INTO v_section FROM quote_sections qs WHERE qs.id = p_section_id AND qs.quote_id = p_quote_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Section not found or does not belong to quote'; END IF;

  -- FIX: Guard against duplicate jobs for the same section
  IF EXISTS (SELECT 1 FROM jobs WHERE quote_section_id = p_section_id AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'A job already exists for this quote section. Delete or cancel the existing job first.';
  END IF;

  v_job_date := COALESCE(v_section.needed_by_date, CURRENT_DATE);
  v_season := CASE WHEN EXTRACT(MONTH FROM v_job_date) >= 10
    THEN EXTRACT(YEAR FROM v_job_date)::integer + 1 ELSE EXTRACT(YEAR FROM v_job_date)::integer END;
  v_job_number := next_job_number();

  INSERT INTO jobs (
    job_number, customer_id, status, job_date, notes, season, quote_id, quote_section_id,
    total_acres, total_cost_cents, total_price_cents, created_by
  ) VALUES (
    v_job_number, v_quote.customer_id, 'scheduled', v_job_date,
    COALESCE(v_section.section_name, 'Untitled') || COALESCE(': ' || v_section.section_header_notes, ''),
    v_season, p_quote_id, p_section_id, 0, 0, 0, v_actor
  ) RETURNING id INTO v_job_id;

  IF v_section.field_id IS NOT NULL THEN
    SELECT COALESCE(MAX(qi.acres), 0) INTO v_total_acres FROM quote_items qi WHERE qi.section_id = p_section_id;
    INSERT INTO job_fields (job_id, field_id, acres_to_treat, sort_order) VALUES (v_job_id, v_section.field_id, v_total_acres, 1);
  END IF;

  FOR v_item IN
    SELECT qi.product_id, qi.total_units_needed, qi.price_unit, qi.actual_rate, qi.rate_unit,
           qi.price_per_unit, qi.current_cost, qi.acres, qi.sort_order, p.unit_size
    FROM quote_items qi JOIN products p ON p.id = qi.product_id
    WHERE qi.section_id = p_section_id ORDER BY qi.sort_order
  LOOP
    v_sort := v_sort + 1;
    INSERT INTO job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit,
      cost_per_unit_cents, price_per_unit_cents, sort_order
    ) VALUES (v_job_id, v_item.product_id, COALESCE(v_item.total_units_needed, 0),
      COALESCE(v_item.price_unit, v_item.unit_size), v_item.actual_rate, v_item.rate_unit,
      ROUND(COALESCE(v_item.current_cost, 0) * 100)::bigint,
      ROUND(COALESCE(v_item.price_per_unit, 0) * 100)::bigint, v_sort);
    v_total_cost_cents := v_total_cost_cents + ROUND(COALESCE(v_item.current_cost, 0) * COALESCE(v_item.total_units_needed, 0) * 100)::bigint;
    v_total_price_cents := v_total_price_cents + ROUND(COALESCE(v_item.price_per_unit, 0) * COALESCE(v_item.total_units_needed, 0) * 100)::bigint;
  END LOOP;

  IF v_total_acres = 0 THEN
    SELECT COALESCE(MAX(qi.acres), 0) INTO v_total_acres FROM quote_items qi WHERE qi.section_id = p_section_id;
  END IF;
  UPDATE jobs SET total_acres = v_total_acres, total_cost_cents = v_total_cost_cents, total_price_cents = v_total_price_cents WHERE id = v_job_id;

  INSERT INTO activity_log (action, entity_type, entity_id, performed_by, details)
  VALUES ('job_created_from_quote', 'job', v_job_id, v_actor,
    jsonb_build_object('job_number', v_job_number, 'quote_id', p_quote_id, 'quote_number', v_quote.quote_number, 'section_name', v_section.section_name));

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'create_job_from_quote_section', jsonb_build_object('job_id', v_job_id));
  END IF;

  RETURN jsonb_build_object('job_id', v_job_id);
END;
$function$;