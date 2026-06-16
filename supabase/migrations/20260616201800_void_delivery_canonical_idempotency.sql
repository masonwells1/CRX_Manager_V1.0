-- Fix (LOW, large-RPC pass #11): void_delivery's idempotency diverged from the canonical helper pattern.
-- On a retried call it returned a bare {"status":"already_processed"} marker instead of the rich payload the
-- first call returned (success/delivery_id/delivery_number/new_order_status/posted_invoices_exist), and it
-- stored to_jsonb(p_delivery_id) (a bare UUID) as the cached result. So an idempotent replay gave the caller
-- a different shape than the original — DeliveryDetail.tsx reads posted_invoices_exist off the result, which
-- the 'already_processed' marker lacked.
--
-- Fix: move to the canonical check_idempotency()/save_idempotency() helpers (same as create_invoice_from_order),
-- caching the REAL rich result and replaying it verbatim. expires_at is unchanged in effect — the
-- idempotency_keys.expires_at column DEFAULTs to now() + 24h, the exact window the old explicit INSERT used.
-- No frontend code matches the 'already_processed' string (verified); the new replay shape is a strict superset.
--
-- Body reproduced live-verbatim except the marked DELTA-IDEM blocks. Baseline live md5: bcc970f05a4dfa0d70b584b4837834e5.
-- Source: nightly-debug (LEDGER: delivery:void_delivery:idempotency-shape-divergence).
-- Rollback: re-apply void_delivery with the DELTA-IDEM blocks reverted to the inline PERFORM-1 check + bare-UUID INSERT.

CREATE OR REPLACE FUNCTION public.void_delivery(p_delivery_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor         uuid;
  v_delivery      record;
  v_item          record;
  v_posted_invoices_exist boolean := false;
  v_order_confirmed boolean;
  v_order_fulfilled boolean;
  v_new_order_status text;
  v_closed_period record;
  v_admin record;
  -- DELTA-IDEM BEGIN (#11 nightly-debug: canonical idempotency — cache/replay the rich result)
  v_existing jsonb;
  v_result jsonb;
  -- DELTA-IDEM END
BEGIN
  -- Strict actor pattern (codex audit F1)
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  IF (SELECT role FROM profiles WHERE id = v_actor) != 'admin' THEN
    RAISE EXCEPTION 'Admin access required to void a completed delivery';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required to void a delivery';
  END IF;

  -- DELTA-IDEM BEGIN (#11: canonical check — replay the cached rich payload, not a bare marker)
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'void_delivery');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;
  -- DELTA-IDEM END

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

  SELECT id, period_start, period_end
    INTO v_closed_period
    FROM accounting_periods
   WHERE status = 'closed'
     AND v_delivery.scheduled_date BETWEEN period_start AND period_end
   LIMIT 1;

  IF FOUND THEN
    INSERT INTO activity_feed (
      event_type, description, performed_by,
      related_entity_type, related_entity_id, customer_id
    ) VALUES (
      'backdated_delivery_in_closed_period',
      'WARNING: Delivery ' || v_delivery.delivery_number ||
        ' voided for date ' || v_delivery.scheduled_date::text ||
        ' which falls in CLOSED accounting period ' ||
        v_closed_period.period_start::text || ' to ' ||
        v_closed_period.period_end::text || '. Reason: ' || p_reason ||
        '. Operation proceeded; verify with finance.',
      v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
    );

    FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
    LOOP
      INSERT INTO notifications (
        user_id, title, message, notification_type,
        related_entity_type, related_entity_id
      ) VALUES (
        v_admin.id,
        'Backdated Delivery Void',
        'Delivery ' || v_delivery.delivery_number ||
          ' was voided for scheduled date ' || v_delivery.scheduled_date::text ||
          ' — that date is inside a CLOSED accounting period (' ||
          v_closed_period.period_start::text || ' to ' ||
          v_closed_period.period_end::text || '). Inventory was restored and ' ||
          'draft invoices were auto-cancelled. Verify the financial impact.',
        'period_warning', 'delivery', p_delivery_id
      );
    END LOOP;
  END IF;

  PERFORM set_config('app.admin_override', 'true', true);

  FOR v_item IN
    SELECT di.*, p.product_name
    FROM delivery_items di
    JOIN products p ON p.id = di.product_id
    WHERE di.delivery_id = p_delivery_id
      AND di.quantity_delivered > 0
  LOOP
    UPDATE inventory SET
      quantity_available = quantity_available + v_item.quantity_delivered,
      quantity_prebooked = quantity_prebooked + v_item.quantity_delivered,
      updated_at = now()
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, from_location,
      order_id, delivery_id, performed_by, notes
    ) VALUES (
      v_item.product_id, 'void_delivery_reversal', v_item.quantity_delivered, 'Main Warehouse',
      v_delivery.order_id, p_delivery_id, v_actor,
      'Delivery ' || v_delivery.delivery_number || ' voided: ' || p_reason || ' (available + prebooked restored)'
    );

    UPDATE order_items SET
      quantity_delivered = GREATEST(quantity_delivered - v_item.quantity_delivered, 0),
      quantity_remaining = quantity_remaining + v_item.quantity_delivered
    WHERE id = v_item.order_item_id;
  END LOOP;

  DELETE FROM delivery_remainders WHERE original_delivery_id = p_delivery_id;

  SELECT NOT EXISTS (
    SELECT 1 FROM order_items
    WHERE order_id = v_delivery.order_id AND quantity_remaining > 0
  ) INTO v_order_fulfilled;

  SELECT NOT EXISTS (
    SELECT 1 FROM order_items
    WHERE order_id = v_delivery.order_id AND quantity_remaining < total_units_needed
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

  UPDATE invoices SET
    status      = 'cancelled',
    void_reason = 'Auto-cancelled: delivery ' || v_delivery.delivery_number || ' was voided by admin',
    updated_at  = now()
  WHERE order_id = v_delivery.order_id AND status = 'draft';

  SELECT EXISTS (
    SELECT 1 FROM invoices
    WHERE order_id = v_delivery.order_id AND status = 'posted'
  ) INTO v_posted_invoices_exist;

  UPDATE deliveries SET
    status     = 'voided',
    updated_at = now()
  WHERE id = p_delivery_id;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, actor_role,
    old_values, new_values, description
  ) VALUES (
    'delivery_voided', 'delivery', p_delivery_id, v_actor,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object('status', 'completed'),
    jsonb_build_object('status', 'voided', 'order_status', v_new_order_status),
    'Delivery ' || v_delivery.delivery_number || ' voided: ' || p_reason
  );

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'delivery_voided',
    'Delivery ' || v_delivery.delivery_number || ' voided: ' || p_reason,
    v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  -- DELTA-IDEM BEGIN (#11: build the rich result first, then cache it via the canonical helper + replay it)
  v_result := jsonb_build_object(
    'success',                true,
    'delivery_id',            p_delivery_id,
    'delivery_number',        v_delivery.delivery_number,
    'new_order_status',       v_new_order_status,
    'posted_invoices_exist',  v_posted_invoices_exist
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'void_delivery', v_result);
  END IF;

  PERFORM set_config('app.admin_override', 'false', true);

  RETURN v_result;
  -- DELTA-IDEM END
END;
$function$;
