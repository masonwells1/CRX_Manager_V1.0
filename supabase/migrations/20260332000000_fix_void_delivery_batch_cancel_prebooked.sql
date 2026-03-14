-- ============================================================================
-- FIX: void_delivery, batch_cancel_deliveries, cancel_order
-- Same class of bug as cancel_delivery (fixed in 20260331900000)
-- ============================================================================
--
-- BUG 1: void_delivery restores quantity_available but not quantity_prebooked
--   when voiding a completed delivery. complete_delivery decremented both,
--   so voiding must restore both.
--
-- BUG 2: batch_cancel_deliveries has 3 sub-bugs:
--   a) Releases prebooked for scheduled deliveries (order still active)
--   b) Doesn't re-increment prebooked when restoring in_progress deliveries
--   c) Uses 'prebook_released' transaction type (violates CHECK constraint)
--
-- BUG 3: cancel_order logs negative quantity in inventory_transactions
-- ============================================================================


-- =============================================
-- FIX 1: void_delivery
-- =============================================
DROP FUNCTION IF EXISTS void_delivery(uuid, text, uuid, text);

CREATE OR REPLACE FUNCTION void_delivery(
  p_delivery_id uuid,
  p_reason text,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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

    -- Restore inventory: available AND prebooked
    -- (complete_delivery decremented both; we must restore both)
    UPDATE inventory SET
      quantity_available = quantity_available + v_item.quantity_delivered,
      quantity_prebooked = quantity_prebooked + v_item.quantity_delivered,
      updated_at = now()
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';

    -- Log inventory transaction
    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, from_location,
      order_id, delivery_id, performed_by, notes
    ) VALUES (
      v_item.product_id, 'void_delivery_reversal', v_item.quantity_delivered, 'Main Warehouse',
      v_delivery.order_id, p_delivery_id, v_actor,
      'Delivery ' || v_delivery.delivery_number || ' voided: ' || p_reason || ' (available + prebooked restored)'
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


-- =============================================
-- FIX 2: batch_cancel_deliveries
-- Rewrite to call cancel_delivery() instead of
-- duplicating logic (DRY principle)
-- =============================================
DROP FUNCTION IF EXISTS batch_cancel_deliveries(uuid[], text, uuid, text);

CREATE OR REPLACE FUNCTION batch_cancel_deliveries(
  p_delivery_ids uuid[],
  p_cancel_reason text DEFAULT 'Batch cancelled',
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_del record;
  v_count integer := 0;
  v_actor uuid;
  v_result jsonb;
BEGIN
  PERFORM check_rate_limit(auth.uid(), 'batch_cancel_deliveries', 3, 60);
  v_actor := COALESCE(p_performed_by, auth.uid());

  IF array_length(p_delivery_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'No delivery IDs provided';
  END IF;

  -- Verify caller is admin or sales_rep
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to cancel deliveries';
  END IF;

  FOR v_del IN
    SELECT id, status
    FROM deliveries
    WHERE id = ANY(p_delivery_ids)
    ORDER BY id
  LOOP
    -- Skip already cancelled/voided
    IF v_del.status NOT IN ('scheduled', 'in_progress', 'completed') THEN
      CONTINUE;
    END IF;

    -- Delegate to cancel_delivery which has the correct logic
    v_result := cancel_delivery(
      p_delivery_id := v_del.id,
      p_cancel_reason := p_cancel_reason,
      p_performed_by := v_actor
    );

    IF (v_result->>'success')::boolean THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;

  RETURN v_count;
END;
$$;


-- =============================================
-- FIX 3: cancel_order — negative transaction qty
-- =============================================
DROP FUNCTION IF EXISTS cancel_order(uuid, uuid, text);

CREATE OR REPLACE FUNCTION cancel_order(
  p_order_id uuid,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_cached_result jsonb;
  v_order record;
  v_item record;
  v_hold record;
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
BEGIN
  -- P0-001: auth.uid() enforcement
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  IF p_performed_by IS NOT NULL AND v_actor IS DISTINCT FROM p_performed_by THEN
    RAISE EXCEPTION 'actor mismatch';
  END IF;

  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := check_idempotency(p_idempotency_key, 'cancel_order');
    IF v_cached_result IS NOT NULL THEN
      RETURN v_cached_result;
    END IF;
  END IF;

  -- Lock and validate order
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

  -- Verify caller is admin
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Only admins can cancel orders';
  END IF;

  -- Set admin override so state-machine triggers allow the transitions
  SET LOCAL app.admin_override = 'true';

  -- Cancel active deliveries (scheduled/in_progress only)
  UPDATE deliveries SET
    status = 'cancelled',
    cancelled_at = now(),
    cancelled_by = v_actor,
    cancel_reason = 'Parent order ' || v_order.order_number || ' cancelled',
    updated_at = now()
  WHERE order_id = p_order_id
    AND status IN ('scheduled', 'in_progress');
  GET DIAGNOSTICS v_deliveries_cancelled = ROW_COUNT;

  -- Notify drivers of cancelled deliveries
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

  -- Update order status
  UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = p_order_id;

  -- Release prebooked inventory for undelivered items
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

    -- FIX: Use positive quantity (not negative) in transaction log
    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, to_location,
      order_id, performed_by, notes
    ) VALUES (
      v_item.product_id, 'released', v_undelivered, 'Main Warehouse',
      p_order_id, v_actor,
      'Released ' || v_undelivered || ' units — order ' || v_order.order_number || ' cancelled'
    );
  END LOOP;

  -- Release inventory holds via source_id (NOT order_id)
  IF v_order.quote_id IS NOT NULL THEN
    FOR v_hold IN
      SELECT ih.product_id, ih.quantity
      FROM inventory_holds ih
      WHERE ih.source_id = v_order.quote_id AND ih.is_active = true
      FOR UPDATE
    LOOP
      UPDATE inventory
      SET quantity_available = quantity_available + v_hold.quantity,
          updated_at = now()
      WHERE product_id = v_hold.product_id
        AND location = 'Main Warehouse';
    END LOOP;

    UPDATE inventory_holds SET is_active = false, updated_at = now()
    WHERE source_id = v_order.quote_id AND is_active = true;
    GET DIAGNOSTICS v_holds_released = ROW_COUNT;
  END IF;

  -- Cancel pending commissions
  UPDATE commissions SET
    status = 'cancelled',
    commission_amount = 0
  WHERE order_id = p_order_id AND status = 'pending';
  GET DIAGNOSTICS v_commissions_cancelled = ROW_COUNT;

  -- Check for paid commissions — flag for admin review
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

  -- Handle invoices
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

  -- Financial audit log
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

  -- Activity feed
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

  -- Build result
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

  -- Save idempotency result
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'cancel_order', v_result);
  END IF;

  RETURN v_result;
END;
$$;


-- =============================================
-- Verify: no overloads for any of the 3 functions
-- =============================================
DO $$
DECLARE
  v_overloads integer;
BEGIN
  SELECT count(*) INTO v_overloads
  FROM (
    SELECT proname FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname IN ('void_delivery', 'batch_cancel_deliveries', 'cancel_order')
    GROUP BY proname HAVING count(*) > 1
  ) x;
  IF v_overloads > 0 THEN
    RAISE EXCEPTION 'Function overloads detected after migration — aborting';
  END IF;
END $$;
