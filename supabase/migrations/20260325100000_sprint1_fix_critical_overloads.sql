-- ============================================================================
-- Migration: 20260325100000_sprint1_fix_critical_overloads.sql
-- Purpose: Fix CRITICAL stale RPC overloads causing frontend calls to resolve
--          to old/broken function versions.
--
-- Bugs Fixed:
--   RPC-001:   complete_job — stale overload without p_idempotency_key
--   RPC-002:   convert_quote_to_order — stale overload missing net position logic
--   RPC-003:   create_quick_delivery — stale overload without p_idempotency_key
--   ORDER-001: cancel_order — overwritten by 20260317200000 with broken version
--
-- Strategy for each function:
--   1. DROP ALL overloads (stale + current)
--   2. Recreate with the CORRECT business logic (from the latest good migration)
--   3. Add p_idempotency_key text DEFAULT NULL as the LAST parameter
--   4. GRANT EXECUTE to authenticated
--
-- IMPORTANT: Function bodies are copied EXACTLY from their source migrations.
--            Only the parameter signature is modified to unify the idempotency key.
-- ============================================================================


-- ============================================================================
-- BUG 1 FIX: complete_job (RPC-001)
-- Source: 20260316100000_rpc_state_machine_enforcement.sql line 333
-- Problem: Frontend sends p_idempotency_key but resolves to stale overload
--          from 20260306200000 that has older business logic.
-- Fix: Drop both overloads, recreate with p_idempotency_key DEFAULT NULL.
-- ============================================================================

-- Drop ALL overloads of complete_job
DROP FUNCTION IF EXISTS public.complete_job(uuid, jsonb, uuid, text);  -- stale overload with idem key
DROP FUNCTION IF EXISTS public.complete_job(uuid, jsonb, uuid);        -- current version from 20260316100000

CREATE OR REPLACE FUNCTION complete_job(
  p_job_id uuid,
  p_applied_info jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
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

GRANT EXECUTE ON FUNCTION complete_job(uuid, jsonb, uuid, text) TO authenticated;


-- ============================================================================
-- BUG 2 FIX: convert_quote_to_order (RPC-002 / QUOTE-001)
-- Source: 20260322100000_inventory_warn_not_block_net_position.sql line 233
-- Problem: Frontend sends p_idempotency_key but resolves to stale overload
--          from 20260317200000 that has OLDER business logic (missing net
--          position check, missing warn-not-block behavior).
-- Fix: Drop both overloads, recreate with p_idempotency_key DEFAULT NULL.
-- ============================================================================

-- Drop ALL overloads of convert_quote_to_order
DROP FUNCTION IF EXISTS public.convert_quote_to_order(uuid, uuid, text);  -- stale from 20260317200000
DROP FUNCTION IF EXISTS public.convert_quote_to_order(uuid, uuid);         -- current from 20260322100000

CREATE OR REPLACE FUNCTION convert_quote_to_order(
  p_quote_id uuid,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
  -- Derive actor from JWT, reject spoofing
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by <> v_actor THEN
    RAISE EXCEPTION 'Actor mismatch';
  END IF;

  SELECT * INTO v_quote FROM quotes WHERE id = p_quote_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found'; END IF;

  -- Idempotency: already converted?
  IF v_quote.status = 'accepted' THEN
    SELECT id INTO v_order_id FROM orders WHERE quote_id = p_quote_id LIMIT 1;
    IF v_order_id IS NOT NULL THEN
      RETURN jsonb_build_object('status', 'already_converted', 'order_id', v_order_id);
    END IF;
  END IF;

  SELECT * INTO v_customer FROM customers WHERE id = v_quote.customer_id;

  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- Availability check — use NET POSITION, collect as warnings (no blocking)
  FOR v_item IN
    SELECT qi.product_id, p.product_name,
           SUM(COALESCE(qi.total_units_needed, 0)) AS qty_needed
    FROM quote_items qi
    JOIN products p ON p.id = qi.product_id
    WHERE qi.quote_id = p_quote_id
      AND qi.product_id IS NOT NULL
      AND COALESCE(qi.total_units_needed, 0) > 0
    GROUP BY qi.product_id, p.product_name
  LOOP
    SELECT * INTO v_inv
    FROM inventory
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse'
    FOR UPDATE;

    IF NOT FOUND THEN
      v_shortfalls := array_append(v_shortfalls,
        v_item.product_name || ': need ' || v_item.qty_needed || ', net position is 0 (no inventory record)');
    ELSE
      -- Net position = available - prebooked + on_order
      v_net_position := v_inv.quantity_available - v_inv.quantity_prebooked + COALESCE(v_inv.quantity_on_order, 0);
      IF v_net_position < v_item.qty_needed THEN
        v_shortfalls := array_append(v_shortfalls,
          v_item.product_name || ': need ' || v_item.qty_needed ||
          ', net position is ' || GREATEST(v_net_position, 0) ||
          ' (on floor: ' || (v_inv.quantity_available - v_inv.quantity_prebooked) ||
          ', on order: ' || COALESCE(v_inv.quantity_on_order, 0) || ')');
      END IF;
    END IF;
  END LOOP;

  SET LOCAL app.admin_override = 'true';

  UPDATE quotes SET status = 'accepted', updated_at = now() WHERE id = p_quote_id;

  v_order_number := generate_order_number();

  INSERT INTO orders (
    order_number, quote_id, customer_id, status,
    commission_split, total_price, total_cost, total_profit,
    total_margin_pct, order_date
  ) VALUES (
    v_order_number, p_quote_id, v_quote.customer_id, 'confirmed',
    v_quote.commission_split,
    v_quote.total_price, v_quote.total_cost, v_quote.total_profit,
    v_quote.total_margin_pct, current_date
  ) RETURNING id INTO v_order_id;

  -- Create order items from quote items
  INSERT INTO order_items (
    order_id, product_id, quote_item_id, section_name, product_name,
    price_per_unit, cost_per_unit, actual_rate, rate_unit, acres,
    total_units_needed, unit_size, total_price, profit, net_margin,
    quantity_delivered, quantity_remaining
  )
  SELECT
    v_order_id, qi.product_id, qi.id,
    qs.section_name, p.product_name,
    qi.price_per_unit, qi.current_cost, qi.actual_rate, qi.rate_unit, qi.acres,
    COALESCE(qi.total_units_needed, 0), qi.unit_size,
    qi.total_price, qi.profit, qi.net_margin,
    0, COALESCE(qi.total_units_needed, 0)
  FROM quote_items qi
  JOIN quote_sections qs ON qs.id = qi.section_id
  JOIN products p ON p.id = qi.product_id
  WHERE qi.quote_id = p_quote_id AND qi.product_id IS NOT NULL;

  -- Pre-book inventory (even if exceeding available — tracks oversold status)
  FOR v_item IN
    SELECT oi.product_id, oi.total_units_needed, oi.unit_size
    FROM order_items oi
    WHERE oi.order_id = v_order_id AND oi.product_id IS NOT NULL AND oi.total_units_needed > 0
  LOOP
    UPDATE inventory SET
      quantity_prebooked = quantity_prebooked + v_item.total_units_needed,
      updated_at = now()
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';

    IF NOT FOUND THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order, unit_size)
      VALUES (v_item.product_id, 'Main Warehouse', 0, v_item.total_units_needed, 0, v_item.unit_size);
    END IF;

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, to_location,
      order_id, performed_by, notes
    ) VALUES (
      v_item.product_id, 'booked', v_item.total_units_needed, 'Main Warehouse',
      v_order_id, v_actor,
      'Pre-booked for order ' || v_order_number
    );
  END LOOP;

  -- Create commission records
  IF v_quote.commission_split IS NOT NULL AND v_quote.commission_split ? 'splits' THEN
    INSERT INTO commissions (
      order_id, customer_id, recipient, split_percentage,
      commission_amount, order_profit, order_date, status
    )
    SELECT
      v_order_id, v_quote.customer_id,
      s->>'recipient',
      (s->>'percentage')::numeric,
      v_quote.total_profit * ((s->>'percentage')::numeric / 100),
      v_quote.total_profit,
      current_date,
      'pending'
    FROM jsonb_array_elements(v_quote.commission_split->'splits') s
    WHERE (s->>'recipient') IS NOT NULL AND (s->>'percentage')::numeric > 0;
  END IF;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'order_created',
    'Order ' || v_order_number || ' created from quote ' || v_quote.quote_number ||
    ' for ' || COALESCE(v_customer.farm_name, 'customer') ||
    CASE WHEN array_length(v_shortfalls, 1) > 0
      THEN ' (inventory warnings: ' || array_to_string(v_shortfalls, '; ') || ')'
      ELSE '' END,
    v_actor, 'order', v_order_id, v_quote.customer_id
  );

  -- Return result WITH warnings (instead of blocking)
  RETURN jsonb_build_object(
    'status', 'created',
    'order_id', v_order_id,
    'order_number', v_order_number,
    'warnings', to_jsonb(v_shortfalls)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION convert_quote_to_order(uuid, uuid, text) TO authenticated;


-- ============================================================================
-- BUG 3 FIX: create_quick_delivery (RPC-003)
-- Source: 20260315200000_emergency_rpc_fixes.sql line 802
-- Problem: Frontend sends p_idempotency_key but resolves to stale overload
--          from 20260306200000 that has older business logic.
-- Fix: Drop both overloads, recreate with p_idempotency_key DEFAULT NULL.
-- ============================================================================

-- Drop ALL overloads of create_quick_delivery
DROP FUNCTION IF EXISTS public.create_quick_delivery(uuid, jsonb, uuid, date, text, uuid, text);  -- stale with idem key
DROP FUNCTION IF EXISTS public.create_quick_delivery(uuid, jsonb, uuid, date, text, uuid);         -- current from 20260315200000

CREATE OR REPLACE FUNCTION create_quick_delivery(
  p_customer_id uuid,
  p_items jsonb,
  p_driver_id uuid DEFAULT NULL,
  p_scheduled_date date DEFAULT CURRENT_DATE,
  p_delivery_notes text DEFAULT NULL,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_order_id uuid;
  v_order_number text;
  v_delivery_id uuid;
  v_delivery_number text;
  v_invoice_id uuid;
  v_invoice_number text;
  v_item jsonb;
  v_order_item_id uuid;
  v_product record;
  v_inv record;
  v_total_cents bigint := 0;
  v_total_cost_cents bigint := 0;
  v_item_price_cents bigint;
  v_item_qty numeric;
  v_sort integer := 0;
  v_customer record;
  v_split jsonb;
  v_split_entry jsonb;
  v_order_profit numeric;
  v_split_total numeric;
  v_net_available numeric;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND is_active = true
      AND role IN ('admin', 'sales_rep', 'driver')
  ) THEN
    RAISE EXCEPTION 'Not authorized to create quick deliveries';
  END IF;

  SELECT * INTO v_customer
  FROM customers WHERE id = p_customer_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer not found';
  END IF;

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'At least one item is required';
  END IF;

  -- Pre-check inventory availability before creating anything
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    SELECT * INTO v_product
    FROM products WHERE id = (v_item->>'product_id')::uuid AND is_active = true;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product not found or inactive: %', v_item->>'product_id';
    END IF;

    v_item_qty := (v_item->>'quantity')::numeric;

    SELECT * INTO v_inv
    FROM inventory
    WHERE product_id = v_product.id AND location = 'Main Warehouse'
    FOR UPDATE;

    -- FIX #8: Subtract prebooked from available for net free check
    v_net_available := COALESCE(v_inv.quantity_available, 0) - COALESCE(v_inv.quantity_prebooked, 0);

    IF NOT FOUND OR v_net_available < v_item_qty THEN
      RAISE EXCEPTION 'Insufficient inventory for %: need % units, only % net available (% on hand, % prebooked)',
        v_product.product_name,
        v_item_qty,
        GREATEST(v_net_available, 0),
        COALESCE(v_inv.quantity_available, 0),
        COALESCE(v_inv.quantity_prebooked, 0);
    END IF;
  END LOOP;

  -- FIX #6: Use default_commission_split (correct column on customers table)
  v_split := v_customer.default_commission_split;

  -- FIX #7: Commission splits are stored as {splits: [{recipient, percentage}]}, not bare array
  IF v_split IS NOT NULL AND v_split ? 'splits' AND jsonb_array_length(v_split->'splits') > 0 THEN
    SELECT COALESCE(SUM((elem->>'percentage')::numeric), 0)
    INTO v_split_total
    FROM jsonb_array_elements(v_split->'splits') elem;

    IF ABS(v_split_total - 100) > 0.01 THEN
      RAISE EXCEPTION 'Customer commission splits must sum to 100%% (got %.2f%%). Fix customer settings before creating delivery.', v_split_total;
    END IF;
  END IF;

  -- Step 1: Create Order
  v_order_id := gen_random_uuid();
  v_order_number := generate_order_number();

  INSERT INTO orders (
    id, order_number, customer_id, status,
    order_date, notes, total_price, total_cost, total_profit, total_margin_pct,
    commission_split
  ) VALUES (
    v_order_id, v_order_number, p_customer_id, 'confirmed',
    CURRENT_DATE, 'Quick delivery', 0, 0, 0, 0,
    v_customer.default_commission_split  -- FIX #6: correct column name
  );

  -- Step 2: Create Delivery
  v_delivery_id := gen_random_uuid();
  v_delivery_number := next_delivery_number();

  INSERT INTO deliveries (
    id, delivery_number, order_id, customer_id,
    assigned_driver, scheduled_date, status,
    delivery_notes, is_quick_delivery
  ) VALUES (
    v_delivery_id, v_delivery_number, v_order_id, p_customer_id,
    p_driver_id, p_scheduled_date, 'scheduled',
    p_delivery_notes, true
  );

  -- Step 3: Create Invoice (draft)
  v_invoice_id := gen_random_uuid();
  v_invoice_number := next_invoice_number('chemical_sale');

  INSERT INTO invoices (
    id, invoice_number, invoice_type, order_id, customer_id,
    status, total_amount_cents, paid_amount_cents, prepay_applied_cents,
    invoice_date, is_quick_delivery, created_by
  ) VALUES (
    v_invoice_id, v_invoice_number, 'chemical_sale', v_order_id, p_customer_id,
    'draft', 0, 0, 0,
    CURRENT_DATE, true, v_actor
  );

  -- Step 4: Process items (inventory already validated above)
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_sort := v_sort + 1;

    SELECT * INTO v_product
    FROM products WHERE id = (v_item->>'product_id')::uuid AND is_active = true;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product not found or inactive: %', v_item->>'product_id';
    END IF;

    v_item_qty := (v_item->>'quantity')::numeric;
    v_item_price_cents := (v_item->>'price_cents')::bigint;

    IF v_item_price_cents IS NULL THEN
      v_item_price_cents := CASE COALESCE(v_customer.assigned_tier, 1)
        WHEN 1 THEN COALESCE(v_product.tier1_price * 100, 0)::bigint
        WHEN 2 THEN COALESCE(v_product.tier2_price * 100, v_product.tier1_price * 100, 0)::bigint
        WHEN 3 THEN COALESCE(v_product.tier3_price * 100, v_product.tier1_price * 100, 0)::bigint
        ELSE COALESCE(v_product.tier1_price * 100, 0)::bigint
      END;
    END IF;

    v_order_item_id := gen_random_uuid();
    INSERT INTO order_items (
      id, order_id, product_id, product_name, price_per_unit, cost_per_unit,
      total_units_needed, quantity_remaining, quantity_delivered, unit_size,
      total_price, profit, net_margin
    ) VALUES (
      v_order_item_id, v_order_id, v_product.id, v_product.product_name,
      (v_item_price_cents / 100.0)::numeric, COALESCE(v_product.current_cost, 0),
      v_item_qty, v_item_qty, 0,
      COALESCE(v_item->>'unit_size', v_product.unit_size),
      (v_item_price_cents * v_item_qty / 100.0)::numeric,
      ((v_item_price_cents / 100.0) - COALESCE(v_product.current_cost, 0)) * v_item_qty,
      CASE WHEN v_item_price_cents > 0
        THEN ((v_item_price_cents / 100.0 - COALESCE(v_product.current_cost, 0)) / (v_item_price_cents / 100.0) * 100)
        ELSE 0
      END
    );

    INSERT INTO delivery_items (
      delivery_id, order_item_id, product_id, quantity, unit_size
    ) VALUES (
      v_delivery_id, v_order_item_id, v_product.id, v_item_qty,
      COALESCE(v_item->>'unit_size', v_product.unit_size)
    );

    INSERT INTO invoice_items (
      invoice_id, order_item_id, product_id, description,
      quantity, unit_price_cents, extended_cents, cost_cents,
      unit_size, sort_order
    ) VALUES (
      v_invoice_id, v_order_item_id, v_product.id, v_product.product_name,
      v_item_qty, v_item_price_cents, v_item_price_cents * v_item_qty::bigint,
      COALESCE(v_product.current_cost * 100, 0)::bigint,
      COALESCE(v_item->>'unit_size', v_product.unit_size), v_sort
    );

    v_total_cents := v_total_cents + (v_item_price_cents * v_item_qty::bigint);
    v_total_cost_cents := v_total_cost_cents + (COALESCE(v_product.current_cost * 100, 0)::bigint * v_item_qty::bigint);
  END LOOP;

  -- Step 5: Update totals
  v_order_profit := ((v_total_cents - v_total_cost_cents) / 100.0)::numeric;

  UPDATE orders SET
    total_price = (v_total_cents / 100.0)::numeric,
    total_cost = (v_total_cost_cents / 100.0)::numeric,
    total_profit = v_order_profit,
    total_margin_pct = CASE WHEN v_total_cents > 0
      THEN ((v_total_cents - v_total_cost_cents)::numeric / v_total_cents * 100)
      ELSE 0 END
  WHERE id = v_order_id;

  UPDATE invoices SET
    total_amount_cents = v_total_cents
  WHERE id = v_invoice_id;

  -- Generate commissions (FIX #7: correct JSON path through 'splits' key)
  IF v_split IS NOT NULL AND v_split ? 'splits' AND jsonb_array_length(v_split->'splits') > 0 THEN
    FOR v_split_entry IN SELECT * FROM jsonb_array_elements(v_split->'splits')
    LOOP
      INSERT INTO commissions (
        order_id, customer_id, recipient,
        split_percentage, commission_amount, order_profit,
        order_date, status
      ) VALUES (
        v_order_id, p_customer_id,
        COALESCE(v_split_entry->>'recipient', v_split_entry->>'name', 'Unknown'),
        (v_split_entry->>'percentage')::numeric,
        v_order_profit * ((v_split_entry->>'percentage')::numeric / 100.0),
        v_order_profit,
        CURRENT_DATE,
        'pending'
      );
    END LOOP;
  END IF;

  -- Activity log
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'quick_delivery_created',
    'Quick delivery ' || v_delivery_number || ' created with order ' || v_order_number || ' and draft invoice ' || v_invoice_number,
    v_actor, 'delivery', v_delivery_id, p_customer_id
  );

  RETURN jsonb_build_object(
    'status', 'created',
    'order_id', v_order_id,
    'order_number', v_order_number,
    'delivery_id', v_delivery_id,
    'delivery_number', v_delivery_number,
    'invoice_id', v_invoice_id,
    'invoice_number', v_invoice_number
  );
END;
$$;

GRANT EXECUTE ON FUNCTION create_quick_delivery(uuid, jsonb, uuid, date, text, uuid, text) TO authenticated;


-- ============================================================================
-- BUG 4 FIX: cancel_order (ORDER-001 / STOCK-001 / STOCK-002 / STOCK-003 / STOCK-004)
-- Source: 20260311000000_audit_cancel_state_machine_fixes.sql line 93
-- Problem: Migration 20260317200000 overwrote the correct cancel_order with a
--          broken version that:
--          - References order_id on inventory_holds (column is source_id)
--          - Missing SET LOCAL app.admin_override = 'true'
--          - No delivery cascade cancellation
--          - Uses 'voided' for draft invoices (trigger rejects draft->voided)
-- Fix: Drop all overloads, recreate with the CORRECT version from 20260311000000.
-- ============================================================================

-- Drop ALL overloads of cancel_order
DROP FUNCTION IF EXISTS public.cancel_order(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.cancel_order(uuid, uuid);
DROP FUNCTION IF EXISTS public.cancel_order(uuid, text);

CREATE OR REPLACE FUNCTION cancel_order(
  p_order_id uuid,
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
  v_cached_result jsonb;
  v_order record;
  v_item record;
  v_hold record;
  v_undelivered numeric;
  v_holds_released integer := 0;
  v_commissions_cancelled integer := 0;
  v_paid_commissions integer := 0;
  v_draft_cancelled integer := 0;
  v_posted_notified integer := 0;
  v_deliveries_cancelled integer := 0;
  v_invoice record;
  v_admin record;
  v_result jsonb;
BEGIN
  -- ── P0-001: auth.uid() enforcement ──
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  IF p_performed_by IS NOT NULL AND v_actor IS DISTINCT FROM p_performed_by THEN
    RAISE EXCEPTION 'actor mismatch';
  END IF;

  -- ── Idempotency check ──
  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := check_idempotency(p_idempotency_key, 'cancel_order');
    IF v_cached_result IS NOT NULL THEN
      RETURN v_cached_result;
    END IF;
  END IF;

  -- ── Lock and validate order ──
  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;
  IF v_order.status = 'cancelled' THEN
    RETURN jsonb_build_object('status', 'already_cancelled');
  END IF;
  IF v_order.status = 'fulfilled' THEN
    RAISE EXCEPTION 'Cannot cancel a fulfilled order';
  END IF;

  -- ── Verify caller is admin ──
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Only admins can cancel orders';
  END IF;

  -- ── Set admin override so state-machine triggers allow the transitions ──
  SET LOCAL app.admin_override = 'true';

  -- ── Cancel active deliveries (scheduled/in_progress only) ──
  -- Do NOT cancel completed deliveries — those need explicit reversal.
  -- Direct UPDATE (not recursive cancel_delivery call) to avoid double prebook release.
  UPDATE deliveries SET
    status = 'cancelled',
    cancelled_at = now(),
    cancelled_by = v_actor,
    cancel_reason = 'Parent order ' || v_order.order_number || ' cancelled',
    updated_at = now()
  WHERE order_id = p_order_id
    AND status IN ('scheduled', 'in_progress');
  GET DIAGNOSTICS v_deliveries_cancelled = ROW_COUNT;

  -- Notify drivers of cancelled deliveries
  IF v_deliveries_cancelled > 0 THEN
    INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
    SELECT
      d.assigned_driver,
      'Delivery Cancelled',
      'Delivery ' || d.delivery_number || ' cancelled — order ' || v_order.order_number || ' was cancelled.',
      'delivery_update', 'delivery', d.id
    FROM deliveries d
    WHERE d.order_id = p_order_id
      AND d.status = 'cancelled'
      AND d.cancel_reason LIKE 'Parent order%'
      AND d.assigned_driver IS NOT NULL;
  END IF;

  -- ── Update order status ──
  UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = p_order_id;

  -- ── Release prebooked inventory for undelivered items ──
  FOR v_item IN
    SELECT product_id, total_units_needed, quantity_delivered
    FROM order_items WHERE order_id = p_order_id
  LOOP
    v_undelivered := GREATEST(v_item.total_units_needed - COALESCE(v_item.quantity_delivered, 0), 0);
    IF v_undelivered <= 0 THEN CONTINUE; END IF;

    UPDATE inventory SET
      quantity_prebooked = GREATEST(quantity_prebooked - v_undelivered, 0),
      updated_at = now()
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, to_location,
      order_id, performed_by, notes
    ) VALUES (
      v_item.product_id, 'cancelled_order_release', -v_undelivered, 'Main Warehouse',
      p_order_id, v_actor,
      'Released ' || v_undelivered || ' units — order ' || v_order.order_number || ' cancelled'
    );
  END LOOP;

  -- ── Release inventory holds via source_id (NOT order_id) ──
  -- Holds are linked to the QUOTE that originated this order.
  -- Look up quote_id from the order, then release holds for that quote.
  IF v_order.quote_id IS NOT NULL THEN
    FOR v_hold IN
      SELECT ih.product_id, ih.quantity
      FROM inventory_holds ih
      WHERE ih.source_id = v_order.quote_id AND ih.is_active = true
      FOR UPDATE
    LOOP
      UPDATE inventory
      SET quantity_available = quantity_available + v_hold.quantity,
          updated_at = now()
      WHERE product_id = v_hold.product_id
        AND location = 'Main Warehouse';
    END LOOP;

    UPDATE inventory_holds SET is_active = false, updated_at = now()
    WHERE source_id = v_order.quote_id AND is_active = true;
    GET DIAGNOSTICS v_holds_released = ROW_COUNT;
  END IF;

  -- ── Cancel pending commissions ──
  UPDATE commissions SET
    status = 'cancelled',
    commission_amount = 0
  WHERE order_id = p_order_id AND status = 'pending';
  GET DIAGNOSTICS v_commissions_cancelled = ROW_COUNT;

  -- ── Check for paid commissions — flag for admin review, don't touch them ──
  SELECT COUNT(*) INTO v_paid_commissions
  FROM commissions WHERE order_id = p_order_id AND status = 'paid';

  IF v_paid_commissions > 0 THEN
    FOR v_admin IN
      SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
    LOOP
      INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
      VALUES (
        v_admin.id,
        'Cancelled Order Has Paid Commissions',
        'Order ' || v_order.order_number || ' was cancelled but has ' || v_paid_commissions || ' paid commission(s). Manual review required.',
        'cancellation_review', 'order', p_order_id
      );
    END LOOP;
  END IF;

  -- ── Handle invoices ──
  -- Draft invoices: set status to 'cancelled' (NOT 'voided').
  --   The state machine trigger allows draft->cancelled but NOT draft->voided.
  --   Do NOT set balance_cents (it's GENERATED ALWAYS).
  --   Instead zero out the component columns so balance computes to 0.
  -- Posted invoices: flag for admin review (don't auto-void).
  FOR v_invoice IN
    SELECT * FROM invoices
    WHERE order_id = p_order_id
      AND deleted_at IS NULL
      AND status IN ('draft', 'unposted', 'posted')
  LOOP
    IF v_invoice.status IN ('draft', 'unposted') THEN
      UPDATE invoices SET
        status = 'cancelled',
        total_amount_cents = 0,
        paid_amount_cents = 0,
        prepay_applied_cents = 0,
        write_off_cents = 0,
        updated_at = now()
      WHERE id = v_invoice.id;

      INSERT INTO financial_audit_log (
        operation_type, entity_type, entity_id, actor_role,
        old_values, new_values, total_impact_cents, description
      ) VALUES (
        'invoice_cancelled', 'invoice', v_invoice.id, 'admin',
        jsonb_build_object('status', v_invoice.status, 'total_cents', v_invoice.total_amount_cents),
        jsonb_build_object('status', 'cancelled', 'reason', 'Order ' || v_order.order_number || ' cancelled'),
        -1 * v_invoice.total_amount_cents,
        'Auto-cancelled ' || v_invoice.status || ' invoice ' || v_invoice.invoice_number || ' — order ' || v_order.order_number || ' cancelled'
      );

      v_draft_cancelled := v_draft_cancelled + 1;

    ELSIF v_invoice.status = 'posted' THEN
      -- Posted invoices require manual void — just notify admins
      FOR v_admin IN
        SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
      LOOP
        INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
        VALUES (
          v_admin.id,
          'Order Cancelled — Posted Invoice Needs Review',
          'Order ' || v_order.order_number || ' cancelled. Invoice ' || v_invoice.invoice_number || ' is posted and needs manual voiding.',
          'cancellation_review', 'invoice', v_invoice.id
        );
      END LOOP;

      v_posted_notified := v_posted_notified + 1;
    END IF;
  END LOOP;

  -- ── Financial audit log for the order cancellation itself ──
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'order_cancelled', 'order', p_order_id, 'admin',
    jsonb_build_object('status', v_order.status, 'order_number', v_order.order_number),
    jsonb_build_object(
      'status', 'cancelled',
      'deliveries_cancelled', v_deliveries_cancelled,
      'holds_released', v_holds_released,
      'commissions_cancelled', v_commissions_cancelled,
      'draft_invoices_cancelled', v_draft_cancelled,
      'posted_invoices_flagged', v_posted_notified
    ),
    0,
    'Order ' || v_order.order_number || ' cancelled by admin'
  );

  -- ── Activity feed ──
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'order_cancelled',
    'Order ' || v_order.order_number || ' cancelled. ' ||
      v_deliveries_cancelled || ' delivery(s) cancelled, ' ||
      v_holds_released || ' hold(s) released, ' ||
      v_commissions_cancelled || ' commission(s) zeroed, ' ||
      v_draft_cancelled || ' draft/unposted invoice(s) cancelled.' ||
      CASE WHEN v_posted_notified > 0 THEN ' ' || v_posted_notified || ' posted invoice(s) flagged for review.' ELSE '' END ||
      CASE WHEN v_paid_commissions > 0 THEN ' ' || v_paid_commissions || ' paid commission(s) flagged for review.' ELSE '' END,
    v_actor, 'order', p_order_id, v_order.customer_id
  );

  -- ── Build result ──
  v_result := jsonb_build_object(
    'status', 'cancelled',
    'order_number', v_order.order_number,
    'deliveries_cancelled', v_deliveries_cancelled,
    'holds_released', v_holds_released,
    'commissions_cancelled', v_commissions_cancelled,
    'paid_commissions_flagged', v_paid_commissions,
    'draft_invoices_cancelled', v_draft_cancelled,
    'posted_invoices_notified', v_posted_notified
  );

  -- ── Save idempotency result ──
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'cancel_order', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION cancel_order(uuid, uuid, text) TO authenticated;


-- ============================================================================
-- BUG 5 VERIFICATION: confirm_delivery
-- Migration 20260324100000 already fixed confirm_delivery's overloads.
-- This block verifies all 4 fixed functions have exactly 1 overload each.
-- ============================================================================

DO $$
DECLARE
  func_name TEXT;
  overload_count INT;
  func_names TEXT[] := ARRAY[
    'complete_job', 'convert_quote_to_order', 'create_quick_delivery', 'cancel_order'
  ];
BEGIN
  FOREACH func_name IN ARRAY func_names
  LOOP
    SELECT count(*) INTO overload_count
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.proname = func_name;

    IF overload_count != 1 THEN
      RAISE EXCEPTION 'VERIFICATION FAILED: Function % has % overloads (expected 1)', func_name, overload_count;
    END IF;
  END LOOP;
  RAISE NOTICE 'All functions verified: 1 overload each';
END $$;
