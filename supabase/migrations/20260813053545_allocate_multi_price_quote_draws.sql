-- STATUS: PARKED DRAFT - NOT APPLIED
-- Keep quote draw-downs cent-exact when one Product is booked on multiple
-- quote lines at different prices.
--
-- The live implementation collapsed those lines to one weighted-average unit
-- price. Two equal quantities at $10.00 and $10.01 therefore produced the
-- non-representable unit price $10.005. The below-cost wall correctly rejects
-- fractional-cent unit prices, so an otherwise valid draw rolled back.
--
-- This forward-only replacement keeps the public five-argument wrapper and
-- all authorization/idempotency/inventory behavior unchanged. It allocates
-- each draw's authoritative total from the Product's booked cent total using
-- cumulative rounding. That makes repeated partial draws telescope exactly to
-- the booked total. The stored unit price is rounded DOWN to a cent so the
-- below-cost comparison is fail-closed: cent allocation can cause an approval
-- prompt, but can never round a sub-cent effective price up past catalog cost.
-- No existing business row is rewritten by this migration.

CREATE OR REPLACE FUNCTION public._draw_down_quote_below_cost_impl_20260810(
  p_quote_id uuid,
  p_draws jsonb,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid;
  v_actor_role text;
  v_quote record;
  v_customer record;
  v_draw jsonb;
  v_product_id uuid;
  v_product_name text;
  v_qty numeric;
  v_booked numeric;
  v_booked_price_total numeric;
  v_drawn numeric;
  v_remaining numeric;
  v_allocated_unit_price numeric;
  v_wavg_cost numeric;
  v_total_acres numeric;
  v_unit_size text;
  v_acres numeric;
  v_inv record;
  v_net_position numeric;
  v_order_id uuid;
  v_order_number text;
  v_total_price numeric := 0;
  v_total_cost numeric := 0;
  v_total_profit numeric;
  v_total_margin_pct numeric;
  v_line_total numeric;
  v_line_cost numeric;
  v_consumed_before numeric;
  v_shortfalls text[] := '{}';
  v_lines jsonb := '[]'::jsonb;
  v_hold record;
  v_to_consume numeric;
  v_fully_drawn boolean;
  v_line_count integer := 0;
  v_result jsonb;
  v_existing jsonb;
  v_job_drawn numeric;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT role INTO v_actor_role
  FROM public.profiles
  WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  SELECT * INTO v_quote
  FROM public.quotes
  WHERE id = p_quote_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(p_idempotency_key, 'draw_down_quote');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  IF v_quote.status NOT IN ('sent', 'revised') THEN
    RAISE EXCEPTION
      'BOOKING_CLOSED: quote % is % — only sent or revised quotes can be drawn down',
      v_quote.quote_number, v_quote.status;
  END IF;

  IF p_draws IS NULL
     OR jsonb_typeof(p_draws) <> 'array'
     OR jsonb_array_length(p_draws) = 0 THEN
    RAISE EXCEPTION 'EMPTY_DRAW: no draw lines supplied';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_draws) d
    WHERE (d->>'product_id') IS NOT NULL
      AND COALESCE((d->>'quantity')::numeric, 0) > 0
  ) THEN
    RAISE EXCEPTION 'EMPTY_DRAW: no draw lines supplied';
  END IF;

  SELECT * INTO v_customer
  FROM public.customers
  WHERE id = v_quote.customer_id;

  v_order_number := public.generate_order_number();
  INSERT INTO public.orders (
    order_number, quote_id, customer_id, status, commission_split,
    total_price, total_cost, total_profit, total_margin_pct, order_date,
    program_notes
  )
  VALUES (
    v_order_number, p_quote_id, v_quote.customer_id, 'confirmed',
    v_quote.commission_split, 0, 0, 0, 0, current_date,
    (
      SELECT string_agg(qs.section_name || ': ' || qs.section_header_notes, E'\n')
      FROM public.quote_sections qs
      WHERE qs.quote_id = p_quote_id
        AND qs.section_header_notes IS NOT NULL
        AND qs.section_header_notes <> ''
    )
  )
  RETURNING id INTO v_order_id;

  UPDATE public.orders
  SET booking_draw = true
  WHERE id = v_order_id;

  FOR v_draw IN SELECT * FROM jsonb_array_elements(p_draws) LOOP
    v_product_id := (v_draw->>'product_id')::uuid;
    v_qty := COALESCE((v_draw->>'quantity')::numeric, 0);
    IF v_product_id IS NULL OR v_qty <= 0 THEN CONTINUE; END IF;

    IF EXISTS (
      SELECT 1
      FROM public.quote_items qi
      WHERE qi.quote_id = p_quote_id
        AND qi.product_id = v_product_id
        AND COALESCE(qi.total_units_needed, 0) > 0
        AND (qi.cost_at_quote_cents IS NULL OR qi.cost_at_quote_cents <= 0)
    ) THEN
      RAISE EXCEPTION 'COST_BASIS_REQUIRED:%', v_product_id;
    END IF;

    SELECT
      SUM(COALESCE(qi.total_units_needed, 0)),
      SUM(ROUND(COALESCE(qi.total_price, 0), 2)),
      CASE WHEN SUM(COALESCE(qi.total_units_needed, 0)) > 0
        THEN SUM(
          (qi.cost_at_quote_cents::numeric / 100)
          * COALESCE(qi.total_units_needed, 0)
        ) / SUM(COALESCE(qi.total_units_needed, 0))
        ELSE 0 END,
      SUM(COALESCE(qi.acres, 0)),
      MIN(qi.unit_size)
    INTO
      v_booked, v_booked_price_total, v_wavg_cost, v_total_acres, v_unit_size
    FROM public.quote_items qi
    WHERE qi.quote_id = p_quote_id
      AND qi.product_id = v_product_id;

    v_wavg_cost := ROUND(v_wavg_cost, 2);

    SELECT product_name INTO v_product_name
    FROM public.products
    WHERE id = v_product_id;

    IF v_booked IS NULL OR v_booked <= 0 THEN
      RAISE EXCEPTION
        'BOOKING_OVERDRAWN: % is not booked on this quote',
        COALESCE(v_product_name, v_product_id::text);
    END IF;

    SELECT quantity_drawn INTO v_drawn
    FROM public.quote_product_draws
    WHERE quote_id = p_quote_id
      AND product_id = v_product_id;
    v_drawn := COALESCE(v_drawn, 0);

    SELECT COALESCE(SUM(quantity_drawn), 0) INTO v_job_drawn
    FROM public.job_product_draws
    WHERE quote_id = p_quote_id
      AND product_id = v_product_id;

    v_consumed_before := v_drawn + v_job_drawn;
    v_remaining := GREATEST(v_booked - v_consumed_before, 0);
    IF v_qty > v_remaining THEN
      RAISE EXCEPTION
        'BOOKING_OVERDRAWN: %: requested %, only % remaining (booked %, already drawn %)',
        COALESCE(v_product_name, v_product_id::text),
        v_qty, v_remaining, v_booked, v_consumed_before;
    END IF;

    -- Cumulative allocation is the key invariant. For any sequence of partial
    -- draws, the deltas telescope to the booked Product total exactly.
    v_line_total :=
      ROUND(v_booked_price_total * (v_consumed_before + v_qty) / v_booked, 2)
      - ROUND(v_booked_price_total * v_consumed_before / v_booked, 2);
    v_line_cost := ROUND(v_wavg_cost * v_qty, 2);
    v_allocated_unit_price :=
      FLOOR((v_line_total / v_qty) * 100) / 100;
    v_acres := CASE WHEN v_total_acres > 0
      THEN ROUND(v_total_acres * v_qty / v_booked, 2)
      ELSE NULL END;

    v_line_count := v_line_count + 1;
    INSERT INTO public.order_items (
      order_id, product_id, product_name,
      price_per_unit, cost_per_unit, acres,
      total_units_needed, unit_size, total_price, profit, net_margin,
      quantity_delivered, quantity_remaining, sort_order, notes,
      cost_at_time_cents
    )
    VALUES (
      v_order_id, v_product_id, COALESCE(v_product_name, ''),
      v_allocated_unit_price, v_wavg_cost, v_acres,
      v_qty, v_unit_size, v_line_total, v_line_total - v_line_cost,
      CASE WHEN v_allocated_unit_price > 0
        THEN ROUND(
          ((v_allocated_unit_price - v_wavg_cost) / v_allocated_unit_price) * 100,
          2
        )
        ELSE 0 END,
      0, v_qty, v_line_count,
      'Drawn from booking ' || v_quote.quote_number,
      ROUND(v_wavg_cost * 100)::bigint
    );

    SELECT * INTO v_inv
    FROM public.inventory
    WHERE product_id = v_product_id
      AND location = 'Main Warehouse'
    FOR UPDATE;
    IF NOT FOUND THEN
      v_shortfalls := array_append(
        v_shortfalls,
        COALESCE(v_product_name, 'Unknown product') || ': need ' || v_qty
          || ', net position is 0 (no inventory record)'
      );
      INSERT INTO public.inventory (
        product_id, location, quantity_available, quantity_prebooked,
        quantity_on_order, unit_size
      )
      VALUES (v_product_id, 'Main Warehouse', 0, v_qty, 0, v_unit_size);
    ELSE
      v_net_position :=
        v_inv.quantity_available - v_inv.quantity_prebooked
        + COALESCE(v_inv.quantity_on_order, 0);
      IF v_net_position < v_qty THEN
        v_shortfalls := array_append(
          v_shortfalls,
          COALESCE(v_product_name, 'Unknown product') || ': need ' || v_qty
            || ', net position is ' || GREATEST(v_net_position, 0)
            || ' (on floor: '
            || (v_inv.quantity_available - v_inv.quantity_prebooked)
            || ', on order: ' || COALESCE(v_inv.quantity_on_order, 0) || ')'
        );
      END IF;
      UPDATE public.inventory
      SET quantity_prebooked = quantity_prebooked + v_qty,
          updated_at = now()
      WHERE product_id = v_product_id
        AND location = 'Main Warehouse';
    END IF;

    INSERT INTO public.inventory_transactions (
      product_id, transaction_type, quantity, to_location,
      order_id, performed_by, notes
    )
    VALUES (
      v_product_id, 'booked', v_qty, 'Main Warehouse',
      v_order_id, v_actor,
      'Pre-booked for order ' || v_order_number
        || ' (draw from quote ' || v_quote.quote_number || ')'
    );

    v_to_consume := v_qty;
    FOR v_hold IN
      SELECT id, quantity
      FROM public.inventory_holds
      WHERE source_id = p_quote_id
        AND product_id = v_product_id
        AND is_active = true
      ORDER BY created_at
      FOR UPDATE
    LOOP
      EXIT WHEN v_to_consume <= 0;
      IF v_hold.quantity <= v_to_consume THEN
        UPDATE public.inventory_holds
        SET quantity = 0, is_active = false, updated_at = now()
        WHERE id = v_hold.id;
        v_to_consume := v_to_consume - v_hold.quantity;
      ELSE
        UPDATE public.inventory_holds
        SET quantity = quantity - v_to_consume, updated_at = now()
        WHERE id = v_hold.id;
        v_to_consume := 0;
      END IF;
    END LOOP;

    INSERT INTO public.quote_product_draws (
      quote_id, product_id, quantity_drawn
    )
    VALUES (p_quote_id, v_product_id, v_qty)
    ON CONFLICT (quote_id, product_id)
    DO UPDATE SET
      quantity_drawn = quote_product_draws.quantity_drawn
        + EXCLUDED.quantity_drawn,
      updated_at = now();

    v_total_price := v_total_price + v_line_total;
    v_total_cost := v_total_cost + v_line_cost;
    v_lines := v_lines || jsonb_build_object(
      'product_id', v_product_id,
      'product_name', v_product_name,
      'drawn', v_qty,
      'remaining', v_remaining - v_qty
    );
  END LOOP;

  IF v_line_count = 0 THEN
    RAISE EXCEPTION 'EMPTY_DRAW: no draw lines supplied';
  END IF;

  v_total_profit := v_total_price - v_total_cost;
  v_total_margin_pct := CASE WHEN v_total_price > 0
    THEN ROUND((v_total_profit / v_total_price) * 100, 2)
    ELSE 0 END;
  UPDATE public.orders
  SET total_price = v_total_price,
      total_cost = v_total_cost,
      total_profit = v_total_profit,
      total_margin_pct = v_total_margin_pct
  WHERE id = v_order_id;

  PERFORM public._insert_commissions_for_order(
    v_order_id,
    v_quote.customer_id,
    v_total_profit,
    v_quote.commission_split,
    current_date
  );

  SELECT COALESCE(
    bool_and(COALESCE(d.quantity_drawn, 0) >= b.booked),
    true
  ) INTO v_fully_drawn
  FROM (
    SELECT product_id, SUM(COALESCE(total_units_needed, 0)) AS booked
    FROM public.quote_items
    WHERE quote_id = p_quote_id
    GROUP BY product_id
  ) b
  LEFT JOIN public.quote_product_draws d
    ON d.quote_id = p_quote_id
   AND d.product_id = b.product_id
  WHERE b.booked > 0;

  IF v_fully_drawn THEN
    UPDATE public.quotes
    SET status = 'accepted', updated_at = now()
    WHERE id = p_quote_id;
  ELSE
    UPDATE public.quotes
    SET updated_at = now()
    WHERE id = p_quote_id;
  END IF;

  INSERT INTO public.financial_audit_log (
    operation_type, entity_type, entity_id, actor_role, new_values,
    total_impact_cents, description
  )
  VALUES (
    'quote_converted', 'order', v_order_id, v_actor_role,
    jsonb_build_object(
      'quote_id', p_quote_id,
      'quote_number', v_quote.quote_number,
      'order_number', v_order_number,
      'customer_id', v_quote.customer_id,
      'customer_name', COALESCE(v_customer.farm_name, 'unknown'),
      'total_price_dollars', v_total_price,
      'booking_draw', true,
      'fully_drawn', v_fully_drawn,
      'lines', v_lines,
      'inventory_warnings', to_jsonb(v_shortfalls)
    ),
    ROUND(v_total_price * 100)::bigint,
    'Drew down quote ' || v_quote.quote_number || ' to order ' || v_order_number
      || ' for ' || COALESCE(v_customer.farm_name, 'customer')
      || CASE WHEN v_fully_drawn
        THEN ' (booking now fully drawn)'
        ELSE ' (partial draw — booking stays open)' END
      || CASE WHEN array_length(v_shortfalls, 1) > 0
        THEN ' (inventory shortfalls: '
          || array_to_string(v_shortfalls, '; ') || ')'
        ELSE '' END
  );

  INSERT INTO public.activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  )
  VALUES (
    'order_created',
    'Order ' || v_order_number || ' created from booking '
      || v_quote.quote_number || ' for '
      || COALESCE(v_customer.farm_name, 'customer')
      || CASE WHEN v_fully_drawn
        THEN ' — booking fully drawn'
        ELSE ' — partial draw' END,
    v_actor, 'order', v_order_id, v_quote.customer_id
  );

  v_result := jsonb_build_object(
    'success', true,
    'status', 'created',
    'order_id', v_order_id,
    'order_number', v_order_number,
    'warnings', to_jsonb(v_shortfalls),
    'fully_drawn', v_fully_drawn,
    'lines', v_lines
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(
      p_idempotency_key,
      'draw_down_quote',
      v_result
    );
  END IF;

  RETURN v_result;
END;
$function$;

-- The implementation remains private. CREATE OR REPLACE preserves the prior
-- ACL, and this explicit revoke makes the contract fail closed on rebuilds.
REVOKE ALL ON FUNCTION public._draw_down_quote_below_cost_impl_20260810(
  uuid, jsonb, uuid, text
) FROM PUBLIC, anon, authenticated, service_role;

DO $postflight$
DECLARE
  v_impl_count integer;
  v_wrapper_count integer;
BEGIN
  SELECT count(*) INTO v_impl_count
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname = '_draw_down_quote_below_cost_impl_20260810'
    AND p.proargtypes = '2950 3802 2950 25'::oidvector
    AND p.prosecdef
    AND p.proconfig @> ARRAY['search_path=public, pg_temp']::text[]
    AND position('v_booked_price_total' IN p.prosrc) > 0
    AND position('v_consumed_before' IN p.prosrc) > 0;

  SELECT count(*) INTO v_wrapper_count
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname = 'draw_down_quote'
    AND p.proargtypes = '2950 3802 2950 25 25'::oidvector
    AND p.prosecdef
    AND p.proconfig @> ARRAY['search_path=public, pg_temp']::text[]
    AND position('_draw_down_quote_below_cost_impl_20260810' IN p.prosrc) > 0;

  IF v_impl_count <> 1 OR v_wrapper_count <> 1 THEN
    RAISE EXCEPTION
      'DRAW_DOWN_CENT_ALLOCATION_POSTFLIGHT_FAILED: impl %, wrapper %',
      v_impl_count, v_wrapper_count;
  END IF;

  IF EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc p
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
       ) acl
       WHERE p.oid =
         'public._draw_down_quote_below_cost_impl_20260810(uuid,jsonb,uuid,text)'::regprocedure
         AND acl.grantee = 0
         AND acl.privilege_type = 'EXECUTE'
     )
     OR has_function_privilege(
       'anon',
       'public._draw_down_quote_below_cost_impl_20260810(uuid,jsonb,uuid,text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public._draw_down_quote_below_cost_impl_20260810(uuid,jsonb,uuid,text)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public._draw_down_quote_below_cost_impl_20260810(uuid,jsonb,uuid,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'DRAW_DOWN_CENT_ALLOCATION_IMPL_ACL_DRIFT';
  END IF;
END
$postflight$;
