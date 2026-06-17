-- Nightly-Debug remediation — cancel_delivery HIGH (PARKED-03), large-RPC pass
-- ============================================================================
-- BUG (verified live rhyzpcqhnizqbxphqdkr): create_quick_delivery reserves
-- inventory by incrementing inventory.quantity_prebooked (+ a 'prebooked' txn)
-- against an auto-created order it owns EXCLUSIVELY. cancel_delivery's only
-- inventory-restore block is gated to status IN ('completed','in_progress') AND
-- quantity_delivered > 0. For a quick delivery cancelled while 'scheduled' (or
-- 'in_progress' — confirm_delivery flips status but touches NO inventory, so the
-- prebook is still fully held; verified live md5 of confirm_delivery), NOTHING
-- releases the prebook AND the auto-order is left 'confirmed' (BLOCK B's
-- has-remaining branch) → a zombie confirmed order with a stranded prebook,
-- understating Net Free (available − holds − prebooked) indefinitely. The dead
-- v_prebooked_reincremented counter is the tell-tale of the missing logic.
--
-- SCOPE EXTENSION vs PARKED-03: the parked spec scoped to status='scheduled'.
-- This session verified confirm_delivery does not release the prebook, so an
-- 'in_progress' quick delivery leaks identically (BLOCK A is a no-op there:
-- quantity_delivered is still 0 until complete_delivery). Covering both is the
-- complete fix for the same bug class; a scheduled-only fix would knowingly
-- leave the in_progress leak. Flagged for Codex review.
--
-- FIX (Option A intent, INLINE mechanism — NOT PERFORM cancel_order):
--   cancel_order is admin-only ("Only admins can cancel orders") while
--   cancel_delivery allows sales_rep, so calling it would abort a sales_rep
--   quick-delivery cancel (regression). Instead, inline, inside the existing
--   app.admin_override bracket, for is_quick_delivery AND status IN
--   ('scheduled','in_progress') AND the auto-order is EXCLUSIVE to this delivery:
--     1. Release the prebook this delivery reserved (mirror cancel_order's
--        'released' inventory_transactions block; GREATEST guard; undelivered qty).
--     2. Cancel the auto-created order (status='cancelled') instead of leaving it
--        'confirmed'/'partially_fulfilled' (the zombie), + zero its pending
--        commissions, + a financial_audit_log 'order_cancelled' row (parity with
--        cancel_order — an order going to cancelled must leave a financial trail).
--     3. The draft invoice is already cancelled by cancel_delivery's own invoice
--        loop below — left as-is (no double-handling).
--   Exclusivity guard: only act when no OTHER non-cancelled/voided delivery is
--   linked to the order (a quick-delivery order is exclusive, but assert it so a
--   hand-linked order is never wrongly cancelled — falls back to original logic).
--
-- Everything else is reproduced VERBATIM from the live definition
-- (md5 c6aba47c51aa83653e153399e84d4981). Only the DECLARE block, BLOCK B
-- (order-status handling), and the result jsonb change.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.cancel_delivery(p_delivery_id uuid, p_cancel_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_delivery record; v_actor uuid; v_item record; v_items_restored integer := 0;
  v_prebooked_reincremented integer := 0; v_invoice record; v_draft_cancelled integer := 0;
  v_posted_notified integer := 0; v_admin record; v_order_has_remaining boolean; v_order_status text;
  v_result jsonb;
  -- PARKED-03 quick-delivery prebook-leak fix (additions):
  v_quick_scheduled_exclusive boolean := false; v_prebooked_released integer := 0;
  v_qd_item record; v_release_qty numeric; v_actor_role text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF p_performed_by IS NOT NULL AND auth.uid() IS DISTINCT FROM p_performed_by THEN RAISE EXCEPTION 'actor mismatch'; END IF;
  v_actor := COALESCE(p_performed_by, auth.uid());

  IF p_idempotency_key IS NOT NULL THEN
    DECLARE v_cached jsonb;
    BEGIN v_cached := check_idempotency(p_idempotency_key, 'cancel_delivery'); IF v_cached IS NOT NULL THEN RETURN v_cached; END IF; END;
  END IF;

  SELECT * INTO v_delivery FROM deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery not found'; END IF;
  IF v_delivery.status NOT IN ('scheduled', 'in_progress', 'completed') THEN RAISE EXCEPTION 'Cannot cancel a % delivery', v_delivery.status; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN RAISE EXCEPTION 'Not authorized to cancel deliveries'; END IF;

  PERFORM set_config('app.admin_override', 'true', true);

  IF v_delivery.status IN ('completed', 'in_progress') THEN
    FOR v_item IN SELECT di.*, p.product_name FROM delivery_items di JOIN products p ON p.id = di.product_id WHERE di.delivery_id = p_delivery_id
    LOOP
      IF COALESCE(v_item.quantity_delivered, 0) > 0 THEN
        UPDATE inventory SET quantity_available = quantity_available + v_item.quantity_delivered, quantity_prebooked = quantity_prebooked + v_item.quantity_delivered, updated_at = now() WHERE product_id = v_item.product_id AND location = 'Main Warehouse';
        INSERT INTO inventory_transactions (product_id, transaction_type, quantity, to_location, order_id, delivery_id, performed_by, notes)
        VALUES (v_item.product_id, 'cancelled_delivery_reversal', v_item.quantity_delivered, 'Main Warehouse', v_delivery.order_id, p_delivery_id, v_actor, 'Delivery ' || v_delivery.delivery_number || ' cancelled — restored ' || v_item.quantity_delivered || ' units of ' || v_item.product_name);
        UPDATE order_items SET quantity_delivered = GREATEST(quantity_delivered - v_item.quantity_delivered, 0), quantity_remaining = quantity_remaining + v_item.quantity_delivered WHERE id = v_item.order_item_id;
        v_items_restored := v_items_restored + 1;
      END IF;
    END LOOP;
  END IF;

  IF v_delivery.order_id IS NOT NULL THEN
    SELECT status INTO v_order_status FROM orders WHERE id = v_delivery.order_id;

    -- PARKED-03: a quick delivery still holding its prebook (scheduled or
    -- in_progress) owns its auto-order exclusively. Assert exclusivity before
    -- touching the order so a hand-linked order is never wrongly cancelled.
    IF COALESCE(v_delivery.is_quick_delivery, false) AND v_delivery.status IN ('scheduled', 'in_progress') THEN
      SELECT NOT EXISTS (
        SELECT 1 FROM deliveries
        WHERE order_id = v_delivery.order_id AND id <> p_delivery_id
          AND status NOT IN ('cancelled', 'voided')
      ) INTO v_quick_scheduled_exclusive;
    END IF;

    IF v_order_status IS NOT NULL AND v_order_status NOT IN ('cancelled', 'voided') THEN
      IF v_quick_scheduled_exclusive THEN
        -- 1. Release the prebook this delivery reserved (mirror cancel_order's release block).
        FOR v_qd_item IN SELECT product_id, quantity, COALESCE(quantity_delivered, 0) AS quantity_delivered FROM delivery_items WHERE delivery_id = p_delivery_id
        LOOP
          v_release_qty := GREATEST(v_qd_item.quantity - v_qd_item.quantity_delivered, 0);
          IF v_release_qty <= 0 THEN CONTINUE; END IF;
          UPDATE inventory SET quantity_prebooked = GREATEST(quantity_prebooked - v_release_qty, 0), updated_at = now() WHERE product_id = v_qd_item.product_id AND location = 'Main Warehouse';
          INSERT INTO inventory_transactions (product_id, transaction_type, quantity, to_location, order_id, delivery_id, performed_by, notes)
          VALUES (v_qd_item.product_id, 'released', v_release_qty, 'Main Warehouse', v_delivery.order_id, p_delivery_id, v_actor, 'Released ' || v_release_qty || ' units — quick delivery ' || v_delivery.delivery_number || ' cancelled');
          v_prebooked_released := v_prebooked_released + 1;
        END LOOP;

        -- 2. Cancel the auto-created order (no zombie) + zero its pending commissions + audit row.
        UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = v_delivery.order_id;
        UPDATE commissions SET status = 'cancelled', commission_amount = 0 WHERE order_id = v_delivery.order_id AND status = 'pending';

        SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor;
        INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, old_values, new_values, total_impact_cents, description)
        VALUES ('order_cancelled', 'order', v_delivery.order_id, COALESCE(v_actor_role, 'sales_rep'),
          jsonb_build_object('status', v_order_status),
          jsonb_build_object('status', 'cancelled', 'reason', 'Quick delivery ' || v_delivery.delivery_number || ' cancelled', 'prebook_lines_released', v_prebooked_released),
          0,
          'Auto-cancelled quick-delivery order on cancellation of delivery ' || v_delivery.delivery_number);
      ELSE
        SELECT EXISTS (SELECT 1 FROM order_items WHERE order_id = v_delivery.order_id AND quantity_remaining > 0) INTO v_order_has_remaining;
        IF v_order_has_remaining THEN
          IF EXISTS (SELECT 1 FROM order_items WHERE order_id = v_delivery.order_id AND quantity_delivered > 0) THEN
            UPDATE orders SET status = 'partially_fulfilled', updated_at = now() WHERE id = v_delivery.order_id;
          ELSE
            UPDATE orders SET status = 'confirmed', updated_at = now() WHERE id = v_delivery.order_id;
          END IF;
        END IF;
      END IF;
    END IF;
    UPDATE delivery_remainders SET status = 'cancelled', updated_at = now() WHERE original_delivery_id = p_delivery_id AND status = 'pending' AND followup_delivery_id IS NULL;
    UPDATE delivery_remainders SET status = 'fulfilled', updated_at = now() WHERE original_delivery_id = p_delivery_id AND status IN ('pending', 'scheduled') AND followup_delivery_id IS NOT NULL;
  END IF;

  UPDATE deliveries SET status = 'cancelled', cancelled_at = now(), cancelled_by = v_actor, cancel_reason = p_cancel_reason, updated_at = now() WHERE id = p_delivery_id;

  IF v_delivery.order_id IS NOT NULL THEN
    FOR v_invoice IN SELECT * FROM invoices WHERE order_id = v_delivery.order_id AND status IN ('draft', 'posted', 'unposted') AND deleted_at IS NULL
    LOOP
      IF v_invoice.status IN ('draft', 'unposted') THEN
        UPDATE invoices SET status = 'cancelled', voided_by = v_actor, void_reason = 'Auto-cancelled: delivery ' || v_delivery.delivery_number || ' cancelled', updated_at = now() WHERE id = v_invoice.id;
        v_draft_cancelled := v_draft_cancelled + 1;
      ELSIF v_invoice.status = 'posted' THEN
        FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true LOOP
          INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id) VALUES (v_admin.id, 'Posted Invoice Needs Review', 'Delivery ' || v_delivery.delivery_number || ' cancelled but invoice ' || v_invoice.invoice_number || ' is posted.', 'invoice_review', 'invoice', v_invoice.id);
        END LOOP;
        v_posted_notified := v_posted_notified + 1;
      END IF;
    END LOOP;
  END IF;

  IF v_delivery.assigned_driver IS NOT NULL THEN
    INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id) VALUES (v_delivery.assigned_driver, 'Delivery Cancelled', 'Delivery ' || v_delivery.delivery_number || ' cancelled. Reason: ' || p_cancel_reason, 'delivery_update', 'delivery', p_delivery_id);
  END IF;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('delivery_cancelled', 'Delivery ' || v_delivery.delivery_number || ' cancelled. Reason: ' || p_cancel_reason || CASE WHEN v_items_restored > 0 THEN '. Restored ' || v_items_restored || ' items.' ELSE '' END, v_actor, 'delivery', p_delivery_id, v_delivery.customer_id);

  PERFORM set_config('app.admin_override', 'false', true);

  v_result := jsonb_build_object('success', true, 'delivery_id', p_delivery_id, 'items_restored', v_items_restored, 'prebooked_reincremented', v_prebooked_reincremented, 'prebooked_released', v_prebooked_released, 'draft_invoices_cancelled', v_draft_cancelled, 'posted_invoices_flagged', v_posted_notified);

  -- FIX DEL-1: Save idempotency result (was missing)
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'cancel_delivery', v_result);
  END IF;

  RETURN v_result;
END;
$function$;
