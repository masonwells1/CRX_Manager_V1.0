-- Fix Section-8 MED: bind cached unapply_credit_memo replays to the same credit memo.
-- Source body: 20260711050000_credit_apply_reversal_and_lifecycle.sql (latest emission).

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
  v_capp     record;  -- CREDIT-APPLY: active-application cursor
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
      -- Gauntlet Section-8 MED: key reuse across memos must error, matching the apply and reverse RPCs.
      IF (v_existing->>'credit_memo_id')::uuid IS DISTINCT FROM p_credit_memo_id THEN
        RAISE EXCEPTION 'IDEMPOTENCY_ARGUMENT_MISMATCH: idempotency key was already used for a different credit memo';
      END IF;
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

  -- Preserved from LIVE (PARKED-001): unapply respects the ORIGINAL credit's booking period.
  -- NOT new in this migration — the on-disk base file (20260609190725) predates this live gate.
  PERFORM check_period_open(v_invoice.invoice_date);

  -- CREDIT-APPLY: reverse every active application this memo handed out, so each target becomes
  -- owed again and the ledger stays consistent, BEFORE the memo is voided below (Codex #4).
  FOR v_capp IN
    SELECT id, applied_at FROM credit_memo_applications
     WHERE credit_memo_id = p_credit_memo_id AND reversed_at IS NULL
     ORDER BY id
  LOOP
    -- drift HIGH: each application's reversal is a money movement — gate it on THAT application's
    -- own period (applied_at), matching void_invoice + reverse_credit_memo_application. The
    -- top-of-function check_period_open(v_invoice.invoice_date) only covers the memo's ISSUE date;
    -- an application that landed in a since-closed period must not be reversible without its gate.
    PERFORM check_period_open(v_capp.applied_at::date);
    PERFORM _reverse_credit_memo_application(v_capp.id, v_actor,
      (SELECT role FROM profiles WHERE id = v_actor),
      'Auto-reversed: credit memo ' || v_invoice.invoice_number || ' unapplied — ' || p_reason);
  END LOOP;

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

REVOKE ALL ON FUNCTION public.unapply_credit_memo(uuid, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unapply_credit_memo(uuid, text, uuid, text) TO authenticated, service_role;
