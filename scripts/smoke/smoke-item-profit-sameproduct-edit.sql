-- ============================================================================
-- ROLLED-BACK smoke for 20260617123503_refresh_item_profit_on_sameproduct_order_edit
-- ----------------------------------------------------------------------------
-- Proves the same-product edit branch of update_order_items now refreshes the
-- per-line order_items.profit / net_margin (previously left stale), AND that the
-- verbatim-reproduced commission-recompute block still rescales pending commissions
-- from the (correct) order header.
--
-- PRE-APPLY safe: the first statement CREATE OR REPLACEs the NEW function, then the
-- DO block exercises it, then RAISE 'SMOKE_PASS_ROLLBACK' aborts — rolling back the
-- function redefinition AND every fixture. Zero prod footprint. Run as a SINGLE
-- execute_sql call. "SMOKE_PASS_ROLLBACK" = pass; any other error = real failure.
-- After the migration is applied, the CREATE OR REPLACE is idempotent so this file
-- still serves as a post-apply smoke.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.update_order_items(
  p_order_id uuid,
  p_items jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid; v_order record; v_old_item record; v_item jsonb; v_qty_diff numeric; v_new_total numeric;
  v_result jsonb; v_passed_ids uuid[]; v_new_item_id uuid; v_product record; v_new_qty numeric;
  v_new_price numeric; v_new_cost numeric; v_new_items_added integer := 0; v_new_product_id uuid;
  v_old_remaining numeric; v_blocking_table text; v_existing jsonb;
BEGIN
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

  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF v_order.booking_draw THEN
    RAISE EXCEPTION 'BOOKING_DRAW_ORDER_LOCKED: order % was created by a booking draw-down — its items mirror the booking ledger. Void or cancel the order to return quantity to the booking, then draw again', v_order.order_number;
  END IF;

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

    PERFORM set_config('app.admin_override', 'true', true);
    DELETE FROM delivery_items WHERE order_item_id = v_old_item.id
      AND delivery_id IN (SELECT id FROM deliveries WHERE status IN ('cancelled', 'voided'));
    PERFORM set_config('app.admin_override', 'false', true);

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
          total_price = (v_item->>'price_per_unit')::numeric * (v_item->>'total_units_needed')::numeric,
          profit = ((v_item->>'price_per_unit')::numeric - COALESCE(v_old_item.cost_per_unit, 0)) * (v_item->>'total_units_needed')::numeric,
          net_margin = CASE WHEN (v_item->>'price_per_unit')::numeric > 0
            THEN ROUND((((v_item->>'price_per_unit')::numeric - COALESCE(v_old_item.cost_per_unit, 0)) / (v_item->>'price_per_unit')::numeric) * 100, 2)
            ELSE 0 END
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

  UPDATE commissions c
     SET order_profit      = ROUND(COALESCE(o.total_profit, 0), 2),
         commission_amount = compute_commission_amount(o.total_profit, c.split_percentage)
    FROM orders o
   WHERE c.order_id = p_order_id
     AND o.id = p_order_id
     AND c.status = 'pending'
     AND c.deleted_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM commission_payment_items cpi
       JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
       WHERE cpi.commission_id = c.id AND cp.status <> 'voided'
     );

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

DO $smoke$
DECLARE
  v_admin uuid; v_customer uuid; v_product uuid; v_order uuid; v_item uuid;
  v_suffix text := substr(md5(random()::text),1,8);
  v_profit numeric; v_margin numeric; v_total numeric;
  v_oprofit numeric; v_omargin numeric;
  v_cprofit numeric; v_camt numeric;
BEGIN
  SELECT id INTO v_admin FROM profiles WHERE role='admin' AND is_active=true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: no active admin profile'; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role','authenticated')::text, true);

  -- Fixtures (owner; rolled back at the end)
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] ItemProfit '||v_suffix) RETURNING id INTO v_customer;
  INSERT INTO products (product_name, current_cost) VALUES ('[SMOKE] ItemProfit Prod '||v_suffix, 6) RETURNING id INTO v_product;
  INSERT INTO orders (order_number, customer_id, status, booking_draw)
    VALUES ('[SMOKE] OIP-'||v_suffix, v_customer, 'confirmed', false) RETURNING id INTO v_order;
  INSERT INTO order_items (order_id, product_id, product_name, price_per_unit, cost_per_unit,
    total_units_needed, total_price, profit, net_margin, quantity_delivered, quantity_remaining)
    VALUES (v_order, v_product, '[SMOKE] line', 10, 6, 100, 1000, 400, 40.00, 0, 100) RETURNING id INTO v_item;

  -- Pending commission @ 100% to confirm the verbatim recompute block still fires
  INSERT INTO commissions (order_id, customer_id, recipient, split_percentage, order_profit, commission_amount, status)
    VALUES (v_order, v_customer, 'Smoke Rep', 100, 400, compute_commission_amount(400, 100), 'pending');

  -- Baseline sanity: header initialized by trg_recalc_order_totals to 400 / 40.00
  SELECT total_profit, total_margin_pct INTO v_oprofit, v_omargin FROM orders WHERE id=v_order;
  IF v_oprofit IS DISTINCT FROM 400 OR v_omargin IS DISTINCT FROM 40.00 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: baseline header = %/% (expected 400/40.00)', v_oprofit, v_omargin;
  END IF;

  -- SCENARIO A: same-product PRICE 10 -> 12 (qty 100). Pre-fix the line profit/margin
  -- would stay 400/40.00; the fix must move them to 600/50.00.
  PERFORM update_order_items(v_order,
    jsonb_build_array(jsonb_build_object('id', v_item, 'product_id', v_product,
      'price_per_unit', 12, 'total_units_needed', 100)), v_admin, NULL);
  SELECT profit, net_margin, total_price INTO v_profit, v_margin, v_total FROM order_items WHERE id=v_item;
  IF v_profit IS DISTINCT FROM 600 OR v_margin IS DISTINCT FROM 50.00 OR v_total IS DISTINCT FROM 1200 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (A) line profit/margin/total = %/%/% (expected 600/50.00/1200)', v_profit, v_margin, v_total;
  END IF;
  SELECT total_profit, total_margin_pct INTO v_oprofit, v_omargin FROM orders WHERE id=v_order;
  IF v_oprofit IS DISTINCT FROM 600 OR v_omargin IS DISTINCT FROM 50.00 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (A) header profit/margin = %/% (expected 600/50.00)', v_oprofit, v_omargin;
  END IF;
  SELECT order_profit, commission_amount INTO v_cprofit, v_camt FROM commissions WHERE order_id=v_order;
  IF v_cprofit IS DISTINCT FROM 600 OR v_camt IS DISTINCT FROM compute_commission_amount(600,100) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (A) pending commission not rescaled: profit=%, amt=% (expected 600 / %)',
      v_cprofit, v_camt, compute_commission_amount(600,100);
  END IF;

  -- SCENARIO B: same-product QTY 100 -> 150, price back to 10 -> profit (10-6)*150=600, margin 40.00
  PERFORM update_order_items(v_order,
    jsonb_build_array(jsonb_build_object('id', v_item, 'product_id', v_product,
      'price_per_unit', 10, 'total_units_needed', 150)), v_admin, NULL);
  SELECT profit, net_margin, total_price INTO v_profit, v_margin, v_total FROM order_items WHERE id=v_item;
  IF v_profit IS DISTINCT FROM 600 OR v_margin IS DISTINCT FROM 40.00 OR v_total IS DISTINCT FROM 1500 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (B) line profit/margin/total = %/%/% (expected 600/40.00/1500)', v_profit, v_margin, v_total;
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
