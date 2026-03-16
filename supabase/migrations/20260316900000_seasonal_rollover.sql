-- Sprint 11: Seasonal Program Rollover
-- Duplicates a quote into a new season with updated pricing from current products

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
  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM idempotency_keys
      WHERE key = p_idempotency_key AND created_at > now() - interval '24 hours'
    ) THEN
      RETURN jsonb_build_object('status', 'duplicate', 'message', 'Already processed');
    END IF;
    INSERT INTO idempotency_keys (key, entity_type, entity_id)
    VALUES (p_idempotency_key, 'rollover_quote', p_quote_id);
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

GRANT EXECUTE ON FUNCTION rollover_quote_to_season(uuid, integer, uuid, text) TO authenticated;
