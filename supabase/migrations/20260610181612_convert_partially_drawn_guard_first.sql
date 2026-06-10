-- idempotency-body-check: exempt
-- ============================================================================
-- BLOCKER fix (2026-06-10 error-prevention review §3): the partially-drawn
-- guard in convert_quote_to_order was dead code in the app's real flow.
-- ----------------------------------------------------------------------------
-- Bug chain (verified end-to-end against live + QuoteBuilder.tsx):
--   1. QuoteBuilder.executeConvertToOrder calls saveQuote('accepted') BEFORE
--      the convert RPC. sent->accepted is enforcer-legal, so the quote flips
--      to 'accepted' and trg_release_holds_on_quote_status releases ALL
--      remaining holds for the booking.
--   2. convert_quote_to_order (20260610145253) then sees status='accepted',
--      finds an order with quote_id (every DRAW order carries quote_id), and
--      returns {'status':'already_converted', order_id:<old draw order>}.
--   3. The BOOKING_PARTIALLY_DRAWN guard required status <> 'accepted', so it
--      never evaluated. Net: converting a partially-drawn booking silently
--      closed it, destroyed the undrawn balance (no recovery path — the
--      enforcer blocks accepted->sent when orders exist), and toasted success.
--
-- Fix (two layers; the UI pre-flip is separately removed in QuoteBuilder.tsx):
--   (a) convert_quote_to_order reproduced verbatim from live (= the
--       20260610145253 disk body) with the draws check MOVED to run FIRST,
--       immediately after the row lock and STATUS-INDEPENDENT:
--         - draws exist + NOT fully drawn  -> RAISE BOOKING_PARTIALLY_DRAWN
--           (regardless of status — even corrupt 'accepted' states are safe)
--         - draws exist + fully drawn      -> 'already_converted' (the
--           booking's quantities are already on orders; never re-book)
--         - no draws                       -> original behavior unchanged
--   (b) NEW integrity trigger enforce_quote_accepted_fully_drawn on quotes:
--       blocks ANY writer (save_quote, direct PostgREST, future RPCs) from
--       setting status='accepted' while the booking has an undrawn balance.
--       Honors the canonical _is_admin_override() hatch (convert's existing
--       override bracket is safe — convert now guards explicitly first;
--       draw_down_quote's final flip passes because the ledger is already
--       fully drawn at that point). This is the layer that stops the UI
--       pre-flip damage even if an out-of-date client calls save_quote.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. convert_quote_to_order — verbatim from live, draws guard hoisted first
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.convert_quote_to_order(p_quote_id uuid, p_performed_by uuid DEFAULT NULL, p_idempotency_key text DEFAULT NULL)
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
  ) INTO v_has_draws;
  IF v_has_draws THEN
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
    -- Fully drawn: every booked unit is already on an order. Surface the most
    -- recent draw order; never create another.
    SELECT id INTO v_order_id FROM orders WHERE quote_id = p_quote_id LIMIT 1;
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
    v_quote.commission_split, v_quote.total_price, v_quote.total_cost,
    v_quote.total_profit, v_quote.total_margin_pct, current_date,
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

  PERFORM _insert_commissions_for_order(
    v_order_id, v_quote.customer_id, v_quote.total_profit,
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

REVOKE EXECUTE ON FUNCTION public.convert_quote_to_order(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.convert_quote_to_order(uuid, uuid, text) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 2. Integrity trigger: status='accepted' implies the booking is fully drawn
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_quote_accepted_fully_drawn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_fully_drawn boolean;
BEGIN
  IF NEW.status = 'accepted' AND OLD.status IS DISTINCT FROM 'accepted' THEN
    -- Canonical RPC/admin escape hatch (convert_quote_to_order brackets its
    -- own status write AFTER explicitly guarding the draws ledger).
    IF _is_admin_override() THEN RETURN NEW; END IF;

    IF EXISTS (
      SELECT 1 FROM quote_product_draws
      WHERE quote_id = NEW.id AND quantity_drawn > 0
    ) THEN
      SELECT COALESCE(bool_and(COALESCE(d.quantity_drawn, 0) >= b.booked), true) INTO v_fully_drawn
      FROM (
        SELECT product_id, SUM(COALESCE(total_units_needed, 0)) AS booked
        FROM quote_items WHERE quote_id = NEW.id
        GROUP BY product_id
      ) b
      LEFT JOIN quote_product_draws d
        ON d.quote_id = NEW.id AND d.product_id = b.product_id
      WHERE b.booked > 0;

      IF NOT v_fully_drawn THEN
        RAISE EXCEPTION 'BOOKING_PARTIALLY_DRAWN: cannot mark quote % accepted — the booking still has an undrawn balance', NEW.quote_number;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS enforce_quote_accepted_fully_drawn ON public.quotes;
CREATE TRIGGER enforce_quote_accepted_fully_drawn
  BEFORE UPDATE OF status ON public.quotes
  FOR EACH ROW EXECUTE FUNCTION public.enforce_quote_accepted_fully_drawn();

-- ----------------------------------------------------------------------------
-- 3. Self-verification
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_count int;
  v_src text;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc WHERE proname = 'convert_quote_to_order' AND pronamespace = 'public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'convert_quote_to_order overload count = %, expected 1', v_count;
  END IF;

  SELECT prosrc INTO v_src
  FROM pg_proc WHERE proname = 'convert_quote_to_order' AND pronamespace = 'public'::regnamespace;
  -- The guard must now evaluate BEFORE the already_converted short-circuit.
  IF position('BOOKING_PARTIALLY_DRAWN' IN v_src) = 0
     OR position('BOOKING_PARTIALLY_DRAWN' IN v_src) > position('already_converted' IN v_src) THEN
    RAISE EXCEPTION 'convert_quote_to_order: partially-drawn guard is not ahead of the already_converted branch';
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_trigger WHERE tgname = 'enforce_quote_accepted_fully_drawn'
    AND tgrelid = 'public.quotes'::regclass AND NOT tgisinternal;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'enforce_quote_accepted_fully_drawn trigger missing on quotes';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'enforce_quote_accepted_fully_drawn'
      AND pronamespace = 'public'::regnamespace
      AND prosecdef
      AND array_to_string(proconfig, ',') LIKE '%search_path%'
  ) THEN
    RAISE EXCEPTION 'enforce_quote_accepted_fully_drawn must be SECURITY DEFINER with search_path';
  END IF;
END $$;
