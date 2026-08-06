-- Surface canonical Net Position warnings from bulk order imports.
--
-- Bulk imports intentionally follow the application's warn-not-block inventory
-- policy. The prior body reserved inventory correctly but returned only success,
-- so shortages were silent in the UI and activity record. Aggregate normalized
-- quantities by Product, lock existing Main Warehouse inventory rows in stable
-- Product order, compute the canonical Net Position before reservation, and
-- return/persist the same warnings as the normal direct-order path.

CREATE OR REPLACE FUNCTION public.bulk_import_order(
  p_order_number text,
  p_customer_id uuid,
  p_status text,
  p_total_price numeric,
  p_total_cost numeric,
  p_total_profit numeric,
  p_total_margin_pct numeric,
  p_order_date date,
  p_items jsonb,
  p_notes text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_order_id uuid;
  v_existing public.idempotency_keys%ROWTYPE;
  v_result jsonb;
  v_request_fingerprint text;
  v_item jsonb;
  v_normalized_items jsonb := '[]'::jsonb;
  v_product record;
  v_customer record;
  v_item_count integer := 0;
  v_validation_index integer := 0;
  v_sort_order integer;
  v_qty numeric;
  v_price_per_unit numeric;
  v_cost_per_unit numeric;
  v_cost_cents bigint;
  v_supplied_cost numeric;
  v_total_price numeric := 0;
  v_total_cost numeric := 0;
  v_total_profit numeric;
  v_total_margin_pct numeric;
  v_line_profit_sum numeric;
  v_last_item_id uuid;
  v_warning_item record;
  v_inventory record;
  v_warnings text[] := '{}';
  v_net_position numeric;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;

  SELECT role
    INTO v_actor_role
  FROM public.profiles
  WHERE id = v_actor
    AND is_active = true;

  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  IF NULLIF(btrim(p_order_number), '') IS NULL THEN
    RAISE EXCEPTION 'ORDER_NUMBER_REQUIRED';
  END IF;
  IF p_customer_id IS NULL THEN
    RAISE EXCEPTION 'CUSTOMER_ID_REQUIRED';
  END IF;
  IF p_order_date IS NULL THEN
    RAISE EXCEPTION 'ORDER_DATE_REQUIRED';
  END IF;
  IF lower(btrim(COALESCE(p_status, 'confirmed'))) <> 'confirmed' THEN
    RAISE EXCEPTION 'INVALID_IMPORT_STATUS: only confirmed orders can be imported';
  END IF;
  IF p_items IS NULL
     OR jsonb_typeof(p_items) <> 'array'
     OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'ITEMS_REQUIRED';
  END IF;

  v_request_fingerprint := encode(
    extensions.digest(
      convert_to(jsonb_build_object(
        'actor_id', v_actor,
        'order_number', btrim(p_order_number),
        'customer_id', p_customer_id,
        'status', lower(btrim(p_status)),
        'order_date', p_order_date,
        'items', p_items,
        'notes', NULLIF(btrim(COALESCE(p_notes, '')), '')
      )::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('crx:idempotency:' || p_idempotency_key, 0)
    );

    DELETE FROM public.idempotency_keys
     WHERE idempotency_key = p_idempotency_key
       AND expires_at < now();

    SELECT *
      INTO v_existing
      FROM public.idempotency_keys
     WHERE idempotency_key = p_idempotency_key;

    IF FOUND THEN
      IF v_existing.operation IS DISTINCT FROM 'bulk_import_order' THEN
        RAISE EXCEPTION 'IDEMPOTENCY_CROSS_OP_KEY_REUSE';
      END IF;
      IF v_existing.request_actor_id IS DISTINCT FROM v_actor THEN
        RAISE EXCEPTION 'IDEMPOTENCY_ACTOR_MISMATCH';
      END IF;
      IF v_existing.request_fingerprint IS DISTINCT FROM v_request_fingerprint THEN
        RAISE EXCEPTION 'IDEMPOTENCY_INTENT_MISMATCH'
          USING ERRCODE = '22023',
                DETAIL = jsonb_build_object(
                  'operation', v_existing.operation,
                  'result', v_existing.result
                )::text;
      END IF;
      RETURN v_existing.result;
    END IF;
  END IF;

  -- Lock all requested Product rows in stable UUID order before reading any
  -- cost. FOR SHARE conflicts with a concurrent current_cost update while
  -- allowing concurrent imports to share the same immutable snapshot.
  BEGIN
    PERFORM 1
      FROM public.products p
      JOIN (
        SELECT DISTINCT (e.value->>'product_id')::uuid AS id
          FROM jsonb_array_elements(p_items) AS e(value)
      ) requested ON requested.id = p.id
     ORDER BY p.id
     FOR SHARE OF p;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'ITEM_INVALID: product_id must be a valid UUID';
  END;

  SELECT *
    INTO v_customer
  FROM public.customers
  WHERE id = p_customer_id
    AND is_active = true
  FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CUSTOMER_NOT_FOUND_OR_INACTIVE';
  END IF;

  -- Validate, resolve Product identity/cost, normalize cents, and snapshot one
  -- immutable item payload before any lifecycle write. The four p_total_*
  -- parameters remain only for backwards-compatible PostgREST argument shape.
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    IF NULLIF(v_item->>'product_id', '') IS NULL THEN
      RAISE EXCEPTION 'ITEM_INVALID: product_id required';
    END IF;

    SELECT id, product_name, unit_size, current_cost
      INTO v_product
    FROM public.products
    WHERE id = (v_item->>'product_id')::uuid
      AND is_active = true;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'ITEM_INVALID: product not found or inactive';
    END IF;

    BEGIN
      v_qty := COALESCE((v_item->>'total_units_needed')::numeric, 0);
      v_price_per_unit := COALESCE((v_item->>'price_per_unit')::numeric, 0);
      v_supplied_cost := NULLIF(btrim(v_item->>'unit_cost'), '')::numeric;
      v_cost_cents := round(v_product.current_cost * 100)::bigint;
      v_cost_per_unit := v_cost_cents::numeric / 100;
      v_sort_order := COALESCE((v_item->>'sort_order')::integer, v_validation_index + 1);
    EXCEPTION
      WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RAISE EXCEPTION 'ITEM_INVALID: quantity, price, cost, and sort order must be valid numbers';
    END;

    IF v_qty::text IN ('NaN', 'Infinity', '-Infinity') OR v_qty <= 0 THEN
      RAISE EXCEPTION 'ITEM_INVALID: total_units_needed must be finite and > 0';
    END IF;
    IF v_price_per_unit::text IN ('NaN', 'Infinity', '-Infinity')
       OR v_price_per_unit < 0 THEN
      RAISE EXCEPTION 'ITEM_INVALID: price must be finite and >= 0';
    END IF;
    IF v_supplied_cost IS NOT NULL
       AND (
         v_supplied_cost::text IN ('NaN', 'Infinity', '-Infinity')
         OR v_supplied_cost < 0
       ) THEN
      RAISE EXCEPTION 'ITEM_INVALID: supplied unit_cost must be finite and >= 0';
    END IF;
    IF v_cost_per_unit IS NULL
       OR v_cost_per_unit::text IN ('NaN', 'Infinity', '-Infinity')
       OR v_cost_per_unit < 0 THEN
      RAISE EXCEPTION 'ITEM_INVALID: unit_cost is missing or invalid and Product current_cost is unavailable';
    END IF;

    -- These legacy columns store dollars as numeric. Round at the authoritative
    -- boundary so sub-cent caller/catalog values cannot enter financial records.
    v_price_per_unit := round(v_price_per_unit, 2);
    v_cost_per_unit := round(v_cost_per_unit, 2);
    v_total_price := v_total_price + round(v_qty * v_price_per_unit, 2);
    v_total_cost := v_total_cost + round(v_qty * v_cost_per_unit, 2);

    v_normalized_items := v_normalized_items || jsonb_build_array(jsonb_build_object(
      'product_id', v_product.id,
      'product_name', v_product.product_name,
      'price_per_unit', v_price_per_unit,
      'unit_cost', v_cost_per_unit,
      'cost_at_time_cents', v_cost_cents,
      'total_units_needed', v_qty,
      'unit_size', COALESCE(NULLIF(v_item->>'unit_size', ''), v_product.unit_size),
      'notes', NULLIF(v_item->>'notes', ''),
      'sort_order', v_sort_order
    ));
    v_validation_index := v_validation_index + 1;
  END LOOP;

  -- Follow the canonical warn-not-block inventory policy. Aggregate repeated
  -- Product lines and lock existing rows in stable UUID order so the warning is
  -- based on the same pre-reservation Net Position used by normal order entry.
  FOR v_warning_item IN
    SELECT
      x.product_id,
      max(x.product_name) AS product_name,
      sum(x.total_units_needed) AS qty_needed
    FROM jsonb_to_recordset(v_normalized_items) AS x(
      product_id uuid,
      product_name text,
      total_units_needed numeric
    )
    GROUP BY x.product_id
    ORDER BY x.product_id
  LOOP
    SELECT quantity_available, quantity_prebooked, quantity_on_order
      INTO v_inventory
    FROM public.inventory
    WHERE product_id = v_warning_item.product_id
      AND location = 'Main Warehouse'
    FOR UPDATE;

    IF NOT FOUND THEN
      v_warnings := array_append(
        v_warnings,
        v_warning_item.product_name || ': need ' || v_warning_item.qty_needed ||
        ', net position is 0 (no inventory record)'
      );
    ELSE
      v_net_position :=
        v_inventory.quantity_available
        - v_inventory.quantity_prebooked
        + COALESCE(v_inventory.quantity_on_order, 0);
      IF v_net_position < v_warning_item.qty_needed THEN
        v_warnings := array_append(
          v_warnings,
          v_warning_item.product_name || ': need ' || v_warning_item.qty_needed ||
          ', net position is ' || GREATEST(v_net_position, 0) ||
          ' (on floor: ' ||
          (v_inventory.quantity_available - v_inventory.quantity_prebooked) ||
          ', on order: ' || COALESCE(v_inventory.quantity_on_order, 0) || ')'
        );
      END IF;
    END IF;
  END LOOP;

  v_total_profit := v_total_price - v_total_cost;
  v_total_margin_pct := CASE
    WHEN v_total_price > 0 THEN (v_total_profit / v_total_price) * 100
    ELSE 0
  END;

  INSERT INTO public.orders (
    order_number,
    customer_id,
    status,
    total_price,
    total_cost,
    total_profit,
    total_margin_pct,
    order_date,
    notes
  ) VALUES (
    btrim(p_order_number),
    p_customer_id,
    'confirmed',
    v_total_price,
    v_total_cost,
    v_total_profit,
    v_total_margin_pct,
    p_order_date,
    NULLIF(btrim(COALESCE(p_notes, '')), '')
  )
  RETURNING id INTO v_order_id;

  FOR v_item IN SELECT value FROM jsonb_array_elements(v_normalized_items)
  LOOP
    v_qty := (v_item->>'total_units_needed')::numeric;
    v_price_per_unit := (v_item->>'price_per_unit')::numeric;
    v_cost_per_unit := (v_item->>'unit_cost')::numeric;
    v_cost_cents := (v_item->>'cost_at_time_cents')::bigint;

    INSERT INTO public.order_items (
      order_id,
      product_id,
      product_name,
      price_per_unit,
      cost_per_unit,
      cost_at_time_cents,
      total_units_needed,
      unit_size,
      total_price,
      profit,
      net_margin,
      notes,
      sort_order,
      quantity_delivered,
      quantity_remaining
    ) VALUES (
      v_order_id,
      (v_item->>'product_id')::uuid,
      v_item->>'product_name',
      v_price_per_unit,
      v_cost_per_unit,
      v_cost_cents,
      v_qty,
      NULLIF(v_item->>'unit_size', ''),
      round(v_qty * v_price_per_unit, 2),
      round(v_qty * v_price_per_unit, 2) - round(v_qty * v_cost_per_unit, 2),
      CASE
        WHEN v_price_per_unit > 0
          THEN ((v_price_per_unit - v_cost_per_unit) / v_price_per_unit) * 100
        ELSE 0
      END,
      NULLIF(v_item->>'notes', ''),
      (v_item->>'sort_order')::integer,
      0,
      v_qty
    )
    RETURNING id INTO v_last_item_id;

    INSERT INTO public.inventory (
      product_id,
      location,
      quantity_available,
      quantity_prebooked,
      quantity_on_order,
      unit_size
    ) VALUES (
      (v_item->>'product_id')::uuid,
      'Main Warehouse',
      0,
      v_qty,
      0,
      NULLIF(v_item->>'unit_size', '')
    )
    ON CONFLICT (product_id, location) DO UPDATE
      SET quantity_prebooked = public.inventory.quantity_prebooked + EXCLUDED.quantity_prebooked,
          updated_at = now();

    INSERT INTO public.inventory_transactions (
      product_id,
      transaction_type,
      quantity,
      to_location,
      order_id,
      performed_by,
      notes
    ) VALUES (
      (v_item->>'product_id')::uuid,
      'booked',
      v_qty,
      'Main Warehouse',
      v_order_id,
      v_actor,
      'Pre-booked for imported order ' || btrim(p_order_number)
    );

    v_item_count := v_item_count + 1;
  END LOOP;

  -- Item triggers own the canonical order totals. Read them only after the last
  -- insert, then make the item-profit aggregate agree exactly with the stored
  -- header before creating commission liability.
  SELECT total_price, total_cost, total_profit, total_margin_pct
    INTO v_total_price, v_total_cost, v_total_profit, v_total_margin_pct
    FROM public.orders
   WHERE id = v_order_id
   FOR UPDATE;

  SELECT COALESCE(sum(profit), 0)
    INTO v_line_profit_sum
    FROM public.order_items
   WHERE order_id = v_order_id;

  UPDATE public.order_items
     SET profit = profit + (v_total_profit - v_line_profit_sum)
   WHERE id = v_last_item_id;

  PERFORM public._insert_commissions_for_order(
    v_order_id,
    p_customer_id,
    v_total_profit,
    v_customer.default_commission_split,
    p_order_date
  );

  INSERT INTO public.activity_feed (
    event_type,
    description,
    performed_by,
    related_entity_type,
    related_entity_id,
    customer_id
  ) VALUES (
    'order_created',
    'Imported order ' || btrim(p_order_number) || ' created for ' || v_customer.farm_name ||
    CASE
      WHEN array_length(v_warnings, 1) > 0
        THEN ' (inventory warnings: ' || array_to_string(v_warnings, '; ') || ')'
      ELSE ''
    END,
    v_actor,
    'order',
    v_order_id,
    p_customer_id
  );

  v_result := jsonb_build_object(
    'success', true,
    'status', 'created',
    'order_id', v_order_id,
    'order_number', btrim(p_order_number),
    'item_count', v_item_count,
    'warnings', to_jsonb(v_warnings)
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(
      p_idempotency_key,
      'bulk_import_order',
      v_result
    );

    UPDATE public.idempotency_keys
       SET request_fingerprint = v_request_fingerprint,
           request_actor_id = v_actor
     WHERE idempotency_key = p_idempotency_key
       AND operation = 'bulk_import_order';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING';
    END IF;
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.bulk_import_order(
  text, uuid, text, numeric, numeric, numeric, numeric, date, jsonb, text, text
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.bulk_import_order(
  text, uuid, text, numeric, numeric, numeric, numeric, date, jsonb, text, text
) TO authenticated, service_role;

DO $verify$
DECLARE
  v_src text;
  v_overloads integer;
BEGIN
  SELECT count(*), max(prosrc)
    INTO v_overloads, v_src
  FROM pg_proc
  WHERE proname = 'bulk_import_order'
    AND pronamespace = 'public'::regnamespace;

  IF v_overloads <> 1 THEN
    RAISE EXCEPTION 'bulk_import_order overload count %, expected 1', v_overloads;
  END IF;
  IF v_src NOT LIKE '%jsonb_to_recordset(v_normalized_items)%'
     OR v_src NOT LIKE '%FOR UPDATE%'
     OR v_src NOT LIKE $needle$%'warnings', to_jsonb(v_warnings)%$needle$ THEN
    RAISE EXCEPTION 'bulk_import_order inventory-warning markers missing';
  END IF;
END;
$verify$;
