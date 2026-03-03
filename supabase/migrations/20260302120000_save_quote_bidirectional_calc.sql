-- Migration: Update save_quote() to support bidirectional calc_mode
-- When calc_mode = 'units_direct', server uses client-provided total_units_needed
-- instead of computing from rate × acres.
-- Also persists price_unit and calc_mode on quote_items.

DROP FUNCTION IF EXISTS save_quote(uuid, jsonb, jsonb, uuid, text);
DROP FUNCTION IF EXISTS save_quote(uuid, jsonb, jsonb, uuid);

CREATE OR REPLACE FUNCTION save_quote(
  p_quote_id uuid,
  p_quote_payload jsonb,
  p_sections jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_quote_id uuid;
  v_is_new boolean := (p_quote_id IS NULL);
  v_section jsonb;
  v_section_id uuid;
  v_item jsonb;
  v_tier integer;
  v_server_totals RECORD;
  v_current_status text;
  v_new_status text;
BEGIN
  -- Derive actor from JWT, reject spoofing
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by <> v_actor THEN
    RAISE EXCEPTION 'Actor mismatch';
  END IF;

  -- Verify caller is admin or sales_rep
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to save quotes';
  END IF;

  -- State machine validation
  v_new_status := COALESCE(p_quote_payload->>'status', 'draft');

  IF v_is_new THEN
    IF v_new_status != 'draft' THEN
      RAISE EXCEPTION 'New quotes must start with status draft, got: %', v_new_status;
    END IF;
  ELSE
    SELECT status INTO v_current_status
    FROM quotes WHERE id = p_quote_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Quote not found: %', p_quote_id;
    END IF;

    IF v_new_status IS DISTINCT FROM v_current_status THEN
      IF NOT (
        (v_current_status = 'draft'   AND v_new_status IN ('sent', 'revised', 'declined', 'expired'))
        OR (v_current_status = 'sent'    AND v_new_status IN ('revised', 'accepted', 'declined', 'expired'))
        OR (v_current_status = 'revised' AND v_new_status IN ('sent', 'accepted', 'declined', 'expired'))
        OR (v_current_status = 'expired' AND v_new_status = 'revised')
      ) THEN
        RAISE EXCEPTION 'Invalid quote status transition: % -> %', v_current_status, v_new_status;
      END IF;
    END IF;
  END IF;

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
      v_actor,
      v_tier,
      COALESCE(p_quote_payload->>'status', 'draft'),
      CASE WHEN p_quote_payload ? 'commission_split'
        THEN (p_quote_payload->'commission_split')
        ELSE NULL
      END,
      0, 0, 0, 0,
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

  -- Insert sections and items (now includes calc_mode and price_unit)
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
        total_units_needed, unit_size, profit, total_price, net_margin,
        calc_mode, price_unit
      )
      SELECT
        v_quote_id,
        v_section_id,
        (item->>'product_id')::uuid,
        COALESCE((item->>'sort_order')::integer, 0),
        NULLIF(item->>'notes', ''),
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
        COALESCE((item->>'net_margin')::numeric, 0),
        COALESCE(item->>'calc_mode', 'rate_acres'),
        item->>'price_unit'
      FROM jsonb_array_elements(v_section->'items') AS item
      WHERE (item->>'product_id') IS NOT NULL;
    END IF;
  END LOOP;

  -- Server-authoritative recalculation
  -- Now branches on calc_mode: units_direct uses client total_units_needed as-is
  WITH base AS (
    SELECT
      qi.id AS item_id,
      COALESCE(qi.calc_mode, 'rate_acres') AS calc_mode,
      COALESCE(qi.actual_rate, 0) AS ar,
      COALESCE(qi.acres, 0) AS ac,
      COALESCE(qi.total_units_needed, 0) AS client_units,
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
      calc_mode,
      ppu,
      cc,
      -- oz_per_acre: rate_acres computes from rate; units_direct back-calculates if acres > 0
      CASE
        WHEN calc_mode = 'units_direct' AND ac > 0 AND inv_oz > 0
          THEN ROUND((client_units * inv_oz) / ac, 2)
        WHEN calc_mode = 'units_direct'
          THEN 0::numeric
        ELSE ROUND(ar * rate_oz, 2)
      END AS oz_per_acre,
      -- total_units: units_direct trusts the client value
      CASE
        WHEN calc_mode = 'units_direct'
          THEN ROUND(client_units, 2)
        WHEN inv_oz > 0
          THEN ROUND((ac * ar * rate_oz) / inv_oz, 2)
        ELSE 0::numeric
      END AS total_units,
      -- price_per_acre
      CASE
        WHEN calc_mode = 'units_direct' AND ac > 0
          THEN ROUND(ppu * client_units / ac, 2)
        WHEN calc_mode = 'units_direct'
          THEN 0::numeric
        WHEN inv_oz > 0
          THEN ROUND(ppu * (ar * rate_oz / inv_oz), 2)
        ELSE 0::numeric
      END AS price_per_acre,
      -- total_price
      CASE
        WHEN calc_mode = 'units_direct'
          THEN ROUND(ppu * client_units, 2)
        ELSE ROUND(ppu * CASE WHEN inv_oz > 0
          THEN (ac * ar * rate_oz) / inv_oz
          ELSE 0 END, 2)
      END AS total_price,
      -- profit
      CASE
        WHEN calc_mode = 'units_direct'
          THEN ROUND((ppu - cc) * client_units, 2)
        ELSE ROUND((ppu - cc) * CASE WHEN inv_oz > 0
          THEN (ac * ar * rate_oz) / inv_oz
          ELSE 0 END, 2)
      END AS profit
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

  -- Recalculate quote-level totals
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

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id
  ) VALUES (
    CASE WHEN v_is_new THEN 'quote_created' ELSE 'quote_updated' END,
    CASE WHEN v_is_new
      THEN 'Quote ' || COALESCE(p_quote_payload->>'quote_number', '') || ' created'
      ELSE 'Quote ' || COALESCE(p_quote_payload->>'quote_number', '') || ' updated'
    END,
    v_actor, 'quote', v_quote_id
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

GRANT EXECUTE ON FUNCTION save_quote(uuid, jsonb, jsonb, uuid, text) TO authenticated;
