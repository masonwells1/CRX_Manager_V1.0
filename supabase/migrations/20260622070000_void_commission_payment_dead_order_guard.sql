-- 20260622070000_void_commission_payment_dead_order_guard.sql
--
-- OVERNIGHT BUG HUNT Run 2 cycle 7, finding #15 (MEDIUM verifier / HIGH Codex; money — pays a rep on a dead order).
-- dedupeKey: commissions:void_commission_payment:resurrect-cancelled-order
--
-- WHAT WAS WRONG
-- After a commission batch is POSTED, each commission is status='paid'. If the underlying ORDER
-- is then voided/cancelled, the order-teardown guard in cancel_order/void_order only catches
-- commissions still 'pending' (`WHERE status='pending'`), so the 'paid' one survives. Later,
-- void_commission_payment UNCONDITIONALLY runs
--     UPDATE commissions SET status='pending', paid_date=NULL WHERE id IN (batch items)
-- which RESURRECTS that commission to 'pending' on a dead order. fetchUnpaid (.eq status,'pending'),
-- get_commission_balance_report, and create_commission_payment all re-expose it as payable, so a
-- rep can be paid commission AGAIN on an order that no longer exists.
--
-- THE FIX
-- Split the blanket reset by the order's liveness, mirroring cancel_order's own teardown
-- (UPDATE commissions SET status='cancelled', commission_amount=0 ...):
--   • order still LIVE (no cancelled/voided/deleted order) -> reset to 'pending' (correctly re-payable);
--   • order DEAD (status IN ('cancelled','voided') OR deleted_at IS NOT NULL) -> set 'cancelled',
--     commission_amount=0 (never re-payable), matching what cancel_order/void_order would have done.
-- Report both counts (commissions_reset vs commissions_cancelled) in the result + financial_audit_log.
-- Body otherwise reproduced verbatim from the live definition; the ONLY change is the single
-- blanket UPDATE becoming the two scoped UPDATEs (marked OVERNIGHT FIX) + the extra count.
--
-- Latent today: 0 paid commissions / 0 posted commission_payments live. ROLLBACK: restore the
-- single blanket UPDATE.

CREATE OR REPLACE FUNCTION public.void_commission_payment(p_payment_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_payment record;
  v_reset_count integer;
  v_cancelled_count integer;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT is_admin() THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'void_commission_payment');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_payment
  FROM commission_payments
  WHERE id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'COMMISSION_PAYMENT_NOT_FOUND'; END IF;
  IF v_payment.status NOT IN ('posted', 'unposted') THEN
    RAISE EXCEPTION 'INVALID_COMMISSION_PAYMENT_STATUS: %', v_payment.status;
  END IF;

  UPDATE commission_payments SET
    status = 'voided',
    updated_at = now()
  WHERE id = p_payment_id;

  -- OVERNIGHT FIX (finding #15): only return a batch commission to 'pending' (re-payable) if its
  -- ORDER is still live. A commission whose order was voided/cancelled/deleted after the batch was
  -- posted must NOT be resurrected — set it 'cancelled' / amount 0, matching cancel_order/void_order.
  UPDATE commissions c SET
    status = 'pending',
    paid_date = NULL
  WHERE c.id IN (
    SELECT commission_id FROM commission_payment_items
    WHERE commission_payment_id = p_payment_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM orders o
    WHERE o.id = c.order_id
      AND (o.status IN ('cancelled', 'voided') OR o.deleted_at IS NOT NULL)
  );
  GET DIAGNOSTICS v_reset_count = ROW_COUNT;

  UPDATE commissions c SET
    status = 'cancelled',
    commission_amount = 0,
    paid_date = NULL
  WHERE c.id IN (
    SELECT commission_id FROM commission_payment_items
    WHERE commission_payment_id = p_payment_id
  )
  AND EXISTS (
    SELECT 1 FROM orders o
    WHERE o.id = c.order_id
      AND (o.status IN ('cancelled', 'voided') OR o.deleted_at IS NOT NULL)
  );
  GET DIAGNOSTICS v_cancelled_count = ROW_COUNT;

  INSERT INTO financial_audit_log (
    operation_type,
    entity_type,
    entity_id,
    actor_role,
    old_values, new_values, description
  ) VALUES (
    'commission_payment_voided', 'commission_payment', p_payment_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object('status', v_payment.status, 'total_amount', v_payment.total_amount),
    jsonb_build_object('status', 'voided', 'commissions_reset', v_reset_count, 'commissions_cancelled_dead_order', v_cancelled_count),
    'Commission payment ' || v_payment.payment_number || ' voided: ' || p_reason
  );

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type,
    related_entity_id
  ) VALUES (
    'commission_payment_voided',
    'Commission payment ' || v_payment.payment_number || ' voided: ' || p_reason,
    v_actor, 'commission_payment', p_payment_id
  );

  v_result := jsonb_build_object(
    'success', true,
    'payment_id', p_payment_id,
    'payment_number', v_payment.payment_number,
    'commissions_reset', v_reset_count,
    'commissions_cancelled_dead_order', v_cancelled_count
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'void_commission_payment', v_result);
  END IF;

  RETURN v_result;
END;
$function$;
