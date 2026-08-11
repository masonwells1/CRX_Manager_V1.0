-- Blend-ticket order creation: let the canonical trigger own the order header
--
-- 20260810151000 added VALIDATED whole-cent CHECK constraints to
-- orders.total_cost and orders.total_profit. create_order_from_blend_ticket
-- ended by overwriting the order header with raw, unrounded
-- price x converted-quantity sums, so any blend ticket whose unit conversion
-- produced a fractional quantity (e.g. quantity 1.5, price 10.01, cost 5.00 ->
-- profit 7.515) was rejected by those constraints and the entire
-- completed-ticket -> order transaction rolled back. No production blend
-- ticket exists yet, so no order was ever lost: the defect is latent, not
-- historical.
--
-- Scope of the failure, verified against live: the per-line INSERT is NOT
-- affected. order_items.profit is the only constrained line column, and the
-- BEFORE-ROW trigger trg_order_items_round_money (_round_money_to_whole_cents)
-- DERIVES it as ROUND(total_price,2) - ROUND(cost_per_unit * total_units_needed, 2),
-- discarding whatever the caller passed. order_items.total_price and
-- net_margin carry no whole-cent constraint. Only the two orders columns in
-- the removed UPDATE could ever violate a constraint, so only that statement
-- is touched here.
--
-- Re-emitted from 20260714230200 (body md5-matched against the live function
-- before editing) with exactly two deltas:
--   1. The raw header overwrite is removed. The AFTER-ROW trigger
--      after_order_items_change (trg_recalc_order_totals) has already written
--      all four header columns from the per-line values, rounding on the way
--      in, which is what satisfies the new constraints. The header is now read
--      back so the returned total is the value actually stored.
--   2. The two hand-maintained running totals that fed only that removed
--      UPDATE are dropped as dead code, along with the now-unused v_total_cost
--      declaration.
-- Per-line money, actor binding, idempotency, SECURITY DEFINER, search_path
-- and grants are unchanged.

CREATE OR REPLACE FUNCTION public.create_order_from_blend_ticket(p_blend_ticket_id uuid, p_order_number text, p_order_date date DEFAULT CURRENT_DATE, p_notes text DEFAULT NULL::text, p_performed_by uuid DEFAULT auth.uid(), p_idempotency_key text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor       uuid := auth.uid();
  v_ticket      blend_tickets%ROWTYPE;
  v_order_id    uuid;
  v_customer    customers%ROWTYPE;
  v_product     blend_ticket_products%ROWTYPE;
  v_db_product  products%ROWTYPE;
  v_item_id     uuid;
  v_tier        int;
  v_price       numeric;
  v_cost        numeric;
  v_total_price numeric := 0;
  v_item_count  int := 0;
  v_invalid_count int;
  v_link_result json;
  v_cached      jsonb;
  v_result      jsonb;
  -- A5: quantity converted to the product's inventory unit + the unit label to store
  v_qty_conv    numeric;
  v_unit_out    text;
  -- Per-blend-line mappings retain the ticket quantity/unit truth. The order
  -- line and inventory transaction may use a converted inventory-unit value.
  v_mappings    jsonb := '[]'::jsonb;
BEGIN
  -- A5-actor: reject a forged actor / non-admin up front, mirroring the two sibling
  -- blend-ticket RPCs (create_invoice_/create_application_record_from_blend_ticket).
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: admin or sales role required to create orders from blend tickets';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_cached := check_idempotency(p_idempotency_key, 'create_order_from_blend_ticket');
    IF v_cached IS NOT NULL THEN
      RETURN v_cached::json;
    END IF;
  END IF;

  SELECT * INTO v_ticket FROM blend_tickets WHERE id = p_blend_ticket_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket not found');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.invoices
     WHERE blend_ticket_id = p_blend_ticket_id
       AND deleted_at IS NULL
       AND COALESCE(status, '') NOT IN ('voided', 'cancelled')
  ) THEN
    RAISE EXCEPTION 'BLEND_TICKET_ACTIVE_INVOICE_ORDER_LOCKED';
  END IF;
  IF v_ticket.order_link_status = 'linked' THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket is already linked to an order');
  END IF;
  IF v_ticket.customer_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket has no customer assigned');
  END IF;
  IF v_ticket.status <> 'completed' OR v_ticket.review_status <> 'approved' THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket must be completed and approved before creating an order');
  END IF;
  IF v_ticket.payment_status <> 'unbilled' THEN
    RETURN json_build_object('success', false, 'error', 'Only an unbilled blend ticket can create an order');
  END IF;

  SELECT count(*) FILTER (
           WHERE btp.product_id IS NULL
              OR btp.quantity <= 0
              OR btp.quantity::text IN ('NaN', 'Infinity', '-Infinity')
              OR p.id IS NULL
              OR p.is_active IS DISTINCT FROM true
         )
    INTO v_invalid_count
    FROM blend_ticket_products btp
    LEFT JOIN products p ON p.id = btp.product_id
   WHERE btp.blend_ticket_id = p_blend_ticket_id;

  IF NOT EXISTS (
    SELECT 1 FROM blend_ticket_products
     WHERE blend_ticket_id = p_blend_ticket_id
  ) THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket has no products');
  END IF;
  IF v_invalid_count > 0 THEN
    RETURN json_build_object('success', false, 'error', 'Every blend-ticket product must be matched to an active catalog product with a positive quantity');
  END IF;

  SELECT * INTO v_customer FROM customers WHERE id = v_ticket.customer_id AND is_active = true;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Customer not found');
  END IF;
  v_tier := COALESCE(v_customer.assigned_tier, 1);

  -- CHANGED: Removed total_paid and balance_due from INSERT (AR tracked via invoices)
  v_order_id := gen_random_uuid();
  INSERT INTO orders (id, order_number, customer_id, status, order_date, notes, season, salesman_id, total_price, total_cost, total_profit, total_margin_pct)
  VALUES (
    v_order_id,
    p_order_number,
    v_ticket.customer_id,
    'confirmed',
    p_order_date,
    COALESCE(p_notes, 'Created from blend ticket ' || v_ticket.ticket_number),
    v_ticket.season,
    v_ticket.salesman_id,
    0, 0, 0, 0
  );

  FOR v_product IN
    SELECT * FROM blend_ticket_products
    WHERE blend_ticket_id = p_blend_ticket_id
    ORDER BY sequence_order
  LOOP
    v_price := 0;
    v_cost := 0;
    -- A5: default for an unmatched product (no product row) — no price, no conversion.
    v_qty_conv := v_product.quantity;
    v_unit_out := COALESCE(v_product.unit, 'ea');

    IF v_product.product_id IS NOT NULL THEN
      SELECT * INTO v_db_product FROM products WHERE id = v_product.product_id;
      IF FOUND THEN
        v_price := CASE v_tier
          WHEN 1 THEN COALESCE(v_db_product.tier1_price, 0)
          WHEN 2 THEN COALESCE(v_db_product.tier2_price, 0)
          WHEN 3 THEN COALESCE(v_db_product.tier3_price, 0)
          ELSE COALESCE(v_db_product.tier1_price, 0)
        END;
        v_cost := COALESCE(v_db_product.current_cost, 0);
        -- A5: convert the stored quantity (in v_product.unit) to the inventory unit
        -- so total_price, prebook, and the inventory txn all use the pricing/stock unit.
        v_qty_conv := field_app_priced_quantity(
                        v_product.quantity,
                        normalize_rate_unit(NULLIF(btrim(v_product.unit), '')),
                        normalize_rate_unit(COALESCE(NULLIF(btrim(v_db_product.inventory_unit), ''), v_db_product.unit_size)),
                        v_db_product.product_form);
        IF v_qty_conv IS NULL
           OR v_qty_conv <= 0
           OR v_qty_conv::text IN ('NaN', 'Infinity', '-Infinity') THEN
          RAISE EXCEPTION 'BLEND_TICKET_UNIT_UNCONVERTIBLE: product % quantity unit "%" cannot convert to inventory unit "%"',
            v_product.product_name, v_product.unit, COALESCE(v_db_product.inventory_unit, v_db_product.unit_size);
        END IF;
        v_unit_out := COALESCE(NULLIF(btrim(v_db_product.inventory_unit), ''), v_db_product.unit_size, v_product.unit, 'ea');
      END IF;
    END IF;

    v_item_id := gen_random_uuid();
    INSERT INTO order_items (
      id, order_id, product_id, product_name, price_per_unit, cost_per_unit,
      actual_rate, rate_unit, acres, total_units_needed, unit_size,
      total_price, profit, net_margin, quantity_delivered, quantity_remaining, sort_order
    )
    VALUES (
      v_item_id,
      v_order_id,
      v_product.product_id,
      v_product.product_name,
      v_price,
      v_cost,
      v_product.rate_per_acre,
      v_product.rate_per_acre_unit,
      v_ticket.total_acres,
      v_qty_conv,
      v_unit_out,
      v_price * v_qty_conv,
      (v_price - v_cost) * v_qty_conv,
      CASE WHEN v_price > 0 THEN ((v_price - v_cost) / v_price * 100) ELSE 0 END,
      0,
      v_qty_conv,
      v_product.sequence_order
    );

    -- Preserve exact blend-line identity and source quantity for link validation.
    IF v_product.product_id IS NOT NULL THEN
      v_mappings := v_mappings || jsonb_build_object(
        'blend_product_id', v_product.id,
        'order_item_id', v_item_id,
        'quantity_applied', v_product.quantity
      );
    END IF;

    IF v_product.product_id IS NOT NULL AND v_qty_conv > 0 THEN
      INSERT INTO inventory (
        product_id, location, quantity_available,
        quantity_prebooked, quantity_on_order, unit_size, updated_at
      ) VALUES (
        v_product.product_id, 'Main Warehouse', 0,
        v_qty_conv, 0, v_unit_out, now()
      )
      ON CONFLICT (product_id, location) DO UPDATE
        SET quantity_prebooked = COALESCE(inventory.quantity_prebooked, 0)
                                 + EXCLUDED.quantity_prebooked,
            updated_at = now();

      INSERT INTO inventory_transactions (
        product_id, transaction_type, quantity, to_location,
        order_id, performed_by, notes
      ) VALUES (
        v_product.product_id, 'booked', v_qty_conv, 'Main Warehouse',
        v_order_id, p_performed_by,
        'Prebooked for blend ticket order ' || p_order_number
      );
    END IF;

    v_item_count := v_item_count + 1;
  END LOOP;

  -- DELTA 1 (was: a raw UPDATE of the four orders header columns from
  -- unrounded price x quantity sums, which the whole-cent constraints reject).
  -- after_order_items_change / trg_recalc_order_totals has already written all
  -- four columns from the per-line values, rounding each on the way in. Read
  -- the canonical header back so the returned total is what is stored. Every
  -- reachable path here has inserted at least one order_items row -- the
  -- no-products case returned early above -- so the trigger has fired.
  SELECT COALESCE(o.total_price, 0) INTO v_total_price
  FROM orders o
  WHERE o.id = v_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_HEADER_UNREADABLE';
  END IF;

  v_link_result := link_blend_ticket_to_order(p_blend_ticket_id, v_order_id, v_mappings, p_performed_by);
  IF COALESCE((v_link_result->>'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'BLEND_TICKET_ORDER_LINK_FAILED: %', COALESCE(v_link_result->>'error', 'unknown link failure');
  END IF;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
  VALUES (
    'order_created_from_blend_ticket',
    'Order ' || p_order_number || ' created from blend ticket ' || v_ticket.ticket_number,
    p_performed_by,
    'order',
    v_order_id
  );

  v_result := jsonb_build_object(
     'success', true,
     'order_id', v_order_id,
     'order_number', p_order_number,
     'items_created', v_item_count,
     'total_price', v_total_price
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(
      p_idempotency_key,
      'create_order_from_blend_ticket',
      v_result
    );
  END IF;

  RETURN v_result::json;
END;
$function$;

-- caller-analysis: create_order_from_blend_ticket :: grants are re-emitted UNCHANGED from 20260714230200 (revoke PUBLIC/anon, grant authenticated + service_role); the only live caller, src/pages/BlendTicketDetail.tsx:945, invokes this RPC as a signed-in authenticated user and keeps EXECUTE, so no caller loses a privilege it holds today.
REVOKE EXECUTE ON FUNCTION public.create_order_from_blend_ticket(uuid, text, date, text, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_order_from_blend_ticket(uuid, text, date, text, uuid, text)
  TO authenticated, service_role;

-- Post-conditions. The order header is now written ONLY by the AFTER-ROW
-- trigger, so a missing or disabled trigger would silently leave every
-- blend-ticket order header at the literal zeros inserted above instead of
-- raising. Fail the apply here rather than discover that in production.
DO $verify$
DECLARE
  v_overloads int;
  v_trigger_state "char";
  v_trigger_fn    regprocedure;
  v_trigger_type  int2;
  v_src text;
BEGIN
  SELECT count(*) INTO v_overloads
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'create_order_from_blend_ticket';
  IF v_overloads <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected exactly 1 create_order_from_blend_ticket, found %', v_overloads;
  END IF;

  SELECT t.tgenabled, t.tgfoid, t.tgtype
    INTO v_trigger_state, v_trigger_fn, v_trigger_type
  FROM pg_trigger t
  WHERE t.tgrelid = 'public.order_items'::regclass
    AND t.tgname = 'after_order_items_change'
    AND NOT t.tgisinternal;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: trigger after_order_items_change is missing from public.order_items; the order header would be left at zero';
  END IF;
  -- 'D' disabled and 'R' replica-only both mean it will not fire on an
  -- ordinary write. 'O' (origin) and 'A' (always) both will.
  IF v_trigger_state IN ('D', 'R') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: trigger after_order_items_change will not fire on ordinary writes (tgenabled=%)', v_trigger_state;
  END IF;
  IF v_trigger_fn <> 'public.trg_recalc_order_totals()'::regprocedure THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: trigger after_order_items_change runs % instead of trg_recalc_order_totals()', v_trigger_fn;
  END IF;
  -- tgtype bit 4 = fires on INSERT. A trigger scoped to UPDATE/DELETE only
  -- would leave a freshly created order header at its seeded zeros.
  IF (v_trigger_type & 4) <> 4 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: trigger after_order_items_change does not fire on INSERT (tgtype=%)', v_trigger_type;
  END IF;

  SELECT p.prosrc INTO v_src
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'create_order_from_blend_ticket';
  IF position('SET total_price = v_total_price' in v_src) > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the raw order-header overwrite is still present in create_order_from_blend_ticket';
  END IF;
  IF position('SELECT COALESCE(o.total_price, 0) INTO v_total_price' in v_src) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the canonical order-header read-back is missing from create_order_from_blend_ticket';
  END IF;
  IF position('ACTOR_MISMATCH' in v_src) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: actor-binding guard missing from create_order_from_blend_ticket';
  END IF;
  IF position('check_idempotency' in v_src) = 0 OR position('save_idempotency' in v_src) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: idempotency handling missing from create_order_from_blend_ticket';
  END IF;
END;
$verify$;
