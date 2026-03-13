-- ============================================================================
-- Phase 2.1: void_delivery()
-- Reverses a completed delivery: restores inventory, order_items, removes
-- delivery_remainders. Admin-only. Full audit trail.
-- ============================================================================

-- Expand deliveries.status CHECK to include 'voided'
ALTER TABLE deliveries
  DROP CONSTRAINT IF EXISTS deliveries_status_check;

ALTER TABLE deliveries
  ADD CONSTRAINT deliveries_status_check
  CHECK (status IN ('scheduled', 'in_progress', 'completed', 'cancelled', 'voided'));

-- Expand inventory_transactions.transaction_type CHECK
ALTER TABLE inventory_transactions
  DROP CONSTRAINT IF EXISTS inventory_transactions_transaction_type_check;

ALTER TABLE inventory_transactions
  ADD CONSTRAINT inventory_transactions_transaction_type_check
  CHECK (transaction_type IN (
    'received', 'booked', 'delivered', 'returned',
    'adjusted', 'transferred', 'job_applied',
    'cancelled_delivery_reversal', 'void_delivery_reversal'
  ));

-- ============================================================================
-- void_delivery()
-- ============================================================================
CREATE OR REPLACE FUNCTION public.void_delivery(
  p_delivery_id     uuid,
  p_reason          text,
  p_performed_by    uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor         uuid;
  v_delivery      record;
  v_item          record;
  v_posted_invoices_exist boolean := false;
  v_order_confirmed boolean;
  v_order_fulfilled boolean;
  v_new_order_status text;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  -- Admin-only
  IF (SELECT role FROM profiles WHERE id = v_actor) != 'admin' THEN
    RAISE EXCEPTION 'Admin access required to void a completed delivery';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required to void a delivery';
  END IF;

  -- Idempotency
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM 1 FROM idempotency_keys
    WHERE key = p_idempotency_key AND operation = 'void_delivery';
    IF FOUND THEN
      RETURN jsonb_build_object('status', 'already_processed');
    END IF;
  END IF;

  -- Lock and fetch delivery
  SELECT * INTO v_delivery
  FROM deliveries
  WHERE id = p_delivery_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery not found: %', p_delivery_id;
  END IF;

  IF v_delivery.status != 'completed' THEN
    RAISE EXCEPTION 'Only completed deliveries can be voided (current status: %)', v_delivery.status;
  END IF;

  -- Process each delivery item — reverse inventory and order_items
  FOR v_item IN
    SELECT di.*, p.product_name
    FROM delivery_items di
    JOIN products p ON p.id = di.product_id
    WHERE di.delivery_id = p_delivery_id
      AND di.quantity_delivered > 0
  LOOP
    -- Reverse order_items
    UPDATE order_items SET
      quantity_delivered = GREATEST(quantity_delivered - v_item.quantity_delivered, 0),
      quantity_remaining = quantity_remaining + v_item.quantity_delivered
    WHERE id = v_item.order_item_id;

    -- Restore inventory
    UPDATE inventory SET
      quantity_available = quantity_available + v_item.quantity_delivered,
      updated_at = now()
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';

    -- Log inventory transaction
    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, from_location,
      order_id, delivery_id, performed_by, notes
    ) VALUES (
      v_item.product_id, 'void_delivery_reversal', v_item.quantity_delivered, 'Main Warehouse',
      v_delivery.order_id, p_delivery_id, v_actor,
      'Delivery ' || v_delivery.delivery_number || ' voided: ' || p_reason
    );
  END LOOP;

  -- Delete delivery_remainders created by this delivery
  DELETE FROM delivery_remainders WHERE original_delivery_id = p_delivery_id;

  -- Re-evaluate order status
  SELECT NOT EXISTS (
    SELECT 1 FROM order_items
    WHERE order_id = v_delivery.order_id AND quantity_remaining > 0
  ) INTO v_order_fulfilled;

  SELECT NOT EXISTS (
    SELECT 1 FROM order_items
    WHERE order_id = v_delivery.order_id AND quantity_remaining < quantity
  ) INTO v_order_confirmed;

  v_new_order_status :=
    CASE
      WHEN v_order_fulfilled  THEN 'fulfilled'
      WHEN v_order_confirmed  THEN 'confirmed'
      ELSE 'partially_fulfilled'
    END;

  UPDATE orders SET
    status = v_new_order_status,
    updated_at = now()
  WHERE id = v_delivery.order_id;

  -- Auto-void any draft invoices linked to this order
  UPDATE invoices SET
    status    = 'voided',
    void_reason = 'Auto-voided: delivery ' || v_delivery.delivery_number || ' was voided by admin',
    updated_at = now()
  WHERE order_id = v_delivery.order_id AND status = 'draft';

  -- Check for posted invoices (cannot auto-void, just flag)
  SELECT EXISTS (
    SELECT 1 FROM invoices
    WHERE order_id = v_delivery.order_id AND status = 'posted'
  ) INTO v_posted_invoices_exist;

  -- Mark delivery as voided
  UPDATE deliveries SET
    status     = 'voided',
    updated_at = now()
  WHERE id = p_delivery_id;

  -- Financial audit log
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, description
  ) VALUES (
    'delivery_voided', 'delivery', p_delivery_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object('status', 'completed'),
    jsonb_build_object('status', 'voided', 'order_status', v_new_order_status),
    'Delivery ' || v_delivery.delivery_number || ' voided: ' || p_reason
  );

  -- Activity feed
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'delivery_voided',
    'Delivery ' || v_delivery.delivery_number || ' voided: ' || p_reason,
    v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  -- Record idempotency key
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (key, operation, result_id, expires_at)
    VALUES (p_idempotency_key, 'void_delivery', p_delivery_id, now() + interval '24 hours')
    ON CONFLICT (key) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'success',                true,
    'delivery_id',            p_delivery_id,
    'delivery_number',        v_delivery.delivery_number,
    'new_order_status',       v_new_order_status,
    'posted_invoices_exist',  v_posted_invoices_exist
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.void_delivery(uuid, text, uuid, text) TO authenticated;
