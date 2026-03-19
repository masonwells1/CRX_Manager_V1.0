-- ============================================================================
-- Remove blocking inventory pre-check from complete_delivery()
--
-- CHANGE: Inventory shortages should NOT block delivery completion.
-- If a driver has physical product on the truck and delivers it, we should
-- record that delivery regardless of what our inventory system says.
--
-- Instead of RAISE EXCEPTION on insufficient inventory:
--   1. Still deduct inventory (can go negative)
--   2. Log a warning notification to admins when inventory goes negative
--   3. Log to activity_feed for audit trail
--
-- Scheduling a delivery will show a frontend warning but not block.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.complete_delivery(
  p_delivery_id uuid,
  p_signed_by text,
  p_performed_by uuid DEFAULT NULL,
  p_quantities jsonb DEFAULT NULL,
  p_issue_type text DEFAULT NULL,
  p_issue_notes text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_delivery record;
  v_item record;
  v_inv record;
  v_qty_to_deliver numeric;
  v_deduct_from_prebooked numeric;
  v_any_partial boolean := false;
  v_any_negative_inventory boolean := false;
  v_negative_items text[] := '{}';
  v_all_delivered boolean;
  v_linked_invoice record;
  v_result jsonb;
  v_existing jsonb;
  v_actor uuid;
  v_actor_role text;
  v_admin record;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());
  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor;
  IF v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'Only admin or sales_rep can complete deliveries';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'complete_delivery');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_delivery FROM deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery not found: %', p_delivery_id; END IF;
  IF v_delivery.status = 'completed' THEN RAISE EXCEPTION 'Delivery already completed'; END IF;
  IF v_delivery.status = 'cancelled' THEN RAISE EXCEPTION 'Cannot complete a cancelled delivery'; END IF;

  -- NOTE: No blocking inventory pre-check.
  -- Inventory shortages should not prevent delivery completion.
  -- If inventory goes negative, admins are notified.

  -- Phase 1: Update delivery status
  UPDATE deliveries SET
    status = 'completed', completed_at = now(), signed_by = p_signed_by,
    issue_type = COALESCE(p_issue_type, issue_type),
    issue_notes = CASE WHEN p_issue_notes IS NOT NULL THEN p_issue_notes ELSE issue_notes END
  WHERE id = p_delivery_id;

  -- Phase 2: Process each item
  FOR v_item IN
    SELECT di.*, p.product_name
    FROM delivery_items di JOIN products p ON p.id = di.product_id
    WHERE di.delivery_id = p_delivery_id
  LOOP
    IF p_quantities IS NOT NULL AND p_quantities ? v_item.id::text THEN
      v_qty_to_deliver := GREATEST(0, LEAST((p_quantities->>v_item.id::text)::numeric, v_item.quantity));
    ELSE
      v_qty_to_deliver := v_item.quantity;
    END IF;

    UPDATE delivery_items SET quantity_delivered = v_qty_to_deliver WHERE id = v_item.id;
    IF v_qty_to_deliver = 0 THEN CONTINUE; END IF;

    IF v_qty_to_deliver < v_item.quantity THEN v_any_partial := true; END IF;

    UPDATE order_items SET
      quantity_delivered = quantity_delivered + v_qty_to_deliver,
      quantity_remaining = GREATEST(quantity_remaining - v_qty_to_deliver, 0)
    WHERE id = v_item.order_item_id;

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, from_location,
      order_id, delivery_id, performed_by, notes
    ) VALUES (
      v_item.product_id, 'delivered', v_qty_to_deliver, 'Main Warehouse',
      v_delivery.order_id, p_delivery_id, v_actor,
      'Delivery ' || v_delivery.delivery_number ||
        CASE WHEN v_qty_to_deliver < v_item.quantity
          THEN ' (partial: ' || v_qty_to_deliver || '/' || v_item.quantity || ')'
          ELSE '' END || '. Signed by: ' || p_signed_by
    );

    -- Deduct FULL delivery qty from available, reduce prebooked separately
    SELECT * INTO v_inv FROM inventory
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse' FOR UPDATE;

    IF FOUND THEN
      v_deduct_from_prebooked := LEAST(v_qty_to_deliver, COALESCE(v_inv.quantity_prebooked, 0));

      UPDATE inventory SET
        quantity_available = quantity_available - v_qty_to_deliver,
        quantity_prebooked = quantity_prebooked - v_deduct_from_prebooked,
        updated_at = now()
      WHERE product_id = v_item.product_id AND location = 'Main Warehouse';

      -- Track if inventory went negative
      IF (v_inv.quantity_available - v_qty_to_deliver) < 0 THEN
        v_any_negative_inventory := true;
        v_negative_items := array_append(v_negative_items,
          v_item.product_name || ' (' ||
            (v_inv.quantity_available - v_qty_to_deliver) || ' after delivery)');
      END IF;
    ELSE
      -- No inventory record exists — create one with negative quantity
      INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked)
      VALUES (v_item.product_id, 'Main Warehouse', -v_qty_to_deliver, 0);

      v_any_negative_inventory := true;
      v_negative_items := array_append(v_negative_items,
        v_item.product_name || ' (-' || v_qty_to_deliver || ' after delivery, no prior record)');
    END IF;
  END LOOP;

  -- Phase 3: Handle partial deliveries → create remainders
  IF v_any_partial THEN
    FOR v_item IN
      SELECT di.*, p.product_name
      FROM delivery_items di JOIN products p ON p.id = di.product_id
      WHERE di.delivery_id = p_delivery_id AND di.quantity_delivered < di.quantity
    LOOP
      INSERT INTO delivery_remainders (
        original_delivery_id, order_id, order_item_id,
        customer_id, product_id, quantity_remaining, unit_size
      ) VALUES (
        p_delivery_id, v_delivery.order_id, v_item.order_item_id,
        v_delivery.customer_id, v_item.product_id,
        v_item.quantity - v_item.quantity_delivered, v_item.unit_size
      );
    END LOOP;
  END IF;

  -- Phase 4: Update order fulfillment status
  SELECT NOT EXISTS (
    SELECT 1 FROM order_items WHERE order_id = v_delivery.order_id AND quantity_remaining > 0
  ) INTO v_all_delivered;

  UPDATE orders SET
    status = CASE WHEN v_all_delivered THEN 'fulfilled' ELSE 'partially_fulfilled' END,
    updated_at = now()
  WHERE id = v_delivery.order_id;

  -- Phase 5: Auto-adjust linked draft invoices for partial deliveries
  IF v_any_partial AND v_delivery.order_id IS NOT NULL THEN
    FOR v_linked_invoice IN
      SELECT * FROM invoices
      WHERE order_id = v_delivery.order_id AND status = 'draft' AND delivery_id = p_delivery_id
    LOOP
      UPDATE invoice_items ii SET
        quantity = di.quantity_delivered,
        extended_cents = ROUND(di.quantity_delivered * ii.unit_price_cents)
      FROM delivery_items di
      WHERE di.delivery_id = p_delivery_id
        AND ii.invoice_id = v_linked_invoice.id
        AND ii.product_id = di.product_id;

      UPDATE invoices SET
        total_amount_cents = (
          SELECT COALESCE(SUM(extended_cents), 0) FROM invoice_items WHERE invoice_id = v_linked_invoice.id
        ),
        updated_at = now()
      WHERE id = v_linked_invoice.id;
    END LOOP;
  END IF;

  -- Phase 6: Notify admins if inventory went negative
  IF v_any_negative_inventory THEN
    FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
    LOOP
      INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
      VALUES (
        v_admin.id,
        'Negative Inventory After Delivery',
        'Delivery ' || v_delivery.delivery_number || ' completed but caused negative inventory: ' ||
          array_to_string(v_negative_items, '; ') || '. Please verify physical stock.',
        'inventory_alert', 'delivery', p_delivery_id
      );
    END LOOP;

    -- Also log to activity feed
    INSERT INTO activity_feed (
      event_type, description, performed_by,
      related_entity_type, related_entity_id, customer_id
    ) VALUES (
      'inventory_warning',
      'Delivery ' || v_delivery.delivery_number || ' caused negative inventory: ' ||
        array_to_string(v_negative_items, '; '),
      v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
    );
  END IF;

  -- Activity log
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'delivery_completed',
    'Delivery ' || v_delivery.delivery_number || ' completed. Signed by: ' || p_signed_by ||
      CASE WHEN v_any_partial THEN ' (partial delivery — remainders created)' ELSE '' END,
    v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  v_result := jsonb_build_object(
    'status', CASE WHEN v_any_partial THEN 'partial' ELSE 'completed' END,
    'delivery_id', p_delivery_id,
    'order_fulfilled', v_all_delivered,
    'negative_inventory', v_any_negative_inventory
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'complete_delivery', v_result);
  END IF;

  RETURN v_result;
END;
$$;
