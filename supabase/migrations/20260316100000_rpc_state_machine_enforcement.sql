-- ============================================================================
-- RPC STATE MACHINE ENFORCEMENT
-- ============================================================================
-- Adds proper state-machine validation to 4 RPC functions:
--
--   Fix 1: save_quote()            — Quote status transition validation
--   Fix 2: complete_job()          — Require in_progress before completion
--   Fix 3: receive_po_items()      — PO header status gate + FOR UPDATE lock
--   Fix 4: close_accounting_period() — Admin role check
--
-- Each function is CREATE OR REPLACE with the FULL existing body preserved.
-- Only validation guards are ADDED — no existing logic removed.
-- ============================================================================


-- ============================================================================
-- FIX 1: save_quote() — Add Quote Status State Machine
-- ============================================================================
-- Valid transitions:
--   draft    -> sent, revised, declined, expired
--   sent     -> revised, accepted, declined, expired
--   revised  -> sent, accepted, declined, expired
--   expired  -> revised (re-open)
--   accepted -> terminal (no changes allowed)
--   declined -> terminal (no changes allowed)
--
-- New quotes must start as 'draft'.
-- If status is unchanged (editing fields only), the save is allowed.
-- ============================================================================

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
  v_current_status text;
  v_new_status text;
BEGIN
  -- Verify caller is admin or sales_rep
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = p_performed_by AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to save quotes';
  END IF;

  -- ================================================================
  -- STATE MACHINE VALIDATION (added by rpc_state_machine_enforcement)
  -- ================================================================
  v_new_status := COALESCE(p_quote_payload->>'status', 'draft');

  IF v_is_new THEN
    -- New quotes MUST start as draft
    IF v_new_status != 'draft' THEN
      RAISE EXCEPTION 'New quotes must start with status draft, got: %', v_new_status;
    END IF;
  ELSE
    -- Existing quote: fetch current status with row lock
    SELECT status INTO v_current_status
    FROM quotes WHERE id = p_quote_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Quote not found: %', p_quote_id;
    END IF;

    -- If status is unchanged, allow the save (editing fields only)
    IF v_new_status IS DISTINCT FROM v_current_status THEN
      -- Validate the transition
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
  -- ================================================================
  -- END STATE MACHINE VALIDATION
  -- ================================================================

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


-- ============================================================================
-- FIX 2: complete_job() — Require in_progress Before Completion
-- ============================================================================
-- Previously allowed completing a job from 'scheduled' status directly.
-- Now enforces: job must be in 'in_progress' status before completion.
-- Use start_job() to transition scheduled -> in_progress first.
-- ============================================================================

CREATE OR REPLACE FUNCTION complete_job(
  p_job_id uuid,
  p_applied_info jsonb,
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job RECORD;
  v_record_number text;
  v_record_id uuid;
  v_product_data jsonb;
  v_weather jsonb;
  v_chem RECORD;
  v_inv record;
BEGIN
  -- Lock the job
  SELECT j.*, c.farm_name AS customer_name
  INTO v_job
  FROM jobs j
  JOIN customers c ON c.id = j.customer_id
  WHERE j.id = p_job_id
  FOR UPDATE OF j;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found: %', p_job_id;
  END IF;

  -- FIX: Require in_progress (was: scheduled or in_progress)
  IF v_job.status != 'in_progress' THEN
    RAISE EXCEPTION 'Job must be in_progress before completion. Current status: %. Use start_job() first.', v_job.status;
  END IF;

  -- PRE-CHECK: Verify inventory availability for all chemicals (A2.8 fix)
  FOR v_chem IN
    SELECT jc.product_id, jc.quantity, jc.unit, p.product_name
    FROM job_chemicals jc
    JOIN products p ON p.id = jc.product_id
    WHERE jc.job_id = p_job_id AND jc.quantity > 0
  LOOP
    SELECT * INTO v_inv
    FROM inventory
    WHERE product_id = v_chem.product_id AND location = 'Main Warehouse'
    FOR UPDATE;

    IF NOT FOUND OR v_inv.quantity_available < v_chem.quantity THEN
      RAISE EXCEPTION 'Insufficient inventory for %: need % units, only % available',
        v_chem.product_name,
        v_chem.quantity,
        COALESCE(v_inv.quantity_available, 0);
    END IF;
  END LOOP;

  -- Update job status
  UPDATE jobs SET status = 'completed' WHERE id = p_job_id;

  -- Insert applied info
  INSERT INTO job_applied_info (
    job_id, actual_start_time, actual_end_time,
    wind_speed, wind_direction, temperature, humidity,
    actual_gallons_applied, notes
  ) VALUES (
    p_job_id,
    CASE WHEN p_applied_info->>'actual_start_time' IS NOT NULL
      THEN (p_applied_info->>'actual_start_time')::timestamptz ELSE NULL END,
    CASE WHEN p_applied_info->>'actual_end_time' IS NOT NULL
      THEN (p_applied_info->>'actual_end_time')::timestamptz ELSE NULL END,
    (p_applied_info->>'wind_speed')::numeric,
    p_applied_info->>'wind_direction',
    (p_applied_info->>'temperature')::numeric,
    (p_applied_info->>'humidity')::numeric,
    (p_applied_info->>'actual_gallons_applied')::numeric,
    p_applied_info->>'notes'
  )
  ON CONFLICT (job_id) DO UPDATE SET
    actual_start_time = EXCLUDED.actual_start_time,
    actual_end_time = EXCLUDED.actual_end_time,
    wind_speed = EXCLUDED.wind_speed,
    wind_direction = EXCLUDED.wind_direction,
    temperature = EXCLUDED.temperature,
    humidity = EXCLUDED.humidity,
    actual_gallons_applied = EXCLUDED.actual_gallons_applied,
    notes = EXCLUDED.notes;

  -- Build product_data JSONB from job_chemicals
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'product_id', jc.product_id,
        'product_name', p.product_name,
        'quantity', jc.quantity,
        'unit', jc.unit,
        'rate_per_acre', jc.rate_per_acre,
        'rate_unit', jc.rate_unit,
        'epa_registration', p.epa_registration,
        'is_rup', COALESCE(p.is_rup, false)
      )
      ORDER BY jc.sort_order
    ),
    '[]'::jsonb
  )
  INTO v_product_data
  FROM job_chemicals jc
  LEFT JOIN products p ON p.id = jc.product_id
  WHERE jc.job_id = p_job_id;

  -- Build weather conditions
  v_weather := jsonb_build_object(
    'wind_speed', (p_applied_info->>'wind_speed')::numeric,
    'wind_direction', p_applied_info->>'wind_direction',
    'temperature', (p_applied_info->>'temperature')::numeric,
    'humidity', (p_applied_info->>'humidity')::numeric
  );

  -- Generate application record number
  v_record_number := next_application_record_number();

  -- Create application record
  INSERT INTO application_records (
    record_number, source_type, source_id,
    customer_id, applicator_id, field_id,
    application_date, product_data,
    total_acres, total_volume, total_volume_unit,
    vehicle_id, weather_conditions,
    notes, season, created_by
  ) VALUES (
    v_record_number, 'job', p_job_id,
    v_job.customer_id,
    v_job.applicator_id,
    (SELECT field_id FROM job_fields WHERE job_id = p_job_id ORDER BY sort_order LIMIT 1),
    v_job.job_date,
    v_product_data,
    v_job.total_acres,
    (p_applied_info->>'actual_gallons_applied')::numeric,
    'gallons',
    v_job.vehicle_id,
    v_weather,
    v_job.notes,
    v_job.season,
    p_performed_by
  )
  RETURNING id INTO v_record_id;

  -- A2.8 FIX: Deduct inventory from quantity_available (not quantity_on_hand)
  -- This is consistent with complete_delivery() behavior
  FOR v_chem IN
    SELECT jc.product_id, jc.quantity, jc.unit
    FROM job_chemicals jc
    WHERE jc.job_id = p_job_id AND jc.quantity > 0
  LOOP
    UPDATE inventory SET
      quantity_available = quantity_available - v_chem.quantity,
      quantity_prebooked = GREATEST(quantity_prebooked - v_chem.quantity, 0),
      updated_at = now()
    WHERE product_id = v_chem.product_id AND location = 'Main Warehouse';

    -- Create inventory transaction for audit trail
    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, from_location,
      performed_by, notes
    ) VALUES (
      v_chem.product_id, 'job_applied', v_chem.quantity, 'Main Warehouse',
      p_performed_by,
      'Job ' || v_job.job_number || ' completed — ' || v_chem.quantity || ' units applied'
    );
  END LOOP;

  -- Activity log
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'job_completed',
    'Job ' || v_job.job_number || ' completed. Application record: ' || v_record_number,
    p_performed_by, 'job', p_job_id, v_job.customer_id
  );

  RETURN jsonb_build_object(
    'success', true,
    'job_id', p_job_id,
    'application_record_id', v_record_id,
    'record_number', v_record_number
  );
END;
$$;

GRANT EXECUTE ON FUNCTION complete_job(uuid, jsonb, uuid) TO authenticated;


-- ============================================================================
-- FIX 3: receive_po_items() — PO Header Status Gate + Inventory FOR UPDATE Lock
-- ============================================================================
-- Two additions:
--   1. After fetching PO header, reject if PO status is not 'submitted' or
--      'partially_received' (prevents receiving on draft/cancelled/fully_received POs).
--   2. Before updating inventory quantity_available, acquire a FOR UPDATE lock
--      on the inventory row to prevent concurrent receiving race conditions.
-- ============================================================================

CREATE OR REPLACE FUNCTION receive_po_items(
  p_items jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL,
  p_allow_over_receive boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_item jsonb;
  v_po_item record;
  v_po record;
  v_qty numeric;
  v_product record;
  v_po_id uuid;
  v_all_received boolean;
  v_any_received boolean;
  v_new_status text;
  v_cached_result jsonb;
  v_result jsonb;
  v_receiving_record_ids jsonb := '[]'::jsonb;
  v_recv_id uuid;
  v_condition text;
  v_lot_number text;
  v_notes text;
  v_storage_location text;
  v_affected_po_ids uuid[] := '{}';
  v_unique_po_id uuid;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := check_idempotency(p_idempotency_key, 'receive_po_items');
    IF v_cached_result IS NOT NULL THEN
      RETURN v_cached_result;
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = p_performed_by
      AND role IN ('admin', 'sales_rep')
      AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Only admins and sales reps can receive PO items';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_qty := (v_item->>'quantity')::numeric;
    IF v_qty <= 0 THEN CONTINUE; END IF;

    SELECT * INTO v_po_item FROM purchase_order_items WHERE id = (v_item->>'po_item_id')::uuid;
    IF NOT FOUND THEN CONTINUE; END IF;

    IF NOT p_allow_over_receive AND v_po_item.quantity_received + v_qty > v_po_item.quantity_ordered THEN
      RAISE EXCEPTION 'Cannot receive more than ordered for item %', v_po_item.id;
    END IF;

    v_po_id := v_po_item.purchase_order_id;

    -- FIX 3a: PO Header Status Gate — reject if PO is not in a receivable state
    SELECT * INTO v_po FROM purchase_orders WHERE id = v_po_id;
    IF FOUND THEN
      IF v_po.status NOT IN ('submitted', 'partially_received') THEN
        RAISE EXCEPTION 'Cannot receive items for PO in status: %. Must be submitted or partially_received.', v_po.status;
      END IF;
    END IF;

    IF NOT v_po_id = ANY(v_affected_po_ids) THEN
      v_affected_po_ids := v_affected_po_ids || v_po_id;
    END IF;

    v_condition := COALESCE(v_item->>'condition', 'good');
    v_lot_number := v_item->>'lot_number';
    v_notes := v_item->>'notes';
    v_storage_location := COALESCE(v_item->>'storage_location', 'Main Warehouse');

    UPDATE purchase_order_items SET
      quantity_received = quantity_received + v_qty
    WHERE id = v_po_item.id;

    -- FIX 3b: Acquire FOR UPDATE lock on inventory row before modifying
    PERFORM 1 FROM public.inventory
    WHERE product_id = v_po_item.product_id AND location = v_storage_location
    FOR UPDATE;

    UPDATE inventory SET
      quantity_available = quantity_available + v_qty,
      quantity_on_order = GREATEST(quantity_on_order - v_qty, 0),
      updated_at = now()
    WHERE product_id = v_po_item.product_id AND location = v_storage_location;

    IF NOT FOUND THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_on_order, quantity_prebooked, unit_size)
      VALUES (v_po_item.product_id, v_storage_location, v_qty, 0, 0, v_po_item.unit_size);
    END IF;

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, to_location,
      purchase_order_id, performed_by, notes
    ) VALUES (
      v_po_item.product_id, 'received', v_qty, v_storage_location,
      v_po_id, p_performed_by,
      'Received ' || v_qty || ' units via PO'
    );

    INSERT INTO receiving_records (
      purchase_order_id, po_item_id, product_id,
      quantity_received, received_by, notes, condition,
      lot_number, storage_location, unit_size
    ) VALUES (
      v_po_id, v_po_item.id, v_po_item.product_id,
      v_qty, p_performed_by, v_notes, v_condition,
      v_lot_number, v_storage_location, v_po_item.unit_size
    )
    RETURNING id INTO v_recv_id;

    v_receiving_record_ids := v_receiving_record_ids || to_jsonb(v_recv_id::text);

    IF v_po_item.unit_cost IS NOT NULL AND v_po_item.unit_cost > 0 THEN
      SELECT * INTO v_product FROM products WHERE id = v_po_item.product_id;
      IF v_product.current_cost IS DISTINCT FROM v_po_item.unit_cost THEN
        INSERT INTO cost_history (product_id, changed_by, old_cost, new_cost, change_note)
        VALUES (v_po_item.product_id, p_performed_by, v_product.current_cost, v_po_item.unit_cost,
                'Auto-updated from PO receiving');

        UPDATE products SET
          current_cost = v_po_item.unit_cost,
          cost_updated_date = now()
        WHERE id = v_po_item.product_id;
      END IF;
    END IF;
  END LOOP;

  FOREACH v_unique_po_id IN ARRAY v_affected_po_ids
  LOOP
    SELECT * INTO v_po FROM purchase_orders WHERE id = v_unique_po_id;
    IF NOT FOUND THEN CONTINUE; END IF;

    SELECT
      bool_and(quantity_received >= quantity_ordered),
      bool_or(quantity_received > 0)
    INTO v_all_received, v_any_received
    FROM purchase_order_items WHERE purchase_order_id = v_unique_po_id;

    v_new_status := CASE
      WHEN v_all_received THEN 'fully_received'
      WHEN v_any_received THEN 'partially_received'
      ELSE v_po.status
    END;

    IF v_new_status IS DISTINCT FROM v_po.status THEN
      UPDATE purchase_orders SET status = v_new_status, updated_at = now() WHERE id = v_unique_po_id;
    END IF;

    INSERT INTO activity_feed (
      event_type, description, performed_by,
      related_entity_type, related_entity_id
    ) VALUES (
      'po_received',
      'Items received on PO ' || v_po.po_number || ' — inventory updated',
      p_performed_by, 'purchase_order', v_unique_po_id
    );
  END LOOP;

  v_result := jsonb_build_object(
    'status', 'received',
    'receiving_record_ids', v_receiving_record_ids
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'receive_po_items', v_result);
  END IF;

  RETURN v_result;
END;
$$;


-- ============================================================================
-- FIX 4: close_accounting_period() — Admin Role Check
-- ============================================================================
-- Previously any authenticated user with the period params could close a period.
-- Now validates that p_performed_by is an admin before proceeding.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.close_accounting_period(
  p_period_end   date,
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_period_start date;
  v_unposted_count integer;
  v_period_id uuid;
  v_summary jsonb;
BEGIN
  -- FIX: Admin role check (added by rpc_state_machine_enforcement)
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = p_performed_by AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Only admin users can close accounting periods';
  END IF;

  -- Period is the calendar month ending on p_period_end
  v_period_start := date_trunc('month', p_period_end)::date;

  -- Check for unposted invoices in this period
  SELECT count(*)
    INTO v_unposted_count
    FROM public.invoices
   WHERE invoice_date BETWEEN v_period_start AND p_period_end
     AND status IN ('draft', 'unposted')
     AND deleted_at IS NULL;

  IF v_unposted_count > 0 THEN
    RAISE EXCEPTION 'Cannot close period: % unposted invoice(s) exist between % and %',
      v_unposted_count, v_period_start, p_period_end;
  END IF;

  -- Check not already closed
  IF EXISTS (
    SELECT 1 FROM public.accounting_periods
     WHERE period_start = v_period_start AND period_end = p_period_end AND status = 'closed'
  ) THEN
    RAISE EXCEPTION 'Period % to % is already closed', v_period_start, p_period_end;
  END IF;

  -- Upsert accounting period
  INSERT INTO public.accounting_periods (period_start, period_end, status, closed_by, closed_at)
  VALUES (v_period_start, p_period_end, 'closed', p_performed_by, now())
  ON CONFLICT (period_start, period_end)
  DO UPDATE SET status = 'closed', closed_by = p_performed_by, closed_at = now(), updated_at = now()
  RETURNING id INTO v_period_id;

  -- Build summary
  SELECT jsonb_build_object(
    'period_id', v_period_id,
    'period_start', v_period_start,
    'period_end', p_period_end,
    'invoices_posted', (SELECT count(*) FROM public.invoices WHERE invoice_date BETWEEN v_period_start AND p_period_end AND status = 'posted' AND deleted_at IS NULL),
    'total_invoiced_cents', COALESCE((SELECT sum(total_amount_cents) FROM public.invoices WHERE invoice_date BETWEEN v_period_start AND p_period_end AND status = 'posted' AND deleted_at IS NULL), 0),
    'payments_received_cents', COALESCE((SELECT sum(amount_cents) FROM public.payments WHERE payment_date BETWEEN v_period_start AND p_period_end), 0),
    'orders_count', (SELECT count(*) FROM public.orders WHERE order_date BETWEEN v_period_start AND p_period_end AND deleted_at IS NULL),
    'deliveries_count', (SELECT count(*) FROM public.deliveries WHERE delivery_date BETWEEN v_period_start AND p_period_end AND deleted_at IS NULL)
  ) INTO v_summary;

  RETURN v_summary;
END;
$$;


-- ============================================================================
-- Migration complete: 4 RPCs hardened with state machine enforcement
-- ============================================================================
