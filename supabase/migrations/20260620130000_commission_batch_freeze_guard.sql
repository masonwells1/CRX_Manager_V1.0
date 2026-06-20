-- Overnight bug-hunt HIGH: commissions:cancel_void_order:batched-commission-resurrected-paid
--
-- BUG: cancel_order / void_order / cancel_delivery zero a *pending* commission
-- (status='cancelled', commission_amount=0) with no awareness of whether that
-- commission is already committed into a non-voided commission_payments batch
-- (commission_payment_items rows survive — the FK is NO CASCADE). Later,
-- post_commission_payment flips EVERY commission linked to the batch to 'paid'
-- with no status filter, so it resurrects the cancelled (amount=0) commission to
-- 'paid' and the batch pays out the retained (stale) snapshot — a payout for an
-- order that no longer exists.
--
-- FIX (two-sided, defense-in-depth):
--   1. cancel_order / void_order / cancel_delivery: hard-block the operation when
--      the order has a pending commission committed to a non-voided
--      commission_payments batch. The admin must void that payout batch first
--      (void_commission_payment resets the commissions back to 'pending'),
--      after which the cancel/void proceeds normally.
--   2. post_commission_payment: only flip commissions that are still 'pending',
--      and RAISE if the number flipped differs from the batch's item count — so a
--      batch that lost a commission (cancelled/already-paid) cannot post a stale
--      snapshot; the admin must void and rebuild it.
--
-- Bodies below are reproduced verbatim from the live definitions (read 2026-06-20)
-- with ONLY the guard blocks added — verified by a rolled-back line-level diff.
-- Latent on live data (0 commission_payment_items, 0 paid).

-- =====================================================================
-- 1. cancel_order — add batch-freeze hard-block
-- =====================================================================
CREATE OR REPLACE FUNCTION public.cancel_order(p_order_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_cached_result jsonb;
  v_order record;
  v_item record;
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
  -- A3<<<
  v_draw_item record;
  v_draw_quote record;
  v_draw_fully_drawn boolean;
  -- >>>A3
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  IF p_performed_by IS NOT NULL AND v_actor IS DISTINCT FROM p_performed_by THEN
    RAISE EXCEPTION 'actor mismatch';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := check_idempotency(p_idempotency_key, 'cancel_order');
    IF v_cached_result IS NOT NULL THEN
      RETURN v_cached_result;
    END IF;
  END IF;

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

  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Only admins can cancel orders';
  END IF;

  -- Commission batch-freeze guard (overnight bug-hunt HIGH, 20260620): a pending
  -- commission already committed to a non-voided commission_payments batch must not
  -- be silently cancelled here — post_commission_payment would later resurrect it to
  -- 'paid' and pay the retained snapshot. Force the admin to void the payout first.
  IF EXISTS (
    SELECT 1
    FROM commissions cm
    JOIN commission_payment_items cpi ON cpi.commission_id = cm.id
    JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
    WHERE cm.order_id = p_order_id
      AND cm.status = 'pending'
      AND cp.status <> 'voided'
  ) THEN
    RAISE EXCEPTION 'ORDER_HAS_BATCHED_COMMISSIONS: order % has pending commission(s) committed to an active commission payment batch. Void that payment first, then cancel.', v_order.order_number;
  END IF;

  SET LOCAL app.admin_override = 'true';

  UPDATE deliveries SET
    status = 'cancelled',
    cancelled_at = now(),
    cancelled_by = v_actor,
    cancel_reason = 'Parent order ' || v_order.order_number || ' cancelled',
    updated_at = now()
  WHERE order_id = p_order_id
    AND status IN ('scheduled', 'in_progress');
  GET DIAGNOSTICS v_deliveries_cancelled = ROW_COUNT;

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

  UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = p_order_id;
  -- A3<<< draw-ledger reversal (finding A3, 20260610190000 — see file header).
  -- cancel = only the UNDELIVERED remainder returns to the booking balance
  -- (mirrors the prebook release below); delivered units stay consumed so the
  -- customer cannot be over-entitled.
  IF COALESCE(v_order.booking_draw, false) AND v_order.quote_id IS NOT NULL THEN
    -- Lock the parent quote first: same quote → inventory order as
    -- draw_down_quote, and serializes against a concurrent draw.
    SELECT * INTO v_draw_quote FROM quotes
    WHERE id = v_order.quote_id FOR UPDATE;

    FOR v_draw_item IN
      SELECT product_id,
             SUM(GREATEST(COALESCE(total_units_needed, 0) - COALESCE(quantity_delivered, 0), 0)) AS qty_undelivered
      FROM order_items
      WHERE order_id = p_order_id AND product_id IS NOT NULL
      GROUP BY product_id
      HAVING SUM(GREATEST(COALESCE(total_units_needed, 0) - COALESCE(quantity_delivered, 0), 0)) > 0
    LOOP
      UPDATE quote_product_draws
        SET quantity_drawn = GREATEST(quantity_drawn - v_draw_item.qty_undelivered, 0),
            updated_at = now()
      WHERE quote_id = v_order.quote_id
        AND product_id = v_draw_item.product_id;
    END LOOP;

    -- If this was the final draw, the quote sits at 'accepted'; with the
    -- balance restored it is no longer fully drawn, so reopen the booking.
    IF v_draw_quote.status = 'accepted' THEN
      SELECT COALESCE(bool_and(COALESCE(d.quantity_drawn, 0) >= b.booked), true) INTO v_draw_fully_drawn
      FROM (
        SELECT product_id, SUM(COALESCE(total_units_needed, 0)) AS booked
        FROM quote_items WHERE quote_id = v_order.quote_id
        GROUP BY product_id
      ) b
      LEFT JOIN quote_product_draws d
        ON d.quote_id = v_order.quote_id AND d.product_id = b.product_id
      WHERE b.booked > 0;

      IF NOT v_draw_fully_drawn THEN
        -- app.admin_override is already 'true' for this whole function body
        -- (SET LOCAL above) and is deliberately NOT reset here — the later
        -- unposted-invoice cancellation depends on it staying set.
        UPDATE quotes SET status = 'sent', updated_at = now()
        WHERE id = v_order.quote_id;

        INSERT INTO activity_feed (event_type, description, performed_by,
          related_entity_type, related_entity_id, customer_id)
        VALUES ('booking_reopened',
          'Booking ' || v_draw_quote.quote_number || ' reopened (accepted → sent): draw order ' ||
            v_order.order_number || ' was cancelled, returning its undelivered quantity to the booking balance',
          v_actor, 'quote', v_order.quote_id, v_draw_quote.customer_id);
      END IF;
    END IF;
  END IF;
  -- >>>A3

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
      v_item.product_id, 'released', v_undelivered, 'Main Warehouse',
      p_order_id, v_actor,
      'Released ' || v_undelivered || ' units — order ' || v_order.order_number || ' cancelled'
    );
  END LOOP;

  -- F7 fix / A3b: a non-draw cancel deactivates the booking's holds; a draw cancel
  -- keeps the booking OPEN but must REBUILD its holds to booked−drawn — the draw
  -- moved hold→prebooked, the prebooked was just released above, and the drawn
  -- ledger was just reduced, so a preserved (decremented) hold leaks the returned
  -- quantity out of the reservation (Net Free over-counts). Codex 2026-06-13 finding 1.
  IF v_order.quote_id IS NOT NULL THEN
    IF COALESCE(v_order.booking_draw, false) THEN
      PERFORM _sync_planned_holds(v_order.quote_id, v_actor);
    ELSE
      UPDATE inventory_holds SET is_active = false, updated_at = now()
      WHERE source_id = v_order.quote_id AND is_active = true;
      GET DIAGNOSTICS v_holds_released = ROW_COUNT;
    END IF;
  END IF;

  UPDATE commissions SET
    status = 'cancelled',
    commission_amount = 0
  WHERE order_id = p_order_id AND status = 'pending';
  GET DIAGNOSTICS v_commissions_cancelled = ROW_COUNT;

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

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'cancel_order', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

-- =====================================================================
-- 2. void_order — add batch-freeze hard-block
-- =====================================================================
CREATE OR REPLACE FUNCTION public.void_order(p_order_id uuid, p_performed_by uuid, p_reason text DEFAULT 'Voided by admin'::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_order record;
  v_item record;
  v_invoice record;
  v_admin record;
  v_inventory_restored integer := 0;
  v_commissions_cancelled integer := 0;
  v_paid_commissions integer := 0;
  v_draft_voided integer := 0;
  v_posted_notified integer := 0;
  v_existing jsonb;
  v_result jsonb;
  -- A3<<<
  v_draw_item record;
  v_draw_quote record;
  v_draw_fully_drawn boolean;
  -- >>>A3
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT is_admin() THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'void_order');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_NOT_FOUND'; END IF;
  IF v_order.status != 'fulfilled' THEN
    RAISE EXCEPTION 'INVALID_ORDER_STATUS: %', v_order.status;
  END IF;

  -- Commission batch-freeze guard (overnight bug-hunt HIGH, 20260620): a pending
  -- commission already committed to a non-voided commission_payments batch must not
  -- be silently cancelled here — post_commission_payment would later resurrect it to
  -- 'paid' and pay the retained snapshot. Force the admin to void the payout first.
  IF EXISTS (
    SELECT 1
    FROM public.commissions cm
    JOIN public.commission_payment_items cpi ON cpi.commission_id = cm.id
    JOIN public.commission_payments cp ON cp.id = cpi.commission_payment_id
    WHERE cm.order_id = p_order_id
      AND cm.status = 'pending'
      AND cp.status <> 'voided'
  ) THEN
    RAISE EXCEPTION 'ORDER_HAS_BATCHED_COMMISSIONS: order % has pending commission(s) committed to an active commission payment batch. Void that payment first, then void the order.', v_order.order_number;
  END IF;

  -- fulfilled→voided is a deliberate admin reversal the status-transition trigger does not
  -- include; bracket ONLY this write with the transaction-local admin override.
  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE public.orders
    SET status = 'voided',
        updated_at = now()
  WHERE id = p_order_id;
  PERFORM set_config('app.admin_override', 'false', true);
  -- A3<<< draw-ledger reversal (finding A3, 20260610190000 — see file header).
  -- void = the order is nulled and goods return to the warehouse, so the FULL
  -- drawn quantity goes back to the booking balance.
  IF COALESCE(v_order.booking_draw, false) AND v_order.quote_id IS NOT NULL THEN
    -- Lock the parent quote first: same quote → inventory order as
    -- draw_down_quote, and serializes against a concurrent draw.
    SELECT * INTO v_draw_quote FROM public.quotes
    WHERE id = v_order.quote_id FOR UPDATE;

    FOR v_draw_item IN
      SELECT product_id, SUM(COALESCE(total_units_needed, 0)) AS qty_drawn
      FROM public.order_items
      WHERE order_id = p_order_id AND product_id IS NOT NULL
      GROUP BY product_id
      HAVING SUM(COALESCE(total_units_needed, 0)) > 0
    LOOP
      UPDATE public.quote_product_draws
        SET quantity_drawn = GREATEST(quantity_drawn - v_draw_item.qty_drawn, 0),
            updated_at = now()
      WHERE quote_id = v_order.quote_id
        AND product_id = v_draw_item.product_id;
    END LOOP;

    -- If this was the final draw, the quote sits at 'accepted'; with the
    -- balance restored it is no longer fully drawn, so reopen the booking.
    IF v_draw_quote.status = 'accepted' THEN
      SELECT COALESCE(bool_and(COALESCE(d.quantity_drawn, 0) >= b.booked), true) INTO v_draw_fully_drawn
      FROM (
        SELECT product_id, SUM(COALESCE(total_units_needed, 0)) AS booked
        FROM public.quote_items WHERE quote_id = v_order.quote_id
        GROUP BY product_id
      ) b
      LEFT JOIN public.quote_product_draws d
        ON d.quote_id = v_order.quote_id AND d.product_id = b.product_id
      WHERE b.booked > 0;

      IF NOT v_draw_fully_drawn THEN
        -- accepted→sent is enforcer-legal on the live enforcer today; the
        -- override bracket is defense-in-depth (see file header).
        PERFORM set_config('app.admin_override', 'true', true);
        UPDATE public.quotes SET status = 'sent', updated_at = now()
        WHERE id = v_order.quote_id;
        PERFORM set_config('app.admin_override', 'false', true);

        INSERT INTO public.activity_feed (event_type, description, performed_by,
          related_entity_type, related_entity_id, customer_id)
        VALUES ('booking_reopened',
          'Booking ' || v_draw_quote.quote_number || ' reopened (accepted → sent): draw order ' ||
            v_order.order_number || ' was voided, returning its drawn quantity to the booking balance',
          v_actor, 'quote', v_order.quote_id, v_draw_quote.customer_id);
      END IF;
    END IF;
    -- VOID-1 fix (2026-06-13): the draw moved hold→prebooked; complete_delivery
    -- drained the prebooked to 0 before fulfilment, and the drawn ledger was just
    -- reversed above, so the still-OPEN booking's hold must be REBUILT to
    -- booked−drawn — a preserved (decremented) hold leaks the returned quantity
    -- out of the reservation (Net Free over-counts). Runs for every booking_draw
    -- void (reopened or not). The helper self-gates for non-planned/closed quotes.
    -- Symmetric twin of the cancel_order fix (20260613150100).
    PERFORM _sync_planned_holds(v_order.quote_id, v_actor);
  END IF;
  -- >>>A3

  FOR v_item IN
    SELECT product_id, quantity_delivered
    FROM public.order_items
    WHERE order_id = p_order_id
      AND COALESCE(quantity_delivered, 0) > 0
  LOOP
    UPDATE public.inventory
      SET quantity_available = quantity_available + v_item.quantity_delivered,
          updated_at = now()
    WHERE product_id = v_item.product_id
      AND location = 'Main Warehouse';

    INSERT INTO public.inventory_transactions (
      product_id, transaction_type, quantity, to_location,
      order_id, performed_by, notes
    ) VALUES (
      v_item.product_id,
      'void_delivery_reversal',
      v_item.quantity_delivered,
      'Main Warehouse',
      p_order_id,
      v_actor,
      'Restored ' || v_item.quantity_delivered || ' units - order ' ||
        v_order.order_number || ' voided. Reason: ' || p_reason
    );

    v_inventory_restored := v_inventory_restored + 1;
  END LOOP;

  UPDATE public.commissions
    SET status = 'cancelled',
        commission_amount = 0
  WHERE order_id = p_order_id
    AND status = 'pending';
  GET DIAGNOSTICS v_commissions_cancelled = ROW_COUNT;

  SELECT COUNT(*) INTO v_paid_commissions
  FROM public.commissions
  WHERE order_id = p_order_id AND status = 'paid';

  IF v_paid_commissions > 0 THEN
    FOR v_admin IN
      SELECT id FROM public.profiles WHERE role = 'admin' AND is_active = true
    LOOP
      INSERT INTO public.notifications (
        user_id, title, message,
        notification_type,
        related_entity_type,
        related_entity_id
      ) VALUES (
        v_admin.id,
        'Voided Order Has Paid Commissions',
        'Order ' || v_order.order_number || ' was voided but has ' ||
          v_paid_commissions || ' paid commission(s). Manual review required.',
        'void_review', 'order', p_order_id
      );
    END LOOP;
  END IF;

  FOR v_invoice IN
    SELECT * FROM public.invoices
    WHERE order_id = p_order_id
      AND deleted_at IS NULL
      AND status IN ('draft', 'posted')
  LOOP
    IF v_invoice.status = 'draft' THEN
      -- never-posted draft has no financial impact: cancel (allowed transition), do not void.
      UPDATE public.invoices
        SET status = 'cancelled',
            void_reason = 'Order ' || v_order.order_number || ' voided. ' || p_reason,
            updated_at = now()
      WHERE id = v_invoice.id;

      INSERT INTO public.financial_audit_log (
        operation_type,
        entity_type,
        entity_id,
        actor_role,
        old_values, new_values, total_impact_cents, description
      ) VALUES (
        'invoice_cancelled', 'invoice', v_invoice.id, 'admin',
        jsonb_build_object('status', 'draft', 'total_cents', v_invoice.total_amount_cents),
        jsonb_build_object('status', 'cancelled', 'void_reason', 'Order voided'),
        -1 * v_invoice.total_amount_cents,
        'Auto-cancelled draft invoice ' || v_invoice.invoice_number ||
          ' - order ' || v_order.order_number || ' voided'
      );

      v_draft_voided := v_draft_voided + 1;
    ELSIF v_invoice.status = 'posted' THEN
      FOR v_admin IN
        SELECT id FROM public.profiles WHERE role = 'admin' AND is_active = true
      LOOP
        INSERT INTO public.notifications (
          user_id, title, message,
          notification_type,
          related_entity_type,
          related_entity_id
        ) VALUES (
          v_admin.id,
          'Voided Order - Posted Invoice Needs Review',
          'Order ' || v_order.order_number || ' was voided. Invoice ' ||
            v_invoice.invoice_number || ' is posted and needs manual voiding.',
          'void_review', 'invoice', v_invoice.id
        );
      END LOOP;

      v_posted_notified := v_posted_notified + 1;
    END IF;
  END LOOP;

  INSERT INTO public.financial_audit_log (
    operation_type,
    entity_type,
    entity_id,
    actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'order_voided', 'order', p_order_id, 'admin',
    jsonb_build_object('status', 'fulfilled', 'total_price', v_order.total_price),
    jsonb_build_object('status', 'voided', 'void_reason', p_reason),
    -1 * ROUND(v_order.total_price * 100)::bigint,
    'Order ' || v_order.order_number || ' voided. Reason: ' || p_reason
  );

  INSERT INTO public.activity_feed (
    event_type, description, performed_by,
    related_entity_type,
    related_entity_id,
    customer_id
  ) VALUES (
    'order_voided',
    'Order ' || v_order.order_number || ' voided. ' ||
      v_inventory_restored || ' product(s) inventory restored. ' ||
      v_commissions_cancelled || ' commission(s) cancelled. ' ||
      v_draft_voided || ' draft invoice(s) cancelled.' ||
      CASE WHEN v_posted_notified > 0
           THEN ' ' || v_posted_notified || ' posted invoice(s) flagged for review.'
           ELSE '' END ||
      CASE WHEN v_paid_commissions > 0
           THEN ' ' || v_paid_commissions || ' paid commission(s) flagged for review.'
           ELSE '' END ||
      ' Reason: ' || p_reason,
    v_actor, 'order', p_order_id, v_order.customer_id
  );

  v_result := jsonb_build_object(
    'status', 'voided',
    'order_number', v_order.order_number,
    'inventory_products_restored', v_inventory_restored,
    'commissions_cancelled', v_commissions_cancelled,
    'paid_commissions_flagged', v_paid_commissions,
    'draft_invoices_voided', v_draft_voided,
    'posted_invoices_flagged', v_posted_notified
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'void_order', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

-- =====================================================================
-- 3. cancel_delivery — add batch-freeze hard-block in the quick-delivery
--    auto-cancel branch (the only path that cancels commissions)
-- =====================================================================
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
  v_quick_scheduled_exclusive boolean := false; v_prebooked_released integer := 0;
  v_qd_item record; v_release_qty numeric; v_actor_role text; v_paid_commissions integer := 0;
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
    -- Codex P2 (20260616171449): lock the order row so a concurrent update_order_items
    -- (which holds orders FOR UPDATE) cannot add/increase prebook in the window between
    -- the release loop and the order cancel. cancel_order locks the order the same way.
    SELECT status INTO v_order_status FROM orders WHERE id = v_delivery.order_id FOR UPDATE;

    IF COALESCE(v_delivery.is_quick_delivery, false) AND v_delivery.status IN ('scheduled', 'in_progress') THEN
      SELECT NOT EXISTS (
        SELECT 1 FROM deliveries
        WHERE order_id = v_delivery.order_id AND id <> p_delivery_id
          AND status NOT IN ('cancelled', 'voided')
      ) INTO v_quick_scheduled_exclusive;
    END IF;

    IF v_order_status IS NOT NULL AND v_order_status NOT IN ('cancelled', 'voided') THEN
      IF v_quick_scheduled_exclusive THEN
        -- Commission batch-freeze guard (overnight bug-hunt HIGH, 20260620): this branch
        -- auto-cancels the order and zeroes its pending commissions. A pending commission
        -- already committed to a non-voided commission_payments batch must not be silently
        -- cancelled — post_commission_payment would later resurrect it to 'paid'. Force the
        -- admin to void the payout first.
        IF EXISTS (
          SELECT 1
          FROM commissions cm
          JOIN commission_payment_items cpi ON cpi.commission_id = cm.id
          JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
          WHERE cm.order_id = v_delivery.order_id
            AND cm.status = 'pending'
            AND cp.status <> 'voided'
        ) THEN
          RAISE EXCEPTION 'ORDER_HAS_BATCHED_COMMISSIONS: the order auto-cancelled by this quick delivery has pending commission(s) committed to an active commission payment batch. Void that payment first.';
        END IF;
        -- P2-1: release by ORDER_ITEMS (the booking source of truth) so edited/added quantities prebooked via
        -- update_order_items (which never touches delivery_items) are released too. Mirrors cancel_order.
        FOR v_qd_item IN SELECT product_id, total_units_needed, COALESCE(quantity_delivered, 0) AS quantity_delivered FROM order_items WHERE order_id = v_delivery.order_id
        LOOP
          v_release_qty := GREATEST(v_qd_item.total_units_needed - v_qd_item.quantity_delivered, 0);
          IF v_release_qty <= 0 THEN CONTINUE; END IF;
          UPDATE inventory SET quantity_prebooked = GREATEST(quantity_prebooked - v_release_qty, 0), updated_at = now() WHERE product_id = v_qd_item.product_id AND location = 'Main Warehouse';
          INSERT INTO inventory_transactions (product_id, transaction_type, quantity, to_location, order_id, delivery_id, performed_by, notes)
          VALUES (v_qd_item.product_id, 'released', v_release_qty, 'Main Warehouse', v_delivery.order_id, p_delivery_id, v_actor, 'Released ' || v_release_qty || ' units — quick delivery ' || v_delivery.delivery_number || ' cancelled');
          v_prebooked_released := v_prebooked_released + 1;
        END LOOP;

        UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = v_delivery.order_id;
        UPDATE commissions SET status = 'cancelled', commission_amount = 0 WHERE order_id = v_delivery.order_id AND status = 'pending';

        -- P2-2: a quick order may have already-paid commissions — flag for admin review (mirror cancel_order).
        SELECT COUNT(*) INTO v_paid_commissions FROM commissions WHERE order_id = v_delivery.order_id AND status = 'paid';
        IF v_paid_commissions > 0 THEN
          FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true LOOP
            INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
            VALUES (v_admin.id, 'Cancelled Order Has Paid Commissions',
              'Quick-delivery order auto-cancelled with delivery ' || v_delivery.delivery_number || ' has ' || v_paid_commissions || ' paid commission(s). Manual review required.',
              'cancellation_review', 'order', v_delivery.order_id);
          END LOOP;
        END IF;

        SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor;
        INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role, old_values, new_values, total_impact_cents, description)
        VALUES ('order_cancelled', 'order', v_delivery.order_id, COALESCE(v_actor_role, 'sales_rep'),
          jsonb_build_object('status', v_order_status),
          jsonb_build_object('status', 'cancelled', 'reason', 'Quick delivery ' || v_delivery.delivery_number || ' cancelled', 'prebook_lines_released', v_prebooked_released, 'paid_commissions_flagged', v_paid_commissions),
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

  v_result := jsonb_build_object('success', true, 'delivery_id', p_delivery_id, 'items_restored', v_items_restored, 'prebooked_reincremented', v_prebooked_reincremented, 'prebooked_released', v_prebooked_released, 'paid_commissions_flagged', v_paid_commissions, 'draft_invoices_cancelled', v_draft_cancelled, 'posted_invoices_flagged', v_posted_notified);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'cancel_delivery', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

-- =====================================================================
-- 4. post_commission_payment — only flip pending commissions + drift guard
-- =====================================================================
CREATE OR REPLACE FUNCTION public.post_commission_payment(p_payment_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor    uuid;
  v_existing jsonb;
  v_payment  record;
  v_count    integer;
  v_item_count integer;
  v_result   jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Admin access required to post a commission payment';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'post_commission_payment');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_payment FROM commission_payments WHERE id = p_payment_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Commission payment not found';
  END IF;

  IF v_payment.status = 'posted' THEN
    RAISE EXCEPTION 'Commission payment is already posted';
  END IF;
  IF v_payment.status = 'voided' THEN
    RAISE EXCEPTION 'Cannot post a voided commission payment';
  END IF;

  PERFORM check_period_open(COALESCE(v_payment.payment_date, CURRENT_DATE));

  UPDATE commission_payments
     SET status = 'posted',
         posted_by = v_actor,
         posted_at = now(),
         updated_at = now()
   WHERE id = p_payment_id;

  UPDATE commissions
     SET status = 'paid',
         paid_date = v_payment.payment_date
   WHERE id IN (
     SELECT commission_id FROM commission_payment_items
     WHERE commission_payment_id = p_payment_id
   )
     AND status = 'pending';
  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Commission batch-freeze guard (overnight bug-hunt HIGH, 20260620): every commission
  -- in this batch must still be 'pending'. If any was cancelled/voided out from under the
  -- batch (or already paid), the count flipped will differ from the batch's item count —
  -- refuse to post the stale batch rather than resurrect a cancelled commission to 'paid'
  -- and pay its retained snapshot. The admin must void and rebuild the batch.
  SELECT count(*) INTO v_item_count
  FROM commission_payment_items
  WHERE commission_payment_id = p_payment_id;

  IF v_count <> v_item_count THEN
    RAISE EXCEPTION 'BATCH_COMMISSION_DRIFT: % of % batched commission(s) are no longer pending (cancelled or already paid). Void and rebuild this commission payment.', (v_item_count - v_count), v_item_count;
  END IF;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id,
    actor_user_id, total_impact_cents, description
  ) VALUES (
    'commission_payment_posted', 'commission_payment', p_payment_id,
    v_actor, (v_payment.total_amount * 100)::bigint,
    'Posted commission payment ' || v_payment.payment_number ||
    ' for $' || to_char(v_payment.total_amount, 'FM999,999,990.00') ||
    ' (' || v_count || ' commissions marked paid)'
  );

  v_result := jsonb_build_object(
    'success',           true,
    'payment_id',        p_payment_id,
    'payment_number',    v_payment.payment_number,
    'commissions_paid',  v_count
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'post_commission_payment', v_result);
  END IF;

  RETURN v_result;
END;
$function$;
