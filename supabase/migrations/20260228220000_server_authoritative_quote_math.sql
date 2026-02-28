-- Migration: Server-authoritative quote math
-- Sprint 1b: Move financial calculations to SQL using NUMERIC precision
--
-- After save_quote() inserts items with client values, a server-side
-- recalculation pass joins products + unit_conversions to recompute
-- all financial fields. This ensures:
-- 1. Price lookup uses current product data (not stale client cache)
-- 2. All math uses NUMERIC precision (no IEEE 754 float errors)
-- 3. The database is the single source of truth for financial values

CREATE OR REPLACE FUNCTION save_quote(
  p_quote_id uuid,
  p_quote_payload jsonb,
  p_sections jsonb,
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_quote_id uuid;
  v_is_new boolean := (p_quote_id IS NULL);
  v_section jsonb;
  v_section_id uuid;
  v_item jsonb;
  v_tier integer;
  v_server_totals RECORD;
BEGIN
  -- Verify caller is admin or sales_rep
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = p_performed_by AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to save quotes';
  END IF;

  -- Extract tier for pricing lookup
  v_tier := COALESCE((p_quote_payload->>'tier')::integer, 1);

  IF v_is_new THEN
    INSERT INTO quotes (
      quote_number, customer_id, created_by, tier, status,
      commission_split, total_price, total_cost, total_profit,
      total_margin_pct, valid_days, expires_at,
      header_notes, footer_notes, sent_at
    ) VALUES (
      p_quote_payload->>'quote_number',
      (p_quote_payload->>'customer_id')::uuid,
      p_performed_by,
      v_tier,
      COALESCE(p_quote_payload->>'status', 'draft'),
      CASE WHEN p_quote_payload ? 'commission_split'
        THEN (p_quote_payload->'commission_split')
        ELSE NULL
      END,
      0, 0, 0, 0, -- totals will be recalculated below
      COALESCE((p_quote_payload->>'valid_days')::integer, 30),
      (p_quote_payload->>'expires_at')::timestamptz,
      NULLIF(p_quote_payload->>'header_notes', ''),
      NULLIF(p_quote_payload->>'footer_notes', ''),
      CASE WHEN p_quote_payload->>'sent_at' IS NOT NULL
        THEN (p_quote_payload->>'sent_at')::timestamptz
        ELSE NULL
      END
    ) RETURNING id INTO v_quote_id;
  ELSE
    v_quote_id := p_quote_id;

    UPDATE quotes SET
      customer_id = COALESCE((p_quote_payload->>'customer_id')::uuid, customer_id),
      tier = v_tier,
      status = COALESCE(p_quote_payload->>'status', status),
      commission_split = CASE WHEN p_quote_payload ? 'commission_split'
        THEN (p_quote_payload->'commission_split')
        ELSE commission_split
      END,
      -- totals will be recalculated below; set to 0 as placeholder
      valid_days = COALESCE((p_quote_payload->>'valid_days')::integer, valid_days),
      expires_at = COALESCE((p_quote_payload->>'expires_at')::timestamptz, expires_at),
      header_notes = CASE WHEN p_quote_payload ? 'header_notes'
        THEN NULLIF(p_quote_payload->>'header_notes', '')
        ELSE header_notes
      END,
      footer_notes = CASE WHEN p_quote_payload ? 'footer_notes'
        THEN NULLIF(p_quote_payload->>'footer_notes', '')
        ELSE footer_notes
      END,
      sent_at = CASE WHEN p_quote_payload->>'sent_at' IS NOT NULL
        THEN (p_quote_payload->>'sent_at')::timestamptz
        ELSE sent_at
      END,
      updated_at = now()
    WHERE id = v_quote_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Quote not found: %', v_quote_id;
    END IF;

    DELETE FROM quote_sections WHERE quote_id = v_quote_id;
  END IF;

  -- ================================================================
  -- Insert sections and items (using client values as initial data)
  -- ================================================================
  FOR v_section IN SELECT * FROM jsonb_array_elements(p_sections) LOOP
    INSERT INTO quote_sections (
      quote_id, section_name, sort_order, section_notes
    ) VALUES (
      v_quote_id,
      COALESCE(v_section->>'section_name', ''),
      COALESCE((v_section->>'sort_order')::integer, 0),
      NULLIF(v_section->>'section_notes', '')
    ) RETURNING id INTO v_section_id;

    IF v_section ? 'items' AND jsonb_array_length(v_section->'items') > 0 THEN
      INSERT INTO quote_items (
        quote_id, section_id, product_id, sort_order, notes,
        price_per_unit, current_cost, suggested_rate, actual_rate,
        rate_unit, oz_per_acre, price_per_acre, acres,
        total_units_needed, unit_size, profit, total_price, net_margin
      )
      SELECT
        v_quote_id,
        v_section_id,
        (item->>'product_id')::uuid,
        COALESCE((item->>'sort_order')::integer, 0),
        NULLIF(item->>'notes', ''),
        -- Financial fields inserted as client values; overwritten below
        COALESCE((item->>'price_per_unit')::numeric, 0),
        COALESCE((item->>'current_cost')::numeric, 0),
        item->>'suggested_rate',
        (item->>'actual_rate')::numeric,
        item->>'rate_unit',
        (item->>'oz_per_acre')::numeric,
        (item->>'price_per_acre')::numeric,
        (item->>'acres')::numeric,
        (item->>'total_units_needed')::numeric,
        item->>'unit_size',
        COALESCE((item->>'profit')::numeric, 0),
        COALESCE((item->>'total_price')::numeric, 0),
        COALESCE((item->>'net_margin')::numeric, 0)
      FROM jsonb_array_elements(v_section->'items') AS item
      WHERE (item->>'product_id') IS NOT NULL;
    END IF;
  END LOOP;

  -- ================================================================
  -- SERVER-AUTHORITATIVE RECALCULATION
  -- Recompute all item financials from products + unit_conversions
  -- using NUMERIC precision. This overwrites client-calculated values.
  -- ================================================================
  WITH base AS (
    SELECT
      qi.id AS item_id,
      COALESCE(qi.actual_rate, 0) AS ar,
      COALESCE(qi.acres, 0) AS ac,
      CASE v_tier
        WHEN 1 THEN COALESCE(p.tier1_price, 0)
        WHEN 2 THEN COALESCE(p.tier2_price, 0)
        ELSE COALESCE(p.tier3_price, 0)
      END AS ppu,
      COALESCE(p.current_cost, 0) AS cc,
      COALESCE(rate_conv.factor_oz, 1) AS rate_oz,
      COALESCE(inv_conv.factor_oz, 1) AS inv_oz
    FROM quote_items qi
    JOIN products p ON p.id = qi.product_id
    LEFT JOIN unit_conversions rate_conv
      ON LOWER(rate_conv.unit) = LOWER(qi.rate_unit)
    LEFT JOIN unit_conversions inv_conv
      ON LOWER(inv_conv.unit) = LOWER(p.inventory_unit)
    WHERE qi.quote_id = v_quote_id
  ),
  calc AS (
    SELECT
      item_id,
      ppu,
      cc,
      ROUND(ar * rate_oz, 2) AS oz_per_acre,
      CASE WHEN inv_oz > 0
        THEN ROUND((ac * ar * rate_oz) / inv_oz, 2)
        ELSE 0::numeric
      END AS total_units,
      CASE WHEN inv_oz > 0
        THEN ROUND(ppu * (ar * rate_oz / inv_oz), 2)
        ELSE 0::numeric
      END AS price_per_acre,
      ROUND(ppu * CASE WHEN inv_oz > 0
        THEN (ac * ar * rate_oz) / inv_oz
        ELSE 0 END, 2) AS total_price,
      ROUND((ppu - cc) * CASE WHEN inv_oz > 0
        THEN (ac * ar * rate_oz) / inv_oz
        ELSE 0 END, 2) AS profit
    FROM base
  )
  UPDATE quote_items qi SET
    price_per_unit = calc.ppu,
    current_cost = calc.cc,
    oz_per_acre = calc.oz_per_acre,
    total_units_needed = calc.total_units,
    price_per_acre = calc.price_per_acre,
    total_price = calc.total_price,
    profit = calc.profit,
    net_margin = CASE WHEN calc.total_price > 0
      THEN ROUND(calc.profit / calc.total_price * 100, 2)
      ELSE 0::numeric
    END
  FROM calc
  WHERE qi.id = calc.item_id;

  -- ================================================================
  -- Recalculate quote-level totals from server-calculated items
  -- ================================================================
  SELECT
    COALESCE(ROUND(SUM(total_price), 2), 0) AS tp,
    COALESCE(ROUND(SUM(current_cost * total_units_needed), 2), 0) AS tc,
    COALESCE(ROUND(SUM(profit), 2), 0) AS tprof
  INTO v_server_totals
  FROM quote_items
  WHERE quote_id = v_quote_id;

  UPDATE quotes SET
    total_price = v_server_totals.tp,
    total_cost = v_server_totals.tc,
    total_profit = v_server_totals.tprof,
    total_margin_pct = CASE WHEN v_server_totals.tp > 0
      THEN ROUND(v_server_totals.tprof / v_server_totals.tp * 100, 2)
      ELSE 0
    END,
    updated_at = now()
  WHERE id = v_quote_id;

  -- Log activity
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id
  ) VALUES (
    CASE WHEN v_is_new THEN 'quote_created' ELSE 'quote_updated' END,
    CASE WHEN v_is_new
      THEN 'Quote ' || COALESCE(p_quote_payload->>'quote_number', '') || ' created'
      ELSE 'Quote ' || COALESCE(p_quote_payload->>'quote_number', '') || ' updated'
    END,
    p_performed_by, 'quote', v_quote_id
  );

  RETURN jsonb_build_object(
    'status', 'saved',
    'quote_id', v_quote_id,
    'server_totals', jsonb_build_object(
      'total_price', v_server_totals.tp,
      'total_cost', v_server_totals.tc,
      'total_profit', v_server_totals.tprof,
      'total_margin_pct', CASE WHEN v_server_totals.tp > 0
        THEN ROUND(v_server_totals.tprof / v_server_totals.tp * 100, 2)
        ELSE 0
      END
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION save_quote(uuid, jsonb, jsonb, uuid) TO authenticated;
