-- ============================================================================
-- ADMIN CORRECTIONS: Phase 3
-- Lower-priority reversal capabilities:
--   3.1  revert_quote_status()          — declined/expired/cancelled → sent
--   3.2  restore_cancelled_order()      — cancelled → confirmed
--   3.3  restore_cancelled_delivery()   — cancelled → scheduled
--   3.4  unapply_credit_memo()          — void credit memo, revert return to received
--   3.5  reverse_blend_ticket_approval() — approved → unreviewed
--
-- ALSO fixes: expands financial_audit_log.operation_type CHECK to include
--   operation types added by Phases 1.2, 2.1, 2.2 that were missing:
--   period_reopened, delivery_voided, commission_payment_voided
-- ============================================================================

-- ============================================================================
-- STEP 1: Expand financial_audit_log.operation_type CHECK
-- Adds all missing types from prior phases + new Phase 3 types
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
    -- Split / prepay operations
    'split_modified', 'split_invoices_generated',
    'prepay_created', 'prepay_applied', 'prepay_credit_created',
    'prepay_batch_applied', 'prepay_edited', 'prepay_deleted',
    -- Write-off operations
    'write_off_recorded', 'write_off_reversed', 'write_off_applied',
    -- Finance charge operations
    'finance_charge', 'finance_charge_generated', 'finance_charge_voided',
    -- Credit memo operations
    'credit_memo_created', 'credit_memo_applied', 'credit_memo_unapplied',
    -- Return operations
    'return_created', 'return_approved', 'return_received', 'return_credit_issued',
    -- Order / delivery operations
    'order_updated', 'order_voided', 'order_cancelled', 'order_restored',
    'delivery_updated', 'delivery_cancelled', 'delivery_voided', 'delivery_restored',
    -- Commission payment operations
    'commission_payment_created', 'commission_payment_posted', 'commission_payment_voided',
    -- Batch operations
    'batch_post', 'batch_void', 'batch_payment',
    -- Accounting period operations
    'period_reopened',
    -- Quote / blend ticket operations (Phase 3)
    'quote_status_reverted',
    'blend_ticket_approval_reversed',
    -- Misc
    'cycle_count_completed'
  ]));


-- ============================================================================
-- 3.1  revert_quote_status()
-- Reverts a declined, expired, cancelled, or accepted quote back to 'sent'.
-- For 'accepted' quotes: only allowed if no order has been created yet.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.revert_quote_status(
  p_quote_id        uuid,
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
  v_actor  uuid;
  v_quote  record;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  -- Admin-only
  IF (SELECT role FROM profiles WHERE id = v_actor) != 'admin' THEN
    RAISE EXCEPTION 'Admin access required to revert quote status';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required to revert quote status';
  END IF;

  -- Idempotency
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM 1 FROM idempotency_keys
    WHERE key = p_idempotency_key AND operation = 'revert_quote_status';
    IF FOUND THEN
      RETURN jsonb_build_object('status', 'already_processed');
    END IF;
  END IF;

  -- Lock and fetch
  SELECT * INTO v_quote
  FROM quotes
  WHERE id = p_quote_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quote not found: %', p_quote_id;
  END IF;

  -- Validate current status
  IF v_quote.status NOT IN ('declined', 'expired', 'cancelled', 'accepted') THEN
    RAISE EXCEPTION 'Cannot revert quote in status "%" — only declined, expired, cancelled, or accepted quotes can be reverted', v_quote.status;
  END IF;

  -- For accepted quotes: block if an order already exists
  IF v_quote.status = 'accepted' THEN
    IF EXISTS (SELECT 1 FROM orders WHERE quote_id = p_quote_id) THEN
      RAISE EXCEPTION 'Cannot revert accepted quote % — an order has already been created from it', v_quote.quote_number;
    END IF;
  END IF;

  -- Revert to 'sent'
  UPDATE quotes SET
    status     = 'sent',
    updated_at = now()
  WHERE id = p_quote_id;

  -- Audit log
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, description
  ) VALUES (
    'quote_status_reverted', 'quote', p_quote_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object('status', v_quote.status),
    jsonb_build_object('status', 'sent'),
    'Quote ' || v_quote.quote_number || ' reverted from ' || v_quote.status || ' to sent: ' || p_reason
  );

  -- Activity feed
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'quote_status_reverted',
    'Quote ' || v_quote.quote_number || ' reverted from ' || v_quote.status || ' to sent: ' || p_reason,
    v_actor, 'quote', p_quote_id, v_quote.customer_id
  );

  -- Record idempotency key
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (key, operation, result_id, expires_at)
    VALUES (p_idempotency_key, 'revert_quote_status', p_quote_id, now() + interval '24 hours')
    ON CONFLICT (key) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'success',       true,
    'quote_id',      p_quote_id,
    'quote_number',  v_quote.quote_number,
    'old_status',    v_quote.status,
    'new_status',    'sent'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.revert_quote_status(uuid, text, uuid, text) TO authenticated;


-- ============================================================================
-- 3.2  restore_cancelled_order()
-- Restores a cancelled order to 'confirmed'.
-- Does not automatically restore linked cancelled deliveries.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.restore_cancelled_order(
  p_order_id        uuid,
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
  v_actor  uuid;
  v_order  record;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  -- Admin-only
  IF (SELECT role FROM profiles WHERE id = v_actor) != 'admin' THEN
    RAISE EXCEPTION 'Admin access required to restore a cancelled order';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required to restore a cancelled order';
  END IF;

  -- Idempotency
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM 1 FROM idempotency_keys
    WHERE key = p_idempotency_key AND operation = 'restore_cancelled_order';
    IF FOUND THEN
      RETURN jsonb_build_object('status', 'already_processed');
    END IF;
  END IF;

  -- Lock and fetch
  SELECT * INTO v_order
  FROM orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found: %', p_order_id;
  END IF;

  IF v_order.status != 'cancelled' THEN
    RAISE EXCEPTION 'Only cancelled orders can be restored (current status: %)', v_order.status;
  END IF;

  -- Restore to 'confirmed'
  UPDATE orders SET
    status     = 'confirmed',
    updated_at = now()
  WHERE id = p_order_id;

  -- Audit log
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, description
  ) VALUES (
    'order_restored', 'order', p_order_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object('status', 'cancelled'),
    jsonb_build_object('status', 'confirmed'),
    'Order ' || v_order.order_number || ' restored from cancelled to confirmed: ' || p_reason
  );

  -- Activity feed
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'order_restored',
    'Order ' || v_order.order_number || ' restored from cancelled to confirmed: ' || p_reason,
    v_actor, 'order', p_order_id, v_order.customer_id
  );

  -- Record idempotency key
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (key, operation, result_id, expires_at)
    VALUES (p_idempotency_key, 'restore_cancelled_order', p_order_id, now() + interval '24 hours')
    ON CONFLICT (key) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'success',       true,
    'order_id',      p_order_id,
    'order_number',  v_order.order_number
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.restore_cancelled_order(uuid, text, uuid, text) TO authenticated;


-- ============================================================================
-- 3.3  restore_cancelled_delivery()
-- Restores a cancelled delivery back to 'scheduled'.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.restore_cancelled_delivery(
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
  v_actor    uuid;
  v_delivery record;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  -- Admin-only
  IF (SELECT role FROM profiles WHERE id = v_actor) != 'admin' THEN
    RAISE EXCEPTION 'Admin access required to restore a cancelled delivery';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required to restore a cancelled delivery';
  END IF;

  -- Idempotency
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM 1 FROM idempotency_keys
    WHERE key = p_idempotency_key AND operation = 'restore_cancelled_delivery';
    IF FOUND THEN
      RETURN jsonb_build_object('status', 'already_processed');
    END IF;
  END IF;

  -- Lock and fetch
  SELECT * INTO v_delivery
  FROM deliveries
  WHERE id = p_delivery_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery not found: %', p_delivery_id;
  END IF;

  IF v_delivery.status != 'cancelled' THEN
    RAISE EXCEPTION 'Only cancelled deliveries can be restored (current status: %)', v_delivery.status;
  END IF;

  -- Restore to 'scheduled'
  UPDATE deliveries SET
    status     = 'scheduled',
    updated_at = now()
  WHERE id = p_delivery_id;

  -- Audit log
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, description
  ) VALUES (
    'delivery_restored', 'delivery', p_delivery_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object('status', 'cancelled'),
    jsonb_build_object('status', 'scheduled'),
    'Delivery ' || v_delivery.delivery_number || ' restored from cancelled to scheduled: ' || p_reason
  );

  -- Activity feed
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'delivery_restored',
    'Delivery ' || v_delivery.delivery_number || ' restored from cancelled to scheduled: ' || p_reason,
    v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  -- Record idempotency key
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (key, operation, result_id, expires_at)
    VALUES (p_idempotency_key, 'restore_cancelled_delivery', p_delivery_id, now() + interval '24 hours')
    ON CONFLICT (key) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'success',           true,
    'delivery_id',       p_delivery_id,
    'delivery_number',   v_delivery.delivery_number
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.restore_cancelled_delivery(uuid, text, uuid, text) TO authenticated;


-- ============================================================================
-- 3.4  unapply_credit_memo()
-- Voids a credit memo invoice (invoice_type='credit_memo', status='posted')
-- and reverts the linked return from 'credited' back to 'received'.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.unapply_credit_memo(
  p_credit_memo_id  uuid,
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
  v_actor    uuid;
  v_invoice  record;
  v_return   record;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  -- Admin-only
  IF (SELECT role FROM profiles WHERE id = v_actor) != 'admin' THEN
    RAISE EXCEPTION 'Admin access required to unapply a credit memo';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required to unapply a credit memo';
  END IF;

  -- Idempotency
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM 1 FROM idempotency_keys
    WHERE key = p_idempotency_key AND operation = 'unapply_credit_memo';
    IF FOUND THEN
      RETURN jsonb_build_object('status', 'already_processed');
    END IF;
  END IF;

  -- Lock and fetch the credit memo invoice
  SELECT * INTO v_invoice
  FROM invoices
  WHERE id = p_credit_memo_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found: %', p_credit_memo_id;
  END IF;

  IF v_invoice.invoice_type != 'credit_memo' THEN
    RAISE EXCEPTION 'Invoice % is not a credit memo (type: %)', v_invoice.invoice_number, v_invoice.invoice_type;
  END IF;

  IF v_invoice.status != 'posted' THEN
    RAISE EXCEPTION 'Only posted credit memos can be unapplied (current status: %)', v_invoice.status;
  END IF;

  -- Find the linked return (if any)
  SELECT * INTO v_return
  FROM returns
  WHERE credit_invoice_id = p_credit_memo_id
  FOR UPDATE;

  -- Void the credit memo invoice
  UPDATE invoices SET
    status      = 'voided',
    voided_by   = v_actor,
    voided_at   = now(),
    void_reason = p_reason,
    updated_at  = now()
  WHERE id = p_credit_memo_id;

  -- If a return is linked, revert it to 'received'
  IF FOUND THEN
    UPDATE returns SET
      status             = 'received',
      credit_invoice_id  = NULL,
      total_credit_cents = NULL,
      credited_at        = NULL,
      credited_by        = NULL,
      updated_at         = now()
    WHERE id = v_return.id;
  END IF;

  -- Audit log
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'credit_memo_unapplied', 'invoice', p_credit_memo_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object('status', 'posted', 'total_amount_cents', v_invoice.total_amount_cents),
    jsonb_build_object(
      'status', 'void',
      'return_reverted', CASE WHEN v_return.id IS NOT NULL THEN v_return.return_number ELSE NULL END
    ),
    -v_invoice.total_amount_cents,
    'Credit memo ' || v_invoice.invoice_number || ' unapplied: ' || p_reason
  );

  -- Activity feed
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'credit_memo_unapplied',
    'Credit memo ' || v_invoice.invoice_number || ' unapplied: ' || p_reason,
    v_actor, 'invoice', p_credit_memo_id, v_invoice.customer_id
  );

  -- Record idempotency key
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (key, operation, result_id, expires_at)
    VALUES (p_idempotency_key, 'unapply_credit_memo', p_credit_memo_id, now() + interval '24 hours')
    ON CONFLICT (key) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'success',            true,
    'credit_memo_id',     p_credit_memo_id,
    'invoice_number',     v_invoice.invoice_number,
    'return_id',          v_return.id,
    'return_reverted',    v_return.id IS NOT NULL
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.unapply_credit_memo(uuid, text, uuid, text) TO authenticated;


-- ============================================================================
-- 3.5  reverse_blend_ticket_approval()
-- Reverts a blend ticket's review_status from 'approved' back to 'unreviewed'.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.reverse_blend_ticket_approval(
  p_ticket_id       uuid,
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
  v_actor  uuid;
  v_ticket record;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  -- Admin-only
  IF (SELECT role FROM profiles WHERE id = v_actor) != 'admin' THEN
    RAISE EXCEPTION 'Admin access required to reverse a blend ticket approval';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required to reverse a blend ticket approval';
  END IF;

  -- Idempotency
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM 1 FROM idempotency_keys
    WHERE key = p_idempotency_key AND operation = 'reverse_blend_ticket_approval';
    IF FOUND THEN
      RETURN jsonb_build_object('status', 'already_processed');
    END IF;
  END IF;

  -- Lock and fetch
  SELECT * INTO v_ticket
  FROM blend_tickets
  WHERE id = p_ticket_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Blend ticket not found: %', p_ticket_id;
  END IF;

  IF v_ticket.review_status != 'approved' THEN
    RAISE EXCEPTION 'Only approved blend tickets can have their approval reversed (current review_status: %)', v_ticket.review_status;
  END IF;

  -- Revert to 'unreviewed'
  UPDATE blend_tickets SET
    review_status = 'unreviewed',
    reviewed_by   = NULL,
    reviewed_at   = NULL,
    updated_at    = now()
  WHERE id = p_ticket_id;

  -- Audit log (financial_audit_log for full traceability)
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, description
  ) VALUES (
    'blend_ticket_approval_reversed', 'blend_ticket', p_ticket_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object('review_status', 'approved', 'reviewed_by', v_ticket.reviewed_by, 'reviewed_at', v_ticket.reviewed_at),
    jsonb_build_object('review_status', 'unreviewed'),
    'Blend ticket ' || v_ticket.ticket_number || ' approval reversed: ' || p_reason
  );

  -- Activity feed
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'blend_ticket_approval_reversed',
    'Blend ticket ' || v_ticket.ticket_number || ' approval reversed: ' || p_reason,
    v_actor, 'blend_ticket', p_ticket_id, v_ticket.customer_id
  );

  -- Record idempotency key
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (key, operation, result_id, expires_at)
    VALUES (p_idempotency_key, 'reverse_blend_ticket_approval', p_ticket_id, now() + interval '24 hours')
    ON CONFLICT (key) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'success',        true,
    'ticket_id',      p_ticket_id,
    'ticket_number',  v_ticket.ticket_number
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.reverse_blend_ticket_approval(uuid, text, uuid, text) TO authenticated;
