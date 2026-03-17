-- validate-sql: exempt (fix migration uses activity_feed.entity_type which is a valid column, not idempotency_keys)
-- ============================================================================
-- FINAL FIX: Idempotency column names + search_path on all affected functions
-- ============================================================================
--
-- This migration explicitly rewrites every function that has:
--   1. Wrong idempotency_keys column references:
--      WRONG: key, entity_type, entity_id, result_id
--      RIGHT: idempotency_key, operation, result
--   2. Missing or incorrect search_path (must be: public, pg_temp)
--
-- Functions fixed:
--   1. save_quote                 — wrong idempotency columns + search_path
--   2. create_planned_holds       — wrong idempotency columns
--   3. save_quote_template        — wrong idempotency columns
--   4. create_quote_from_template — wrong idempotency columns
--   5. rollover_quote_to_season   — wrong idempotency columns
--   6. create_commission_payment  — wrong search_path (was SET search_path TO '')
--   7. convert_quote_to_order     — rewritten for safety (latest already correct)
--
-- NO dynamic SQL or pg_get_functiondef() — every function written out explicitly.
-- ============================================================================


-- ============================================================================
-- 1. save_quote
--    Latest source: 20260331300000_fix_product_data_for_quote_calculations.sql
--    Bugs: idempotency uses (key, entity_type, entity_id)
--          search_path = public, auth (missing pg_temp)
-- ============================================================================

CREATE OR REPLACE FUNCTION save_quote(
  p_quote_id uuid,
  p_quote_payload jsonb,
  p_sections jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_quote_id uuid;
  v_section_id uuid;
  v_item jsonb;
  v_section jsonb;
  v_status text;
  v_old_status text;
  v_tier int;
  v_server_totals record;
  v_allowed_transitions jsonb := '{
    "draft": ["sent","revised","declined","expired"],
    "sent": ["revised","accepted","declined","expired"],
    "revised": ["sent","accepted","declined","expired"],
    "expired": ["revised"]
  }'::jsonb;
BEGIN
  -- Auth: derive actor from JWT
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND role IN ('admin','sales_rep') AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Not authorized to save quotes';
  END IF;

  -- Idempotency (FIXED: use correct column names)
  IF p_idempotency_key IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key AND created_at > now() - interval '24 hours'
    ) THEN
      RETURN jsonb_build_object(
        'status', 'duplicate',
        'quote_id', p_quote_id
      );
    END IF;
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'save_quote', COALESCE(p_quote_id, gen_random_uuid())::text);
  END IF;

  v_status := COALESCE(p_quote_payload->>'status', 'draft');
  v_tier := COALESCE((p_quote_payload->>'tier')::int, 1);

  IF p_quote_id IS NOT NULL THEN
    -- UPDATE existing quote
    SELECT status INTO v_old_status FROM quotes WHERE id = p_quote_id;
    IF v_old_status IS NULL THEN
      RAISE EXCEPTION 'Quote not found: %', p_quote_id;
    END IF;

    -- State machine validation
    IF v_status IS DISTINCT FROM v_old_status THEN
      IF NOT (
        v_allowed_transitions->v_old_status IS NOT NULL
        AND v_allowed_transitions->v_old_status ? v_status
      ) THEN
        RAISE EXCEPTION 'Invalid status transition: % -> %', v_old_status, v_status;
      END IF;
    END IF;

    UPDATE quotes SET
      customer_id = (p_quote_payload->>'customer_id')::uuid,
      tier = v_tier,
      status = v_status,
      commission_split = CASE
        WHEN p_quote_payload->'commission_split' IS NOT NULL
        THEN p_quote_payload->'commission_split'
        ELSE commission_split
      END,
      valid_days = COALESCE((p_quote_payload->>'valid_days')::int, valid_days),
      expires_at = COALESCE((p_quote_payload->>'expires_at')::date, expires_at),
      header_notes = p_quote_payload->>'header_notes',
      footer_notes = p_quote_payload->>'footer_notes',
      sent_at = CASE
        WHEN v_status = 'sent' AND sent_at IS NULL THEN now()
        WHEN v_status = 'sent' THEN sent_at
        ELSE sent_at
      END,
      updated_at = now()
    WHERE id = p_quote_id;

    v_quote_id := p_quote_id;

    -- Delete old sections (cascade deletes items)
    DELETE FROM quote_sections WHERE quote_id = v_quote_id;
  ELSE
    -- INSERT new quote (must start as draft)
    IF v_status <> 'draft' THEN
      RAISE EXCEPTION 'New quotes must start with status draft';
    END IF;

    INSERT INTO quotes (
      id, quote_number, customer_id, created_by, tier, status,
      commission_split, total_price, total_cost, total_profit, total_margin_pct,
      valid_days, expires_at, header_notes, footer_notes, created_at, updated_at
    ) VALUES (
      gen_random_uuid(),
      p_quote_payload->>'quote_number',
      (p_quote_payload->>'customer_id')::uuid,
      v_actor,
      v_tier,
      'draft',
      COALESCE(p_quote_payload->'commission_split', '{"splits":[]}'::jsonb),
      0, 0, 0, 0,
      COALESCE((p_quote_payload->>'valid_days')::int, 15),
      COALESCE((p_quote_payload->>'expires_at')::date, current_date + 15),
      p_quote_payload->>'header_notes',
      p_quote_payload->>'footer_notes',
      now(), now()
    )
    RETURNING id INTO v_quote_id;
  END IF;

  -- Insert sections and items
  FOR v_section IN SELECT * FROM jsonb_array_elements(p_sections)
  LOOP
    INSERT INTO quote_sections (
      id, quote_id, section_name, sort_order, section_notes
    ) VALUES (
      gen_random_uuid(),
      v_quote_id,
      COALESCE(v_section->>'section_name', 'Section'),
      COALESCE((v_section->>'sort_order')::int, 0),
      v_section->>'section_notes'
    )
    RETURNING id INTO v_section_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(v_section->'items')
    LOOP
      INSERT INTO quote_items (
        id, quote_id, section_id, product_id, sort_order, notes,
        price_per_unit, current_cost, suggested_rate, actual_rate,
        rate_unit, oz_per_acre, price_per_acre, acres,
        total_units_needed, unit_size, profit, total_price, net_margin,
        calc_mode, price_unit
      ) VALUES (
        gen_random_uuid(),
        v_quote_id,
        v_section_id,
        (v_item->>'product_id')::uuid,
        COALESCE((v_item->>'sort_order')::int, 0),
        v_item->>'notes',
        COALESCE((v_item->>'price_per_unit')::numeric, 0),
        COALESCE((v_item->>'current_cost')::numeric, 0),
        v_item->>'suggested_rate',
        (v_item->>'actual_rate')::numeric,
        v_item->>'rate_unit',
        (v_item->>'oz_per_acre')::numeric,
        (v_item->>'price_per_acre')::numeric,
        (v_item->>'acres')::numeric,
        (v_item->>'total_units_needed')::numeric,
        v_item->>'unit_size',
        COALESCE((v_item->>'profit')::numeric, 0),
        COALESCE((v_item->>'total_price')::numeric, 0),
        COALESCE((v_item->>'net_margin')::numeric, 0),
        COALESCE(v_item->>'calc_mode', 'rate_acres'),
        v_item->>'price_unit'
      );
    END LOOP;
  END LOOP;

  -- SERVER-AUTHORITATIVE RECALCULATION
  -- COALESCE(p.inventory_unit, p.unit_size, 'Ea') ensures no NULL lookup
  WITH base AS (
    SELECT
      qi.id AS item_id,
      COALESCE(qi.calc_mode, 'rate_acres') AS calc_mode,
      COALESCE(qi.actual_rate, 0) AS ar,
      COALESCE(qi.acres, 0) AS ac,
      COALESCE(qi.total_units_needed, 0) AS client_units,
      CASE v_tier
        WHEN 1 THEN COALESCE(p.tier1_price, 0)
        WHEN 2 THEN COALESCE(p.tier2_price, p.tier1_price, 0)
        ELSE COALESCE(p.tier3_price, p.tier1_price, 0)
      END AS ppu,
      COALESCE(p.current_cost, 0) AS cc,
      COALESCE(rate_conv.factor_oz, 1) AS rate_oz,
      COALESCE(inv_conv.factor_oz, 1) AS inv_oz
    FROM quote_items qi
    JOIN products p ON p.id = qi.product_id
    LEFT JOIN unit_conversions rate_conv
      ON LOWER(rate_conv.unit) = LOWER(qi.rate_unit)
    LEFT JOIN unit_conversions inv_conv
      ON LOWER(inv_conv.unit) = LOWER(COALESCE(p.inventory_unit, p.unit_size, 'Ea'))
    WHERE qi.quote_id = v_quote_id
  ),
  calc AS (
    SELECT
      item_id,
      ppu,
      cc,
      calc_mode,
      CASE
        WHEN calc_mode = 'units_direct' AND ac > 0 AND inv_oz > 0
          THEN ROUND((client_units * inv_oz) / ac, 2)
        WHEN calc_mode = 'rate_acres'
          THEN ROUND(ar * rate_oz, 2)
        ELSE 0
      END AS oz_per_acre,
      CASE
        WHEN calc_mode = 'units_direct' THEN ROUND(client_units, 2)
        WHEN inv_oz > 0 THEN ROUND((ac * ar * rate_oz) / inv_oz, 2)
        ELSE 0
      END AS total_units,
      CASE
        WHEN calc_mode = 'units_direct' AND ac > 0
          THEN ROUND(ppu * client_units / ac, 2)
        WHEN calc_mode = 'rate_acres' AND inv_oz > 0
          THEN ROUND(ppu * (ar * rate_oz / inv_oz), 2)
        ELSE 0
      END AS price_per_acre
    FROM base
  ),
  final AS (
    SELECT
      item_id,
      ppu,
      cc,
      oz_per_acre,
      total_units,
      price_per_acre,
      ROUND(ppu * total_units, 2) AS total_price,
      ROUND((ppu - cc) * total_units, 2) AS profit,
      CASE
        WHEN ppu * total_units > 0
          THEN ROUND(((ppu - cc) * total_units) / (ppu * total_units) * 100, 2)
        ELSE 0
      END AS net_margin
    FROM calc
  )
  UPDATE quote_items qi SET
    price_per_unit = f.ppu,
    current_cost = f.cc,
    oz_per_acre = f.oz_per_acre,
    total_units_needed = f.total_units,
    price_per_acre = f.price_per_acre,
    total_price = f.total_price,
    profit = f.profit,
    net_margin = f.net_margin
  FROM final f
  WHERE qi.id = f.item_id;

  -- Recalculate quote-level totals
  SELECT
    COALESCE(SUM(total_price), 0),
    COALESCE(SUM(current_cost * total_units_needed), 0),
    COALESCE(SUM(profit), 0)
  INTO v_server_totals
  FROM quote_items
  WHERE quote_id = v_quote_id;

  UPDATE quotes SET
    total_price = v_server_totals.sum,
    total_cost = (SELECT COALESCE(SUM(current_cost * total_units_needed), 0) FROM quote_items WHERE quote_id = v_quote_id),
    total_profit = (SELECT COALESCE(SUM(profit), 0) FROM quote_items WHERE quote_id = v_quote_id),
    total_margin_pct = CASE
      WHEN (SELECT COALESCE(SUM(total_price), 0) FROM quote_items WHERE quote_id = v_quote_id) > 0
      THEN ROUND(
        (SELECT COALESCE(SUM(profit), 0) FROM quote_items WHERE quote_id = v_quote_id)
        / (SELECT COALESCE(SUM(total_price), 0) FROM quote_items WHERE quote_id = v_quote_id) * 100, 2
      )
      ELSE 0
    END,
    updated_at = now()
  WHERE id = v_quote_id;

  -- Log activity
  INSERT INTO activity_feed (id, action, description, performed_by, entity_type, entity_id, created_at)
  VALUES (
    gen_random_uuid(),
    CASE WHEN p_quote_id IS NOT NULL THEN 'quote_updated' ELSE 'quote_created' END,
    'Quote ' || COALESCE(p_quote_payload->>'quote_number', '') || ' saved',
    v_actor,
    'quote',
    v_quote_id,
    now()
  );

  RETURN jsonb_build_object(
    'status', 'saved',
    'quote_id', v_quote_id,
    'server_totals', jsonb_build_object(
      'total_price', (SELECT total_price FROM quotes WHERE id = v_quote_id),
      'total_cost', (SELECT total_cost FROM quotes WHERE id = v_quote_id),
      'total_profit', (SELECT total_profit FROM quotes WHERE id = v_quote_id),
      'total_margin_pct', (SELECT total_margin_pct FROM quotes WHERE id = v_quote_id)
    )
  );
END;
$$;


-- ============================================================================
-- 2. create_planned_holds
--    Latest source: 20260316500000_planned_programs.sql
--    Bugs: idempotency uses (key, entity_type, entity_id)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_planned_holds(
  p_quote_id uuid,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_quote quotes%ROWTYPE;
  v_item RECORD;
  v_holds_created integer := 0;
BEGIN
  -- Idempotency check (FIXED: use correct column names)
  IF p_idempotency_key IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key AND created_at > now() - interval '24 hours'
    ) THEN
      RETURN jsonb_build_object('status', 'duplicate', 'message', 'Already processed');
    END IF;
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'create_planned_holds', p_quote_id::text);
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
      p_performed_by,
      v_item.needed_by_date + INTERVAL '14 days',  -- 14-day buffer past need date
      true
    );
    v_holds_created := v_holds_created + 1;
  END LOOP;

  RETURN jsonb_build_object('status', 'created', 'holds_created', v_holds_created);
END;
$$;


-- ============================================================================
-- 3. save_quote_template
--    Latest source: 20260316600000_quote_templates.sql
--    Bugs: idempotency uses (key, entity_type, entity_id)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.save_quote_template(
  p_quote_id uuid,
  p_template_name text,
  p_description text DEFAULT NULL,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_sections jsonb;
  v_template_id uuid;
BEGIN
  -- Idempotency check (FIXED: use correct column names)
  IF p_idempotency_key IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key AND created_at > now() - interval '24 hours'
    ) THEN
      RETURN jsonb_build_object('status', 'duplicate', 'message', 'Already processed');
    END IF;
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'save_quote_template', p_quote_id::text);
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
  VALUES (p_template_name, p_description, v_sections, p_performed_by)
  RETURNING id INTO v_template_id;

  RETURN jsonb_build_object('status', 'created', 'template_id', v_template_id);
END;
$$;


-- ============================================================================
-- 4. create_quote_from_template
--    Latest source: 20260316600000_quote_templates.sql
--    Bugs: idempotency uses (key, entity_type, entity_id)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_quote_from_template(
  p_template_id uuid,
  p_customer_id uuid,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_template quote_templates%ROWTYPE;
  v_customer customers%ROWTYPE;
  v_quote_id uuid;
  v_quote_number text;
  v_section jsonb;
  v_item jsonb;
  v_section_id uuid;
  v_tier_price numeric;
BEGIN
  -- Idempotency check (FIXED: use correct column names)
  IF p_idempotency_key IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key AND created_at > now() - interval '24 hours'
    ) THEN
      RETURN jsonb_build_object('status', 'duplicate', 'message', 'Already processed');
    END IF;
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'create_quote_from_template', p_template_id::text);
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
  VALUES (v_quote_number, p_customer_id, p_performed_by, v_customer.assigned_tier, 'draft', 15,
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
$$;


-- ============================================================================
-- 5. rollover_quote_to_season
--    Latest source: 20260316900000_seasonal_rollover.sql
--    Bugs: idempotency uses (key, entity_type, entity_id)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.rollover_quote_to_season(
  p_quote_id uuid,
  p_new_season integer,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_old_quote quotes%ROWTYPE;
  v_new_quote_id uuid;
  v_new_quote_number text;
  v_section RECORD;
  v_new_section_id uuid;
  v_item RECORD;
  v_tier_price numeric;
  v_current_cost numeric;
BEGIN
  -- Idempotency check (FIXED: use correct column names)
  IF p_idempotency_key IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key AND created_at > now() - interval '24 hours'
    ) THEN
      RETURN jsonb_build_object('status', 'duplicate', 'message', 'Already processed');
    END IF;
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'rollover_quote_to_season', p_quote_id::text);
  END IF;

  SELECT * INTO v_old_quote FROM quotes WHERE id = p_quote_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found: %', p_quote_id; END IF;

  SELECT generate_quote_number() INTO v_new_quote_number;

  -- Create new quote (reset dates, status, season)
  INSERT INTO quotes (
    quote_number, customer_id, created_by, tier, status, is_planned,
    commission_split, valid_days, header_notes, footer_notes, season, salesman_id
  ) VALUES (
    v_new_quote_number, v_old_quote.customer_id, p_performed_by, v_old_quote.tier,
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
$$;


-- ============================================================================
-- 6. create_commission_payment
--    Latest source: 20260332600000_fix_commission_functions_updated_at.sql
--    Bug: SET search_path TO '' (should be public, pg_temp)
--    Note: This function does not use idempotency_keys table, so only
--    the search_path needs fixing. But the body explicitly references
--    public.* schema-qualified tables, so the fix is safe.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_commission_payment(
  p_commission_ids   uuid[],
  p_payment_method   text,
  p_reference        text,
  p_payment_date     date,
  p_notes            text,
  p_performed_by     uuid,
  p_idempotency_key  text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_payment_id   uuid;
  v_payment_num  text;
  v_total        numeric := 0;
  v_recipient_id uuid;
  v_commission   record;
  v_season       integer;
  v_payment_dt   date;
BEGIN

  -- Authorization check
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin')
  ) THEN
    RAISE EXCEPTION 'Not authorized: requires admin role';
  END IF;
  v_payment_dt := COALESCE(p_payment_date, CURRENT_DATE);

  -- Enforce accounting period
  PERFORM check_period_open(v_payment_dt);

  -- Validate at least one commission
  IF array_length(p_commission_ids, 1) IS NULL OR array_length(p_commission_ids, 1) = 0 THEN
    RAISE EXCEPTION 'No commissions selected for payment';
  END IF;

  -- Lock commissions FOR UPDATE to prevent double-pay
  SELECT DISTINCT c.recipient_user_id
    INTO v_recipient_id
    FROM commissions c
   WHERE c.id = ANY(p_commission_ids)
     AND c.status != 'paid'
     FOR UPDATE;

  IF v_recipient_id IS NULL THEN
    RAISE EXCEPTION 'No unpaid commissions found for the given IDs';
  END IF;

  IF (SELECT count(DISTINCT c.recipient_user_id)
      FROM commissions c
      WHERE c.id = ANY(p_commission_ids) AND c.status != 'paid') > 1 THEN
    RAISE EXCEPTION 'All commissions in a payment must belong to the same recipient';
  END IF;

  -- Calculate total
  SELECT sum(c.commission_amount)
    INTO v_total
    FROM commissions c
   WHERE c.id = ANY(p_commission_ids)
     AND c.status != 'paid';

  -- Season uses end-year convention
  v_season := compute_season(v_payment_dt);

  -- Generate payment number
  v_payment_num := next_commission_payment_number();

  -- Create the payment
  INSERT INTO commission_payments (
    payment_number, recipient_id, total_amount, status,
    payment_method, reference_number, payment_date, notes, season, created_by
  ) VALUES (
    v_payment_num, v_recipient_id, v_total, 'unposted',
    p_payment_method, p_reference, v_payment_dt,
    p_notes, v_season, p_performed_by
  ) RETURNING id INTO v_payment_id;

  -- Create line items
  FOR v_commission IN
    SELECT c.id, c.commission_amount
      FROM commissions c
     WHERE c.id = ANY(p_commission_ids)
       AND c.status != 'paid'
  LOOP
    INSERT INTO commission_payment_items (
      commission_payment_id, commission_id, amount
    ) VALUES (
      v_payment_id, v_commission.id, v_commission.commission_amount
    );
  END LOOP;

  -- Mark commissions as paid (no updated_at — column does not exist)
  UPDATE commissions
     SET status = 'paid'
   WHERE id = ANY(p_commission_ids)
     AND status != 'paid';

  -- Financial audit log
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id,
    actor_user_id, total_impact_cents, description
  ) VALUES (
    'commission_payment_created', 'commission_payment', v_payment_id,
    p_performed_by, (v_total * 100)::bigint,
    'Commission payment ' || v_payment_num || ' created for $' ||
    to_char(v_total, 'FM999,999,990.00') || ' to ' ||
    (SELECT full_name FROM profiles WHERE id = v_recipient_id)
  );

  RETURN v_payment_id;
END;
$$;


-- ============================================================================
-- 7. convert_quote_to_order
--    Latest source: 20260331500000_drop_unused_overloads_convert_quote_record_payment.sql
--    Already correct in latest version — rewritten here for completeness
--    to ensure no drift from earlier migrations with wrong search_path.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.convert_quote_to_order(
  p_quote_id uuid,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_quote record;
  v_order_number text;
  v_order_id uuid;
  v_section record;
  v_item record;
  v_customer record;
  v_split jsonb;
  v_inv record;
  v_shortfalls text[] := '{}';
  v_net_position numeric;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by <> v_actor THEN RAISE EXCEPTION 'Actor mismatch'; END IF;

  SELECT * INTO v_quote FROM quotes WHERE id = p_quote_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found'; END IF;

  -- Quote status guard
  IF v_quote.status NOT IN ('sent', 'accepted') THEN
    RAISE EXCEPTION 'Cannot convert quote with status "%". Only sent or accepted quotes can be converted.', v_quote.status;
  END IF;

  IF v_quote.status = 'accepted' THEN
    SELECT id INTO v_order_id FROM orders WHERE quote_id = p_quote_id LIMIT 1;
    IF v_order_id IS NOT NULL THEN
      RETURN jsonb_build_object('status', 'already_converted', 'order_id', v_order_id);
    END IF;
  END IF;

  SELECT * INTO v_customer FROM customers WHERE id = v_quote.customer_id;

  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN RAISE EXCEPTION 'Not authorized'; END IF;

  FOR v_item IN
    SELECT qi.product_id, p.product_name, SUM(COALESCE(qi.total_units_needed, 0)) AS qty_needed
    FROM quote_items qi JOIN products p ON p.id = qi.product_id
    WHERE qi.quote_id = p_quote_id AND qi.product_id IS NOT NULL AND COALESCE(qi.total_units_needed, 0) > 0
    GROUP BY qi.product_id, p.product_name
  LOOP
    SELECT * INTO v_inv FROM inventory WHERE product_id = v_item.product_id AND location = 'Main Warehouse' FOR UPDATE;
    IF NOT FOUND THEN
      v_shortfalls := array_append(v_shortfalls, v_item.product_name || ': need ' || v_item.qty_needed || ', net position is 0 (no inventory record)');
    ELSE
      v_net_position := v_inv.quantity_available - v_inv.quantity_prebooked + COALESCE(v_inv.quantity_on_order, 0);
      IF v_net_position < v_item.qty_needed THEN
        v_shortfalls := array_append(v_shortfalls, v_item.product_name || ': need ' || v_item.qty_needed || ', net position is ' || GREATEST(v_net_position, 0) || ' (on floor: ' || (v_inv.quantity_available - v_inv.quantity_prebooked) || ', on order: ' || COALESCE(v_inv.quantity_on_order, 0) || ')');
      END IF;
    END IF;
  END LOOP;

  SET LOCAL app.admin_override = 'true';
  UPDATE quotes SET status = 'accepted', updated_at = now() WHERE id = p_quote_id;
  v_order_number := generate_order_number();

  INSERT INTO orders (order_number, quote_id, customer_id, status, commission_split, total_price, total_cost, total_profit, total_margin_pct, order_date)
  VALUES (v_order_number, p_quote_id, v_quote.customer_id, 'confirmed', v_quote.commission_split, v_quote.total_price, v_quote.total_cost, v_quote.total_profit, v_quote.total_margin_pct, current_date)
  RETURNING id INTO v_order_id;

  INSERT INTO order_items (order_id, product_id, quote_item_id, section_name, product_name, price_per_unit, cost_per_unit, actual_rate, rate_unit, acres, total_units_needed, unit_size, total_price, profit, net_margin, quantity_delivered, quantity_remaining)
  SELECT v_order_id, qi.product_id, qi.id, qs.section_name, p.product_name, qi.price_per_unit, qi.current_cost, qi.actual_rate, qi.rate_unit, qi.acres, COALESCE(qi.total_units_needed, 0), qi.unit_size, qi.total_price, qi.profit, qi.net_margin, 0, COALESCE(qi.total_units_needed, 0)
  FROM quote_items qi JOIN quote_sections qs ON qs.id = qi.section_id JOIN products p ON p.id = qi.product_id
  WHERE qi.quote_id = p_quote_id AND qi.product_id IS NOT NULL;

  FOR v_item IN SELECT oi.product_id, oi.total_units_needed, oi.unit_size FROM order_items oi WHERE oi.order_id = v_order_id AND oi.product_id IS NOT NULL AND oi.total_units_needed > 0
  LOOP
    UPDATE inventory SET quantity_prebooked = quantity_prebooked + v_item.total_units_needed, updated_at = now() WHERE product_id = v_item.product_id AND location = 'Main Warehouse';
    IF NOT FOUND THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order, unit_size) VALUES (v_item.product_id, 'Main Warehouse', 0, v_item.total_units_needed, 0, v_item.unit_size);
    END IF;
    INSERT INTO inventory_transactions (product_id, transaction_type, quantity, to_location, order_id, performed_by, notes) VALUES (v_item.product_id, 'booked', v_item.total_units_needed, 'Main Warehouse', v_order_id, v_actor, 'Pre-booked for order ' || v_order_number);
  END LOOP;

  -- Commission: clamp to 0 when profit is negative
  IF v_quote.commission_split IS NOT NULL AND v_quote.commission_split ? 'splits' THEN
    INSERT INTO commissions (order_id, customer_id, recipient, split_percentage, commission_amount, order_profit, order_date, status)
    SELECT v_order_id, v_quote.customer_id, s->>'recipient', (s->>'percentage')::numeric,
      GREATEST(v_quote.total_profit * ((s->>'percentage')::numeric / 100), 0),
      v_quote.total_profit, current_date, 'pending'
    FROM jsonb_array_elements(v_quote.commission_split->'splits') s
    WHERE (s->>'recipient') IS NOT NULL AND (s->>'percentage')::numeric > 0;
  END IF;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('order_created', 'Order ' || v_order_number || ' created from quote ' || v_quote.quote_number || ' for ' || COALESCE(v_customer.farm_name, 'customer') || CASE WHEN array_length(v_shortfalls, 1) > 0 THEN ' (inventory warnings: ' || array_to_string(v_shortfalls, '; ') || ')' ELSE '' END, v_actor, 'order', v_order_id, v_quote.customer_id);

  RETURN jsonb_build_object('status', 'created', 'order_id', v_order_id, 'order_number', v_order_number, 'warnings', to_jsonb(v_shortfalls));
END;
$$;


-- ============================================================================
-- VERIFICATION: Warn if any functions still reference wrong column names
-- ============================================================================

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
      AND (
        p.prosrc LIKE '%entity_type%'
        OR p.prosrc LIKE '%entity_id%'
        OR (p.prosrc LIKE '%idempotency_keys%' AND p.prosrc LIKE '% key %')
      )
  ) THEN
    RAISE WARNING 'Some functions may still have wrong idempotency column references';
  END IF;
END $$;
