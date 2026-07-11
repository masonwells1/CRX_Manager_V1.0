-- Credit-memo apply — Migration 3 of 5: the apply RPC
-- ====================================================
-- apply_credit_memo_to_invoice(memo, target, amount, performed_by, idempotency_key)
-- Mirrors apply_prepay_to_invoice, hardened per the Codex review (#3, #6):
--   * deterministic dual FOR UPDATE lock ordered by id (deadlock-safe), re-check AFTER locking
--   * idempotency bound to (memo, target, amount) → IDEMPOTENCY_ARGUMENT_MISMATCH on key reuse
--     with different args (the prepay mirror does NOT do this; check_idempotency keys only on
--     (key, op) and would silently return the OLD application)
--   * net-zero on the customer ledger (financial_audit_log.total_impact_cents = 0): the memo
--     already reduced AR when it was issued.

CREATE OR REPLACE FUNCTION public.apply_credit_memo_to_invoice(
  p_credit_memo_id    uuid,
  p_target_invoice_id uuid,
  p_amount_cents      bigint,
  p_performed_by      uuid DEFAULT NULL,
  p_idempotency_key   text DEFAULT NULL
) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor      uuid;
  v_actor_role text;
  v_memo       record;
  v_target     record;
  v_first      uuid;
  v_second     uuid;
  v_remaining  bigint;
  v_app_id     uuid;
  v_existing   jsonb;
BEGIN
  -- ---- gates (auth / actor / role) ----
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor AND is_active = true;
  -- Codex BLOCKER: an inactive/absent profile yields NULL, and `NULL NOT IN (...)` is NOT true,
  -- so the bare NOT IN would let a deactivated-but-still-authenticated user through. Guard the NULL.
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: only active admins and sales reps can apply credit memos';
  END IF;

  -- ---- cheap argument guards ----
  IF p_credit_memo_id = p_target_invoice_id THEN
    RAISE EXCEPTION 'INVALID_TARGET: a credit memo cannot be applied to itself';
  END IF;
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: application amount must be positive';
  END IF;

  -- ---- idempotency bound to (memo, target, amount) — Codex #3 ----
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'apply_credit_memo_to_invoice');
    IF v_existing IS NOT NULL THEN
      IF (v_existing->>'credit_memo_id')::uuid    IS DISTINCT FROM p_credit_memo_id
      OR (v_existing->>'target_invoice_id')::uuid IS DISTINCT FROM p_target_invoice_id
      OR (v_existing->>'amount_cents')::bigint     IS DISTINCT FROM p_amount_cents THEN
        RAISE EXCEPTION 'IDEMPOTENCY_ARGUMENT_MISMATCH: key % was already used for a different credit application', p_idempotency_key;
      END IF;
      RETURN (v_existing->>'application_id')::uuid;
    END IF;
  END IF;

  -- ---- lock BOTH invoices, ordered by id (deadlock-safe), then read current state ----
  IF p_credit_memo_id < p_target_invoice_id THEN
    v_first := p_credit_memo_id; v_second := p_target_invoice_id;
  ELSE
    v_first := p_target_invoice_id; v_second := p_credit_memo_id;
  END IF;
  PERFORM 1 FROM invoices WHERE id = v_first  FOR UPDATE;
  PERFORM 1 FROM invoices WHERE id = v_second FOR UPDATE;

  -- Codex BLOCKER (concurrent replay): re-check idempotency AFTER acquiring the locks. Two
  -- simultaneous calls with the same key both pass the pre-lock check (neither committed yet),
  -- serialize on the lock, and would each create a separate application — double-applying the
  -- credit. The winner commits its cached result; the loser now sees it and returns it.
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'apply_credit_memo_to_invoice');
    IF v_existing IS NOT NULL THEN
      RETURN (v_existing->>'application_id')::uuid;
    END IF;
  END IF;

  SELECT * INTO v_memo   FROM invoices WHERE id = p_credit_memo_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'CREDIT_MEMO_NOT_FOUND'; END IF;
  SELECT * INTO v_target FROM invoices WHERE id = p_target_invoice_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'TARGET_INVOICE_NOT_FOUND'; END IF;

  -- ---- eligibility (re-checked after locking) ----
  IF v_memo.deleted_at IS NOT NULL OR v_target.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'INVOICE_DELETED';
  END IF;
  IF v_memo.invoice_type <> 'credit_memo' THEN
    RAISE EXCEPTION 'NOT_A_CREDIT_MEMO: % is a %', v_memo.invoice_number, v_memo.invoice_type;
  END IF;
  IF v_memo.status <> 'posted' THEN
    RAISE EXCEPTION 'CREDIT_MEMO_NOT_POSTED: % is %', v_memo.invoice_number, v_memo.status;
  END IF;
  IF v_target.invoice_type = 'credit_memo' THEN
    RAISE EXCEPTION 'TARGET_IS_CREDIT_MEMO: cannot apply a credit to another credit memo';
  END IF;
  IF v_target.status NOT IN ('posted', 'overdue') THEN
    RAISE EXCEPTION 'TARGET_NOT_OPEN: % is % (must be posted or overdue)', v_target.invoice_number, v_target.status;
  END IF;
  IF v_memo.customer_id IS DISTINCT FROM v_target.customer_id THEN
    RAISE EXCEPTION 'CUSTOMER_MISMATCH: credit memo and target invoice belong to different customers';
  END IF;

  PERFORM check_period_open(CURRENT_DATE);

  -- ---- amount bounds ----
  v_remaining := -v_memo.balance_cents;  -- memo balance is <= 0; remaining credit is its magnitude
  IF p_amount_cents > v_remaining THEN
    RAISE EXCEPTION 'AMOUNT_EXCEEDS_CREDIT: $% requested but only $% credit remains on %',
      (p_amount_cents / 100.0)::numeric(12,2), (v_remaining / 100.0)::numeric(12,2), v_memo.invoice_number;
  END IF;
  IF p_amount_cents > v_target.balance_cents THEN
    RAISE EXCEPTION 'AMOUNT_EXCEEDS_BALANCE: $% requested but % only owes $%',
      (p_amount_cents / 100.0)::numeric(12,2), v_target.invoice_number, (v_target.balance_cents / 100.0)::numeric(12,2);
  END IF;

  -- ---- ledger row ----
  INSERT INTO credit_memo_applications (credit_memo_id, target_invoice_id, amount_cents, applied_by)
  VALUES (p_credit_memo_id, p_target_invoice_id, p_amount_cents, v_actor)
  RETURNING id INTO v_app_id;

  -- ---- consume the memo (its negative balance rises toward 0); status unchanged ----
  UPDATE invoices
     SET credit_applied_cents = credit_applied_cents + p_amount_cents,
         updated_at = now()
   WHERE id = p_credit_memo_id;

  -- ---- reduce the target; flip to paid when the (5-lever) balance hits 0 ----
  UPDATE invoices
     SET credit_applied_cents = credit_applied_cents + p_amount_cents,
         status = CASE
           WHEN (total_amount_cents - paid_amount_cents - prepay_applied_cents - write_off_cents
                 - (credit_applied_cents + p_amount_cents)) <= 0
           THEN 'paid' ELSE status END,
         updated_at = now()
   WHERE id = p_target_invoice_id;

  -- ---- audit: net-zero on the ledger (the memo already reduced AR when issued) — Codex #6.
  -- entity_type='credit_memo' (the closest allowed value; 'credit_memo_application' is not in
  -- the financial_audit_log entity_type CHECK). operation_type 'credit_memo_applied' is allowed.
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'credit_memo_applied', 'credit_memo', v_app_id, v_actor, v_actor_role,
    jsonb_build_object(
      'application_id', v_app_id,
      'credit_memo_id', p_credit_memo_id, 'credit_memo_number', v_memo.invoice_number,
      'target_invoice_id', p_target_invoice_id, 'target_invoice_number', v_target.invoice_number,
      'amount_cents', p_amount_cents
    ),
    0,
    'Applied $' || (p_amount_cents / 100.0)::numeric(12,2) || ' credit ' || v_memo.invoice_number
      || ' to ' || v_target.invoice_number
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'apply_credit_memo_to_invoice',
      jsonb_build_object(
        'application_id', v_app_id,
        'credit_memo_id', p_credit_memo_id,
        'target_invoice_id', p_target_invoice_id,
        'amount_cents', p_amount_cents
      ));
  END IF;

  RETURN v_app_id;
END;
$$;

-- in-body role gate is the real guard; still revoke anon EXECUTE (grant-debt hygiene)
REVOKE ALL ON FUNCTION public.apply_credit_memo_to_invoice(uuid, uuid, bigint, uuid, text) FROM public;
REVOKE ALL ON FUNCTION public.apply_credit_memo_to_invoice(uuid, uuid, bigint, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.apply_credit_memo_to_invoice(uuid, uuid, bigint, uuid, text) TO authenticated;
