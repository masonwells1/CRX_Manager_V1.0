-- Restrict partial quote draw-down to the quote owner (or an active admin).
--
-- STATUS: NOT APPLIED
-- LOCAL CANDIDATE.
--
-- The applied draw-down implementation authenticated active admins and sales
-- reps but did not bind sales reps to quotes.created_by and did not reject a
-- soft-deleted quote. Because quotes are broadly readable, an authenticated
-- sales rep could otherwise invoke the SECURITY DEFINER public wrapper against
-- another rep's sent/revised quote or a deleted booking.
--
-- This forward-only migration changes only the private implementation behind
-- the governed five-argument public wrapper: it adds the ownership/deletion
-- guard and settles both weighted money inputs to whole cents before deriving
-- the order line. It preserves the public signature,
-- below-cost approval context, idempotency ordering, inventory/order behavior,
-- grants, and generated TypeScript contract. Both new checks execute after the
-- existing quote row lock and before any idempotency result can be returned or
-- any business row can be written.
-- Historical quotes whose created_by is NULL remain admin-only: the ownership
-- comparison uses IS DISTINCT FROM, so no sales representative can inherit an
-- ownerless booking by accident. No live sent/revised row is backfilled here.
--
-- Supabase apply_migration owns the outer transaction. Do not add BEGIN/COMMIT:
-- the body replacement, ACL assertions, and ledger stamp must remain atomic.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
DECLARE
  v_impl regprocedure := to_regprocedure(
    'public._draw_down_quote_below_cost_impl_20260810(uuid,jsonb,uuid,text)'
  );
  v_wrapper regprocedure := to_regprocedure(
    'public.draw_down_quote(uuid,jsonb,uuid,text,text)'
  );
  v_impl_acl aclitem[];
BEGIN
  IF v_impl IS NULL OR v_wrapper IS NULL THEN
    RAISE EXCEPTION 'DRAW_DOWN_OWNER_GUARD_DRIFT: expected wrapper chain is incomplete';
  END IF;

  IF (SELECT count(*) FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
        AND proname = '_draw_down_quote_below_cost_impl_20260810') <> 1
     OR (SELECT count(*) FROM pg_proc
         WHERE pronamespace = 'public'::regnamespace
           AND proname = 'draw_down_quote') <> 1 THEN
    RAISE EXCEPTION 'DRAW_DOWN_OWNER_GUARD_DRIFT: unexpected overload set';
  END IF;

  SELECT p.proacl INTO v_impl_acl
  FROM pg_proc p
  WHERE p.oid = v_impl;

  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = v_impl)
       <> '87bf7adcdc63d94684676da5ab09bfde'
     OR NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_impl)
     OR (SELECT p.proconfig FROM pg_proc p WHERE p.oid = v_impl)
       IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR (SELECT p.proowner FROM pg_proc p WHERE p.oid = v_impl)
       <> 'postgres'::regrole THEN
    RAISE EXCEPTION 'DRAW_DOWN_OWNER_GUARD_DRIFT: private implementation changed';
  END IF;

  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = v_wrapper)
       <> '970960d8490b63b972bc8c60fe207a5b'
     OR NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_wrapper)
     OR (SELECT p.proconfig FROM pg_proc p WHERE p.oid = v_wrapper)
       IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[] THEN
    RAISE EXCEPTION 'DRAW_DOWN_OWNER_GUARD_DRIFT: public wrapper changed';
  END IF;

  IF has_function_privilege('anon', v_impl, 'EXECUTE')
     OR has_function_privilege('authenticated', v_impl, 'EXECUTE')
     OR has_function_privilege('service_role', v_impl, 'EXECUTE')
     OR NOT has_function_privilege('postgres', v_impl, 'EXECUTE')
     OR EXISTS (
       SELECT 1
       FROM aclexplode(COALESCE(v_impl_acl, acldefault('f', 'postgres'::regrole))) a
       WHERE a.grantee = 0
         AND a.privilege_type = 'EXECUTE'
     )
     OR has_function_privilege('anon', v_wrapper, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_wrapper, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_wrapper, 'EXECUTE') THEN
    RAISE EXCEPTION 'DRAW_DOWN_OWNER_GUARD_DRIFT: wrapper ACL changed';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public._draw_down_quote_below_cost_impl_20260810(p_quote_id uuid, p_draws jsonb, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
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
  v_drawn numeric;
  v_remaining numeric;
  v_wavg_price numeric;
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
  v_shortfalls text[] := '{}';
  v_lines jsonb := '[]'::jsonb;
  v_hold record;
  v_to_consume numeric;
  v_fully_drawn boolean;
  v_line_count integer := 0;
  v_result jsonb;
  v_existing jsonb;
  -- LAYER2<<< job reservations consumed against this quote (§6.5)
  v_job_drawn numeric;
  -- >>>LAYER2
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT role INTO v_actor_role
  FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  -- Lock the quote: serializes concurrent draws on the same booking.
  SELECT * INTO v_quote FROM quotes WHERE id = p_quote_id FOR UPDATE;
  IF NOT FOUND OR v_quote.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Quote not found';
  END IF;
  IF v_actor_role <> 'admin' AND v_quote.created_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'NOT_QUOTE_OWNER';
  END IF;
  -- Idempotency check AFTER the lock (2026-06-10 HIGH fix): the row lock
  -- serializes same-key duplicates so the non-atomic check/save pair cannot
  -- both pass. Kept BEFORE the status guard so a retry of the final draw
  -- (which flips status to 'accepted') returns the cached result rather than
  -- BOOKING_CLOSED.
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'draw_down_quote');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  IF v_quote.status NOT IN ('sent', 'revised') THEN
    RAISE EXCEPTION 'BOOKING_CLOSED: quote % is % — only sent or revised quotes can be drawn down', v_quote.quote_number, v_quote.status;
  END IF;

  IF p_draws IS NULL OR jsonb_typeof(p_draws) <> 'array' OR jsonb_array_length(p_draws) = 0 THEN
    RAISE EXCEPTION 'EMPTY_DRAW: no draw lines supplied';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_draws) d
    WHERE (d->>'product_id') IS NOT NULL AND COALESCE((d->>'quantity')::numeric, 0) > 0
  ) THEN
    RAISE EXCEPTION 'EMPTY_DRAW: no draw lines supplied';
  END IF;

  SELECT * INTO v_customer FROM customers WHERE id = v_quote.customer_id;

  v_order_number := generate_order_number();
  INSERT INTO orders (order_number, quote_id, customer_id, status, commission_split,
    total_price, total_cost, total_profit, total_margin_pct, order_date, program_notes)
  VALUES (v_order_number, p_quote_id, v_quote.customer_id, 'confirmed',
    v_quote.commission_split, 0, 0, 0, 0, current_date,
    (SELECT string_agg(qs.section_name || ': ' || qs.section_header_notes, E'\n')
     FROM quote_sections qs WHERE qs.quote_id = p_quote_id
       AND qs.section_header_notes IS NOT NULL AND qs.section_header_notes <> ''))
  RETURNING id INTO v_order_id;
  -- A3<<< mark this order as a booking draw so void_order/cancel_order know
  -- to reverse the quote_product_draws ledger (20260610190000). Kept as a
  -- separate statement (not folded into the INSERT) so the body above stays
  -- byte-identical to the live baseline.
  UPDATE orders SET booking_draw = true WHERE id = v_order_id;
  -- >>>A3

  FOR v_draw IN SELECT * FROM jsonb_array_elements(p_draws) LOOP
    v_product_id := (v_draw->>'product_id')::uuid;
    v_qty := COALESCE((v_draw->>'quantity')::numeric, 0);
    IF v_product_id IS NULL OR v_qty <= 0 THEN CONTINUE; END IF;

    IF EXISTS (
      SELECT 1
      FROM quote_items qi
      WHERE qi.quote_id = p_quote_id
        AND qi.product_id = v_product_id
        AND COALESCE(qi.total_units_needed, 0) > 0
        AND (qi.cost_at_quote_cents IS NULL OR qi.cost_at_quote_cents <= 0)
    ) THEN
      RAISE EXCEPTION 'COST_BASIS_REQUIRED:%', v_product_id;
    END IF;

    -- Per-product booking balance (locked quote => stable within this txn)
    SELECT
      SUM(COALESCE(qi.total_units_needed, 0)),
      CASE WHEN SUM(COALESCE(qi.total_units_needed, 0)) > 0
        THEN SUM(qi.price_per_unit * COALESCE(qi.total_units_needed, 0)) / SUM(COALESCE(qi.total_units_needed, 0))
        ELSE 0 END,
      CASE WHEN SUM(COALESCE(qi.total_units_needed, 0)) > 0
        THEN SUM((qi.cost_at_quote_cents::numeric / 100) * COALESCE(qi.total_units_needed, 0)) / SUM(COALESCE(qi.total_units_needed, 0))
        ELSE 0 END,
      SUM(COALESCE(qi.acres, 0)),
      MIN(qi.unit_size)
    INTO v_booked, v_wavg_price, v_wavg_cost, v_total_acres, v_unit_size
    FROM quote_items qi
    WHERE qi.quote_id = p_quote_id AND qi.product_id = v_product_id;

    -- SNAPSHOT<<< settle both weighted money inputs to whole cents ONCE, here,
    -- before anything derives from them. Several quote lines of one product can
    -- average to fractional cents. The order_items invariant rejects a
    -- fractional price_per_unit, and leaving either input unsettled would make
    -- line totals, profit, commissions and reports use different bases.
    v_wavg_price := ROUND(v_wavg_price, 2);
    v_wavg_cost := ROUND(v_wavg_cost, 2);
    -- >>>SNAPSHOT

    SELECT product_name INTO v_product_name FROM products WHERE id = v_product_id;

    IF v_booked IS NULL OR v_booked <= 0 THEN
      RAISE EXCEPTION 'BOOKING_OVERDRAWN: % is not booked on this quote', COALESCE(v_product_name, v_product_id::text);
    END IF;

    SELECT quantity_drawn INTO v_drawn
    FROM quote_product_draws
    WHERE quote_id = p_quote_id AND product_id = v_product_id;
    v_drawn := COALESCE(v_drawn, 0);
    -- LAYER2<<< job reservations also consume the booking (§6.5): subtract live
    -- job draws so demand a job already reserved can't be re-drawn to an order
    -- (no double-fulfilment via transfer_job_to_invoice + a later order draw).
    SELECT COALESCE(SUM(quantity_drawn), 0) INTO v_job_drawn
    FROM job_product_draws
    WHERE quote_id = p_quote_id AND product_id = v_product_id;
    v_remaining := GREATEST(v_booked - v_drawn - v_job_drawn, 0);
    IF v_qty > v_remaining THEN
      RAISE EXCEPTION 'BOOKING_OVERDRAWN: %: requested %, only % remaining (booked %, already drawn %)',
        COALESCE(v_product_name, v_product_id::text), v_qty, v_remaining, v_booked, (v_drawn + v_job_drawn);
    END IF;
    -- >>>LAYER2  (baseline: v_remaining := GREATEST(v_booked - v_drawn, 0); and
    -- the message's last arg was v_drawn — text is unchanged, only the value.)

    v_line_count := v_line_count + 1;
    v_line_total := ROUND(v_wavg_price * v_qty, 2);
    v_line_cost := ROUND(v_wavg_cost * v_qty, 2);
    v_acres := CASE WHEN v_total_acres > 0 THEN ROUND(v_total_acres * v_qty / v_booked, 2) ELSE NULL END;

    INSERT INTO order_items (order_id, product_id, product_name,
      price_per_unit, cost_per_unit, acres,
      total_units_needed, unit_size, total_price, profit, net_margin,
      quantity_delivered, quantity_remaining, sort_order, notes,
      cost_at_time_cents -- SNAPSHOT
      )
    VALUES (v_order_id, v_product_id, COALESCE(v_product_name, ''),
      v_wavg_price, v_wavg_cost, v_acres,
      v_qty, v_unit_size, v_line_total, v_line_total - v_line_cost,
      CASE WHEN v_wavg_price > 0 THEN ROUND(((v_wavg_price - v_wavg_cost) / v_wavg_price) * 100, 2) ELSE 0 END,
      0, v_qty, v_line_count,
      'Drawn from booking ' || v_quote.quote_number,
      -- SNAPSHOT: a partial draw is a conversion too. v_wavg_cost is the
      -- quote-time basis, already settled to whole cents above, so every derived
      -- figure and this stamp share one value. Without the stamp the row inserts
      -- with a NULL cost_at_time_cents and trg_snapshot_order_item_cost writes
      -- TODAY's catalog cost, splitting the reports from the order totals, line
      -- profit and commissions. Unknown historical cost is rejected above; it
      -- must never be converted into a real zero-cost order line.
      ROUND(v_wavg_cost * 100)::bigint);

    -- Inventory: warn (never block) on net position, then prebook the draw
    SELECT * INTO v_inv FROM inventory
    WHERE product_id = v_product_id AND location = 'Main Warehouse' FOR UPDATE;
    IF NOT FOUND THEN
      v_shortfalls := array_append(v_shortfalls,
        COALESCE(v_product_name, 'Unknown product') || ': need ' || v_qty || ', net position is 0 (no inventory record)');
      INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order, unit_size)
      VALUES (v_product_id, 'Main Warehouse', 0, v_qty, 0, v_unit_size);
    ELSE
      v_net_position := v_inv.quantity_available - v_inv.quantity_prebooked + COALESCE(v_inv.quantity_on_order, 0);
      IF v_net_position < v_qty THEN
        v_shortfalls := array_append(v_shortfalls,
          COALESCE(v_product_name, 'Unknown product') || ': need ' || v_qty ||
          ', net position is ' || GREATEST(v_net_position, 0) ||
          ' (on floor: ' || (v_inv.quantity_available - v_inv.quantity_prebooked) ||
          ', on order: ' || COALESCE(v_inv.quantity_on_order, 0) || ')');
      END IF;
      UPDATE inventory SET quantity_prebooked = quantity_prebooked + v_qty, updated_at = now()
      WHERE product_id = v_product_id AND location = 'Main Warehouse';
    END IF;

    INSERT INTO inventory_transactions (product_id, transaction_type, quantity, to_location,
      order_id, performed_by, notes)
    VALUES (v_product_id, 'booked', v_qty, 'Main Warehouse',
      v_order_id, v_actor, 'Pre-booked for order ' || v_order_number || ' (draw from quote ' || v_quote.quote_number || ')');

    -- Move the drawn quantity out of this quote's active holds (FIFO).
    -- Net Free = available − holds − prebooked stays constant: the quantity
    -- leaves the hold bucket and enters the prebooked bucket.
    v_to_consume := v_qty;
    FOR v_hold IN
      SELECT id, quantity FROM inventory_holds
      WHERE source_id = p_quote_id AND product_id = v_product_id AND is_active = true
      ORDER BY created_at
      FOR UPDATE
    LOOP
      EXIT WHEN v_to_consume <= 0;
      IF v_hold.quantity <= v_to_consume THEN
        UPDATE inventory_holds SET quantity = 0, is_active = false, updated_at = now()
        WHERE id = v_hold.id;
        v_to_consume := v_to_consume - v_hold.quantity;
      ELSE
        UPDATE inventory_holds SET quantity = quantity - v_to_consume, updated_at = now()
        WHERE id = v_hold.id;
        v_to_consume := 0;
      END IF;
    END LOOP;

    -- Ledger: record the draw
    INSERT INTO quote_product_draws (quote_id, product_id, quantity_drawn)
    VALUES (p_quote_id, v_product_id, v_qty)
    ON CONFLICT (quote_id, product_id)
    DO UPDATE SET quantity_drawn = quote_product_draws.quantity_drawn + EXCLUDED.quantity_drawn,
                  updated_at = now();

    v_total_price := v_total_price + v_line_total;
    v_total_cost := v_total_cost + v_line_cost;
    v_lines := v_lines || jsonb_build_object(
      'product_id', v_product_id,
      'product_name', v_product_name,
      'drawn', v_qty,
      'remaining', v_remaining - v_qty);
  END LOOP;

  IF v_line_count = 0 THEN
    RAISE EXCEPTION 'EMPTY_DRAW: no draw lines supplied';
  END IF;

  v_total_profit := v_total_price - v_total_cost;
  v_total_margin_pct := CASE WHEN v_total_price > 0 THEN ROUND((v_total_profit / v_total_price) * 100, 2) ELSE 0 END;
  UPDATE orders SET total_price = v_total_price, total_cost = v_total_cost,
    total_profit = v_total_profit, total_margin_pct = v_total_margin_pct
  WHERE id = v_order_id;

  PERFORM _insert_commissions_for_order(
    v_order_id, v_quote.customer_id, v_total_profit,
    v_quote.commission_split, current_date
  );

  -- Fully drawn? Then the booking closes as 'accepted' (enforcer-legal from
  -- sent/revised) and the hold-release trigger clears any leftover holds.
  -- LAYER2 NOTE: this stays on ORDER draws only (quote_product_draws) by design
  -- — job draws are reversible, so letting them flip status to 'accepted' would
  -- require un-accepting on job cancel (a quote-lifecycle change out of scope).
  SELECT COALESCE(bool_and(COALESCE(d.quantity_drawn, 0) >= b.booked), true) INTO v_fully_drawn
  FROM (
    SELECT product_id, SUM(COALESCE(total_units_needed, 0)) AS booked
    FROM quote_items WHERE quote_id = p_quote_id
    GROUP BY product_id
  ) b
  LEFT JOIN quote_product_draws d
    ON d.quote_id = p_quote_id AND d.product_id = b.product_id
  WHERE b.booked > 0;

  IF v_fully_drawn THEN
    UPDATE quotes SET status = 'accepted', updated_at = now() WHERE id = p_quote_id;
  ELSE
    UPDATE quotes SET updated_at = now() WHERE id = p_quote_id;
  END IF;

  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, new_values, total_impact_cents, description)
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
    'Drew down quote ' || v_quote.quote_number || ' to order ' || v_order_number ||
      ' for ' || COALESCE(v_customer.farm_name, 'customer') ||
      CASE WHEN v_fully_drawn THEN ' (booking now fully drawn)' ELSE ' (partial draw — booking stays open)' END ||
      CASE WHEN array_length(v_shortfalls, 1) > 0
        THEN ' (inventory shortfalls: ' || array_to_string(v_shortfalls, '; ') || ')'
        ELSE '' END
  );

  INSERT INTO activity_feed (event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id)
  VALUES ('order_created',
    'Order ' || v_order_number || ' created from booking ' || v_quote.quote_number ||
    ' for ' || COALESCE(v_customer.farm_name, 'customer') ||
    CASE WHEN v_fully_drawn THEN ' — booking fully drawn' ELSE ' — partial draw' END,
    v_actor, 'order', v_order_id, v_quote.customer_id);

  v_result := jsonb_build_object(
    'success', true, 'status', 'created',
    'order_id', v_order_id, 'order_number', v_order_number,
    'warnings', to_jsonb(v_shortfalls),
    'fully_drawn', v_fully_drawn,
    'lines', v_lines);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'draw_down_quote', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public._draw_down_quote_below_cost_impl_20260810(
  uuid, jsonb, uuid, text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._draw_down_quote_below_cost_impl_20260810(
  uuid, jsonb, uuid, text
) TO postgres;

DO $postflight$
DECLARE
  v_impl regprocedure := to_regprocedure(
    'public._draw_down_quote_below_cost_impl_20260810(uuid,jsonb,uuid,text)'
  );
  v_wrapper regprocedure := to_regprocedure(
    'public.draw_down_quote(uuid,jsonb,uuid,text,text)'
  );
  v_impl_acl aclitem[];
  v_impl_source text;
BEGIN
  SELECT p.proacl, p.prosrc INTO v_impl_acl, v_impl_source
  FROM pg_proc p
  WHERE p.oid = v_impl;

  IF v_impl IS NULL
     OR v_wrapper IS NULL
     OR md5(v_impl_source) <> '2ff7a345a555b1cdeee16a890bb65034'
     OR position('v_quote.deleted_at IS NOT NULL' in v_impl_source) = 0
     OR position('v_quote.created_by IS DISTINCT FROM v_actor' in v_impl_source) = 0
     OR position('NOT_QUOTE_OWNER' in v_impl_source) = 0
     OR position('v_quote.deleted_at IS NOT NULL' in v_impl_source)
        > position('check_idempotency' in v_impl_source)
     OR position('v_quote.created_by IS DISTINCT FROM v_actor' in v_impl_source)
        > position('check_idempotency' in v_impl_source)
     OR NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_impl)
     OR (SELECT p.proconfig FROM pg_proc p WHERE p.oid = v_impl)
       IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR (SELECT p.proowner FROM pg_proc p WHERE p.oid = v_impl)
       <> 'postgres'::regrole THEN
    RAISE EXCEPTION 'DRAW_DOWN_OWNER_GUARD_POSTCONDITION_FAILED: private implementation drifted';
  END IF;

  IF has_function_privilege('anon', v_impl, 'EXECUTE')
     OR has_function_privilege('authenticated', v_impl, 'EXECUTE')
     OR has_function_privilege('service_role', v_impl, 'EXECUTE')
     OR NOT has_function_privilege('postgres', v_impl, 'EXECUTE')
     OR EXISTS (
       SELECT 1
       FROM aclexplode(COALESCE(v_impl_acl, acldefault('f', 'postgres'::regrole))) a
       WHERE a.grantee = 0
         AND a.privilege_type = 'EXECUTE'
     )
     OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = v_wrapper)
       <> '970960d8490b63b972bc8c60fe207a5b'
     OR has_function_privilege('anon', v_wrapper, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_wrapper, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_wrapper, 'EXECUTE') THEN
    RAISE EXCEPTION 'DRAW_DOWN_OWNER_GUARD_POSTCONDITION_FAILED: wrapper boundary changed';
  END IF;
END;
$postflight$;
