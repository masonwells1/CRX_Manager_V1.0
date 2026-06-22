-- 20260622040000_apply_prepay_remove_double_decrement.sql
--
-- OVERNIGHT BUG HUNT Run 2 cycle 2, finding #1 (HIGH — both adversarial verifier + Codex; money loss).
-- dedupeKey: money:apply_prepay_to_invoice:balance-double-decrement
--
-- WHAT WAS WRONG
-- apply_prepay_to_invoice subtracts the applied amount from prepay_credits.balance_cents TWICE:
--   (1) INSERT INTO prepay_applications (...)   -- this alone is enough, because:
--   (2) the AFTER INSERT/DELETE trigger trg_recompute_prepay_credit_balance ->
--       _recompute_prepay_credit_balance() ABSOLUTELY recomputes
--       balance_cents = original_amount_cents - SUM(applied_amount_cents)
--   (3) then the function ALSO does an explicit
--       UPDATE prepay_credits SET balance_cents = balance_cents - p_amount_cents
-- Step (3) double-subtracts on top of the trigger's correct recompute. A $300 application
-- destroys $600 of credit; reconcile_prepay_balances() then propagates the understated
-- per-credit balance into customers.prepay_balance_cents (permanent customer credit loss).
-- Root cause = migration ordering drift: the explicit decrement (function hardening, live
-- stamp 20260511214128) was correct BEFORE the recompute trigger (20260512024802) existed,
-- and was never removed after the trigger took over balance maintenance.
--
-- THE FIX
-- Remove ONLY the explicit `UPDATE prepay_credits SET balance_cents = balance_cents - p_amount_cents`
-- block and rely solely on the trigger (the single source of truth for prepay_credits.balance_cents).
-- KEEP the customers.prepay_balance_cents decrement — that cache table is NOT trigger-maintained.
-- Everything else is reproduced verbatim from the live body.
--
-- Proven by rolled-back live smoke: 100000c credit + 30000c application -> balance_cents=70000
-- (was 40000 before the fix). Rolled back; zero prod footprint.
--
-- ROLLBACK: re-add the explicit decrement block (restores the double-subtract bug).

CREATE OR REPLACE FUNCTION public.apply_prepay_to_invoice(p_prepay_credit_id uuid, p_invoice_id uuid, p_amount_cents bigint, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_credit    record;
  v_inv       record;
  v_app_id    uuid;
  v_actor     uuid;
  v_actor_role text;
  v_existing  jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;

  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: only admins and sales reps can apply prepayments';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'apply_prepay_to_invoice');
    IF v_existing IS NOT NULL THEN
      RETURN (v_existing->>'application_id')::uuid;
    END IF;
  END IF;

  SELECT * INTO v_credit FROM prepay_credits WHERE id = p_prepay_credit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Prepay credit not found'; END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;

  -- DELTA (overnight-fix 20260620): same-customer guard. A prepay credit may only be applied to an
  -- invoice belonging to the SAME customer. Protects the direct RPC path and batch_apply_prepayments.
  IF v_credit.customer_id IS DISTINCT FROM v_inv.customer_id THEN
    RAISE EXCEPTION 'CUSTOMER_MISMATCH: prepay credit % (customer %) cannot be applied to invoice % (customer %)',
      p_prepay_credit_id, v_credit.customer_id, p_invoice_id, v_inv.customer_id;
  END IF;

  IF v_inv.status NOT IN ('posted', 'overdue') THEN
    RAISE EXCEPTION 'Can only apply prepay to posted/overdue invoices (current status: %)', v_inv.status;
  END IF;

  PERFORM check_period_open(CURRENT_DATE);

  IF p_amount_cents <= 0 THEN RAISE EXCEPTION 'Application amount must be positive'; END IF;

  IF p_amount_cents > v_credit.balance_cents THEN
    RAISE EXCEPTION 'Amount exceeds prepay balance ($%)', (v_credit.balance_cents / 100.0)::numeric(12,2);
  END IF;

  IF p_amount_cents > v_inv.balance_cents THEN
    RAISE EXCEPTION 'Amount exceeds invoice balance ($%)', (v_inv.balance_cents / 100.0)::numeric(12,2);
  END IF;

  INSERT INTO prepay_applications (prepay_credit_id, invoice_id, applied_amount_cents)
  VALUES (p_prepay_credit_id, p_invoice_id, p_amount_cents)
  RETURNING id INTO v_app_id;

  -- OVERNIGHT FIX (finding #1): the explicit
  --   UPDATE prepay_credits SET balance_cents = balance_cents - p_amount_cents, updated_at = now()
  --   WHERE id = p_prepay_credit_id;
  -- block is REMOVED here. The AFTER INSERT trigger trg_recompute_prepay_credit_balance already
  -- recomputed prepay_credits.balance_cents = original_amount_cents - SUM(applied_amount_cents) from
  -- the INSERT above; the explicit decrement double-subtracted. The trigger is now the sole writer
  -- of prepay_credits.balance_cents.

  UPDATE customers SET
    prepay_balance_cents = GREATEST(COALESCE(prepay_balance_cents, 0) - p_amount_cents, 0),
    updated_at = now()
  WHERE id = v_inv.customer_id;

  UPDATE invoices SET
    prepay_applied_cents = prepay_applied_cents + p_amount_cents,
    status = CASE
      WHEN (total_amount_cents - (paid_amount_cents + prepay_applied_cents + p_amount_cents) - write_off_cents) <= 0
      THEN 'paid' ELSE status END,
    updated_at = now()
  WHERE id = p_invoice_id;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'prepay_applied', 'prepay', v_app_id, v_actor_role,
    jsonb_build_object(
      'prepay_credit_id', p_prepay_credit_id,
      'invoice_id', p_invoice_id,
      'invoice_number', v_inv.invoice_number,
      'amount_cents', p_amount_cents,
      'remaining_credit', v_credit.balance_cents - p_amount_cents
    ),
    p_amount_cents,
    'Applied $' || (p_amount_cents / 100.0)::numeric(12,2) || ' prepay to ' || v_inv.invoice_number
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(
      p_idempotency_key,
      'apply_prepay_to_invoice',
      jsonb_build_object('application_id', v_app_id)
    );
  END IF;

  RETURN v_app_id;
END;
$function$;
