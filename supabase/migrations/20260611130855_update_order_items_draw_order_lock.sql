-- ============================================================================
-- update_order_items: draw-order lock guard (Codex round-2 review, HIGH)
-- ----------------------------------------------------------------------------
-- FINDING (Codex 2026-06-11, HIGH): a draw-created order (orders.booking_draw
-- = true, set by draw_down_quote since 20260610185806) is a materialized slice
-- of its booking's ledger (quote_product_draws). Live update_order_items had
-- NO booking_draw check, so editing items on a draw order desyncs order vs
-- ledger: draw 200, edit the order to 300 — the ledger still says 200 and
-- permits the same 100 units to be drawn AGAIN (double-allocation at the
-- locked booking price). Removing/swapping products desyncs the same way, and
-- the void/cancel reversal logic (20260610185806) would then reverse the WRONG
-- quantities. OrderDetail.tsx allowed editing any confirmed order, so this was
-- UI-reachable.
--
-- FIX (server-side, per the Codex-preferred initial fix): update_order_items
-- now raises 'BOOKING_DRAW_ORDER_LOCKED: ...' for booking_draw orders, BEFORE
-- any mutation. The sanctioned correction paths remain void_order /
-- cancel_order — both reverse the draw ledger (20260610185806) — after which
-- the booking can be drawn again at the corrected quantities. Frontend
-- (same batch): OrderDetail.tsx hides "Edit Order" for draw orders and maps
-- the new token (registered in RpcErrorCodes, src/lib/db.ts) to a friendly
-- toast as the direct-RPC backstop.
--
-- Whole-conversion orders (booking_draw = false — every order that existed
-- before 20260610185806, plus convert_quote_to_order output) are UNAFFECTED:
-- the guard reads only the new flag. Live census at draft time: ZERO
-- booking_draw orders exist, so no live order changes behavior today.
--
-- VERBATIM BASE: body reproduced byte-for-byte from live prosrc (pre-apply
-- md5 d3dc700951bd9409831b99bda6f26417, fetched 2026-06-11). Exactly TWO
-- insertions, both sentinel-delimited blocks, no DECLARE additions:
--   1. -- BEGIN/END active-actor guard (20260611120000) — rls-review L2
--      (2026-06-11): the verbatim role gate lacks is_active, so a DEACTIVATED
--      admin/sales_rep session could still edit items. Canonical strict-actor
--      blocks (restore_quote_version, draw_down_quote, ...) require
--      is_active = true; closed here as a separate block (the "close the gap
--      on the function you're already editing" rule) without touching the
--      verbatim line.
--   2. -- BEGIN/END draw-order lock guard (20260611120000) — the Codex HIGH
--      fix itself.
-- The self-verification block strips both insertions and md5-compares the
-- remainder against the live baseline.
--
-- Guard placement notes:
--   * AFTER `SELECT ... FOR UPDATE` — the orders row lock is already held, so
--     the booking_draw read cannot race a concurrent draw/void (both lock the
--     same row before writing it).
--   * AFTER the verbatim role check — rls-review L1 (2026-06-11): placed
--     before it, the RAISE would leak order_number + the booking_draw flag to
--     authenticated-but-unauthorized callers (drivers hold order UUIDs via
--     deliveries). Below the role gate, those callers keep getting the
--     pre-existing 'Not authorized' error and learn nothing new.
--   * BEFORE the idempotency check — a cached success for a draw order cannot
--     exist (the flag is set at INSERT by draw_down_quote and never toggled;
--     zero draw orders exist live pre-apply), and new attempts must always
--     see the lock error, never a stale cached result.
--
-- Status literals ('confirmed','pending', delivery/return/invoice sets) are
-- verbatim live carry-overs, not new writes.
--
-- Grants: live proacl is {postgres, authenticated, service_role} (no anon /
-- PUBLIC). CREATE OR REPLACE preserves the ACL; the REVOKE/GRANT below just
-- re-asserts the verified live state, and the self-verify block asserts it.
-- caller-analysis: update_order_items :: UI (src/pages/OrderDetail.tsx:425) and
--   offline queue (src/lib/offlineSync.ts:161) both call as the AUTHENTICATED
--   role, which keeps EXECUTE via the GRANT on the next line — the REVOKE
--   strips only PUBLIC/anon, which already lack EXECUTE live (proacl
--   {postgres,authenticated,service_role}). No caller loses access.
--
-- SMOKE TEST (rolled back): scripts/smoke/smoke-order-draw-lock.sql
-- (registered in scripts/smoke/smoke-specs.json under update_order_items).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.update_order_items(p_order_id uuid, p_items jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid; v_order record; v_old_item record; v_item jsonb; v_qty_diff numeric; v_new_total numeric;
  v_result jsonb; v_passed_ids uuid[]; v_new_item_id uuid; v_product record; v_new_qty numeric;
  v_new_price numeric; v_new_cost numeric; v_new_items_added integer := 0; v_new_product_id uuid;
  v_old_remaining numeric; v_blocking_table text; v_existing jsonb;
BEGIN
  -- Strict actor pattern (codex audit F2)
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found: %', p_order_id; END IF;
  IF v_order.status NOT IN ('confirmed', 'pending') THEN
    RAISE EXCEPTION 'Cannot edit order in status: %', v_order.status;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'Not authorized to update order items';
  END IF;

  -- BEGIN active-actor guard (20260611120000)
  -- rls-review L2 (2026-06-11): the verbatim role gate above lacks
  -- is_active, so a deactivated admin/sales_rep session could still edit
  -- items. Canonical strict-actor blocks require is_active = true.
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;
  -- END active-actor guard (20260611120000)

  -- BEGIN draw-order lock guard (20260611120000)
  -- Codex round-2 HIGH (2026-06-11): a draw-created order mirrors
  -- quote_product_draws (the booking ledger). Editing its items here would
  -- desync order vs ledger (e.g. draw 200, edit to 300: the ledger still says
  -- 200 and permits the same 100 to be drawn again). The sanctioned paths are
  -- void_order / cancel_order — both reverse the ledger (20260610185806) —
  -- then draw again at the corrected quantities.
  IF v_order.booking_draw THEN
    RAISE EXCEPTION 'BOOKING_DRAW_ORDER_LOCKED: order % was created by a booking draw-down — its items mirror the booking ledger. Void or cancel the order to return quantity to the booking, then draw again', v_order.order_number;
  END IF;
  -- END draw-order lock guard (20260611120000)

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'update_order_items');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT array_agg((el->>'id')::uuid) INTO v_passed_ids
    FROM jsonb_array_elements(p_items) el WHERE (el->>'id') IS NOT NULL;

  FOR v_old_item IN SELECT oi.* FROM order_items oi
    WHERE oi.order_id = p_order_id AND (v_passed_ids IS NULL OR oi.id != ALL(v_passed_ids))
  LOOP
    IF v_old_item.quantity_delivered > 0 THEN
      RAISE EXCEPTION 'Cannot remove "%" — % unit(s) have already been delivered. Edit the quantity instead.',
        v_old_item.product_name, v_old_item.quantity_delivered;
    END IF;

    IF EXISTS (SELECT 1 FROM delivery_items di JOIN deliveries d ON d.id = di.delivery_id
       WHERE di.order_item_id = v_old_item.id AND d.status NOT IN ('cancelled', 'voided') LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot remove "%" — it is linked to an active delivery. Remove it from the delivery first.', v_old_item.product_name;
    END IF;

    DELETE FROM delivery_items WHERE order_item_id = v_old_item.id
      AND delivery_id IN (SELECT id FROM deliveries WHERE status IN ('cancelled', 'voided'));

    IF EXISTS (SELECT 1 FROM return_items ri JOIN returns r ON r.id = ri.return_id
       WHERE ri.order_item_id = v_old_item.id AND r.status NOT IN ('cancelled', 'rejected') LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot remove "%" — it is linked to a return/RMA. Process or cancel the return first.', v_old_item.product_name;
    END IF;

    UPDATE return_items SET order_item_id = NULL WHERE order_item_id = v_old_item.id
      AND return_id IN (SELECT id FROM returns WHERE status IN ('cancelled', 'rejected'));

    DELETE FROM delivery_remainders WHERE order_item_id = v_old_item.id
      AND (status IN ('resolved', 'cancelled')
           OR original_delivery_id IN (SELECT id FROM deliveries WHERE status IN ('cancelled', 'voided')));

    IF EXISTS (SELECT 1 FROM delivery_remainders WHERE order_item_id = v_old_item.id LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot remove "%" — it has active delivery remainder records. Resolve or cancel them first.', v_old_item.product_name;
    END IF;

    DELETE FROM order_line_allocations WHERE order_item_id = v_old_item.id;

    IF EXISTS (SELECT 1 FROM invoice_items ii JOIN invoices inv ON inv.id = ii.invoice_id
       WHERE ii.order_item_id = v_old_item.id AND inv.status NOT IN ('draft', 'voided', 'cancelled') LIMIT 1) THEN
      RAISE EXCEPTION 'Cannot remove "%" — it is linked to a posted or paid invoice. Void the invoice first.', v_old_item.product_name;
    END IF;

    UPDATE invoice_items SET order_item_id = NULL WHERE order_item_id = v_old_item.id
      AND invoice_id IN (SELECT id FROM invoices WHERE status IN ('draft', 'voided', 'cancelled'));

    IF v_old_item.quantity_remaining > 0 THEN
      UPDATE inventory SET quantity_prebooked = GREATEST(quantity_prebooked - v_old_item.quantity_remaining, 0), updated_at = now()
        WHERE product_id = v_old_item.product_id AND location = 'Main Warehouse';
      INSERT INTO inventory_transactions (product_id, transaction_type, quantity, order_id, performed_by, notes)
      VALUES (v_old_item.product_id, 'released', v_old_item.quantity_remaining, p_order_id, v_actor,
        'Order edit: item removed from ' || v_order.order_number);
    END IF;

    DELETE FROM order_items WHERE id = v_old_item.id;
  END LOOP;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    IF (v_item->>'id') IS NOT NULL THEN
      SELECT * INTO v_old_item FROM order_items WHERE id = (v_item->>'id')::uuid;
      IF NOT FOUND THEN CONTINUE; END IF;

      v_new_product_id := COALESCE((v_item->>'product_id')::uuid, v_old_item.product_id);
      v_qty_diff := (v_item->>'total_units_needed')::numeric - v_old_item.total_units_needed;

      IF v_new_product_id IS DISTINCT FROM v_old_item.product_id THEN
        v_old_remaining := GREATEST(v_old_item.total_units_needed - v_old_item.quantity_delivered, 0);
        IF v_old_remaining > 0 THEN
          UPDATE inventory SET quantity_prebooked = GREATEST(quantity_prebooked - v_old_remaining, 0), updated_at = now()
          WHERE product_id = v_old_item.product_id AND location = 'Main Warehouse';
          INSERT INTO inventory_transactions (product_id, transaction_type, quantity, order_id, performed_by, notes)
          VALUES (v_old_item.product_id, 'released', v_old_remaining, p_order_id, v_actor,
            'Order edit: product swapped from ' || v_old_item.product_name || ' on ' || v_order.order_number);
        END IF;

        v_new_qty := (v_item->>'total_units_needed')::numeric;
        IF v_new_qty > 0 THEN
          UPDATE inventory SET quantity_prebooked = quantity_prebooked + v_new_qty, updated_at = now()
          WHERE product_id = v_new_product_id AND location = 'Main Warehouse';
          INSERT INTO inventory_transactions (product_id, transaction_type, quantity, order_id, performed_by, notes)
          VALUES (v_new_product_id, 'prebooked', v_new_qty, p_order_id, v_actor,
            'Order edit: product swapped to ' || COALESCE(v_item->>'product_name', '') || ' on ' || v_order.order_number);
        END IF;

        v_new_cost := COALESCE((v_item->>'cost_per_unit')::numeric, 0);
        IF v_new_cost = 0 THEN
          SELECT current_cost INTO v_new_cost FROM products WHERE id = v_new_product_id;
          v_new_cost := COALESCE(v_new_cost, 0);
        END IF;

        UPDATE order_items SET
          product_id = v_new_product_id,
          product_name = COALESCE(v_item->>'product_name', product_name),
          unit_size = COALESCE(v_item->>'unit_size', unit_size),
          cost_per_unit = v_new_cost,
          price_per_unit = (v_item->>'price_per_unit')::numeric,
          total_units_needed = (v_item->>'total_units_needed')::numeric,
          quantity_remaining = GREATEST((v_item->>'total_units_needed')::numeric - v_old_item.quantity_delivered, 0),
          total_price = (v_item->>'price_per_unit')::numeric * (v_item->>'total_units_needed')::numeric,
          profit = ((v_item->>'price_per_unit')::numeric - v_new_cost) * (v_item->>'total_units_needed')::numeric,
          net_margin = CASE WHEN (v_item->>'price_per_unit')::numeric > 0
            THEN ROUND((((v_item->>'price_per_unit')::numeric - v_new_cost) / (v_item->>'price_per_unit')::numeric) * 100, 2)
            ELSE 0 END
        WHERE id = v_old_item.id;
      ELSE
        UPDATE order_items SET
          product_name = COALESCE(v_item->>'product_name', product_name),
          price_per_unit = (v_item->>'price_per_unit')::numeric,
          total_units_needed = (v_item->>'total_units_needed')::numeric,
          quantity_remaining = GREATEST((v_item->>'total_units_needed')::numeric - v_old_item.quantity_delivered, 0),
          total_price = (v_item->>'price_per_unit')::numeric * (v_item->>'total_units_needed')::numeric
        WHERE id = v_old_item.id;

        IF v_qty_diff <> 0 THEN
          UPDATE inventory SET quantity_prebooked = GREATEST(quantity_prebooked + v_qty_diff, 0), updated_at = now()
          WHERE product_id = v_old_item.product_id AND location = 'Main Warehouse';
          INSERT INTO inventory_transactions (product_id, transaction_type, quantity, order_id, performed_by, notes)
          VALUES (v_old_item.product_id, CASE WHEN v_qty_diff > 0 THEN 'prebooked' ELSE 'released' END,
            ABS(v_qty_diff), p_order_id, v_actor, 'Order edit: adjusted prebooked by ' || v_qty_diff);
        END IF;
      END IF;
    ELSE
      v_new_qty := COALESCE((v_item->>'total_units_needed')::numeric, 0);
      v_new_price := COALESCE((v_item->>'price_per_unit')::numeric, 0);
      v_new_cost := COALESCE((v_item->>'cost_per_unit')::numeric, 0);
      IF v_new_cost = 0 AND (v_item->>'product_id') IS NOT NULL THEN
        SELECT current_cost INTO v_new_cost FROM products WHERE id = (v_item->>'product_id')::uuid;
        v_new_cost := COALESCE(v_new_cost, 0);
      END IF;
      IF v_new_qty <= 0 THEN CONTINUE; END IF;

      v_new_item_id := gen_random_uuid();
      INSERT INTO order_items (id, order_id, product_id, product_name, price_per_unit, cost_per_unit,
        total_units_needed, unit_size, section_name, total_price, profit, net_margin, quantity_delivered, quantity_remaining)
      VALUES (v_new_item_id, p_order_id, (v_item->>'product_id')::uuid, COALESCE(v_item->>'product_name', ''),
        v_new_price, v_new_cost, v_new_qty, v_item->>'unit_size', v_item->>'section_name',
        v_new_price * v_new_qty, (v_new_price - v_new_cost) * v_new_qty,
        CASE WHEN v_new_price > 0 THEN ROUND(((v_new_price - v_new_cost) / v_new_price) * 100, 2) ELSE 0 END,
        0, v_new_qty);

      UPDATE inventory SET quantity_prebooked = quantity_prebooked + v_new_qty, updated_at = now()
      WHERE product_id = (v_item->>'product_id')::uuid AND location = 'Main Warehouse';

      INSERT INTO inventory_transactions (product_id, transaction_type, quantity, order_id, performed_by, notes)
      VALUES ((v_item->>'product_id')::uuid, 'prebooked', v_new_qty, p_order_id, v_actor,
        'New item added to existing order ' || v_order.order_number);

      v_new_items_added := v_new_items_added + 1;
    END IF;
  END LOOP;

  SELECT COALESCE(SUM(total_price), 0) INTO v_new_total FROM order_items WHERE order_id = p_order_id;
  UPDATE orders SET total_price = v_new_total, updated_at = now() WHERE id = p_order_id;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('order_edited',
    'Order ' || v_order.order_number || ' items updated' ||
    CASE WHEN v_new_items_added > 0 THEN ' (' || v_new_items_added || ' new item(s) added)' ELSE '' END ||
    ' — new total $' || ROUND(v_new_total, 2),
    v_actor, 'order', p_order_id, v_order.customer_id);

  v_result := jsonb_build_object('status', 'updated', 'new_items_added', v_new_items_added);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'update_order_items', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

-- Grants: re-assert the verified live state (no anon/PUBLIC; CREATE OR REPLACE
-- preserves the existing ACL — this is belt-and-suspenders, not a change).
REVOKE EXECUTE ON FUNCTION public.update_order_items(uuid, jsonb, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_order_items(uuid, jsonb, uuid, text) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Self-verification
-- ----------------------------------------------------------------------------
DO $verify$
DECLARE
  v_count int;
  v_src text;
  v_body text;
  v_b int;
  v_e int;
  v_end_marker text := '  -- END draw-order lock guard (20260611120000)' || E'\n\n';
  v_end_marker2 text := '  -- END active-actor guard (20260611120000)' || E'\n\n';
  v_md5 text;
BEGIN
  -- 1. Overload count unchanged (live pre-apply: exactly 1)
  SELECT count(*) INTO v_count
  FROM pg_proc WHERE proname = 'update_order_items' AND pronamespace = 'public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'update_order_items overload count = %, expected 1', v_count;
  END IF;

  SELECT prosrc INTO v_src
  FROM pg_proc WHERE proname = 'update_order_items' AND pronamespace = 'public'::regnamespace;

  -- 2. Both guards present
  IF v_src NOT LIKE '%BOOKING_DRAW_ORDER_LOCKED%'
     OR v_src NOT LIKE '%BEGIN draw-order lock guard (20260611120000)%' THEN
    RAISE EXCEPTION 'update_order_items is missing the draw-order lock guard';
  END IF;
  IF v_src NOT LIKE '%BEGIN active-actor guard (20260611120000)%'
     OR v_src NOT LIKE '%INSUFFICIENT_ROLE%' THEN
    RAISE EXCEPTION 'update_order_items is missing the active-actor guard';
  END IF;

  -- 3. Verbatim fidelity: body minus the two insertions must md5-match the
  --    pre-apply live body exactly (line endings normalized).
  v_body := replace(v_src, E'\r\n', E'\n');
  v_b := position('  -- BEGIN draw-order lock guard (20260611120000)' IN v_body);
  v_e := position(v_end_marker IN v_body);
  IF v_b = 0 OR v_e = 0 OR v_e < v_b THEN
    RAISE EXCEPTION 'draw-order lock guard markers not found or misordered in update_order_items body';
  END IF;
  v_body := left(v_body, v_b - 1) || substr(v_body, v_e + length(v_end_marker));
  v_b := position('  -- BEGIN active-actor guard (20260611120000)' IN v_body);
  v_e := position(v_end_marker2 IN v_body);
  IF v_b = 0 OR v_e = 0 OR v_e < v_b THEN
    RAISE EXCEPTION 'active-actor guard markers not found or misordered in update_order_items body';
  END IF;
  v_body := left(v_body, v_b - 1) || substr(v_body, v_e + length(v_end_marker2));
  v_md5 := md5(v_body);
  IF v_md5 <> 'd3dc700951bd9409831b99bda6f26417' THEN
    RAISE EXCEPTION 'update_order_items body-minus-guards md5 = % (expected d3dc700951bd9409831b99bda6f26417) — verbatim drift', v_md5;
  END IF;

  -- 4. SECDEF + search_path intact
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'update_order_items' AND pronamespace = 'public'::regnamespace
      AND prosecdef
      AND array_to_string(proconfig, ',') LIKE '%search_path=public, pg_temp%'
  ) THEN
    RAISE EXCEPTION 'update_order_items must be SECURITY DEFINER with search_path = public, pg_temp';
  END IF;

  -- 5. Grants: authenticated keeps EXECUTE (in-body auth is the gate), anon
  --    must not have it, service_role must.
  IF NOT has_function_privilege('authenticated', 'public.update_order_items(uuid,jsonb,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'update_order_items: authenticated lost EXECUTE';
  END IF;
  IF has_function_privilege('anon', 'public.update_order_items(uuid,jsonb,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'update_order_items: anon has EXECUTE';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.update_order_items(uuid,jsonb,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'update_order_items: service_role lost EXECUTE';
  END IF;
END $verify$;
