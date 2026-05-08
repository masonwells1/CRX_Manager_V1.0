-- idempotency-body-check: exempt
-- cancel_order uses the check_idempotency() / save_idempotency() helpers
-- (defined in earlier migrations) which internally read/write idempotency_keys.
-- The body-check hook can't see through helper calls.
--
-- ============================================================================
-- Final-wave-review F7 (HIGH, code fix only) — stop phantom-inventory accrual
--
-- Bug. CLAUDE.md declares the canonical inventory formula:
--   Net Free = available − planned holds − prebooked
-- That definition treats holds as SOFT reservations: they affect the
-- displayed "Net Free" without ever moving rows in the inventory table.
-- And in fact `create_planned_holds` (latest live: 20260317100000) does
-- NOT decrement `inventory.quantity_available` when a planned hold is
-- created. The new `create_inventory_hold` (20260507170000) likewise does
-- not.
--
-- However, three functions assume holds DID debit `quantity_available`
-- and therefore "restore" it on release:
--
--   1. release_holds_on_quote_status_change()  (defined 20260316100001)
--      declined / expired branch UPDATE-adds v_hold.quantity to
--      quantity_available.
--   2. auto_expire_quotes()  (defined 20260316100001) belt-and-suspenders
--      block does the same.
--   3. cancel_order()  (latest definition 20260332000000) when
--      v_order.quote_id IS NOT NULL, performs the same restoration.
--
-- The accepted-quote branch correctly skips restoration (the comment cites
-- "convert_quote_to_order prebooks the same quantity") but the declined /
-- expired / cancelled paths run it unconditionally. Net effect since
-- 2026-03-16: every declined or expired planned quote has inflated
-- `inventory.quantity_available` by the hold's quantity, with no
-- corresponding `inventory_transactions` audit row. This is the bug the
-- new e2e spec `tests/e2e/holds-cleanup-paths.spec.ts` Path B catches.
--
-- This migration removes the phantom restoration from all three. The
-- deactivation of inventory_holds (and activity_feed log) is preserved
-- verbatim. Function signatures unchanged.
--
-- HISTORICAL CLEANUP IS NOT IN SCOPE HERE. The trigger has been adding
-- phantom units for ~7 weeks and there is no audit trail to back out
-- from. A separate cleanup migration is required to drain the inflation;
-- design notes are at:
--   docs/plans/2026-05-08-holds-historical-inflation-cleanup.md
--
-- This file STOPS THE BLEEDING. The cleanup pass DRAINS THE WOUND.
-- ============================================================================


-- ─── 1. release_holds_on_quote_status_change ────────────────────────────────
-- Source: 20260316100001 (latest definition). Only change: removed the
-- declined/expired restoration loop; deactivation + activity log preserved.
CREATE OR REPLACE FUNCTION public.release_holds_on_quote_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_released_count integer := 0;
BEGIN
  IF NEW.status IN ('accepted', 'declined', 'expired')
     AND OLD.status NOT IN ('accepted', 'declined', 'expired') THEN

    -- F7 fix: holds are soft reservations that never decremented
    -- quantity_available, so there is nothing to restore. Just deactivate.
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
        'Released ' || v_released_count || ' inventory hold(s) for quote ' || NEW.quote_number || ' (' || NEW.status || ')',
        COALESCE(auth.uid(), '00000000-0000-0000-0000-000000000000'),
        'quote', NEW.id, NEW.customer_id
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$;


-- ─── 2. auto_expire_quotes ──────────────────────────────────────────────────
-- Source: 20260316100001 (latest definition). Only change: removed the
-- belt-and-suspenders restoration loop that mirrored the trigger.
CREATE OR REPLACE FUNCTION public.auto_expire_quotes()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_quote record;
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
    -- Update quote status to expired (fires trg_release_holds_on_quote_status)
    UPDATE public.quotes SET
      status = 'expired',
      updated_at = now()
    WHERE id = v_quote.id;

    -- F7 fix: belt-and-suspenders deactivation only, no restoration.
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
      'Auto-expired ' || v_expired_count || ' quotes, deactivated ' || v_holds_released || ' inventory hold(s)',
      '00000000-0000-0000-0000-000000000000'::uuid
    );
  END IF;

  RETURN jsonb_build_object(
    'expired_count', v_expired_count,
    'holds_released', v_holds_released
  );
END;
$$;


-- ─── 3. cancel_order ────────────────────────────────────────────────────────
-- Source: 20260332000000 (latest definition — uses source columns of
-- balance_cents instead of writing to the GENERATED column, and uses
-- 'cancelled' invoice status). Only change: removed the FOR ... UPDATE
-- inventory loop in the IF v_order.quote_id IS NOT NULL block. The hold
-- deactivation UPDATE is preserved.
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

  -- Release prebooked inventory for undelivered items.
  -- Note: prebook IS a hard reservation (not a soft hold) so this
  -- restoration is correct. Only the soft-hold block below was bogus.
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

  -- F7 fix: deactivate the originating quote's holds without restoring
  -- quantity_available. Holds are soft reservations that never debited it.
  IF v_order.quote_id IS NOT NULL THEN
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

  -- Handle invoices — note: we update SOURCE columns, not the GENERATED
  -- balance_cents column. Postgres rejects writes to GENERATED columns.
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


-- Verify exactly one signature for each
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'release_holds_on_quote_status_change') != 1 THEN
    RAISE EXCEPTION 'release_holds_on_quote_status_change overload detected';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'auto_expire_quotes') != 1 THEN
    RAISE EXCEPTION 'auto_expire_quotes overload detected';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'cancel_order') != 1 THEN
    RAISE EXCEPTION 'cancel_order overload detected';
  END IF;
END $$;
