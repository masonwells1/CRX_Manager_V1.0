-- ============================================================================
-- FIX: cancel_delivery incorrectly releases prebooked inventory
-- ============================================================================
-- ROOT CAUSE: When a scheduled delivery is cancelled, cancel_delivery released
-- prebooked quantities. But prebooked belongs to the ORDER, not the delivery.
-- Cancelling a delivery doesn't cancel the order — items are still committed.
--
-- ALSO FIXES: When cancelling a completed delivery, the function restored
-- quantity_available but did NOT re-increment quantity_prebooked. Since
-- complete_delivery decremented prebooked on completion, cancelling should
-- re-increment it (items go back to "pending on order").
--
-- EVIDENCE: ORD-2026-0176 (Sherman Newlin, Mar 13):
--   1. DEL-00003 cancelled (scheduled) → wrongly released prebooked
--   2. DEL-00004 completed (partial) → correctly decremented prebooked
--   Net effect: prebooked under-counted by delivered amounts for 4 products
-- ============================================================================

-- Drop existing function (single overload confirmed)
DROP FUNCTION IF EXISTS cancel_delivery(uuid, text, uuid, text);

CREATE OR REPLACE FUNCTION cancel_delivery(
  p_delivery_id uuid,
  p_cancel_reason text DEFAULT 'Cancelled',
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_delivery record;
  v_actor uuid;
  v_item record;
  v_items_restored integer := 0;
  v_prebooked_reincremented integer := 0;
  v_invoice record;
  v_draft_cancelled integer := 0;
  v_posted_notified integer := 0;
  v_admin record;
  v_order_has_remaining boolean;
  v_order_status text;
BEGIN
  -- Auth enforcement
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  IF p_performed_by IS NOT NULL AND auth.uid() IS DISTINCT FROM p_performed_by THEN
    RAISE EXCEPTION 'actor mismatch';
  END IF;

  v_actor := COALESCE(p_performed_by, auth.uid());

  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    DECLARE v_cached jsonb;
    BEGIN
      v_cached := check_idempotency(p_idempotency_key, 'cancel_delivery');
      IF v_cached IS NOT NULL THEN
        RETURN v_cached;
      END IF;
    END;
  END IF;

  SELECT * INTO v_delivery
  FROM deliveries WHERE id = p_delivery_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery not found';
  END IF;

  IF v_delivery.status NOT IN ('scheduled', 'in_progress', 'completed') THEN
    RAISE EXCEPTION 'Cannot cancel a % delivery', v_delivery.status;
  END IF;

  -- Verify caller is admin or sales_rep
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to cancel deliveries';
  END IF;

  -- ============================================================
  -- Completed or in_progress: restore any delivered quantity
  -- back to available AND re-increment prebooked (items are
  -- going back to "pending on order" status)
  -- ============================================================
  IF v_delivery.status IN ('completed', 'in_progress') THEN
    FOR v_item IN
      SELECT di.*, p.product_name
      FROM delivery_items di
      JOIN products p ON p.id = di.product_id
      WHERE di.delivery_id = p_delivery_id
    LOOP
      IF COALESCE(v_item.quantity_delivered, 0) > 0 THEN
        -- Restore available AND re-increment prebooked
        -- (complete_delivery decremented both; we reverse both)
        UPDATE inventory SET
          quantity_available = quantity_available + v_item.quantity_delivered,
          quantity_prebooked = quantity_prebooked + v_item.quantity_delivered,
          updated_at = now()
        WHERE product_id = v_item.product_id AND location = 'Main Warehouse';

        INSERT INTO inventory_transactions (
          product_id, transaction_type, quantity, to_location,
          order_id, delivery_id, performed_by, notes
        ) VALUES (
          v_item.product_id, 'cancelled_delivery_reversal', v_item.quantity_delivered, 'Main Warehouse',
          v_delivery.order_id, p_delivery_id, v_actor,
          'Delivery ' || v_delivery.delivery_number || ' cancelled — restored ' || v_item.quantity_delivered || ' units of ' || v_item.product_name || ' (available + prebooked)'
        );

        UPDATE order_items SET
          quantity_delivered = GREATEST(quantity_delivered - v_item.quantity_delivered, 0),
          quantity_remaining = quantity_remaining + v_item.quantity_delivered
        WHERE id = v_item.order_item_id;

        v_items_restored := v_items_restored + 1;
      END IF;
    END LOOP;
  END IF;

  -- ============================================================
  -- REMOVED: prebooked release for scheduled/in_progress
  -- ============================================================
  -- Previously this block released prebooked when cancelling a
  -- scheduled or in_progress delivery. This was WRONG because
  -- prebooked belongs to the ORDER, not the delivery. Cancelling
  -- a delivery does not cancel the order — the items are still
  -- committed and will be fulfilled by another delivery.
  --
  -- Only cancel_order() should release prebooked inventory.
  -- ============================================================

  -- Re-evaluate order status
  IF v_delivery.order_id IS NOT NULL THEN
    SELECT status INTO v_order_status FROM orders WHERE id = v_delivery.order_id;

    IF v_order_status IS NOT NULL AND v_order_status NOT IN ('cancelled', 'voided') THEN
      SELECT EXISTS (
        SELECT 1 FROM order_items
        WHERE order_id = v_delivery.order_id AND quantity_remaining > 0
      ) INTO v_order_has_remaining;

      IF v_order_has_remaining THEN
        IF EXISTS (
          SELECT 1 FROM order_items
          WHERE order_id = v_delivery.order_id AND quantity_delivered > 0
        ) THEN
          UPDATE orders SET status = 'partially_fulfilled', updated_at = now()
          WHERE id = v_delivery.order_id;
        ELSE
          UPDATE orders SET status = 'confirmed', updated_at = now()
          WHERE id = v_delivery.order_id;
        END IF;
      END IF;
    END IF;

    -- Handle remainders
    UPDATE delivery_remainders SET
      status = 'cancelled', updated_at = now()
    WHERE original_delivery_id = p_delivery_id
      AND status = 'pending'
      AND followup_delivery_id IS NULL;

    UPDATE delivery_remainders SET
      status = 'fulfilled', updated_at = now()
    WHERE original_delivery_id = p_delivery_id
      AND status IN ('pending', 'scheduled')
      AND followup_delivery_id IS NOT NULL;
  END IF;

  -- Set admin override BEFORE the status UPDATE so the
  -- state machine trigger allows completed->cancelled transition
  SET LOCAL app.admin_override = 'true';

  -- Mark delivery as cancelled
  UPDATE deliveries SET
    status = 'cancelled',
    cancelled_at = now(),
    cancelled_by = v_actor,
    cancel_reason = p_cancel_reason,
    updated_at = now()
  WHERE id = p_delivery_id;

  -- Handle linked invoices — use 'cancelled' for draft/unposted (trigger allows it)
  IF v_delivery.order_id IS NOT NULL THEN
    FOR v_invoice IN
      SELECT * FROM invoices
      WHERE order_id = v_delivery.order_id
        AND status IN ('draft', 'posted', 'unposted')
        AND deleted_at IS NULL
    LOOP
      IF v_invoice.status IN ('draft', 'unposted') THEN
        UPDATE invoices SET
          status = 'cancelled',
          voided_by = v_actor,
          void_reason = 'Auto-cancelled: delivery ' || v_delivery.delivery_number || ' cancelled',
          updated_at = now()
        WHERE id = v_invoice.id;
        v_draft_cancelled := v_draft_cancelled + 1;
      ELSIF v_invoice.status = 'posted' THEN
        FOR v_admin IN
          SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
        LOOP
          INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
          VALUES (
            v_admin.id,
            'Posted Invoice Needs Review',
            'Delivery ' || v_delivery.delivery_number || ' was cancelled but invoice ' || v_invoice.invoice_number || ' is posted. Please review.',
            'invoice_review', 'invoice', v_invoice.id
          );
        END LOOP;
        v_posted_notified := v_posted_notified + 1;
      END IF;
    END LOOP;
  END IF;

  -- Notify assigned driver
  IF v_delivery.assigned_driver IS NOT NULL THEN
    INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
    VALUES (
      v_delivery.assigned_driver,
      'Delivery Cancelled',
      'Delivery ' || v_delivery.delivery_number || ' has been cancelled. Reason: ' || p_cancel_reason,
      'delivery_update', 'delivery', p_delivery_id
    );
  END IF;

  -- Activity log
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'delivery_cancelled',
    'Delivery ' || v_delivery.delivery_number || ' cancelled. Reason: ' || p_cancel_reason
      || CASE WHEN v_items_restored > 0 THEN '. Restored ' || v_items_restored || ' inventory items (available + prebooked).' ELSE '' END,
    v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  RETURN jsonb_build_object(
    'success', true,
    'delivery_id', p_delivery_id,
    'items_restored', v_items_restored,
    'prebooked_reincremented', v_prebooked_reincremented,
    'draft_invoices_cancelled', v_draft_cancelled,
    'posted_invoices_flagged', v_posted_notified
  );
END;
$$;

-- ============================================================================
-- DATA FIX: Reconcile prebooked quantities for affected products
-- ============================================================================
-- Recalculate quantity_prebooked from actual pending order items.
-- This fixes the 4 products affected by DEL-00003 cancellation on Mar 13.
-- ============================================================================

-- Log FIRST (before the UPDATE changes the values), then fix
INSERT INTO inventory_transactions (
  product_id, transaction_type, quantity, to_location, performed_by, notes
)
SELECT
  i.product_id,
  'adjusted',
  sub.calculated_prebooked - i.quantity_prebooked,
  'Main Warehouse',
  (SELECT id FROM profiles WHERE role = 'admin' AND is_active = true LIMIT 1),
  'Prebooked reconciliation: cancel_delivery bug fix (migration 20260331900000). ' ||
  'Old: ' || i.quantity_prebooked || ', New: ' || sub.calculated_prebooked ||
  '. Root cause: DEL-00003 cancellation incorrectly released prebooked on Mar 13.'
FROM inventory i
JOIN (
  SELECT
    oi.product_id,
    COALESCE(SUM(oi.total_units_needed - oi.quantity_delivered), 0) AS calculated_prebooked
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  WHERE o.status IN ('confirmed', 'partially_fulfilled')
  GROUP BY oi.product_id
) sub ON sub.product_id = i.product_id
WHERE i.location = 'Main Warehouse'
  AND i.quantity_prebooked != sub.calculated_prebooked;

-- Now update prebooked to match what active orders actually need
UPDATE inventory i SET
  quantity_prebooked = sub.calculated_prebooked,
  updated_at = now()
FROM (
  SELECT
    oi.product_id,
    COALESCE(SUM(oi.total_units_needed - oi.quantity_delivered), 0) AS calculated_prebooked
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  WHERE o.status IN ('confirmed', 'partially_fulfilled')
  GROUP BY oi.product_id
) sub
WHERE i.product_id = sub.product_id
  AND i.location = 'Main Warehouse'
  AND i.quantity_prebooked != sub.calculated_prebooked;

-- Verify: no function overloads after this migration
DO $$
DECLARE
  v_overloads integer;
BEGIN
  SELECT count(*) INTO v_overloads
  FROM (
    SELECT proname FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace AND proname = 'cancel_delivery'
    GROUP BY proname HAVING count(*) > 1
  ) x;
  IF v_overloads > 0 THEN
    RAISE EXCEPTION 'cancel_delivery has overloads after migration — aborting';
  END IF;
END $$;
