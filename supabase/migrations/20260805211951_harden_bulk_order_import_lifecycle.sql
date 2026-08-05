-- Harden bulk order imports so they cannot bypass the canonical order lifecycle.
--
-- The legacy implementation accepted terminal/partial statuses while seeding every
-- line as fully remaining, and it omitted inventory prebooking, the booked ledger,
-- commissions, and the atomic activity event. Keep the RPC signature stable for
-- existing callers, but create only confirmed orders and perform the same required
-- downstream work as create_direct_order.

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
  v_existing jsonb;
  v_result jsonb;
  v_item jsonb;
  v_product record;
  v_customer record;
  v_item_count integer := 0;
  v_qty numeric;
  v_price_per_unit numeric;
  v_cost_per_unit numeric;
  v_total_price numeric := 0;
  v_total_cost numeric := 0;
  v_total_profit numeric;
  v_total_margin_pct numeric;
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

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(p_idempotency_key, 'bulk_import_order');
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  SELECT *
    INTO v_customer
  FROM public.customers
  WHERE id = p_customer_id
    AND is_active = true
  FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CUSTOMER_NOT_FOUND_OR_INACTIVE';
  END IF;

  -- Validate every line and recompute totals on the server. The four p_total_*
  -- parameters remain only for backwards-compatible PostgREST argument shape.
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    IF NULLIF(v_item->>'product_id', '') IS NULL THEN
      RAISE EXCEPTION 'ITEM_INVALID: product_id required';
    END IF;

    SELECT id, product_name, unit_size
      INTO v_product
    FROM public.products
    WHERE id = (v_item->>'product_id')::uuid
      AND is_active = true;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'ITEM_INVALID: product not found or inactive';
    END IF;

    v_qty := COALESCE((v_item->>'total_units_needed')::numeric, 0);
    v_price_per_unit := COALESCE((v_item->>'price_per_unit')::numeric, 0);
    v_cost_per_unit := COALESCE((v_item->>'unit_cost')::numeric, 0);

    IF v_qty <= 0 THEN
      RAISE EXCEPTION 'ITEM_INVALID: total_units_needed must be > 0';
    END IF;
    IF v_price_per_unit < 0 OR v_cost_per_unit < 0 THEN
      RAISE EXCEPTION 'ITEM_INVALID: price and cost must be >= 0';
    END IF;

    v_total_price := v_total_price + (v_qty * v_price_per_unit);
    v_total_cost := v_total_cost + (v_qty * v_cost_per_unit);
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

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    SELECT id, product_name, unit_size
      INTO v_product
    FROM public.products
    WHERE id = (v_item->>'product_id')::uuid
      AND is_active = true;

    v_qty := (v_item->>'total_units_needed')::numeric;
    v_price_per_unit := COALESCE((v_item->>'price_per_unit')::numeric, 0);
    v_cost_per_unit := COALESCE((v_item->>'unit_cost')::numeric, 0);

    INSERT INTO public.order_items (
      order_id,
      product_id,
      product_name,
      price_per_unit,
      cost_per_unit,
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
      v_product.id,
      v_product.product_name,
      v_price_per_unit,
      v_cost_per_unit,
      v_qty,
      COALESCE(NULLIF(v_item->>'unit_size', ''), v_product.unit_size),
      v_qty * v_price_per_unit,
      v_qty * (v_price_per_unit - v_cost_per_unit),
      CASE
        WHEN v_price_per_unit > 0
          THEN ((v_price_per_unit - v_cost_per_unit) / v_price_per_unit) * 100
        ELSE 0
      END,
      NULLIF(v_item->>'notes', ''),
      COALESCE((v_item->>'sort_order')::integer, v_item_count + 1),
      0,
      v_qty
    );

    INSERT INTO public.inventory (
      product_id,
      location,
      quantity_available,
      quantity_prebooked,
      quantity_on_order,
      unit_size
    ) VALUES (
      v_product.id,
      'Main Warehouse',
      0,
      v_qty,
      0,
      COALESCE(NULLIF(v_item->>'unit_size', ''), v_product.unit_size)
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
      v_product.id,
      'booked',
      v_qty,
      'Main Warehouse',
      v_order_id,
      v_actor,
      'Pre-booked for imported order ' || btrim(p_order_number)
    );

    v_item_count := v_item_count + 1;
  END LOOP;

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
    'Imported order ' || btrim(p_order_number) || ' created for ' || v_customer.farm_name,
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
    'item_count', v_item_count
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(
      p_idempotency_key,
      'bulk_import_order',
      v_result
    );
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
