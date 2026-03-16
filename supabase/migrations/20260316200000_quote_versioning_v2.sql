-- Sprint 2: Quote Versioning RPCs
-- create_quote_version: snapshots full quote state when presented/emailed
-- restore_quote_version: restores quote from a version snapshot as revised draft

-- RPC: create_quote_version
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

-- RPC: restore_quote_version
-- Restores a quote to a previous version's state as a new revised draft
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
    INSERT INTO quote_sections (quote_id, section_name, sort_order, section_notes)
    VALUES (
      p_quote_id,
      v_section->>'section_name',
      (v_section->>'sort_order')::integer,
      v_section->>'section_notes'
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
