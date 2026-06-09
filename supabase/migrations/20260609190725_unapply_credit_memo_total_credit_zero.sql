-- Fix Codex BLOCKER 1: unapply_credit_memo happy path fails.
--
-- unapply_credit_memo set returns.total_credit_cents = NULL, but the column is NOT NULL
-- DEFAULT 0 (verified live) — so unapplying a return-linked credit memo aborted with a
-- NOT NULL violation. Fix: reset total_credit_cents to 0 (not NULL) when reverting the
-- return to 'received'. credited_by = NULL is now valid (the column was added in
-- 20260609150000). Body otherwise verbatim from 20260609134025 (the prior strict-actor
-- version). Reversible.

CREATE OR REPLACE FUNCTION public.unapply_credit_memo(p_credit_memo_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor    uuid;
  v_invoice  record;
  v_return   record;
  v_existing jsonb;
  v_result   jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
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

  IF v_return.id IS NOT NULL THEN
    PERFORM set_config('app.admin_override', 'true', true);
    UPDATE returns SET
      status             = 'received',
      credit_invoice_id  = NULL,
      total_credit_cents = 0,
      credited_at        = NULL,
      credited_by        = NULL,
      updated_at         = now()
    WHERE id = v_return.id;
    PERFORM set_config('app.admin_override', 'false', true);
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
$function$;
