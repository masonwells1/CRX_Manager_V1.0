-- ============================================================================
-- CRITICAL BUG FIXES: Cancel RPCs + State Machine + Missing GRANTs
-- Migration: 20260311000000_audit_cancel_state_machine_fixes.sql
--
-- Fixes:
--   Bug 1: Drop orphan cancel_order(uuid, text) overload from 20260228300000
--   Bug 2: Unify cancel_order into one correct function with all cleanup logic
--   Bug 3: Fix cancel_delivery trigger bypass for completed deliveries +
--          add P0-001 auth.uid() enforcement
--   Bug 4: Add missing GRANT EXECUTE for void_invoice
--
-- Also:
--   - Expand financial_audit_log operation_type CHECK to include
--     order_cancelled and delivery_cancelled
-- ============================================================================


-- ============================================================================
-- PREREQUISITE: Expand financial_audit_log operation_type constraint
-- The cancel_order function logs 'order_cancelled' which is not in the
-- current CHECK constraint. Add it (plus delivery_cancelled) before
-- creating functions that reference it.
-- ============================================================================

ALTER TABLE financial_audit_log
  DROP CONSTRAINT IF EXISTS financial_audit_log_operation_type_check;

ALTER TABLE financial_audit_log
  ADD CONSTRAINT financial_audit_log_operation_type_check
  CHECK (operation_type = ANY (ARRAY[
    -- Invoice operations
    'invoice_created', 'invoice_posted', 'invoice_voided',
    'invoice_cancelled', 'invoice_updated', 'invoice_deleted',
    -- Payment operations
    'payment_recorded', 'payment_allocation', 'payment_voided',
    -- Split operations
    'split_modified', 'split_invoices_generated',
    -- Prepay operations
    'prepay_created', 'prepay_applied', 'prepay_credit_created',
    'prepay_batch_applied', 'prepay_edited', 'prepay_deleted',
    -- Write-off operations
    'write_off_recorded', 'write_off_reversed', 'write_off_applied',
    -- Finance charge operations
    'finance_charge', 'finance_charge_generated', 'finance_charge_voided',
    -- Credit memo operations
    'credit_memo_created', 'credit_memo_applied',
    -- Return operations
    'return_created', 'return_approved', 'return_received', 'return_credit_issued',
    -- Order/delivery operations
    'order_updated', 'delivery_updated',
    'order_cancelled', 'delivery_cancelled',
    -- Batch operations
    'batch_post', 'batch_void', 'batch_payment',
    -- Commission operations
    'commission_payment_created', 'commission_payment_posted',
    -- Cycle count
    'cycle_count_completed'
  ]));


-- ============================================================================
-- BUG 1: Drop orphan cancel_order(uuid, text) overload
--
-- The old 2-param (uuid, text) version from 20260228300000_critical_prelaunch_fixes.sql
-- was never dropped. It lacks inventory cleanup, hold release, commission
-- cancellation, and financial audit logging. If the frontend accidentally
-- called this overload, data would be silently corrupted.
-- ============================================================================

DROP FUNCTION IF EXISTS cancel_order(uuid, text);


-- ============================================================================
-- BUG 2: Unify cancel_order into one correct function
--
-- Problem: Two competing overloads existed:
--   1. cancel_order(uuid, uuid) from 20260316100001 — correct inventory logic
--      but missing auth.uid() enforcement, idempotency, admin_override, and
--      has the draft->voided bug (trigger rejects this transition).
--   2. cancel_order(uuid, uuid, text) from 20260317200000 — has auth.uid()
--      enforcement but STILL has the holds bug (WHERE order_id on
--      inventory_holds — column is source_id), no delivery cancellation,
--      no admin_override for triggers, and the draft->voided bug.
--
-- Fix: Drop BOTH overloads. Create one unified function that merges the
-- best of both + fixes all known bugs.
-- ============================================================================

-- Drop both old overloads to ensure clean single function
DROP FUNCTION IF EXISTS cancel_order(uuid, uuid);
DROP FUNCTION IF EXISTS cancel_order(uuid, uuid, text);

CREATE OR REPLACE FUNCTION cancel_order(
  p_order_id uuid,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
  -- ── P0-001: auth.uid() enforcement ──
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  IF p_performed_by IS NOT NULL AND v_actor IS DISTINCT FROM p_performed_by THEN
    RAISE EXCEPTION 'actor mismatch';
  END IF;

  -- ── Idempotency check ──
  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := check_idempotency(p_idempotency_key, 'cancel_order');
    IF v_cached_result IS NOT NULL THEN
      RETURN v_cached_result;
    END IF;
  END IF;

  -- ── Lock and validate order ──
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

  -- ── Verify caller is admin ──
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Only admins can cancel orders';
  END IF;

  -- ── Set admin override so state-machine triggers allow the transitions ──
  SET LOCAL app.admin_override = 'true';

  -- ── Cancel active deliveries (scheduled/in_progress only) ──
  -- Do NOT cancel completed deliveries — those need explicit reversal.
  -- Direct UPDATE (not recursive cancel_delivery call) to avoid double prebook release.
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

  -- ── Update order status ──
  UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = p_order_id;

  -- ── Release prebooked inventory for undelivered items ──
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
      v_item.product_id, 'cancelled_order_release', -v_undelivered, 'Main Warehouse',
      p_order_id, v_actor,
      'Released ' || v_undelivered || ' units — order ' || v_order.order_number || ' cancelled'
    );
  END LOOP;

  -- ── Release inventory holds via source_id (NOT order_id) ──
  -- Holds are linked to the QUOTE that originated this order.
  -- Look up quote_id from the order, then release holds for that quote.
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

  -- ── Cancel pending commissions ──
  UPDATE commissions SET
    status = 'cancelled',
    commission_amount = 0
  WHERE order_id = p_order_id AND status = 'pending';
  GET DIAGNOSTICS v_commissions_cancelled = ROW_COUNT;

  -- ── Check for paid commissions — flag for admin review, don't touch them ──
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

  -- ── Handle invoices ──
  -- Draft invoices: set status to 'cancelled' (NOT 'voided').
  --   The state machine trigger allows draft->cancelled but NOT draft->voided.
  --   Do NOT set balance_cents (it's GENERATED ALWAYS).
  --   Instead zero out the component columns so balance computes to 0.
  -- Posted invoices: flag for admin review (don't auto-void).
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
      -- Posted invoices require manual void — just notify admins
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

  -- ── Financial audit log for the order cancellation itself ──
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

  -- ── Activity feed ──
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

  -- ── Build result ──
  v_result := jsonb_build_object(
    'status', 'cancelled',
    'order_number', v_order.order_number,
    'deliveries_cancelled', v_deliveries_cancelled,
    'holds_released', v_holds_released,
    'commissions_cancelled', v_commissions_cancelled,
    'paid_commissions_flagged', v_paid_commissions,
    'draft_invoices_cancelled', v_draft_cancelled,
    'posted_invoices_notified', v_posted_notified
  );

  -- ── Save idempotency result ──
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'cancel_order', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION cancel_order(uuid, uuid, text) TO authenticated;


-- ============================================================================
-- BUG 3: Fix cancel_delivery — trigger bypass + auth enforcement
--
-- Problem 1: When cancelling a completed delivery, the state machine trigger
-- (_enforce_delivery_status_transition) rejects completed->cancelled because
-- the function doesn't set the admin_override flag before the UPDATE.
--
-- Problem 2: cancel_delivery was never updated with P0-001 auth.uid()
-- enforcement from the security audit.
--
-- Fix: Add SET LOCAL app.admin_override = 'true' before the status UPDATE,
-- and add auth.uid() enforcement at the top.
-- ============================================================================

CREATE OR REPLACE FUNCTION cancel_delivery(
  p_delivery_id uuid,
  p_cancel_reason text DEFAULT 'Cancelled',
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_delivery record;
  v_actor uuid;
  v_item record;
  v_inv record;
  v_items_restored integer := 0;
  v_prebooked_released integer := 0;
  v_invoice record;
  v_draft_voided integer := 0;
  v_posted_notified integer := 0;
  v_admin record;
  v_order_has_remaining boolean;
  v_order_status text;
BEGIN
  -- P0-001 FIX: Derive actor from JWT, reject spoofing
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

  -- Completed or in_progress: restore any delivered quantity back to available
  IF v_delivery.status IN ('completed', 'in_progress') THEN
    FOR v_item IN
      SELECT di.*, p.product_name
      FROM delivery_items di
      JOIN products p ON p.id = di.product_id
      WHERE di.delivery_id = p_delivery_id
    LOOP
      IF COALESCE(v_item.quantity_delivered, 0) > 0 THEN
        UPDATE inventory SET
          quantity_available = quantity_available + v_item.quantity_delivered,
          updated_at = now()
        WHERE product_id = v_item.product_id AND location = 'Main Warehouse';

        INSERT INTO inventory_transactions (
          product_id, transaction_type, quantity, to_location,
          order_id, delivery_id, performed_by, notes
        ) VALUES (
          v_item.product_id, 'cancelled_delivery_reversal', v_item.quantity_delivered, 'Main Warehouse',
          v_delivery.order_id, p_delivery_id, v_actor,
          'Delivery ' || v_delivery.delivery_number || ' cancelled — restored ' || v_item.quantity_delivered || ' units of ' || v_item.product_name
        );

        UPDATE order_items SET
          quantity_delivered = GREATEST(quantity_delivered - v_item.quantity_delivered, 0),
          quantity_remaining = quantity_remaining + v_item.quantity_delivered
        WHERE id = v_item.order_item_id;

        v_items_restored := v_items_restored + 1;
      END IF;
    END LOOP;
  END IF;

  -- Scheduled OR in_progress: release prebooked inventory
  IF v_delivery.status IN ('scheduled', 'in_progress') THEN
    FOR v_item IN
      SELECT di.*, p.product_name
      FROM delivery_items di
      JOIN products p ON p.id = di.product_id
      WHERE di.delivery_id = p_delivery_id
    LOOP
      IF COALESCE(v_item.quantity, 0) > 0 THEN
        UPDATE inventory SET
          quantity_prebooked = GREATEST(quantity_prebooked - v_item.quantity, 0),
          updated_at = now()
        WHERE product_id = v_item.product_id AND location = 'Main Warehouse';

        INSERT INTO inventory_transactions (
          product_id, transaction_type, quantity, to_location,
          order_id, delivery_id, performed_by, notes
        ) VALUES (
          v_item.product_id, 'released', v_item.quantity, 'Main Warehouse',
          v_delivery.order_id, p_delivery_id, v_actor,
          'Delivery ' || v_delivery.delivery_number || ' cancelled — released prebooked ' || v_item.quantity || ' units of ' || v_item.product_name
        );

        v_prebooked_released := v_prebooked_released + 1;
      END IF;
    END LOOP;
  END IF;

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

  -- BUG 3 FIX: Set admin override BEFORE the status UPDATE so the
  -- state machine trigger (_enforce_delivery_status_transition) allows
  -- the completed->cancelled transition.
  SET LOCAL app.admin_override = 'true';

  -- Mark delivery as cancelled
  UPDATE deliveries SET
    status = 'cancelled',
    cancelled_at = now(),
    cancelled_by = v_actor,
    cancel_reason = p_cancel_reason,
    updated_at = now()
  WHERE id = p_delivery_id;

  -- Handle linked invoices
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
        v_draft_voided := v_draft_voided + 1;
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
      || CASE WHEN v_items_restored > 0 THEN '. Restored ' || v_items_restored || ' inventory items.' ELSE '' END
      || CASE WHEN v_prebooked_released > 0 THEN '. Released ' || v_prebooked_released || ' prebooked items.' ELSE '' END,
    v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  RETURN jsonb_build_object(
    'success', true,
    'delivery_id', p_delivery_id,
    'items_restored', v_items_restored,
    'prebooked_released', v_prebooked_released,
    'draft_invoices_voided', v_draft_voided,
    'posted_invoices_flagged', v_posted_notified
  );
END;
$$;

GRANT EXECUTE ON FUNCTION cancel_delivery(uuid, text, uuid, text) TO authenticated;


-- ============================================================================
-- BUG 4: Add missing GRANT EXECUTE for void_invoice
--
-- void_invoice(uuid, text) from 20260315200001_accounting_and_integrity_fixes.sql
-- was never GRANTed to authenticated. Frontend calls fail with permission denied.
-- ============================================================================

GRANT EXECUTE ON FUNCTION void_invoice(uuid, text) TO authenticated;
