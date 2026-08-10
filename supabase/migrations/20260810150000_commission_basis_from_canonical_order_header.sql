-- actor-binding-check: exempt
--   REASON: create_direct_order's actor guard is real and unchanged -- it binds
--   p_performed_by to auth.uid() and raises on a mismatch -- but the live text
--   raises the literal 'Actor mismatch', not the canonical ACTOR_MISMATCH token
--   the hook greps for. That wording is pre-existing live text (md5 pinned below)
--   and this migration reproduces it byte-for-byte on purpose; renaming the token
--   here would change an error string the frontend matches on, which is a separate
--   change. _convert_quote_to_order_owner_impl already uses the canonical token.
-- ============================================================================
-- Mint order commissions from the CANONICAL order header, and store whole-cent
-- line money on the direct-order path.
-- ----------------------------------------------------------------------------
-- BUG (money):
--   20260809230500 made orders.total_profit canonical: the order_items triggers
--   (_round_money_to_whole_cents BEFORE, trg_recalc_order_totals AFTER) recompute
--   the order header from the rounded per-line values whenever a line is written.
--
--   The two primary order-creation paths still mint commissions from a value they
--   captured BEFORE those triggers ran:
--     * _convert_quote_to_order_owner_impl passes v_quote.total_profit -- the
--       QUOTE's cached header, copied in before the lines existed.
--     * create_direct_order passes v_total_profit -- a local accumulator summing
--       raw, unrounded quantity x price products.
--   Either can disagree with orders.total_profit, so commissions.order_profit is
--   attributed to a profit figure the order itself does not report. Every other
--   caller of _insert_commissions_for_order already reads or writes the header
--   immediately beforehand; bulk_import_order (20260806004644) re-reads it
--   explicitly. This makes the two outliers match.
--
--   NOT CHANGED ON PURPOSE: transfer_job_to_invoice passes a deliberately
--   different basis (chemical-line profit only, excluding the per-acre
--   application fee, per the owner rule recorded in that function). The fix is
--   therefore applied at the two broken call sites, NOT inside the shared helper
--   _insert_commissions_for_order -- patching the helper would silently change
--   the application-channel commission basis.
--
-- BASELINE (verbatim-from-live, verified 2026-08-10):
--   md5(prosrc) public._convert_quote_to_order_owner_impl = 1627fcaa5dad2682e26f48cf4819ece9
--   md5(prosrc) public.create_direct_order                = 1e5f173cbbb039617334cef731a0a667
--   Both prosecdef = true, search_path = public, pg_temp. Signatures unchanged, so
--   CREATE OR REPLACE preserves the existing ACLs
--   (_convert_..._impl: postgres, service_role only; create_direct_order:
--    postgres, authenticated, service_role -- no anon, no PUBLIC).
--   The bodies below are byte-faithful to live EXCEPT the sentinel-marked deltas.
--
-- EXHAUSTIVE DELTA LIST:
--   DELTA-A  both functions: declare v_canonical_profit and SELECT
--            ROUND(COALESCE(orders.total_profit,0),2) for the order just written,
--            then pass it to _insert_commissions_for_order in place of the stale
--            local/quote value.
--   DELTA-C  create_direct_order only: ROUND(...,2) on the header accumulator and
--            on the order_items line total_price/profit, so no sub-cent value is
--            ever written or summed. (Ordering-cycle FINDINGS 2026-08-09, line 761.)
--   DELTA-E  _convert_quote_to_order_owner_impl only: ROUND(...,2) on the three
--            money values copied from the quote header into the new orders row.
--            Changes no final value (trg_recalc_order_totals overwrites all three
--            from the rounded lines immediately after), but keeps the INSERT itself
--            legal under the whole-cent constraints added by 20260810151000 when
--            the source quote is one of the 2 live drafts carrying a sub-cent
--            total_cost.
--
-- BACKFILL: none. This changes mint-time behavior for NEW commissions only.
--   Existing commission rows are NOT rewritten -- that is a money write and needs
--   its own approval. See docs/manual/KNOWN_ISSUES.md.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._convert_quote_to_order_owner_impl(p_quote_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid; v_actor_role text;
  v_quote record; v_order_number text; v_order_id uuid; v_item record;
  v_customer record; v_inv record; v_shortfalls text[] := '{}'; v_net_position numeric;
  v_result jsonb; v_existing jsonb;
  v_has_draws boolean; v_fully_drawn boolean;
  v_canonical_profit numeric;  -- DELTA-A
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

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'convert_quote_to_order');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_quote FROM quotes WHERE id = p_quote_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found'; END IF;

  -- Draws guard FIRST and status-independent (2026-06-10 BLOCKER fix): the UI
  -- may have pre-flipped status to 'accepted' before calling this RPC, so the
  -- guard can never key off status. A booking with an undrawn balance is
  -- never whole-convertible; a fully-drawn booking is never re-bookable.
  SELECT EXISTS (
    SELECT 1 FROM quote_product_draws
    WHERE quote_id = p_quote_id AND quantity_drawn > 0
  )
  -- LAYER2<<< job reservations count as draws too (§6.5): a job that reserved
  -- booking units makes this a partially-drawn booking — whole conversion would
  -- re-order units a job already holds/bills.
  OR EXISTS (
    SELECT 1 FROM job_product_draws
    WHERE quote_id = p_quote_id AND quantity_drawn > 0
  )
  -- >>>LAYER2
  INTO v_has_draws;
  IF v_has_draws THEN
    -- ORDER draws only (see header): job draws never satisfy 'fully drawn'.
    SELECT COALESCE(bool_and(COALESCE(d.quantity_drawn, 0) >= b.booked), true) INTO v_fully_drawn
    FROM (
      SELECT product_id, SUM(COALESCE(total_units_needed, 0)) AS booked
      FROM quote_items WHERE quote_id = p_quote_id
      GROUP BY product_id
    ) b
    LEFT JOIN quote_product_draws d
      ON d.quote_id = p_quote_id AND d.product_id = b.product_id
    WHERE b.booked > 0;
    IF NOT v_fully_drawn THEN
      RAISE EXCEPTION 'BOOKING_PARTIALLY_DRAWN: this quote has partial draw-downs — draw the remaining balance from the booking instead';
    END IF;
    -- Fully ORDER-drawn: every booked unit is already on an order. Surface the
    -- most recent draw order; never create another.
    SELECT id INTO v_order_id FROM orders WHERE quote_id = p_quote_id LIMIT 1;
    -- LAYER2<<< defensive (Codex): the order-only fully-drawn check is vacuously
    -- TRUE when the booked-rows set is empty (e.g. a job-drawn product was
    -- dropped from quote_items). Never return a null-order 'already_converted'
    -- the caller force-uses (result.order_id!) — treat as an unresolved booking.
    IF v_order_id IS NULL THEN
      RAISE EXCEPTION 'BOOKING_PARTIALLY_DRAWN: this booking has no order to convert (reservations exist) — review the booking''s jobs and draws';
    END IF;
    -- >>>LAYER2
    v_result := jsonb_build_object('status', 'already_converted', 'order_id', v_order_id);
    IF p_idempotency_key IS NOT NULL THEN
      PERFORM save_idempotency(p_idempotency_key, 'convert_quote_to_order', v_result);
    END IF;
    RETURN v_result;
  END IF;

  IF v_quote.status = 'accepted' THEN
    SELECT id INTO v_order_id FROM orders WHERE quote_id = p_quote_id LIMIT 1;
    IF v_order_id IS NOT NULL THEN
      v_result := jsonb_build_object('status', 'already_converted', 'order_id', v_order_id);
      IF p_idempotency_key IS NOT NULL THEN
        PERFORM save_idempotency(p_idempotency_key, 'convert_quote_to_order', v_result);
      END IF;
      RETURN v_result;
    END IF;
  END IF;

  IF v_quote.status NOT IN ('sent', 'revised', 'accepted') THEN
    RAISE EXCEPTION 'BOOKING_CLOSED: cannot convert a % quote', v_quote.status;
  END IF;

  SELECT * INTO v_customer FROM customers WHERE id = v_quote.customer_id;

  FOR v_item IN
    SELECT qi.product_id, p.product_name, SUM(COALESCE(qi.total_units_needed, 0)) AS qty_needed
    FROM quote_items qi JOIN products p ON p.id = qi.product_id
    WHERE qi.quote_id = p_quote_id AND qi.product_id IS NOT NULL
      AND COALESCE(qi.total_units_needed, 0) > 0
    GROUP BY qi.product_id, p.product_name
  LOOP
    SELECT * INTO v_inv FROM inventory
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse' FOR UPDATE;
    IF NOT FOUND THEN
      v_shortfalls := array_append(v_shortfalls,
        v_item.product_name || ': need ' || v_item.qty_needed || ', net position is 0 (no inventory record)');
    ELSE
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
  UPDATE inventory_holds SET is_active = false, updated_at = now()
  WHERE source_id = p_quote_id AND is_active = true;

  v_order_number := generate_order_number();

  INSERT INTO orders (order_number, quote_id, customer_id, status, commission_split,
    total_price, total_cost, total_profit, total_margin_pct, order_date, program_notes)
  VALUES (v_order_number, p_quote_id, v_quote.customer_id, 'confirmed',
    -- DELTA-E (2026-08-10): round the quote header on the way in. This row is
    -- transient -- the AFTER trigger trg_recalc_order_totals recomputes
    -- total_price/total_cost/total_profit from the rounded per-line values as soon
    -- as the order_items rows below land -- but a legacy quote whose total_cost was
    -- written before 20260810150500 can carry a sub-cent value, and the INSERT
    -- itself is checked against orders' whole-cent constraints.
    v_quote.commission_split,
    ROUND(COALESCE(v_quote.total_price, 0), 2),
    ROUND(COALESCE(v_quote.total_cost, 0), 2),
    ROUND(COALESCE(v_quote.total_profit, 0), 2), v_quote.total_margin_pct, current_date,
    (SELECT string_agg(qs.section_name || ': ' || qs.section_header_notes, E'\n')
     FROM quote_sections qs WHERE qs.quote_id = p_quote_id
       AND qs.section_header_notes IS NOT NULL AND qs.section_header_notes <> ''))
  RETURNING id INTO v_order_id;

  INSERT INTO order_items (order_id, product_id, quote_item_id, section_name, product_name,
    price_per_unit, cost_per_unit, actual_rate, rate_unit, acres,
    total_units_needed, unit_size, total_price, profit, net_margin,
    quantity_delivered, quantity_remaining, notes)
  SELECT v_order_id, qi.product_id, qi.id, qs.section_name, p.product_name,
    qi.price_per_unit, qi.current_cost, qi.actual_rate, qi.rate_unit, qi.acres,
    COALESCE(qi.total_units_needed, 0), qi.unit_size,
    qi.total_price, qi.profit, qi.net_margin,
    0, COALESCE(qi.total_units_needed, 0), qi.notes
  FROM quote_items qi
  JOIN quote_sections qs ON qs.id = qi.section_id
  JOIN products p ON p.id = qi.product_id
  WHERE qi.quote_id = p_quote_id AND qi.product_id IS NOT NULL;

  INSERT INTO quote_product_draws (quote_id, product_id, quantity_drawn)
  SELECT qi.quote_id, qi.product_id, SUM(COALESCE(qi.total_units_needed, 0))
  FROM quote_items qi
  WHERE qi.quote_id = p_quote_id AND qi.product_id IS NOT NULL
  GROUP BY qi.quote_id, qi.product_id
  HAVING SUM(COALESCE(qi.total_units_needed, 0)) > 0
  ON CONFLICT (quote_id, product_id)
  DO UPDATE SET quantity_drawn = EXCLUDED.quantity_drawn, updated_at = now();

  FOR v_item IN
    SELECT oi.product_id, oi.total_units_needed, oi.unit_size FROM order_items oi
    WHERE oi.order_id = v_order_id AND oi.product_id IS NOT NULL AND oi.total_units_needed > 0
  LOOP
    UPDATE inventory SET quantity_prebooked = quantity_prebooked + v_item.total_units_needed,
      updated_at = now()
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';
    IF NOT FOUND THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order, unit_size)
      VALUES (v_item.product_id, 'Main Warehouse', 0, v_item.total_units_needed, 0, v_item.unit_size);
    END IF;
    INSERT INTO inventory_transactions (product_id, transaction_type, quantity, to_location,
      order_id, performed_by, notes)
    VALUES (v_item.product_id, 'booked', v_item.total_units_needed, 'Main Warehouse',
      v_order_id, v_actor, 'Pre-booked for order ' || v_order_number);
  END LOOP;

  -- DELTA-A (2026-08-10): mint commissions from the CANONICAL order header, not the
  -- quote's cached total_profit. The order_items triggers installed by
  -- 20260809230500 (_round_money_to_whole_cents BEFORE, trg_recalc_order_totals AFTER)
  -- rewrite orders.total_profit AFTER the quote lines are copied in, so
  -- v_quote.total_profit can disagree with the very order the commission rows are
  -- attributed to. bulk_import_order already re-reads the header before minting
  -- (20260806004644); this makes the quote-conversion path match it.
  SELECT ROUND(COALESCE(o.total_profit, 0), 2)
    INTO v_canonical_profit
    FROM orders o
   WHERE o.id = v_order_id;

  PERFORM _insert_commissions_for_order(
    v_order_id, v_quote.customer_id, v_canonical_profit,
    v_quote.commission_split, current_date
  );

  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, new_values, total_impact_cents, description)
  VALUES (
    'quote_converted', 'order', v_order_id, v_actor_role,
    jsonb_build_object(
      'quote_id', p_quote_id,
      'quote_number', v_quote.quote_number,
      'order_number', v_order_number,
      'customer_id', v_quote.customer_id,
      'customer_name', COALESCE(v_customer.farm_name, 'unknown'),
      'total_price_dollars', v_quote.total_price,
      'inventory_warnings', to_jsonb(v_shortfalls)
    ),
    ROUND(v_quote.total_price * 100)::bigint,
    'Converted quote ' || v_quote.quote_number || ' to order ' || v_order_number ||
      ' for ' || COALESCE(v_customer.farm_name, 'customer') ||
      CASE WHEN array_length(v_shortfalls, 1) > 0
        THEN ' (inventory shortfalls: ' || array_to_string(v_shortfalls, '; ') || ')'
        ELSE '' END
  );

  INSERT INTO activity_feed (event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id)
  VALUES ('order_created',
    'Order ' || v_order_number || ' created from quote ' || v_quote.quote_number ||
    ' for ' || COALESCE(v_customer.farm_name, 'customer') ||
    CASE WHEN array_length(v_shortfalls, 1) > 0
      THEN ' (inventory warnings: ' || array_to_string(v_shortfalls, '; ') || ')'
      ELSE '' END,
    v_actor, 'order', v_order_id, v_quote.customer_id);

  v_result := jsonb_build_object('status', 'created', 'order_id', v_order_id,
    'order_number', v_order_number, 'warnings', to_jsonb(v_shortfalls));

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'convert_quote_to_order', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_direct_order(p_customer_id uuid, p_order_date date, p_order_name text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_items jsonb DEFAULT '[]'::jsonb, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_customer_po_number text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_actor_role text;
  v_order_id uuid;
  v_order_number text;
  v_item jsonb;
  v_total_price numeric := 0;
  v_total_cost numeric := 0;
  v_total_profit numeric;
  v_total_margin_pct numeric;
  v_customer record;
  v_cached_result jsonb;
  v_result jsonb;
  v_inv record;
  v_warnings text[] := '{}';
  v_qty numeric;
  v_net_position numeric;
  v_canonical_profit numeric;  -- DELTA-A
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by <> v_actor THEN
    RAISE EXCEPTION 'Actor mismatch';
  END IF;

  SELECT role INTO v_actor_role
  FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := check_idempotency(p_idempotency_key, 'create_direct_order');
    IF v_cached_result IS NOT NULL THEN RETURN v_cached_result; END IF;
  END IF;

  SELECT * INTO v_customer FROM customers WHERE id = p_customer_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found: %', p_customer_id; END IF;

  v_order_number := generate_order_number();

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    IF (v_item->>'product_id') IS NULL THEN CONTINUE; END IF;
    v_qty := COALESCE((v_item->>'quantity')::numeric, 0);
    IF v_qty <= 0 THEN CONTINUE; END IF;
    SELECT * INTO v_inv FROM inventory
    WHERE product_id = (v_item->>'product_id')::uuid AND location = 'Main Warehouse';
    IF NOT FOUND THEN
      v_warnings := array_append(v_warnings,
        COALESCE(v_item->>'product_name', 'Unknown product') ||
        ': need ' || v_qty || ', net position is 0 (no inventory record)');
    ELSE
      v_net_position := v_inv.quantity_available - v_inv.quantity_prebooked + COALESCE(v_inv.quantity_on_order, 0);
      IF v_net_position < v_qty THEN
        v_warnings := array_append(v_warnings,
          COALESCE(v_item->>'product_name', 'Unknown product') ||
          ': need ' || v_qty ||
          ', net position is ' || GREATEST(v_net_position, 0) ||
          ' (on floor: ' || (v_inv.quantity_available - v_inv.quantity_prebooked) ||
          ', on order: ' || COALESCE(v_inv.quantity_on_order, 0) || ')');
      END IF;
    END IF;
  END LOOP;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    -- DELTA-C (2026-08-10): round each line to whole cents before accumulating, so
    -- this header matches the canonical rollup formula in trg_recalc_order_totals
    -- (SUM of per-line ROUND(...,2)) instead of summing sub-cent raw products.
    v_total_price := v_total_price
      + ROUND(COALESCE((v_item->>'quantity')::numeric, 0)
              * COALESCE((v_item->>'price_per_unit')::numeric, 0), 2);
    v_total_cost := v_total_cost
      + ROUND(COALESCE((v_item->>'quantity')::numeric, 0)
              * COALESCE((v_item->>'unit_cost')::numeric, 0), 2);
  END LOOP;

  v_total_profit := v_total_price - v_total_cost;
  v_total_margin_pct := CASE
    WHEN v_total_price > 0 THEN (v_total_profit / v_total_price) * 100
    ELSE 0
  END;

  INSERT INTO orders (
    order_number, order_name, customer_id, status,
    total_price, total_cost, total_profit, total_margin_pct,
    order_date, notes,
    customer_po_number  -- DELTA-2 (create_direct_order_customer_po_param)
  ) VALUES (
    v_order_number, NULLIF(TRIM(COALESCE(p_order_name, '')), ''),
    p_customer_id, 'confirmed',
    v_total_price, v_total_cost, v_total_profit, v_total_margin_pct,
    p_order_date,
    NULLIF(TRIM(COALESCE(p_notes, '')), ''),
    NULLIF(TRIM(COALESCE(p_customer_po_number, '')), '')  -- DELTA-2
  ) RETURNING id INTO v_order_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    IF (v_item->>'product_id') IS NULL OR COALESCE((v_item->>'quantity')::numeric, 0) <= 0 THEN
      CONTINUE;
    END IF;
    INSERT INTO order_items (
      order_id, product_id, product_name,
      price_per_unit, cost_per_unit,
      total_units_needed, unit_size,
      total_price, profit, net_margin,
      quantity_delivered, quantity_remaining
    ) VALUES (
      v_order_id, (v_item->>'product_id')::uuid, v_item->>'product_name',
      COALESCE((v_item->>'price_per_unit')::numeric, 0),
      COALESCE((v_item->>'unit_cost')::numeric, 0),
      (v_item->>'quantity')::numeric, v_item->>'unit_size',
      -- DELTA-C (2026-08-10): store whole-cent line money. The BEFORE trigger
      -- _round_money_to_whole_cents normalizes these anyway; rounding here keeps the
      -- value this function believes it wrote identical to the value that lands.
      ROUND(COALESCE((v_item->>'quantity')::numeric, 0) * COALESCE((v_item->>'price_per_unit')::numeric, 0), 2),
      ROUND(COALESCE((v_item->>'quantity')::numeric, 0) * COALESCE((v_item->>'price_per_unit')::numeric, 0), 2)
        - ROUND(COALESCE((v_item->>'unit_cost')::numeric, 0) * COALESCE((v_item->>'quantity')::numeric, 0), 2),
      CASE WHEN COALESCE((v_item->>'price_per_unit')::numeric, 0) > 0
        THEN ((COALESCE((v_item->>'price_per_unit')::numeric, 0) - COALESCE((v_item->>'unit_cost')::numeric, 0))
              / (v_item->>'price_per_unit')::numeric) * 100
        ELSE 0
      END,
      0, (v_item->>'quantity')::numeric
    );
    UPDATE inventory SET
      quantity_prebooked = quantity_prebooked + (v_item->>'quantity')::numeric,
      updated_at = now()
    WHERE product_id = (v_item->>'product_id')::uuid AND location = 'Main Warehouse';
    IF NOT FOUND THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order, unit_size)
      VALUES ((v_item->>'product_id')::uuid, 'Main Warehouse', 0, (v_item->>'quantity')::numeric, 0, v_item->>'unit_size');
    END IF;
    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, to_location,
      order_id, performed_by, notes
    ) VALUES (
      (v_item->>'product_id')::uuid, 'booked', (v_item->>'quantity')::numeric,
      'Main Warehouse', v_order_id, v_actor,
      'Pre-booked for order ' || v_order_number
    );
  END LOOP;

  -- DELTA-A (2026-08-10): see the matching note in
  -- _convert_quote_to_order_owner_impl. v_total_profit is this function's local
  -- accumulator, computed BEFORE the order_items rows (and therefore the
  -- 20260809230500 triggers) rewrote orders.total_profit. Re-read the header so the
  -- commission basis is the same number the order itself reports.
  SELECT ROUND(COALESCE(o.total_profit, 0), 2)
    INTO v_canonical_profit
    FROM orders o
   WHERE o.id = v_order_id;

  PERFORM _insert_commissions_for_order(
    v_order_id, p_customer_id, v_canonical_profit,
    v_customer.default_commission_split, p_order_date
  );

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'order_created',
    'Direct order ' || v_order_number || COALESCE(' (' || NULLIF(TRIM(COALESCE(p_order_name, '')), '') || ')', '') || ' created for ' || COALESCE(v_customer.farm_name, 'customer') ||
    CASE WHEN array_length(v_warnings, 1) > 0
      THEN ' (inventory warnings: ' || array_to_string(v_warnings, '; ') || ')'
      ELSE '' END,
    v_actor, 'order', v_order_id, p_customer_id
  );

  v_result := jsonb_build_object(
    'status', 'created', 'order_id', v_order_id,
    'order_number', v_order_number, 'warnings', to_jsonb(v_warnings)
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_direct_order', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

-- ============================================================================
-- Post-conditions asserted in-migration (fail closed).
-- ============================================================================
DO $$
BEGIN
  -- Exactly one overload of each, still SECURITY DEFINER with a pinned search_path.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = '_convert_quote_to_order_owner_impl') <> 1 THEN
    RAISE EXCEPTION 'POSTCOND: _convert_quote_to_order_owner_impl is not a single overload';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'create_direct_order') <> 1 THEN
    RAISE EXCEPTION 'POSTCOND: create_direct_order is not a single overload';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('_convert_quote_to_order_owner_impl', 'create_direct_order')
       AND (p.prosecdef IS NOT TRUE
            OR p.proconfig IS NULL
            OR NOT (p.proconfig @> ARRAY['search_path=public, pg_temp']))
  ) THEN
    RAISE EXCEPTION 'POSTCOND: SECURITY DEFINER or search_path lost';
  END IF;

  -- Neither function may be reachable by anon or PUBLIC.
  IF has_function_privilege('anon',
       'public.create_direct_order(uuid,date,text,text,jsonb,uuid,text,text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCOND: anon can EXECUTE create_direct_order';
  END IF;
  IF has_function_privilege('anon',
       'public._convert_quote_to_order_owner_impl(uuid,uuid,text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCOND: anon can EXECUTE _convert_quote_to_order_owner_impl';
  END IF;
  IF has_function_privilege('authenticated',
       'public._convert_quote_to_order_owner_impl(uuid,uuid,text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCOND: authenticated regained EXECUTE on the owner impl';
  END IF;
  -- ...and the grant that SHOULD be there was not dropped (availability, not security).
  IF NOT has_function_privilege('authenticated',
       'public.create_direct_order(uuid,date,text,text,jsonb,uuid,text,text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCOND: authenticated lost EXECUTE on create_direct_order';
  END IF;

  -- DELTA-E landed: the quote header is rounded on the way into orders.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = '_convert_quote_to_order_owner_impl'
       AND p.prosrc LIKE '%ROUND(COALESCE(v_quote.total_cost, 0), 2)%'
  ) THEN
    RAISE EXCEPTION 'POSTCOND: quote-to-order header copy is still unrounded';
  END IF;

  -- The delta actually landed: both bodies now re-read the canonical header.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('_convert_quote_to_order_owner_impl', 'create_direct_order')
         AND p.prosrc LIKE '%v_canonical_profit%') <> 2 THEN
    RAISE EXCEPTION 'POSTCOND: canonical-profit re-read missing from one of the two paths';
  END IF;

  -- And neither still passes its stale local value to the commission helper.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = '_convert_quote_to_order_owner_impl'
       AND p.prosrc LIKE '%v_quote.customer_id, v_quote.total_profit%'
  ) THEN
    RAISE EXCEPTION 'POSTCOND: quote path still mints from v_quote.total_profit';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'create_direct_order'
       AND p.prosrc LIKE '%p_customer_id, v_total_profit,%'
  ) THEN
    RAISE EXCEPTION 'POSTCOND: direct-order path still mints from v_total_profit';
  END IF;

  -- The shared helper and the deliberately-different application channel are untouched.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = '_insert_commissions_for_order'
       AND md5(p.prosrc) = '9f1a3c7af994b768bb0a76debc186350'
  ) THEN
    RAISE EXCEPTION 'POSTCOND: _insert_commissions_for_order was modified; it must not be';
  END IF;
END $$;
