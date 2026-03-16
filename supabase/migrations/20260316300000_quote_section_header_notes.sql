-- Sprint 4: Add section_header_notes column to quote_sections
-- Displays above items table, below section name
-- Existing section_notes stays as-is (displays below items table in PDF)

ALTER TABLE quote_sections ADD COLUMN IF NOT EXISTS section_header_notes text;

-- Update save_quote RPC to include section_header_notes in section insert
-- Faithful copy of latest save_quote from 20260331300000 with section_header_notes added
-- Verified: only one overload exists (uuid, jsonb, jsonb, uuid, text)

CREATE OR REPLACE FUNCTION save_quote(
  p_quote_id uuid,
  p_quote_payload jsonb,
  p_sections jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
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

  -- Idempotency
  IF p_idempotency_key IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM idempotency_keys
      WHERE key = p_idempotency_key AND created_at > now() - interval '24 hours'
    ) THEN
      RETURN jsonb_build_object(
        'status', 'duplicate',
        'quote_id', p_quote_id
      );
    END IF;
    INSERT INTO idempotency_keys (key, entity_type, entity_id)
    VALUES (p_idempotency_key, 'quote', COALESCE(p_quote_id, gen_random_uuid()));
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
      id, quote_id, section_name, sort_order, section_notes, section_header_notes
    ) VALUES (
      gen_random_uuid(),
      v_quote_id,
      COALESCE(v_section->>'section_name', 'Section'),
      COALESCE((v_section->>'sort_order')::int, 0),
      v_section->>'section_notes',
      v_section->>'section_header_notes'
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

-- Also update create_quote_version snapshot to include section_header_notes
CREATE OR REPLACE FUNCTION public.create_quote_version(
  p_quote_id uuid,
  p_performed_by uuid,
  p_method text DEFAULT 'presented',
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_quote quotes%ROWTYPE;
  v_version_number integer;
  v_snapshot jsonb;
  v_version_id uuid;
BEGIN
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
  VALUES (p_quote_id, v_version_number, p_performed_by, now(), p_method, v_snapshot)
  RETURNING id INTO v_version_id;

  -- Update quote status to sent
  UPDATE quotes SET status = 'sent', sent_at = now(), updated_at = now()
  WHERE id = p_quote_id;

  -- Save idempotency key
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'create_quote_version', v_version_id::text)
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'status', 'created',
    'version_id', v_version_id,
    'version_number', v_version_number
  );
END;
$$;

-- Also update restore_quote_version to include section_header_notes
CREATE OR REPLACE FUNCTION public.restore_quote_version(
  p_quote_id uuid,
  p_version_id uuid,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_snapshot jsonb;
  v_section jsonb;
  v_item jsonb;
  v_section_id uuid;
  v_version_number integer;
BEGIN
  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM 1 FROM idempotency_keys WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN jsonb_build_object('status', 'duplicate', 'message', 'Already processed');
    END IF;
  END IF;

  -- Get snapshot data
  SELECT snapshot_data, version_number INTO v_snapshot, v_version_number
  FROM quote_versions
  WHERE id = p_version_id AND quote_id = p_quote_id;

  IF v_snapshot IS NULL THEN
    RAISE EXCEPTION 'Version not found: %', p_version_id;
  END IF;

  -- Delete existing sections (cascades to items via ON DELETE CASCADE)
  DELETE FROM quote_sections WHERE quote_id = p_quote_id;

  -- Restore quote-level fields
  UPDATE quotes SET
    header_notes = v_snapshot->'quote'->>'header_notes',
    footer_notes = v_snapshot->'quote'->>'footer_notes',
    total_price = (v_snapshot->'quote'->>'total_price')::numeric,
    total_cost = (v_snapshot->'quote'->>'total_cost')::numeric,
    total_profit = (v_snapshot->'quote'->>'total_profit')::numeric,
    total_margin_pct = (v_snapshot->'quote'->>'total_margin_pct')::numeric,
    status = 'revised',
    updated_at = now()
  WHERE id = p_quote_id;

  -- Restore sections and items from snapshot
  FOR v_section IN SELECT * FROM jsonb_array_elements(v_snapshot->'sections')
  LOOP
    INSERT INTO quote_sections (quote_id, section_name, sort_order, section_notes, section_header_notes)
    VALUES (
      p_quote_id,
      v_section->>'section_name',
      (v_section->>'sort_order')::integer,
      v_section->>'section_notes',
      v_section->>'section_header_notes'
    )
    RETURNING id INTO v_section_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(v_section->'items')
    LOOP
      INSERT INTO quote_items (
        quote_id, section_id, product_id, sort_order, notes,
        price_per_unit, current_cost, suggested_rate, actual_rate, rate_unit,
        oz_per_acre, price_per_acre, acres, total_units_needed, unit_size,
        profit, total_price, net_margin, calc_mode, price_unit
      )
      VALUES (
        p_quote_id, v_section_id,
        (v_item->>'product_id')::uuid,
        (v_item->>'sort_order')::integer,
        v_item->>'notes',
        (v_item->>'price_per_unit')::numeric,
        (v_item->>'current_cost')::numeric,
        v_item->>'suggested_rate',
        (v_item->>'actual_rate')::numeric,
        v_item->>'rate_unit',
        (v_item->>'oz_per_acre')::numeric,
        (v_item->>'price_per_acre')::numeric,
        (v_item->>'acres')::numeric,
        (v_item->>'total_units_needed')::numeric,
        v_item->>'unit_size',
        (v_item->>'profit')::numeric,
        (v_item->>'total_price')::numeric,
        (v_item->>'net_margin')::numeric,
        v_item->>'calc_mode',
        v_item->>'price_unit'
      );
    END LOOP;
  END LOOP;

  -- Save idempotency key
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'restore_quote_version', p_quote_id::text)
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'status', 'restored',
    'restored_from_version', v_version_number,
    'quote_id', p_quote_id
  );
END;
$$;
