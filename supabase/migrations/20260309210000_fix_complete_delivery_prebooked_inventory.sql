-- Fix complete_delivery() to properly handle prebooked inventory
-- Bug: Pre-check only looked at quantity_available, but stock was moved to quantity_prebooked
-- when the delivery was created. Completion should deduct from prebooked first.
--
-- Two changes:
-- 1. Pre-check: quantity_available + quantity_prebooked >= needed (was: quantity_available >= needed)
-- 2. Deduction: Deduct from prebooked first, then available for remainder (was: both equally)
-- 3. Also: Allow sales_rep role to complete deliveries (was: only admin + driver)

CREATE OR REPLACE FUNCTION public.complete_delivery(
  p_delivery_id uuid,
  p_signed_by text,
  p_performed_by uuid,
  p_quantities jsonb DEFAULT NULL,
  p_issue_type text DEFAULT NULL,
  p_issue_notes text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_delivery record;
  v_item record;
  v_inv record;
  v_all_delivered boolean;
  v_qty_to_deliver numeric;
  v_any_partial boolean := false;
  v_linked_invoice record;
  v_old_total bigint;
  v_new_total bigint;
  v_admin record;
  v_deduct_from_prebooked numeric;
  v_deduct_from_available numeric;
BEGIN
  SELECT * INTO v_delivery FROM deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery not found'; END IF;

  IF v_delivery.status = 'completed' THEN
    RETURN jsonb_build_object('status', 'already_completed');
  END IF;
  IF v_delivery.status != 'in_progress' THEN
    RAISE EXCEPTION 'Delivery must be started before completing. Current status: %', v_delivery.status;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = p_performed_by AND is_active = true
      AND (role IN ('admin', 'sales_rep') OR (role = 'driver' AND p_performed_by = v_delivery.assigned_driver))
  ) THEN RAISE EXCEPTION 'Not authorized to complete this delivery'; END IF;

  -- PRE-CHECK INVENTORY (now accounts for prebooked stock)
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

    IF v_qty_to_deliver < v_item.quantity THEN v_any_partial := true; END IF;
    IF v_qty_to_deliver = 0 THEN CONTINUE; END IF;

    SELECT * INTO v_inv FROM inventory
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse' FOR UPDATE;

    -- FIX: Check available + prebooked (prebooked stock IS reserved for deliveries)
    IF NOT FOUND OR (v_inv.quantity_available + v_inv.quantity_prebooked) < v_qty_to_deliver THEN
      RAISE EXCEPTION 'Insufficient inventory for %: need % units, only % available (% on-hand + % prebooked)',
        v_item.product_name, v_qty_to_deliver,
        COALESCE(v_inv.quantity_available, 0) + COALESCE(v_inv.quantity_prebooked, 0),
        COALESCE(v_inv.quantity_available, 0),
        COALESCE(v_inv.quantity_prebooked, 0);
    END IF;
  END LOOP;

  UPDATE deliveries SET
    status = 'completed', completed_at = now(), signed_by = p_signed_by,
    issue_type = COALESCE(p_issue_type, issue_type),
    issue_notes = CASE WHEN p_issue_notes IS NOT NULL THEN p_issue_notes ELSE issue_notes END
  WHERE id = p_delivery_id;

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

    UPDATE order_items SET
      quantity_delivered = quantity_delivered + v_qty_to_deliver,
      quantity_remaining = GREATEST(quantity_remaining - v_qty_to_deliver, 0)
    WHERE id = v_item.order_item_id;

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, from_location,
      order_id, delivery_id, performed_by, notes
    ) VALUES (
      v_item.product_id, 'delivered', v_qty_to_deliver, 'Main Warehouse',
      v_delivery.order_id, p_delivery_id, p_performed_by,
      'Delivery ' || v_delivery.delivery_number ||
        CASE WHEN v_qty_to_deliver < v_item.quantity
          THEN ' (partial: ' || v_qty_to_deliver || '/' || v_item.quantity || ')'
          ELSE '' END || '. Signed by: ' || p_signed_by
    );

    -- FIX: Deduct from prebooked FIRST, then from available for the remainder
    SELECT * INTO v_inv FROM inventory
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';

    v_deduct_from_prebooked := LEAST(v_qty_to_deliver, COALESCE(v_inv.quantity_prebooked, 0));
    v_deduct_from_available := v_qty_to_deliver - v_deduct_from_prebooked;

    UPDATE inventory SET
      quantity_available = quantity_available - v_deduct_from_available,
      quantity_prebooked = quantity_prebooked - v_deduct_from_prebooked,
      updated_at = now()
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';
  END LOOP;

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

  SELECT NOT EXISTS (
    SELECT 1 FROM order_items WHERE order_id = v_delivery.order_id AND quantity_remaining > 0
  ) INTO v_all_delivered;

  UPDATE orders SET
    status = CASE WHEN v_all_delivered THEN 'fulfilled' ELSE 'partially_fulfilled' END,
    updated_at = now()
  WHERE id = v_delivery.order_id;

  IF v_any_partial AND v_delivery.order_id IS NOT NULL THEN
    FOR v_linked_invoice IN
      SELECT * FROM invoices
      WHERE order_id = v_delivery.order_id AND deleted_at IS NULL AND status IN ('draft', 'posted')
    LOOP
      IF v_linked_invoice.status = 'draft' THEN
        v_old_total := v_linked_invoice.total_amount_cents;
        UPDATE invoice_items ii SET
          quantity = oi.quantity_delivered,
          extended_cents = ii.unit_price_cents * oi.quantity_delivered::bigint
        FROM order_items oi
        WHERE ii.invoice_id = v_linked_invoice.id
          AND ii.order_item_id = oi.id
          AND oi.quantity_delivered < oi.total_units_needed;

        SELECT COALESCE(SUM(extended_cents), 0) INTO v_new_total
        FROM invoice_items WHERE invoice_id = v_linked_invoice.id;

        UPDATE invoices SET
          total_amount_cents = v_new_total,
          total_cost_cents = (SELECT COALESCE(SUM(cost_cents * quantity), 0) FROM invoice_items WHERE invoice_id = v_linked_invoice.id),
          updated_at = now()
        WHERE id = v_linked_invoice.id;
      ELSE
        FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
        LOOP
          INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
          VALUES (v_admin.id, 'Partial Delivery — Posted Invoice Needs Review',
            'Delivery ' || v_delivery.delivery_number || ' completed with partial quantities. Invoice ' ||
              v_linked_invoice.invoice_number || ' may need adjustment.',
            'delivery_partial', 'invoice', v_linked_invoice.id);
        END LOOP;
      END IF;
    END LOOP;
  END IF;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'delivery_completed',
    'Delivery ' || v_delivery.delivery_number || ' completed.' ||
      CASE WHEN v_any_partial THEN ' Partial delivery — some items have remainders.' ELSE '' END ||
      ' Signed by: ' || p_signed_by,
    p_performed_by, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  RETURN jsonb_build_object(
    'status', 'completed', 'delivery_id', p_delivery_id,
    'partial', v_any_partial, 'order_fully_delivered', v_all_delivered
  );
END;
$$;
