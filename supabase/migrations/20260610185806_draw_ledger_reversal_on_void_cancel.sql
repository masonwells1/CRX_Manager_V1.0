-- idempotency-body-check: exempt
-- ============================================================================
-- Draw-ledger reversal on void/cancel (2026-06-10 finding A3, MED, verified)
-- ----------------------------------------------------------------------------
-- THE BUG: nothing ever decrements the quote_product_draws ledger. The partial
-- draw-down feature (20260610145253 + fixes 20260610181612 / 20260610181726)
-- creates "draw orders" (orders with quote_id; one order per draw; their
-- order_items carry quote_item_id NULL). Voiding or cancelling a draw order
-- restores inventory but the booking balance stays consumed forever; if it was
-- the FINAL draw the quote is stuck 'accepted' with no recovery path (the new
-- enforce_quote_accepted_fully_drawn trigger blocks re-accepting while
-- partially drawn, and re-drawing requires 'sent'/'revised').
--
-- Design decisions (load-bearing):
-- * HOW A DRAW ORDER IS IDENTIFIED — new explicit column
--   orders.booking_draw boolean NOT NULL DEFAULT false, set by draw_down_quote
--   at creation. Inference ("quote_id set + all items have quote_item_id
--   NULL") was rejected: order_items.quote_item_id population on
--   whole-conversions is a convention of the CURRENT convert_quote_to_order
--   body, not an invariant of historical data — misclassifying a legacy
--   conversion as a draw would wrongly reopen a closed booking on void.
--   Backfill is driven by financial_audit_log (draw_down_quote stamps
--   new_values->>'booking_draw' = 'true' on every draw's audit row), which is
--   authoritative for any draw created between this file being drafted and
--   applied. Live census 2026-06-10: ZERO draw orders exist (the only
--   quote-linked order is ORD-2026-0330, a legacy whole-conversion from
--   2026-03-16, already cancelled), so the backfill is expected to touch 0
--   rows — it is included defensively because main = live prod and the draw
--   feature is already live.
-- * WHOLE-CONVERSION ORDERS ARE EXCLUDED from reversal (booking_draw stays
--   false). Historical semantic preserved: voiding/cancelling a converted
--   order leaves the booking closed ('accepted'); the ledger rows written by
--   convert_quote_to_order / the 20260610145253 backfill stay at fully-drawn
--   so the quote can never be re-drawn or re-converted.
-- * REVERSAL AMOUNTS mirror each function's own inventory math:
--     - void_order (guard: status MUST be 'fulfilled'): the order is nulled
--       and the delivered goods come back to the warehouse, so the ledger is
--       decremented by the FULL ordered quantity (SUM(total_units_needed) per
--       product).
--     - cancel_order (guard: never on 'fulfilled'): only the UNDELIVERED
--       remainder is released back to stock (GREATEST(needed - delivered, 0)
--       per item — the exact formula cancel_order already uses for its
--       prebook release), so only that remainder returns to the booking
--       balance. Reversing the full quantity would over-entitle the customer:
--       booked 500, drew 200, 50 delivered, cancel → full reversal would
--       allow 500 more units on top of the 50 already received.
--   Both decrements clamp with GREATEST(... , 0) (ledger CHECK requires >= 0).
-- * QUOTE REOPEN: after the decrement, if the parent quote is 'accepted' and
--   the booking is no longer fully drawn (same bool_and predicate as
--   draw_down_quote / enforce_quote_accepted_fully_drawn), status flips back
--   to 'sent' and an activity_feed row ('booking_reopened') explains why.
--   HONESTY NOTE: the live enforcer _enforce_quote_status_transition (md5
--   6f08cbf4909192c2b7b81bff052133a9, read 2026-06-10) ALLOWS accepted→sent
--   unconditionally today — the "blocks accepted→sent when orders exist"
--   claim in the finding is stale. The app.admin_override bracket around the
--   flip is kept anyway as defense-in-depth so this reversal keeps working if
--   the enforcer is later tightened. enforce_quote_accepted_fully_drawn only
--   guards ENTERING 'accepted', so leaving it is trigger-safe; a later full
--   re-draw re-enters 'accepted' legally because the ledger is fully drawn at
--   that moment.
-- * cancel_order's F7 block ("deactivate the originating quote's holds")
--   gains an inner skip for draw orders: a cancelled draw leaves the booking
--   OPEN, so the undrawn balance's still-active holds must survive. Without
--   the skip, cancelling a 200/500 partial draw would silently destroy the
--   remaining 300's reservation. For whole-conversion orders the original
--   behavior is unchanged. (Pre-this-feature, F7 was a no-op safety: the only
--   quote-linked orders were conversions whose quotes were already 'accepted'
--   with holds already released.)
-- * In cancel_order the quote flip deliberately does NOT bracket/reset
--   app.admin_override: that function runs its ENTIRE body under
--   SET LOCAL app.admin_override = 'true' and never resets it — resetting it
--   mid-body would break the later unposted-invoice cancellation. void_order
--   resets its override to 'false' before our block runs, so there the flip
--   carries its own set-true/set-false bracket (void_order's own pattern).
-- * LOCK ORDERING: the reversal block locks the parent quote (FOR UPDATE) and
--   is placed BEFORE each function's inventory writes, so void/cancel acquire
--   quote → inventory in the same order as draw_down_quote (no deadlock pair
--   between a void/cancel and a concurrent draw on the same booking).
-- * KNOWN V1 SIMPLIFICATION: the reversal does NOT recreate inventory_holds
--   for the restored balance (the draw consumed holds FIFO into prebooked;
--   exact row-level restoration is ambiguous). The restored balance is simply
--   unreserved free stock — draw_down_quote tolerates absent holds (its FIFO
--   loop is best-effort), so re-drawing works; only the planning reservation
--   is not resurrected. Documented for a follow-up if it matters.
--
-- VERBATIM FIDELITY: all three function bodies are reproduced byte-for-byte
-- from live; every delta is delimited by `-- A3<<<` / `-- >>>A3` sentinel
-- comments (the sentinels themselves are part of the inserted block).
-- Stripping the sentinel-delimited regions yields bodies whose md5 equals the
-- live pre-apply prosrc md5s:
--     void_order       8f63261181adb0764f01022ed1a82025
--     cancel_order     c38cd29c818c95b933eeb7ef47fa6388
--     draw_down_quote  d25494628909d63a798c8b145190cec5
--       (= the 20260610181726 disk body, disk-vs-live verified identical)
-- Live grants on all three (verified): EXECUTE for authenticated +
-- service_role only (no anon/PUBLIC) — restated below after each body.
-- Rolled-back smoke test: scripts/smoke/smoke-draw-ledger-reversal.sql.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Marker column + defensive backfill
-- ----------------------------------------------------------------------------
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS booking_draw boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.orders.booking_draw IS
  'true = this order was created by draw_down_quote (a partial/final draw against a season booking). void_order/cancel_order reverse the quote_product_draws ledger only for these orders; whole-conversion orders (convert_quote_to_order) leave the booking closed.';

-- Backfill any draw order created before this migration applies. Source of
-- truth: draw_down_quote stamps booking_draw=true into its financial_audit_log
-- row. Live census 2026-06-10: expected to update 0 rows (no draw orders
-- exist yet); included because the draw feature is live in prod.
UPDATE public.orders o
SET booking_draw = true
WHERE o.quote_id IS NOT NULL
  AND o.booking_draw = false
  AND EXISTS (
    SELECT 1 FROM public.financial_audit_log fal
    WHERE fal.entity_type = 'order'
      AND fal.entity_id = o.id
      AND fal.operation_type = 'quote_converted'
      AND (fal.new_values->>'booking_draw') = 'true'
  );

-- ----------------------------------------------------------------------------
-- 2. draw_down_quote — VERBATIM from live (md5 d25494628909d63a798c8b145190cec5)
--    + one inserted statement marking the new order as a booking draw
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.draw_down_quote(p_quote_id uuid, p_draws jsonb, p_performed_by uuid DEFAULT NULL, p_idempotency_key text DEFAULT NULL)
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
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found'; END IF;

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

    -- Per-product booking balance (locked quote => stable within this txn)
    SELECT
      SUM(COALESCE(qi.total_units_needed, 0)),
      CASE WHEN SUM(COALESCE(qi.total_units_needed, 0)) > 0
        THEN SUM(qi.price_per_unit * COALESCE(qi.total_units_needed, 0)) / SUM(COALESCE(qi.total_units_needed, 0))
        ELSE 0 END,
      CASE WHEN SUM(COALESCE(qi.total_units_needed, 0)) > 0
        THEN SUM(qi.current_cost * COALESCE(qi.total_units_needed, 0)) / SUM(COALESCE(qi.total_units_needed, 0))
        ELSE 0 END,
      SUM(COALESCE(qi.acres, 0)),
      MIN(qi.unit_size)
    INTO v_booked, v_wavg_price, v_wavg_cost, v_total_acres, v_unit_size
    FROM quote_items qi
    WHERE qi.quote_id = p_quote_id AND qi.product_id = v_product_id;

    SELECT product_name INTO v_product_name FROM products WHERE id = v_product_id;

    IF v_booked IS NULL OR v_booked <= 0 THEN
      RAISE EXCEPTION 'BOOKING_OVERDRAWN: % is not booked on this quote', COALESCE(v_product_name, v_product_id::text);
    END IF;

    SELECT quantity_drawn INTO v_drawn
    FROM quote_product_draws
    WHERE quote_id = p_quote_id AND product_id = v_product_id;
    v_drawn := COALESCE(v_drawn, 0);
    v_remaining := GREATEST(v_booked - v_drawn, 0);
    IF v_qty > v_remaining THEN
      RAISE EXCEPTION 'BOOKING_OVERDRAWN: %: requested %, only % remaining (booked %, already drawn %)',
        COALESCE(v_product_name, v_product_id::text), v_qty, v_remaining, v_booked, v_drawn;
    END IF;

    v_line_count := v_line_count + 1;
    v_line_total := ROUND(v_wavg_price * v_qty, 2);
    v_line_cost := ROUND(v_wavg_cost * v_qty, 2);
    v_acres := CASE WHEN v_total_acres > 0 THEN ROUND(v_total_acres * v_qty / v_booked, 2) ELSE NULL END;

    INSERT INTO order_items (order_id, product_id, product_name,
      price_per_unit, cost_per_unit, acres,
      total_units_needed, unit_size, total_price, profit, net_margin,
      quantity_delivered, quantity_remaining, sort_order, notes)
    VALUES (v_order_id, v_product_id, COALESCE(v_product_name, ''),
      v_wavg_price, v_wavg_cost, v_acres,
      v_qty, v_unit_size, v_line_total, v_line_total - v_line_cost,
      CASE WHEN v_wavg_price > 0 THEN ROUND(((v_wavg_price - v_wavg_cost) / v_wavg_price) * 100, 2) ELSE 0 END,
      0, v_qty, v_line_count,
      'Drawn from booking ' || v_quote.quote_number);

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

REVOKE EXECUTE ON FUNCTION public.draw_down_quote(uuid, jsonb, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.draw_down_quote(uuid, jsonb, uuid, text) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 3. void_order — VERBATIM from live (md5 8f63261181adb0764f01022ed1a82025)
--    + sentinel-delimited reversal block (placed BEFORE the inventory loop so
--    the quote → inventory lock order matches draw_down_quote)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.void_order(p_order_id uuid, p_performed_by uuid, p_reason text DEFAULT 'Voided by admin'::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_order record;
  v_item record;
  v_invoice record;
  v_admin record;
  v_inventory_restored integer := 0;
  v_commissions_cancelled integer := 0;
  v_paid_commissions integer := 0;
  v_draft_voided integer := 0;
  v_posted_notified integer := 0;
  v_existing jsonb;
  v_result jsonb;
  -- A3<<<
  v_draw_item record;
  v_draw_quote record;
  v_draw_fully_drawn boolean;
  -- >>>A3
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT is_admin() THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'void_order');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_NOT_FOUND'; END IF;
  IF v_order.status != 'fulfilled' THEN
    RAISE EXCEPTION 'INVALID_ORDER_STATUS: %', v_order.status;
  END IF;

  -- fulfilled→voided is a deliberate admin reversal the status-transition trigger does not
  -- include; bracket ONLY this write with the transaction-local admin override.
  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE public.orders
    SET status = 'voided',
        updated_at = now()
  WHERE id = p_order_id;
  PERFORM set_config('app.admin_override', 'false', true);
  -- A3<<< draw-ledger reversal (finding A3, 20260610190000 — see file header).
  -- void = the order is nulled and goods return to the warehouse, so the FULL
  -- drawn quantity goes back to the booking balance.
  IF COALESCE(v_order.booking_draw, false) AND v_order.quote_id IS NOT NULL THEN
    -- Lock the parent quote first: same quote → inventory order as
    -- draw_down_quote, and serializes against a concurrent draw.
    SELECT * INTO v_draw_quote FROM public.quotes
    WHERE id = v_order.quote_id FOR UPDATE;

    FOR v_draw_item IN
      SELECT product_id, SUM(COALESCE(total_units_needed, 0)) AS qty_drawn
      FROM public.order_items
      WHERE order_id = p_order_id AND product_id IS NOT NULL
      GROUP BY product_id
      HAVING SUM(COALESCE(total_units_needed, 0)) > 0
    LOOP
      UPDATE public.quote_product_draws
        SET quantity_drawn = GREATEST(quantity_drawn - v_draw_item.qty_drawn, 0),
            updated_at = now()
      WHERE quote_id = v_order.quote_id
        AND product_id = v_draw_item.product_id;
    END LOOP;

    -- If this was the final draw, the quote sits at 'accepted'; with the
    -- balance restored it is no longer fully drawn, so reopen the booking.
    IF v_draw_quote.status = 'accepted' THEN
      SELECT COALESCE(bool_and(COALESCE(d.quantity_drawn, 0) >= b.booked), true) INTO v_draw_fully_drawn
      FROM (
        SELECT product_id, SUM(COALESCE(total_units_needed, 0)) AS booked
        FROM public.quote_items WHERE quote_id = v_order.quote_id
        GROUP BY product_id
      ) b
      LEFT JOIN public.quote_product_draws d
        ON d.quote_id = v_order.quote_id AND d.product_id = b.product_id
      WHERE b.booked > 0;

      IF NOT v_draw_fully_drawn THEN
        -- accepted→sent is enforcer-legal on the live enforcer today; the
        -- override bracket is defense-in-depth (see file header).
        PERFORM set_config('app.admin_override', 'true', true);
        UPDATE public.quotes SET status = 'sent', updated_at = now()
        WHERE id = v_order.quote_id;
        PERFORM set_config('app.admin_override', 'false', true);

        INSERT INTO public.activity_feed (event_type, description, performed_by,
          related_entity_type, related_entity_id, customer_id)
        VALUES ('booking_reopened',
          'Booking ' || v_draw_quote.quote_number || ' reopened (accepted → sent): draw order ' ||
            v_order.order_number || ' was voided, returning its drawn quantity to the booking balance',
          v_actor, 'quote', v_order.quote_id, v_draw_quote.customer_id);
      END IF;
    END IF;
  END IF;
  -- >>>A3

  FOR v_item IN
    SELECT product_id, quantity_delivered
    FROM public.order_items
    WHERE order_id = p_order_id
      AND COALESCE(quantity_delivered, 0) > 0
  LOOP
    UPDATE public.inventory
      SET quantity_available = quantity_available + v_item.quantity_delivered,
          updated_at = now()
    WHERE product_id = v_item.product_id
      AND location = 'Main Warehouse';

    INSERT INTO public.inventory_transactions (
      product_id, transaction_type, quantity, to_location,
      order_id, performed_by, notes
    ) VALUES (
      v_item.product_id,
      'adjusted',
      v_item.quantity_delivered,
      'Main Warehouse',
      p_order_id,
      v_actor,
      'Restored ' || v_item.quantity_delivered || ' units - order ' ||
        v_order.order_number || ' voided. Reason: ' || p_reason
    );

    v_inventory_restored := v_inventory_restored + 1;
  END LOOP;

  UPDATE public.commissions
    SET status = 'cancelled',
        commission_amount = 0
  WHERE order_id = p_order_id
    AND status = 'pending';
  GET DIAGNOSTICS v_commissions_cancelled = ROW_COUNT;

  SELECT COUNT(*) INTO v_paid_commissions
  FROM public.commissions
  WHERE order_id = p_order_id AND status = 'paid';

  IF v_paid_commissions > 0 THEN
    FOR v_admin IN
      SELECT id FROM public.profiles WHERE role = 'admin' AND is_active = true
    LOOP
      INSERT INTO public.notifications (
        user_id, title, message,
        notification_type,
        related_entity_type,
        related_entity_id
      ) VALUES (
        v_admin.id,
        'Voided Order Has Paid Commissions',
        'Order ' || v_order.order_number || ' was voided but has ' ||
          v_paid_commissions || ' paid commission(s). Manual review required.',
        'void_review', 'order', p_order_id
      );
    END LOOP;
  END IF;

  FOR v_invoice IN
    SELECT * FROM public.invoices
    WHERE order_id = p_order_id
      AND deleted_at IS NULL
      AND status IN ('draft', 'posted')
  LOOP
    IF v_invoice.status = 'draft' THEN
      -- never-posted draft has no financial impact: cancel (allowed transition), do not void.
      UPDATE public.invoices
        SET status = 'cancelled',
            void_reason = 'Order ' || v_order.order_number || ' voided. ' || p_reason,
            updated_at = now()
      WHERE id = v_invoice.id;

      INSERT INTO public.financial_audit_log (
        operation_type,
        entity_type,
        entity_id,
        actor_role,
        old_values, new_values, total_impact_cents, description
      ) VALUES (
        'invoice_cancelled', 'invoice', v_invoice.id, 'admin',
        jsonb_build_object('status', 'draft', 'total_cents', v_invoice.total_amount_cents),
        jsonb_build_object('status', 'cancelled', 'void_reason', 'Order voided'),
        -1 * v_invoice.total_amount_cents,
        'Auto-cancelled draft invoice ' || v_invoice.invoice_number ||
          ' - order ' || v_order.order_number || ' voided'
      );

      v_draft_voided := v_draft_voided + 1;
    ELSIF v_invoice.status = 'posted' THEN
      FOR v_admin IN
        SELECT id FROM public.profiles WHERE role = 'admin' AND is_active = true
      LOOP
        INSERT INTO public.notifications (
          user_id, title, message,
          notification_type,
          related_entity_type,
          related_entity_id
        ) VALUES (
          v_admin.id,
          'Voided Order - Posted Invoice Needs Review',
          'Order ' || v_order.order_number || ' was voided. Invoice ' ||
            v_invoice.invoice_number || ' is posted and needs manual voiding.',
          'void_review', 'invoice', v_invoice.id
        );
      END LOOP;

      v_posted_notified := v_posted_notified + 1;
    END IF;
  END LOOP;

  INSERT INTO public.financial_audit_log (
    operation_type,
    entity_type,
    entity_id,
    actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'order_voided', 'order', p_order_id, 'admin',
    jsonb_build_object('status', 'fulfilled', 'total_price', v_order.total_price),
    jsonb_build_object('status', 'voided', 'void_reason', p_reason),
    -1 * ROUND(v_order.total_price * 100)::bigint,
    'Order ' || v_order.order_number || ' voided. Reason: ' || p_reason
  );

  INSERT INTO public.activity_feed (
    event_type, description, performed_by,
    related_entity_type,
    related_entity_id,
    customer_id
  ) VALUES (
    'order_voided',
    'Order ' || v_order.order_number || ' voided. ' ||
      v_inventory_restored || ' product(s) inventory restored. ' ||
      v_commissions_cancelled || ' commission(s) cancelled. ' ||
      v_draft_voided || ' draft invoice(s) cancelled.' ||
      CASE WHEN v_posted_notified > 0
           THEN ' ' || v_posted_notified || ' posted invoice(s) flagged for review.'
           ELSE '' END ||
      CASE WHEN v_paid_commissions > 0
           THEN ' ' || v_paid_commissions || ' paid commission(s) flagged for review.'
           ELSE '' END ||
      ' Reason: ' || p_reason,
    v_actor, 'order', p_order_id, v_order.customer_id
  );

  v_result := jsonb_build_object(
    'status', 'voided',
    'order_number', v_order.order_number,
    'inventory_products_restored', v_inventory_restored,
    'commissions_cancelled', v_commissions_cancelled,
    'paid_commissions_flagged', v_paid_commissions,
    'draft_invoices_voided', v_draft_voided,
    'posted_invoices_flagged', v_posted_notified
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'void_order', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.void_order(uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.void_order(uuid, uuid, text, text) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 4. cancel_order — VERBATIM from live (md5 c38cd29c818c95b933eeb7ef47fa6388)
--    + sentinel-delimited reversal block (undelivered quantity only) + inner
--    skip of the F7 hold-deactivation for draw orders
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_order(p_order_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_cached_result jsonb;
  v_order record;
  v_item record;
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
  -- A3<<<
  v_draw_item record;
  v_draw_quote record;
  v_draw_fully_drawn boolean;
  -- >>>A3
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  IF p_performed_by IS NOT NULL AND v_actor IS DISTINCT FROM p_performed_by THEN
    RAISE EXCEPTION 'actor mismatch';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := check_idempotency(p_idempotency_key, 'cancel_order');
    IF v_cached_result IS NOT NULL THEN
      RETURN v_cached_result;
    END IF;
  END IF;

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

  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Only admins can cancel orders';
  END IF;

  SET LOCAL app.admin_override = 'true';

  UPDATE deliveries SET
    status = 'cancelled',
    cancelled_at = now(),
    cancelled_by = v_actor,
    cancel_reason = 'Parent order ' || v_order.order_number || ' cancelled',
    updated_at = now()
  WHERE order_id = p_order_id
    AND status IN ('scheduled', 'in_progress');
  GET DIAGNOSTICS v_deliveries_cancelled = ROW_COUNT;

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

  UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = p_order_id;
  -- A3<<< draw-ledger reversal (finding A3, 20260610190000 — see file header).
  -- cancel = only the UNDELIVERED remainder returns to the booking balance
  -- (mirrors the prebook release below); delivered units stay consumed so the
  -- customer cannot be over-entitled.
  IF COALESCE(v_order.booking_draw, false) AND v_order.quote_id IS NOT NULL THEN
    -- Lock the parent quote first: same quote → inventory order as
    -- draw_down_quote, and serializes against a concurrent draw.
    SELECT * INTO v_draw_quote FROM quotes
    WHERE id = v_order.quote_id FOR UPDATE;

    FOR v_draw_item IN
      SELECT product_id,
             SUM(GREATEST(COALESCE(total_units_needed, 0) - COALESCE(quantity_delivered, 0), 0)) AS qty_undelivered
      FROM order_items
      WHERE order_id = p_order_id AND product_id IS NOT NULL
      GROUP BY product_id
      HAVING SUM(GREATEST(COALESCE(total_units_needed, 0) - COALESCE(quantity_delivered, 0), 0)) > 0
    LOOP
      UPDATE quote_product_draws
        SET quantity_drawn = GREATEST(quantity_drawn - v_draw_item.qty_undelivered, 0),
            updated_at = now()
      WHERE quote_id = v_order.quote_id
        AND product_id = v_draw_item.product_id;
    END LOOP;

    -- If this was the final draw, the quote sits at 'accepted'; with the
    -- balance restored it is no longer fully drawn, so reopen the booking.
    IF v_draw_quote.status = 'accepted' THEN
      SELECT COALESCE(bool_and(COALESCE(d.quantity_drawn, 0) >= b.booked), true) INTO v_draw_fully_drawn
      FROM (
        SELECT product_id, SUM(COALESCE(total_units_needed, 0)) AS booked
        FROM quote_items WHERE quote_id = v_order.quote_id
        GROUP BY product_id
      ) b
      LEFT JOIN quote_product_draws d
        ON d.quote_id = v_order.quote_id AND d.product_id = b.product_id
      WHERE b.booked > 0;

      IF NOT v_draw_fully_drawn THEN
        -- app.admin_override is already 'true' for this whole function body
        -- (SET LOCAL above) and is deliberately NOT reset here — the later
        -- unposted-invoice cancellation depends on it staying set.
        UPDATE quotes SET status = 'sent', updated_at = now()
        WHERE id = v_order.quote_id;

        INSERT INTO activity_feed (event_type, description, performed_by,
          related_entity_type, related_entity_id, customer_id)
        VALUES ('booking_reopened',
          'Booking ' || v_draw_quote.quote_number || ' reopened (accepted → sent): draw order ' ||
            v_order.order_number || ' was cancelled, returning its undelivered quantity to the booking balance',
          v_actor, 'quote', v_order.quote_id, v_draw_quote.customer_id);
      END IF;
    END IF;
  END IF;
  -- >>>A3

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
      v_item.product_id, 'released', v_undelivered, 'Main Warehouse',
      p_order_id, v_actor,
      'Released ' || v_undelivered || ' units — order ' || v_order.order_number || ' cancelled'
    );
  END LOOP;

  -- F7 fix: deactivate the originating quote's holds without restoring quantity_available
  IF v_order.quote_id IS NOT NULL THEN
    -- A3<<< draw orders: the booking stays OPEN after cancelling one draw, so
    -- the undrawn balance's still-active holds must survive (see file header).
    IF NOT COALESCE(v_order.booking_draw, false) THEN
    -- >>>A3
    UPDATE inventory_holds SET is_active = false, updated_at = now()
    WHERE source_id = v_order.quote_id AND is_active = true;
    GET DIAGNOSTICS v_holds_released = ROW_COUNT;
    -- A3<<<
    END IF;
    -- >>>A3
  END IF;

  UPDATE commissions SET
    status = 'cancelled',
    commission_amount = 0
  WHERE order_id = p_order_id AND status = 'pending';
  GET DIAGNOSTICS v_commissions_cancelled = ROW_COUNT;

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

  v_result := jsonb_build_object(
    'success', true,
    'status', 'cancelled',
    'order_number', v_order.order_number,
    'deliveries_cancelled', v_deliveries_cancelled,
    'holds_released', v_holds_released,
    'commissions_cancelled', v_commissions_cancelled,
    'paid_commissions_flagged', v_paid_commissions,
    'draft_invoices_cancelled', v_draft_cancelled,
    'posted_invoices_flagged', v_posted_notified
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'cancel_order', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.cancel_order(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_order(uuid, uuid, text) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 5. Self-verification
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_count int;
  v_src text;
BEGIN
  -- Marker column exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'booking_draw'
  ) THEN
    RAISE EXCEPTION 'orders.booking_draw column missing';
  END IF;

  -- Exactly one overload of each touched function
  SELECT count(*) INTO v_count
  FROM pg_proc WHERE proname = 'draw_down_quote' AND pronamespace = 'public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'draw_down_quote overload count = %, expected 1', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_proc WHERE proname = 'void_order' AND pronamespace = 'public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'void_order overload count = %, expected 1', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_proc WHERE proname = 'cancel_order' AND pronamespace = 'public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'cancel_order overload count = %, expected 1', v_count;
  END IF;

  -- draw_down_quote marks its orders
  SELECT prosrc INTO v_src
  FROM pg_proc WHERE proname = 'draw_down_quote' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%UPDATE orders SET booking_draw = true WHERE id = v_order_id%' THEN
    RAISE EXCEPTION 'draw_down_quote missing the booking_draw marker statement';
  END IF;

  -- void_order carries the reversal block
  SELECT prosrc INTO v_src
  FROM pg_proc WHERE proname = 'void_order' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%booking_draw%'
     OR v_src NOT LIKE '%GREATEST(quantity_drawn - v_draw_item.qty_drawn, 0)%'
     OR v_src NOT LIKE '%booking_reopened%' THEN
    RAISE EXCEPTION 'void_order missing the draw-ledger reversal block';
  END IF;

  -- cancel_order carries the reversal block + the F7 draw-order skip
  SELECT prosrc INTO v_src
  FROM pg_proc WHERE proname = 'cancel_order' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%booking_draw%'
     OR v_src NOT LIKE '%GREATEST(quantity_drawn - v_draw_item.qty_undelivered, 0)%'
     OR v_src NOT LIKE '%booking_reopened%' THEN
    RAISE EXCEPTION 'cancel_order missing the draw-ledger reversal block';
  END IF;
  IF v_src NOT LIKE '%IF NOT COALESCE(v_order.booking_draw, false) THEN%' THEN
    RAISE EXCEPTION 'cancel_order missing the F7 draw-order hold-release skip';
  END IF;

  -- Grants: anon must NOT be able to execute any of the three
  IF has_function_privilege('anon', 'public.draw_down_quote(uuid, jsonb, uuid, text)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('anon', 'public.void_order(uuid, uuid, text, text)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('anon', 'public.cancel_order(uuid, uuid, text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not have EXECUTE on the draw/void/cancel RPCs';
  END IF;
END $$;
