-- ============================================================================
-- Wave A.6 — Replace dynamic-clone idempotency fixes with explicit rewrites
-- (audit finding P3-2)
-- ----------------------------------------------------------------------------
-- Migration 20260332200000_fix_idempotency_column_refs_round2.sql used the
-- runtime introspection / regex-replace pattern to surgically patch 9 RPC
-- bodies plus save_quote. That technique is fragile (its output depends on
-- whatever happens to be in pg_proc at apply-time, not on a known
-- source-of-truth body) and it's banned by the project rules.
--
-- This migration replaces the active RPC definitions explicitly. Each body
-- below is the static definition from 20260331100000 / 20260331130000,
-- re-authored with:
--
--   1. The CORRECT idempotency_keys columns documented in CLAUDE.md
--      (idempotency_key, operation, result jsonb, expires_at). The previous
--      static bodies referenced columns that don't exist on the table —
--      that's what triggered the dynamic patch in the first place.
--   2. Idempotency replay returns the cached jsonb directly so callers see
--      the SAME response shape on retry.
--   3. SET search_path = public, pg_temp on every SECURITY DEFINER body.
--   4. ON CONFLICT clause references idempotency_key (the unique col).
--
-- reverse_write_off was already explicitly rewritten in Wave A.1 / migration
-- 20260506170000_fix_reverse_write_off.sql, so it is NOT re-declared here.
-- void_delivery and void_commission_payment had post-rewrite static
-- migrations (20260332300000, 20260332600000, 20260430250000) so they're
-- already explicit and not touched here.
-- save_quote was statically re-authored by 20260333200000, also untouched.
-- ============================================================================


-- ============================================================================
-- 1. reopen_accounting_period
-- ============================================================================
CREATE OR REPLACE FUNCTION public.reopen_accounting_period(
  p_period_id       uuid,
  p_reason          text,
  p_performed_by    uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor    uuid;
  v_period   record;
  v_existing jsonb;
  v_result   jsonb;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  IF (SELECT role FROM profiles WHERE id = v_actor) != 'admin' THEN
    RAISE EXCEPTION 'Admin access required to reopen accounting periods';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required to reopen an accounting period';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key
       AND operation = 'reopen_accounting_period';
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  SELECT * INTO v_period
    FROM accounting_periods
   WHERE id = p_period_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Accounting period not found: %', p_period_id;
  END IF;

  IF v_period.status != 'closed' THEN
    RAISE EXCEPTION 'Accounting period is not closed (status: %)', v_period.status;
  END IF;

  UPDATE accounting_periods SET
    status     = 'open',
    closed_at  = NULL,
    closed_by  = NULL,
    updated_at = now()
  WHERE id = p_period_id;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, description
  ) VALUES (
    'period_reopened', 'accounting_period', p_period_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object('status', 'closed', 'closed_at', v_period.closed_at),
    jsonb_build_object('status', 'open'),
    'Accounting period reopened: ' || p_reason
  );

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id
  ) VALUES (
    'period_reopened',
    'Accounting period ' || v_period.period_start || ' to ' || v_period.period_end ||
      ' reopened: ' || p_reason,
    v_actor, 'accounting_period', p_period_id
  );

  v_result := jsonb_build_object(
    'success',      true,
    'period_id',    p_period_id,
    'period_start', v_period.period_start,
    'period_end',   v_period.period_end
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at)
    VALUES (p_idempotency_key, 'reopen_accounting_period', v_result, now() + interval '24 hours')
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reopen_accounting_period(uuid, text, uuid, text) TO authenticated;


-- ============================================================================
-- 2. revert_quote_status
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
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor    uuid;
  v_quote    record;
  v_existing jsonb;
  v_result   jsonb;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  IF (SELECT role FROM profiles WHERE id = v_actor) != 'admin' THEN
    RAISE EXCEPTION 'Admin access required to revert quote status';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required to revert quote status';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key
       AND operation = 'revert_quote_status';
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  SELECT * INTO v_quote
    FROM quotes
   WHERE id = p_quote_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quote not found: %', p_quote_id;
  END IF;

  IF v_quote.status NOT IN ('declined', 'expired', 'cancelled', 'accepted') THEN
    RAISE EXCEPTION 'Cannot revert quote in status "%" — only declined, expired, cancelled, or accepted quotes can be reverted', v_quote.status;
  END IF;

  IF v_quote.status = 'accepted' THEN
    IF EXISTS (SELECT 1 FROM orders WHERE quote_id = p_quote_id) THEN
      RAISE EXCEPTION 'Cannot revert accepted quote % — an order has already been created from it', v_quote.quote_number;
    END IF;
  END IF;

  UPDATE quotes SET
    status     = 'sent',
    updated_at = now()
  WHERE id = p_quote_id;

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

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'quote_status_reverted',
    'Quote ' || v_quote.quote_number || ' reverted from ' || v_quote.status || ' to sent: ' || p_reason,
    v_actor, 'quote', p_quote_id, v_quote.customer_id
  );

  v_result := jsonb_build_object(
    'success',       true,
    'quote_id',      p_quote_id,
    'quote_number',  v_quote.quote_number,
    'old_status',    v_quote.status,
    'new_status',    'sent'
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at)
    VALUES (p_idempotency_key, 'revert_quote_status', v_result, now() + interval '24 hours')
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.revert_quote_status(uuid, text, uuid, text) TO authenticated;


-- ============================================================================
-- 3. restore_cancelled_order
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
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor    uuid;
  v_order    record;
  v_existing jsonb;
  v_result   jsonb;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  IF (SELECT role FROM profiles WHERE id = v_actor) != 'admin' THEN
    RAISE EXCEPTION 'Admin access required to restore a cancelled order';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required to restore a cancelled order';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key
       AND operation = 'restore_cancelled_order';
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

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

  UPDATE orders SET
    status     = 'confirmed',
    updated_at = now()
  WHERE id = p_order_id;

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

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'order_restored',
    'Order ' || v_order.order_number || ' restored from cancelled to confirmed: ' || p_reason,
    v_actor, 'order', p_order_id, v_order.customer_id
  );

  v_result := jsonb_build_object(
    'success',       true,
    'order_id',      p_order_id,
    'order_number',  v_order.order_number
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at)
    VALUES (p_idempotency_key, 'restore_cancelled_order', v_result, now() + interval '24 hours')
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.restore_cancelled_order(uuid, text, uuid, text) TO authenticated;


-- ============================================================================
-- 4. restore_cancelled_delivery
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
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor    uuid;
  v_delivery record;
  v_existing jsonb;
  v_result   jsonb;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  IF (SELECT role FROM profiles WHERE id = v_actor) != 'admin' THEN
    RAISE EXCEPTION 'Admin access required to restore a cancelled delivery';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required to restore a cancelled delivery';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key
       AND operation = 'restore_cancelled_delivery';
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

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

  UPDATE deliveries SET
    status     = 'scheduled',
    updated_at = now()
  WHERE id = p_delivery_id;

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

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'delivery_restored',
    'Delivery ' || v_delivery.delivery_number || ' restored from cancelled to scheduled: ' || p_reason,
    v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  v_result := jsonb_build_object(
    'success',           true,
    'delivery_id',       p_delivery_id,
    'delivery_number',   v_delivery.delivery_number
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at)
    VALUES (p_idempotency_key, 'restore_cancelled_delivery', v_result, now() + interval '24 hours')
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.restore_cancelled_delivery(uuid, text, uuid, text) TO authenticated;


-- ============================================================================
-- 5. unapply_credit_memo
-- Side-fix: the audit log new_values now records the canonical 'voided'
-- status string instead of the inaccurate 'void'.
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
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor    uuid;
  v_invoice  record;
  v_return   record;
  v_existing jsonb;
  v_result   jsonb;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  IF (SELECT role FROM profiles WHERE id = v_actor) != 'admin' THEN
    RAISE EXCEPTION 'Admin access required to unapply a credit memo';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required to unapply a credit memo';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key
       AND operation = 'unapply_credit_memo';
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

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

  SELECT * INTO v_return
    FROM returns
   WHERE credit_invoice_id = p_credit_memo_id
   FOR UPDATE;

  UPDATE invoices SET
    status      = 'voided',
    voided_by   = v_actor,
    voided_at   = now(),
    void_reason = p_reason,
    updated_at  = now()
  WHERE id = p_credit_memo_id;

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

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'credit_memo_unapplied', 'invoice', p_credit_memo_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object('status', 'posted', 'total_amount_cents', v_invoice.total_amount_cents),
    jsonb_build_object(
      'status', 'voided',
      'return_reverted', CASE WHEN v_return.id IS NOT NULL THEN v_return.return_number ELSE NULL END
    ),
    -v_invoice.total_amount_cents,
    'Credit memo ' || v_invoice.invoice_number || ' unapplied: ' || p_reason
  );

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'credit_memo_unapplied',
    'Credit memo ' || v_invoice.invoice_number || ' unapplied: ' || p_reason,
    v_actor, 'invoice', p_credit_memo_id, v_invoice.customer_id
  );

  v_result := jsonb_build_object(
    'success',         true,
    'credit_memo_id',  p_credit_memo_id,
    'invoice_number',  v_invoice.invoice_number,
    'return_id',       v_return.id,
    'return_reverted', v_return.id IS NOT NULL
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at)
    VALUES (p_idempotency_key, 'unapply_credit_memo', v_result, now() + interval '24 hours')
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.unapply_credit_memo(uuid, text, uuid, text) TO authenticated;


-- ============================================================================
-- 6. reverse_blend_ticket_approval
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
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor    uuid;
  v_ticket   record;
  v_existing jsonb;
  v_result   jsonb;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  IF (SELECT role FROM profiles WHERE id = v_actor) != 'admin' THEN
    RAISE EXCEPTION 'Admin access required to reverse a blend ticket approval';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required to reverse a blend ticket approval';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key
       AND operation = 'reverse_blend_ticket_approval';
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

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

  UPDATE blend_tickets SET
    review_status = 'unreviewed',
    reviewed_by   = NULL,
    reviewed_at   = NULL,
    updated_at    = now()
  WHERE id = p_ticket_id;

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

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'blend_ticket_approval_reversed',
    'Blend ticket ' || v_ticket.ticket_number || ' approval reversed: ' || p_reason,
    v_actor, 'blend_ticket', p_ticket_id, v_ticket.customer_id
  );

  v_result := jsonb_build_object(
    'success',        true,
    'ticket_id',      p_ticket_id,
    'ticket_number',  v_ticket.ticket_number
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at)
    VALUES (p_idempotency_key, 'reverse_blend_ticket_approval', v_result, now() + interval '24 hours')
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reverse_blend_ticket_approval(uuid, text, uuid, text) TO authenticated;


-- ============================================================================
-- Documentation comments
-- ============================================================================

COMMENT ON FUNCTION public.reopen_accounting_period(uuid, text, uuid, text) IS
  'Admin-only reopen of a closed accounting period with mandatory reason; logs to financial_audit_log + activity_feed. Wave A.6 explicit rewrite of the dynamic-clone version.';
COMMENT ON FUNCTION public.revert_quote_status(uuid, text, uuid, text) IS
  'Admin-only revert of a declined/expired/cancelled/accepted quote back to "sent". Accepted quotes blocked if an order has been created. Wave A.6 explicit rewrite.';
COMMENT ON FUNCTION public.restore_cancelled_order(uuid, text, uuid, text) IS
  'Admin-only restore of a cancelled order to "confirmed". Does not auto-restore linked deliveries. Wave A.6 explicit rewrite.';
COMMENT ON FUNCTION public.restore_cancelled_delivery(uuid, text, uuid, text) IS
  'Admin-only restore of a cancelled delivery to "scheduled". Wave A.6 explicit rewrite.';
COMMENT ON FUNCTION public.unapply_credit_memo(uuid, text, uuid, text) IS
  'Admin-only void of a posted credit memo invoice and revert of its linked return from "credited" back to "received". Wave A.6 explicit rewrite (also fixes audit-log status string for the new state).';
COMMENT ON FUNCTION public.reverse_blend_ticket_approval(uuid, text, uuid, text) IS
  'Admin-only revert of a blend ticket review_status from "approved" to "unreviewed". Wave A.6 explicit rewrite.';
