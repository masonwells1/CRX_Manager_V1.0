-- ============================================================================
-- Wave A.4 — Guard prepay-application paths with per-invoice period check
-- (audit finding P3-4)
-- ----------------------------------------------------------------------------
-- apply_remaining_prepayments and batch_apply_prepayments both create or
-- adjust prepay applications and decrement prepay_credits / increment
-- invoices.prepay_applied_cents (which feeds GENERATED balance_cents).
-- The previous implementations called check_period_open(CURRENT_DATE) — i.e.
-- they verified TODAY's period was open, but never checked the period of
-- the INVOICE being touched. So an admin running on May 4 (May open) could
-- apply a prepay against an April 28 posted invoice (April closed) without
-- going through reopen_accounting_period. The financial_audit_log captured
-- it but the period-close lock that month-end depends on was bypassed.
--
-- Fix: for every invoice the function will mutate, run
--   PERFORM check_period_open(v_invoice.invoice_date);
-- before incrementing prepay_applied_cents. If any invoice's date is in a
-- closed period, the call raises and the whole transaction rolls back.
--
-- Also adds pg_temp to search_path on apply_remaining_prepayments per the
-- project SECURITY DEFINER rule. (batch_apply_prepayments already has
-- search_path = public; we replace with public, pg_temp.)
--
-- The signature of apply_remaining_prepayments includes p_idempotency_key
-- because the live DB and the frontend both rely on it (PrepaymentManager.tsx
-- passes p_idempotency_key). The previous static migration that authored the
-- 3-arg signature did so via dynamic-clone, which is banned; this migration
-- replaces it explicitly.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. apply_remaining_prepayments(p_customer_id, p_performed_by, p_idempotency_key)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.apply_remaining_prepayments(
  p_customer_id     uuid,
  p_performed_by    uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_available     bigint;
  v_invoice       record;
  v_apply         bigint;
  v_applied_total bigint := 0;
  v_count         integer := 0;
  v_cached        jsonb;
  v_result        jsonb;
BEGIN
  -- Idempotency replay
  IF p_idempotency_key IS NOT NULL THEN
    v_cached := check_idempotency(p_idempotency_key, 'apply_remaining_prepayments');
    IF v_cached IS NOT NULL THEN
      RETURN v_cached;
    END IF;
  END IF;

  -- Lock customer row and read available prepay balance
  SELECT COALESCE(c.prepay_balance_cents, 0)
    INTO v_available
    FROM customers c
   WHERE c.id = p_customer_id
   FOR UPDATE;

  IF v_available IS NULL OR v_available <= 0 THEN
    v_result := jsonb_build_object(
      'applied_count', 0,
      'applied_cents', 0,
      'remaining_prepay_cents', 0,
      'message', 'No prepay balance available'
    );
    IF p_idempotency_key IS NOT NULL THEN
      PERFORM save_idempotency(p_idempotency_key, 'apply_remaining_prepayments', v_result);
    END IF;
    RETURN v_result;
  END IF;

  -- Apply to oldest unpaid invoices first.
  -- IMPORTANT: per-invoice check_period_open(invoice_date) is the heart of
  -- the P3-4 fix. Don't replace this with CURRENT_DATE.
  FOR v_invoice IN
    SELECT id, invoice_number, invoice_date, balance_cents
      FROM invoices
     WHERE customer_id = p_customer_id
       AND status = 'posted'
       AND balance_cents > 0
       AND deleted_at IS NULL
     ORDER BY invoice_date ASC, created_at ASC
     FOR UPDATE
  LOOP
    EXIT WHEN v_available <= 0;

    -- P3-4 FIX: enforce period-close on the INVOICE's date, not today's.
    PERFORM check_period_open(v_invoice.invoice_date);

    v_apply := LEAST(v_available, v_invoice.balance_cents);

    UPDATE invoices
       SET prepay_applied_cents = COALESCE(prepay_applied_cents, 0) + v_apply,
           updated_at = now()
     WHERE id = v_invoice.id;

    v_available     := v_available - v_apply;
    v_applied_total := v_applied_total + v_apply;
    v_count         := v_count + 1;
  END LOOP;

  -- Update customer prepay balance
  UPDATE customers
     SET prepay_balance_cents = GREATEST(0, COALESCE(prepay_balance_cents, 0) - v_applied_total),
         updated_at = now()
   WHERE id = p_customer_id;

  -- Audit log
  IF v_applied_total > 0 THEN
    INSERT INTO financial_audit_log (
      operation_type, entity_type, entity_id,
      actor_user_id, total_impact_cents, description
    ) VALUES (
      'prepay_batch_applied', 'prepay', p_customer_id,
      p_performed_by, v_applied_total,
      'Batch applied $' || (v_applied_total / 100.0)::numeric(12,2) ||
      ' prepay across ' || v_count || ' invoice(s) for customer ' ||
      (SELECT farm_name FROM customers WHERE id = p_customer_id)
    );
  END IF;

  v_result := jsonb_build_object(
    'applied_count', v_count,
    'applied_cents', v_applied_total,
    'remaining_prepay_cents', v_available
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'apply_remaining_prepayments', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_remaining_prepayments(uuid, uuid, text) TO authenticated;

COMMENT ON FUNCTION public.apply_remaining_prepayments(uuid, uuid, text) IS
  'Applies a customer''s available prepay balance to oldest-unpaid posted invoices, enforcing check_period_open per-invoice (Wave A.4 / P3-4). Invoice in a closed period raises and rolls back the entire batch.';


-- ---------------------------------------------------------------------------
-- 2. batch_apply_prepayments(p_allocations, p_performed_by, p_idempotency_key)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.batch_apply_prepayments(
  p_allocations     jsonb,
  p_performed_by    uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_alloc            jsonb;
  v_invoice_id       uuid;
  v_invoice_date     date;
  v_result_id        uuid;
  v_result_ids       uuid[] := ARRAY[]::uuid[];
  v_total_applied    bigint := 0;
  v_count            integer := 0;
  v_cached_result    jsonb;
  v_result           jsonb;
BEGIN
  -- Idempotency replay
  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := check_idempotency(p_idempotency_key, 'batch_apply_prepayments');
    IF v_cached_result IS NOT NULL THEN
      RETURN v_cached_result;
    END IF;
  END IF;

  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations)
  LOOP
    v_invoice_id := (v_alloc->>'invoice_id')::uuid;

    -- P3-4 FIX: look up the invoice's date and enforce period-close on it.
    -- This runs BEFORE the inner apply_prepay_to_invoice call, which itself
    -- only checks CURRENT_DATE.
    SELECT invoice_date INTO v_invoice_date
      FROM invoices
     WHERE id = v_invoice_id;
    IF v_invoice_date IS NULL THEN
      RAISE EXCEPTION 'Invoice not found for prepay allocation: %', v_invoice_id;
    END IF;
    PERFORM check_period_open(v_invoice_date);

    v_result_id := apply_prepay_to_invoice(
      (v_alloc->>'prepay_credit_id')::uuid,
      v_invoice_id,
      (v_alloc->>'amount_cents')::bigint
    );
    v_result_ids := array_append(v_result_ids, v_result_id);
    v_total_applied := v_total_applied + (v_alloc->>'amount_cents')::bigint;
    v_count := v_count + 1;
  END LOOP;

  v_result := jsonb_build_object(
    'success', true,
    'applied_count', v_count,
    'total_applied_cents', v_total_applied,
    'application_ids', to_jsonb(v_result_ids)
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'batch_apply_prepayments', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.batch_apply_prepayments(jsonb, uuid, text) TO authenticated;

COMMENT ON FUNCTION public.batch_apply_prepayments(jsonb, uuid, text) IS
  'Atomic batch application of prepay credits to invoices. Enforces check_period_open per-invoice before mutating (Wave A.4 / P3-4). Any invoice in a closed period raises and rolls back the entire batch.';
