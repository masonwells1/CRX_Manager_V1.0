-- ============================================================================
-- HOTFIX (codex P1 review of PR #59, 2026-05-13) — edit/delete_prepay_credit
-- strict-actor pattern.
-- ============================================================================
-- The prior bodies derived v_actor via `COALESCE(p_performed_by, auth.uid())`
-- and then checked the admin role on that resolved value. Because both RPCs
-- are SECURITY DEFINER, a non-admin caller could pass any admin's UUID as
-- p_performed_by and pass the admin gate — then proceed to edit / delete
-- arbitrary prepay credits with the admin's identity stamped on the audit log.
--
-- Verified in production immediately after 20260513130000 applied, while
-- writing this codex follow-up: a non-admin token + p_performed_by=<admin-uuid>
-- would have bypassed the gate. This file CREATE OR REPLACEs both functions
-- with the canonical strict-actor pattern:
--
--   v_actor := auth.uid();
--   IF v_actor IS NULL THEN RAISE 'AUTH_REQUIRED'; END IF;
--   IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor
--     THEN RAISE 'ACTOR_MISMATCH'; END IF;
--   (then role-check v_actor, not p_performed_by)
--
-- Function bodies otherwise verbatim from 20260513130000.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.edit_prepay_credit(
  p_credit_id         uuid,
  p_new_balance_cents bigint DEFAULT NULL,
  p_reference_number  text   DEFAULT NULL,
  p_bucket_label      text   DEFAULT NULL,
  p_notes             text   DEFAULT NULL,
  p_performed_by      uuid   DEFAULT NULL,
  p_idempotency_key   text   DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_credit      record;
  v_old_balance bigint;
  v_delta       bigint;
  v_actor       uuid;
  v_existing    jsonb;
  v_sum_applied bigint;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN
      RETURN jsonb_build_object('success', true, 'credit_id', p_credit_id, 'idempotent', true);
    END IF;
  END IF;

  -- Strict-actor pattern (codex P1 hotfix): derive from auth.uid(), reject mismatch
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  IF (SELECT role FROM profiles WHERE id = v_actor AND is_active = true) != 'admin' THEN
    RAISE EXCEPTION 'Admin access required to edit prepay credits';
  END IF;

  SELECT * INTO v_credit FROM prepay_credits WHERE id = p_credit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Prepay credit not found: %', p_credit_id; END IF;

  v_old_balance := v_credit.balance_cents;

  SELECT COALESCE(SUM(applied_amount_cents), 0) INTO v_sum_applied
  FROM prepay_applications WHERE prepay_credit_id = p_credit_id;

  UPDATE prepay_credits SET
    balance_cents    = COALESCE(p_new_balance_cents, balance_cents),
    original_amount_cents = CASE
      WHEN p_new_balance_cents IS NOT NULL THEN p_new_balance_cents + v_sum_applied
      ELSE original_amount_cents
    END,
    reference_number = COALESCE(p_reference_number, reference_number),
    bucket_label     = COALESCE(p_bucket_label, bucket_label),
    notes            = COALESCE(p_notes, notes),
    updated_at       = now()
  WHERE id = p_credit_id;

  IF p_new_balance_cents IS NOT NULL AND p_new_balance_cents != v_old_balance THEN
    v_delta := p_new_balance_cents - v_old_balance;
    UPDATE customers
    SET prepay_balance_cents = GREATEST(prepay_balance_cents + v_delta, 0)
    WHERE id = v_credit.customer_id;
  END IF;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id,
    actor_user_id, old_values, new_values,
    total_impact_cents, description
  ) VALUES (
    'prepay_edited', 'prepay', p_credit_id, v_actor,
    jsonb_build_object(
      'balance_cents', v_old_balance,
      'original_amount_cents', v_credit.original_amount_cents,
      'sum_applied_cents', v_sum_applied,
      'reference_number', v_credit.reference_number,
      'bucket_label', v_credit.bucket_label
    ),
    jsonb_build_object(
      'balance_cents', COALESCE(p_new_balance_cents, v_old_balance),
      'original_amount_cents', CASE
        WHEN p_new_balance_cents IS NOT NULL THEN p_new_balance_cents + v_sum_applied
        ELSE v_credit.original_amount_cents
      END,
      'reference_number', COALESCE(p_reference_number, v_credit.reference_number),
      'bucket_label', COALESCE(p_bucket_label, v_credit.bucket_label)
    ),
    COALESCE(p_new_balance_cents - v_old_balance, 0),
    'Edited prepay credit ' || COALESCE(v_credit.reference_number, v_credit.id::text)
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'edit_prepay_credit', jsonb_build_object('credit_id', p_credit_id));
  END IF;

  RETURN jsonb_build_object(
    'success', true, 'credit_id', p_credit_id,
    'old_balance_cents', v_old_balance,
    'new_balance_cents', COALESCE(p_new_balance_cents, v_old_balance)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_prepay_credit(
  p_credit_id       uuid,
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
  v_credit      record;
  v_old_balance bigint;
  v_actor       uuid;
  v_existing    jsonb;
  v_sum_applied bigint;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN
      RETURN jsonb_build_object('success', true, 'credit_id', p_credit_id, 'idempotent', true);
    END IF;
  END IF;

  -- Strict-actor pattern (codex P1 hotfix)
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  IF (SELECT role FROM profiles WHERE id = v_actor AND is_active = true) != 'admin' THEN
    RAISE EXCEPTION 'Admin access required to delete prepay credits';
  END IF;

  SELECT * INTO v_credit FROM prepay_credits WHERE id = p_credit_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Prepay credit not found: %', p_credit_id; END IF;

  v_old_balance := v_credit.balance_cents;
  IF v_old_balance = 0 THEN RAISE EXCEPTION 'Prepay credit already has zero balance'; END IF;

  SELECT COALESCE(SUM(applied_amount_cents), 0) INTO v_sum_applied
  FROM prepay_applications WHERE prepay_credit_id = p_credit_id;

  UPDATE prepay_credits
  SET balance_cents         = 0,
      original_amount_cents = v_sum_applied,
      notes                 = COALESCE(notes, '') || ' [DELETED: ' || p_reason || ']',
      updated_at            = now()
  WHERE id = p_credit_id;

  UPDATE customers
  SET prepay_balance_cents = GREATEST(prepay_balance_cents - v_old_balance, 0)
  WHERE id = v_credit.customer_id;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id,
    actor_user_id, old_values, new_values,
    total_impact_cents, description
  ) VALUES (
    'prepay_deleted', 'prepay', p_credit_id, v_actor,
    jsonb_build_object(
      'balance_cents', v_old_balance,
      'original_amount_cents', v_credit.original_amount_cents,
      'sum_applied_cents', v_sum_applied,
      'reference_number', v_credit.reference_number,
      'bucket_label', v_credit.bucket_label
    ),
    jsonb_build_object('balance_cents', 0, 'original_amount_cents', v_sum_applied, 'reason', p_reason),
    -1 * v_old_balance,
    'Deleted prepay credit ' || COALESCE(v_credit.reference_number, v_credit.id::text) || ' — ' || p_reason
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'delete_prepay_credit', jsonb_build_object('credit_id', p_credit_id));
  END IF;

  RETURN jsonb_build_object(
    'success', true, 'credit_id', p_credit_id, 'deleted_balance_cents', v_old_balance
  );
END;
$$;
