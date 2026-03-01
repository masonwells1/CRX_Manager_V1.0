-- ============================================================================
-- INVENTORY HOLD RESTORATION FIXES
-- ============================================================================
-- Fixes 2 inventory-related bugs:
--
-- FIX 1: release_holds_on_quote_status_change() deactivates holds but never
--   restores quantity_available on the inventory table. When quotes are
--   declined or expired, the held quantity vanishes — inventory appears
--   permanently reduced.
--   NOTE: For 'accepted' status, inventory is NOT restored because the
--   convert_quote_to_order() flow prebooks the same quantity. Restoring
--   would double-count.
--
-- FIX 2: cancel_order() releases holds via WHERE source_id = p_order_id,
--   but holds are linked to QUOTES (source_id = quote_id), not orders.
--   This means cancel_order() never actually releases any holds.
--   Fix: look up the order's originating quote_id and release holds
--   using that, also restoring quantity_available.
--
-- Additionally fixes the same restoration gap in auto_expire_quotes()
-- and convert_quote_to_order() belt-and-suspenders hold release.
-- ============================================================================


-- ============================================================================
-- FIX 1: Rewrite release_holds_on_quote_status_change() trigger function
-- ============================================================================
-- Previously: only set is_active = false on holds
-- Now: also restores quantity_available for declined/expired quotes
-- For accepted quotes: holds are deactivated but inventory is NOT restored
-- because convert_quote_to_order() prebooks the same quantity.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.release_holds_on_quote_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_hold record;
  v_released_count integer := 0;
  v_restored_count integer := 0;
BEGIN
  -- Release holds when quote is accepted, declined, or expired
  IF NEW.status IN ('accepted', 'declined', 'expired')
     AND OLD.status NOT IN ('accepted', 'declined', 'expired') THEN

    -- For declined/expired: restore inventory quantity_available
    -- For accepted: do NOT restore — order prebook supersedes the hold
    IF NEW.status IN ('declined', 'expired') THEN
      FOR v_hold IN
        SELECT ih.product_id, ih.quantity
        FROM public.inventory_holds ih
        WHERE ih.source_id = NEW.id AND ih.is_active = true
        FOR UPDATE
      LOOP
        UPDATE public.inventory
        SET quantity_available = quantity_available + v_hold.quantity,
            updated_at = now()
        WHERE product_id = v_hold.product_id
          AND location = 'Main Warehouse';

        v_restored_count := v_restored_count + 1;
      END LOOP;
    END IF;

    -- Deactivate holds for all three statuses
    UPDATE public.inventory_holds
    SET is_active = false, updated_at = now()
    WHERE source_id = NEW.id AND is_active = true;

    GET DIAGNOSTICS v_released_count = ROW_COUNT;

    IF v_released_count > 0 THEN
      INSERT INTO public.activity_feed (
        event_type, description, performed_by,
        related_entity_type, related_entity_id, customer_id
      ) VALUES (
        'inventory_holds_released',
        'Released ' || v_released_count || ' inventory hold(s) for quote ' || NEW.quote_number || ' (' || NEW.status || ')'
          || CASE WHEN v_restored_count > 0 THEN ' — restored inventory for ' || v_restored_count || ' product(s)' ELSE '' END,
        COALESCE(auth.uid(), '00000000-0000-0000-0000-000000000000'),
        'quote', NEW.id, NEW.customer_id
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$;


-- ============================================================================
-- FIX 1b: Also fix auto_expire_quotes() belt-and-suspenders hold release
-- ============================================================================
-- The trigger (above) handles expiration, but auto_expire_quotes() also
-- directly releases holds as a safety net. It had the same bug: deactivated
-- holds without restoring quantity_available.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.auto_expire_quotes()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_quote record;
  v_hold record;
  v_expired_count integer := 0;
  v_holds_released integer := 0;
  v_hold_count integer;
BEGIN
  FOR v_quote IN
    SELECT q.*
    FROM public.quotes q
    WHERE q.expires_at < CURRENT_DATE
      AND q.status NOT IN ('expired', 'declined', 'accepted', 'converted')
      AND q.deleted_at IS NULL
    FOR UPDATE SKIP LOCKED
  LOOP
    -- Update quote status to expired (triggers trg_release_holds_on_quote_status)
    UPDATE public.quotes SET
      status = 'expired',
      updated_at = now()
    WHERE id = v_quote.id;

    -- Belt-and-suspenders: restore inventory for active holds before deactivating
    FOR v_hold IN
      SELECT ih.product_id, ih.quantity
      FROM public.inventory_holds ih
      WHERE ih.source_id = v_quote.id AND ih.is_active = true
    LOOP
      UPDATE public.inventory
      SET quantity_available = quantity_available + v_hold.quantity,
          updated_at = now()
      WHERE product_id = v_hold.product_id
        AND location = 'Main Warehouse';
    END LOOP;

    -- Deactivate holds
    UPDATE public.inventory_holds SET
      is_active = false,
      updated_at = now()
    WHERE source_id = v_quote.id AND is_active = true;
    GET DIAGNOSTICS v_hold_count = ROW_COUNT;

    v_holds_released := v_holds_released + v_hold_count;
    v_expired_count := v_expired_count + 1;
  END LOOP;

  IF v_expired_count > 0 THEN
    INSERT INTO public.activity_feed (event_type, description, performed_by)
    VALUES (
      'quotes_auto_expired',
      'Auto-expired ' || v_expired_count || ' quotes, released ' || v_holds_released || ' inventory holds (inventory restored)',
      '00000000-0000-0000-0000-000000000000'::uuid
    );
  END IF;

  RETURN jsonb_build_object(
    'expired_count', v_expired_count,
    'holds_released', v_holds_released
  );
END;
$$;


-- ============================================================================
-- FIX 2: Fix cancel_order() hold release — use quote_id, not order_id
-- ============================================================================
-- Previously: WHERE source_id = p_order_id (matches nothing — holds use quote's id)
-- Now: looks up order.quote_id and releases holds via that, also restoring
-- quantity_available since a cancelled order means the inventory is freed.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.cancel_order(
  p_order_id uuid,
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order record;
  v_item record;
  v_hold record;
  v_undelivered numeric;
  v_holds_released integer := 0;
  v_commissions_cancelled integer := 0;
  v_paid_commissions integer := 0;
  v_draft_voided integer := 0;
  v_posted_notified integer := 0;
  v_deliveries_cancelled integer := 0;
  v_invoice record;
  v_admin record;
BEGIN
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;
  IF v_order.status = 'cancelled' THEN
    RETURN jsonb_build_object('status', 'already_cancelled');
  END IF;

  -- Verify caller is admin
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = p_performed_by AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Only admins can cancel orders';
  END IF;

  -- Cancel active deliveries BEFORE releasing inventory
  -- (Direct UPDATE, not recursive cancel_delivery call, to avoid double prebook release)
  UPDATE public.deliveries SET
    status = 'cancelled',
    cancelled_at = now(),
    cancelled_by = p_performed_by,
    cancel_reason = 'Parent order ' || v_order.order_number || ' cancelled',
    updated_at = now()
  WHERE order_id = p_order_id
    AND status IN ('scheduled', 'in_progress');
  GET DIAGNOSTICS v_deliveries_cancelled = ROW_COUNT;

  -- Notify drivers of cancelled deliveries
  IF v_deliveries_cancelled > 0 THEN
    INSERT INTO public.notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
    SELECT
      d.assigned_driver,
      'Delivery Cancelled',
      'Delivery ' || d.delivery_number || ' cancelled — order ' || v_order.order_number || ' was cancelled.',
      'delivery_update', 'delivery', d.id
    FROM public.deliveries d
    WHERE d.order_id = p_order_id
      AND d.status = 'cancelled'
      AND d.cancel_reason LIKE 'Parent order%'
      AND d.assigned_driver IS NOT NULL;
  END IF;

  -- Update order status
  UPDATE public.orders SET status = 'cancelled', updated_at = now() WHERE id = p_order_id;

  -- Release prebooked inventory for undelivered items
  FOR v_item IN
    SELECT product_id, total_units_needed, quantity_delivered
    FROM public.order_items WHERE order_id = p_order_id
  LOOP
    v_undelivered := GREATEST(v_item.total_units_needed - COALESCE(v_item.quantity_delivered, 0), 0);
    IF v_undelivered <= 0 THEN CONTINUE; END IF;

    UPDATE public.inventory SET
      quantity_prebooked = GREATEST(quantity_prebooked - v_undelivered, 0),
      updated_at = now()
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';

    INSERT INTO public.inventory_transactions (
      product_id, transaction_type, quantity, to_location,
      order_id, performed_by, notes
    ) VALUES (
      v_item.product_id, 'cancelled_order_release', -v_undelivered, 'Main Warehouse',
      p_order_id, p_performed_by,
      'Released ' || v_undelivered || ' units — order ' || v_order.order_number || ' cancelled'
    );
  END LOOP;

  -- FIX 2: Release inventory holds using the originating quote_id, not order_id
  -- Holds are linked to quotes via source_id, not to orders.
  -- Also restore quantity_available since the order is being cancelled.
  IF v_order.quote_id IS NOT NULL THEN
    FOR v_hold IN
      SELECT ih.product_id, ih.quantity
      FROM public.inventory_holds ih
      WHERE ih.source_id = v_order.quote_id AND ih.is_active = true
      FOR UPDATE
    LOOP
      UPDATE public.inventory
      SET quantity_available = quantity_available + v_hold.quantity,
          updated_at = now()
      WHERE product_id = v_hold.product_id
        AND location = 'Main Warehouse';
    END LOOP;

    UPDATE public.inventory_holds SET is_active = false, updated_at = now()
    WHERE source_id = v_order.quote_id AND is_active = true;
    GET DIAGNOSTICS v_holds_released = ROW_COUNT;
  END IF;

  -- Cancel pending commissions
  UPDATE public.commissions SET
    status = 'cancelled',
    commission_amount = 0
  WHERE order_id = p_order_id AND status = 'pending';
  GET DIAGNOSTICS v_commissions_cancelled = ROW_COUNT;

  -- Check for paid commissions — don't touch them, just notify
  SELECT COUNT(*) INTO v_paid_commissions
  FROM public.commissions WHERE order_id = p_order_id AND status = 'paid';

  IF v_paid_commissions > 0 THEN
    FOR v_admin IN
      SELECT id FROM public.profiles WHERE role = 'admin' AND is_active = true
    LOOP
      INSERT INTO public.notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
      VALUES (
        v_admin.id,
        'Cancelled Order Has Paid Commissions',
        'Order ' || v_order.order_number || ' was cancelled but has ' || v_paid_commissions || ' paid commission(s). Manual review required.',
        'cancellation_review', 'order', p_order_id
      );
    END LOOP;
  END IF;

  -- Void draft invoices, notify about posted ones
  FOR v_invoice IN
    SELECT * FROM public.invoices
    WHERE order_id = p_order_id AND deleted_at IS NULL AND status IN ('draft', 'posted')
  LOOP
    IF v_invoice.status = 'draft' THEN
      UPDATE public.invoices SET
        status = 'voided',
        voided_by = p_performed_by,
        voided_at = now(),
        void_reason = 'Order ' || v_order.order_number || ' cancelled',
        balance_cents = 0,
        updated_at = now()
      WHERE id = v_invoice.id;

      INSERT INTO public.financial_audit_log (
        operation_type, entity_type, entity_id, actor_role,
        old_values, new_values, total_impact_cents, description
      ) VALUES (
        'invoice_voided', 'invoice', v_invoice.id, 'admin',
        jsonb_build_object('status', 'draft', 'total_cents', v_invoice.total_amount_cents),
        jsonb_build_object('status', 'voided', 'void_reason', 'Order cancelled'),
        -1 * v_invoice.total_amount_cents,
        'Auto-voided draft invoice ' || v_invoice.invoice_number || ' — order ' || v_order.order_number || ' cancelled'
      );

      v_draft_voided := v_draft_voided + 1;

    ELSIF v_invoice.status = 'posted' THEN
      FOR v_admin IN
        SELECT id FROM public.profiles WHERE role = 'admin' AND is_active = true
      LOOP
        INSERT INTO public.notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
        VALUES (
          v_admin.id,
          'Manual Invoice Void Required',
          'Order ' || v_order.order_number || ' cancelled but has posted invoice ' || v_invoice.invoice_number || ' — manual void required.',
          'cancellation_review', 'invoice', v_invoice.id
        );
      END LOOP;

      v_posted_notified := v_posted_notified + 1;
    END IF;
  END LOOP;

  -- Activity log
  INSERT INTO public.activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'order_cancelled',
    'Order ' || v_order.order_number || ' cancelled. ' ||
      v_deliveries_cancelled || ' delivery(s) cancelled, ' ||
      v_holds_released || ' hold(s) released, ' ||
      v_commissions_cancelled || ' commission(s) zeroed, ' ||
      v_draft_voided || ' draft invoice(s) voided.' ||
      CASE WHEN v_posted_notified > 0 THEN ' ' || v_posted_notified || ' posted invoice(s) flagged for review.' ELSE '' END ||
      CASE WHEN v_paid_commissions > 0 THEN ' ' || v_paid_commissions || ' paid commission(s) flagged for review.' ELSE '' END,
    p_performed_by, 'order', p_order_id, v_order.customer_id
  );

  RETURN jsonb_build_object(
    'status', 'cancelled',
    'deliveries_cancelled', v_deliveries_cancelled,
    'holds_released', v_holds_released,
    'commissions_cancelled', v_commissions_cancelled,
    'paid_commissions_flagged', v_paid_commissions,
    'draft_invoices_voided', v_draft_voided,
    'posted_invoices_notified', v_posted_notified
  );
END;
$$;
