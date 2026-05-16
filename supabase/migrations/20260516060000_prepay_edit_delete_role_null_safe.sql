-- ============================================================================
-- Codex P1 fix (PR #59, 2026-05-16 review of cdfa899) — null-safe admin
-- role check on edit/delete_prepay_credit.
-- ============================================================================
-- The 2026-05-13 strict-actor hotfix (20260513150000) and its predecessor
-- (20260513130000) used the form:
--   IF (SELECT role FROM profiles WHERE id = v_actor AND is_active = true) != 'admin' THEN
--     RAISE EXCEPTION 'Admin access required ...';
--   END IF;
--
-- When the user is deactivated (is_active = false) or the profile row was
-- deleted, the subquery returns zero rows and the SELECT evaluates to NULL.
-- In PostgreSQL, `NULL != 'admin'` evaluates to NULL (not TRUE), so the IF
-- branch did NOT fire and the function proceeded to mutate prepay balances.
-- A user holding a still-valid JWT but with `is_active = false` could thus
-- edit or delete any prepay credit — the deactivation gate was a no-op for
-- these two RPCs.
--
-- Fix: fetch the role into a variable and check with IS DISTINCT FROM, which
-- treats NULL as "not admin" and raises correctly.
--
-- Belt+suspenders alignment with increment_customer_prepay (20260516040000)
-- where similar `authenticated` EXECUTE was REVOKEd. For edit/delete prepay,
-- frontend callsites in PrepaymentManager use the standard PostgREST RPC path
-- with the user's JWT, so EXECUTE for `authenticated` must stay — the body
-- gate (auth.uid() + role IS DISTINCT FROM 'admin') is the security boundary.
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
  v_actor_role  text;
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

  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  -- Codex P1 fix (2026-05-16): IS DISTINCT FROM treats NULL (deactivated user
  -- or missing profile row) as "not admin" and raises. Prior `!= 'admin'`
  -- evaluated to NULL when subquery was empty and silently allowed mutation.
  SELECT role INTO v_actor_role
  FROM profiles
  WHERE id = v_actor AND is_active = true;

  IF v_actor_role IS DISTINCT FROM 'admin' THEN
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
  v_actor_role  text;
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

  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  -- Codex P1 fix (2026-05-16): null-safe admin check via IS DISTINCT FROM.
  SELECT role INTO v_actor_role
  FROM profiles
  WHERE id = v_actor AND is_active = true;

  IF v_actor_role IS DISTINCT FROM 'admin' THEN
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

-- ─── Verification ─────────────────────────────────────────────

DO $$
DECLARE
  v_edit_null_safe boolean;
  v_delete_null_safe boolean;
BEGIN
  SELECT prosrc ~ 'IS DISTINCT FROM ''admin''' INTO v_edit_null_safe
  FROM pg_proc
  WHERE proname = 'edit_prepay_credit' AND pronamespace = 'public'::regnamespace;
  IF NOT COALESCE(v_edit_null_safe, false) THEN
    RAISE EXCEPTION 'codex-fix verification: edit_prepay_credit missing IS DISTINCT FROM admin check';
  END IF;

  SELECT prosrc ~ 'IS DISTINCT FROM ''admin''' INTO v_delete_null_safe
  FROM pg_proc
  WHERE proname = 'delete_prepay_credit' AND pronamespace = 'public'::regnamespace;
  IF NOT COALESCE(v_delete_null_safe, false) THEN
    RAISE EXCEPTION 'codex-fix verification: delete_prepay_credit missing IS DISTINCT FROM admin check';
  END IF;

  RAISE NOTICE 'codex-fix: edit/delete_prepay_credit role check now null-safe (deactivated users denied).';
END
$$;
