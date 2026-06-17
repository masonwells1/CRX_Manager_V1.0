-- Recompute pending commissions when an order's items are edited.
--
-- nightly-debug finding `lifecycle:update_order_items:stale-profit-and-commissions`.
-- Verified live 2026-06-16: editing an order's items already keeps the ORDER HEADER
-- correct — the `after_order_items_change` trigger (trg_recalc_order_totals) recomputes
-- orders.total_price / total_cost / total_profit / total_margin_pct on every
-- order_items insert/update/delete. The real gap is the DENORMALIZED `commissions`
-- rows: their order_profit / commission_amount are snapshotted at order creation
-- (_insert_commissions_for_order) and were never refreshed on an edit, so commission
-- reports and payouts went stale after the order changed.
--
-- Fix (Mason's policy, 2026-06-16): after items change, rescale each PENDING commission
-- to the new profit by its OWN snapshotted split_percentage. PAID and cancelled rows are
-- FROZEN — never silently change an already-paid payout. recipient / split_percentage are
-- left untouched so a later change to the customer's commission split does NOT
-- re-attribute this order's commissions. Each pending recipient's amount uses the
-- same per-recipient formula as creation (compute_commission_amount); a multi-recipient
-- order's recomputed TOTAL may differ from creation's largest-remainder reconciliation
-- by at most one cent — accepted, since per-recipient amounts are correct and the
-- commissions table carries no sum-to-profit invariant. Runs automatically inside
-- update_order_items.
--
-- This is a verbatim reproduction of the live update_order_items
-- (uuid, jsonb, uuid, text) with ONE added block (marked below); every other line
-- is byte-identical to the deployed function.

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

    -- BEGIN delivery-item lock pairing (20260616220000)
    -- This migration broadens _enforce_delivery_items_parent_lock to block
    -- delivery_items writes on ANY non-scheduled parent (incl. cancelled/voided).
    -- This cleanup of orphaned items on already-cancelled/voided deliveries is a
    -- sanctioned housekeeping write, so it brackets app.admin_override exactly
    -- like complete_delivery / void_delivery. Transaction-local; reset right after.
    PERFORM set_config('app.admin_override', 'true', true);
    DELETE FROM delivery_items WHERE order_item_id = v_old_item.id
      AND delivery_id IN (SELECT id FROM deliveries WHERE status IN ('cancelled', 'voided'));
    PERFORM set_config('app.admin_override', 'false', true);
    -- END delivery-item lock pairing (20260616220000)

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

  -- BEGIN commission recompute on edit (20260617040000)
  -- The after_order_items_change trigger (trg_recalc_order_totals) already refreshed
  -- orders.total_profit / total_margin_pct above from the edited line items, so re-read
  -- the fresh profit and rescale every PENDING commission for this order by its OWN
  -- snapshotted split_percentage. PAID and cancelled rows are FROZEN (Mason 2026-06-16:
  -- never silently change an already-paid payout); soft-deleted rows are skipped.
  -- recipient / split_percentage are left untouched so a later change to the customer's
  -- commission split does NOT re-attribute this order's commissions. Each pending
  -- recipient's amount uses the same per-recipient formula as creation
  -- (compute_commission_amount, as used by _insert_commissions_for_order). No-op when
  -- the order has no commission rows.
  UPDATE commissions c
     SET order_profit      = ROUND(COALESCE(o.total_profit, 0), 2),
         commission_amount = compute_commission_amount(o.total_profit, c.split_percentage)
    FROM orders o
   WHERE c.order_id = p_order_id
     AND o.id = p_order_id
     AND c.status = 'pending'
     AND c.deleted_at IS NULL
     -- Codex P1 (2026-06-16): a pending commission already pulled into a NON-voided
     -- commission-payment batch has its amount snapshotted in commission_payment_items
     -- (and summed into commission_payments.total_amount); rewriting it here would
     -- desync the batch. Freeze those too — only a voided batch releases the commission
     -- back to recompute. (Posting a batch already flips its commissions to 'paid'.)
     AND NOT EXISTS (
       SELECT 1 FROM commission_payment_items cpi
       JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
       WHERE cpi.commission_id = c.id AND cp.status <> 'voided'
     );
  -- END commission recompute on edit (20260617040000)

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
