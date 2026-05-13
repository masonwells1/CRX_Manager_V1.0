-- ============================================================================
-- Codex review fix for PR #59 (P1, 2026-05-13) — Use correct 7-arg / 4-arg
-- signatures for edit_prepay_credit / delete_prepay_credit, preserving
-- idempotency parameters, while applying the trigger-aware logic.
-- ============================================================================
-- The prior fix migration (20260513120000_prepay_credit_edit_delete_trigger_aware.sql)
-- attempted to add trigger-aware behavior but used the wrong signatures:
--   edit_prepay_credit:   6 args (omitted p_idempotency_key)
--   delete_prepay_credit: 3 args (omitted p_idempotency_key)
--
-- The live installed signatures (from 20260333400000) are:
--   edit_prepay_credit(uuid, bigint, text, text, text, uuid, text)   — 7 args
--   delete_prepay_credit(uuid, text, uuid, text)                      — 4 args
--
-- Because PostgreSQL identifies functions by full input signature, the prior
-- CREATE OR REPLACE would create a SEPARATE overload alongside the live ones.
-- Effects:
--   1. The migration's own verification (`expected 1 overload, found 2`)
--      RAISEs and rolls back the migration on apply.
--   2. The frontend sends p_idempotency_key, so calls would continue resolving
--      to the old 7-arg/4-arg bodies and never hit the trigger-aware fix.
--
-- This migration:
--   1. DROPs any shadow 6-arg / 3-arg overloads (defensive idempotent cleanup).
--   2. CREATE OR REPLACEs the canonical 7-arg / 4-arg signatures with the
--      trigger-aware logic from 20260513120000 folded into the live body.
--   3. Preserves: admin-only role check, idempotency check/save, audit log,
--      customer aggregate update, search_path = public, pg_temp.
--   4. Idempotency INSERTs use jsonb_build_object (canonical jsonb shape).
--
-- Trigger-aware change (same intent as 20260513120000):
--   edit_prepay_credit:  original_amount_cents := new_balance + SUM(applied)
--      so trigger formula yields:  (new_balance + SUM) - SUM = new_balance ✓
--   delete_prepay_credit: original_amount_cents := SUM(applied)
--      so trigger formula yields:  SUM - SUM = 0 ✓
--
-- Frontend impact: none. Both signatures match what the UI already sends.
-- ============================================================================

-- Defensive cleanup of shadow overloads from the prior failed migration.
DROP FUNCTION IF EXISTS public.edit_prepay_credit(uuid, bigint, text, text, text, uuid);
DROP FUNCTION IF EXISTS public.delete_prepay_credit(uuid, text, uuid);

-- ─── edit_prepay_credit (7-arg, trigger-aware) ──────────────────────────

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
  -- Idempotency check (preserves the live inline pattern from 20260333400000)
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN
      RETURN jsonb_build_object('success', true, 'credit_id', p_credit_id, 'idempotent', true);
    END IF;
  END IF;

  v_actor := COALESCE(p_performed_by, auth.uid());

  -- Admin-only access (preserved from 20260333400000)
  IF (SELECT role FROM profiles WHERE id = v_actor) != 'admin' THEN
    RAISE EXCEPTION 'Admin access required to edit prepay credits';
  END IF;

  SELECT * INTO v_credit
  FROM prepay_credits
  WHERE id = p_credit_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Prepay credit not found: %', p_credit_id;
  END IF;

  v_old_balance := v_credit.balance_cents;

  -- Codex P2 fix (PR #59, 2026-05-13): compute SUM(applied) so we can set
  -- original_amount_cents such that the _recompute_prepay_credit_balance
  -- trigger (formula: balance = original - SUM(applied)) yields the
  -- admin-entered new balance on any future application/void.
  SELECT COALESCE(SUM(applied_amount_cents), 0) INTO v_sum_applied
  FROM prepay_applications
  WHERE prepay_credit_id = p_credit_id;

  UPDATE prepay_credits SET
    balance_cents         = COALESCE(p_new_balance_cents, balance_cents),
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
    'prepay_edited', 'prepay', p_credit_id,
    v_actor,
    jsonb_build_object(
      'balance_cents',         v_old_balance,
      'original_amount_cents', v_credit.original_amount_cents,
      'sum_applied_cents',     v_sum_applied,
      'reference_number',      v_credit.reference_number,
      'bucket_label',          v_credit.bucket_label
    ),
    jsonb_build_object(
      'balance_cents',         COALESCE(p_new_balance_cents, v_old_balance),
      'original_amount_cents', CASE
        WHEN p_new_balance_cents IS NOT NULL THEN p_new_balance_cents + v_sum_applied
        ELSE v_credit.original_amount_cents
      END,
      'reference_number',      COALESCE(p_reference_number, v_credit.reference_number),
      'bucket_label',          COALESCE(p_bucket_label, v_credit.bucket_label)
    ),
    COALESCE(p_new_balance_cents - v_old_balance, 0),
    'Edited prepay credit ' || COALESCE(v_credit.reference_number, v_credit.id::text)
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'edit_prepay_credit', jsonb_build_object('credit_id', p_credit_id));
  END IF;

  RETURN jsonb_build_object(
    'success',           true,
    'credit_id',         p_credit_id,
    'old_balance_cents', v_old_balance,
    'new_balance_cents', COALESCE(p_new_balance_cents, v_old_balance)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.edit_prepay_credit(uuid, bigint, text, text, text, uuid, text) TO authenticated;

-- ─── delete_prepay_credit (4-arg, trigger-aware) ─────────────────────────

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

  v_actor := COALESCE(p_performed_by, auth.uid());

  IF (SELECT role FROM profiles WHERE id = v_actor) != 'admin' THEN
    RAISE EXCEPTION 'Admin access required to delete prepay credits';
  END IF;

  SELECT * INTO v_credit
  FROM prepay_credits
  WHERE id = p_credit_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Prepay credit not found: %', p_credit_id;
  END IF;

  v_old_balance := v_credit.balance_cents;

  IF v_old_balance = 0 THEN
    RAISE EXCEPTION 'Prepay credit already has zero balance';
  END IF;

  -- Codex P2 fix (PR #59, 2026-05-13): set original_amount_cents = SUM(applied)
  -- so the _recompute_prepay_credit_balance trigger's formula yields 0 on any
  -- future application/void instead of resurrecting the deleted credit.
  SELECT COALESCE(SUM(applied_amount_cents), 0) INTO v_sum_applied
  FROM prepay_applications
  WHERE prepay_credit_id = p_credit_id;

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
    'prepay_deleted', 'prepay', p_credit_id,
    v_actor,
    jsonb_build_object(
      'balance_cents',         v_old_balance,
      'original_amount_cents', v_credit.original_amount_cents,
      'sum_applied_cents',     v_sum_applied,
      'reference_number',      v_credit.reference_number,
      'bucket_label',          v_credit.bucket_label
    ),
    jsonb_build_object(
      'balance_cents',         0,
      'original_amount_cents', v_sum_applied,
      'reason',                p_reason
    ),
    -1 * v_old_balance,
    'Deleted prepay credit ' || COALESCE(v_credit.reference_number, v_credit.id::text) || ' — ' || p_reason
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'delete_prepay_credit', jsonb_build_object('credit_id', p_credit_id));
  END IF;

  RETURN jsonb_build_object(
    'success',               true,
    'credit_id',             p_credit_id,
    'deleted_balance_cents', v_old_balance
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_prepay_credit(uuid, text, uuid, text) TO authenticated;

-- ─── Verification ─────────────────────────────────────────────

DO $$
DECLARE
  v_edit_overloads integer;
  v_delete_overloads integer;
  v_edit_signature text;
  v_delete_signature text;
  v_edit_has_sum_applied boolean;
  v_delete_has_sum_applied boolean;
BEGIN
  SELECT count(*) INTO v_edit_overloads
  FROM pg_proc
  WHERE proname = 'edit_prepay_credit' AND pronamespace = 'public'::regnamespace;
  IF v_edit_overloads <> 1 THEN
    RAISE EXCEPTION 'codex-fix verification: expected 1 overload of edit_prepay_credit, found %', v_edit_overloads;
  END IF;

  SELECT count(*) INTO v_delete_overloads
  FROM pg_proc
  WHERE proname = 'delete_prepay_credit' AND pronamespace = 'public'::regnamespace;
  IF v_delete_overloads <> 1 THEN
    RAISE EXCEPTION 'codex-fix verification: expected 1 overload of delete_prepay_credit, found %', v_delete_overloads;
  END IF;

  SELECT pg_get_function_identity_arguments(oid) INTO v_edit_signature
  FROM pg_proc
  WHERE proname = 'edit_prepay_credit' AND pronamespace = 'public'::regnamespace;
  IF v_edit_signature NOT LIKE '%p_idempotency_key%' THEN
    RAISE EXCEPTION 'codex-fix verification: edit_prepay_credit missing p_idempotency_key — got: %', v_edit_signature;
  END IF;

  SELECT pg_get_function_identity_arguments(oid) INTO v_delete_signature
  FROM pg_proc
  WHERE proname = 'delete_prepay_credit' AND pronamespace = 'public'::regnamespace;
  IF v_delete_signature NOT LIKE '%p_idempotency_key%' THEN
    RAISE EXCEPTION 'codex-fix verification: delete_prepay_credit missing p_idempotency_key — got: %', v_delete_signature;
  END IF;

  SELECT prosrc ~ 'SUM\(applied_amount_cents\)|sum\(applied_amount_cents\)'
    INTO v_edit_has_sum_applied
  FROM pg_proc
  WHERE proname = 'edit_prepay_credit' AND pronamespace = 'public'::regnamespace;
  IF NOT COALESCE(v_edit_has_sum_applied, false) THEN
    RAISE EXCEPTION 'codex-fix verification: edit_prepay_credit does not compute SUM(applied)';
  END IF;

  SELECT prosrc ~ 'SUM\(applied_amount_cents\)|sum\(applied_amount_cents\)'
    INTO v_delete_has_sum_applied
  FROM pg_proc
  WHERE proname = 'delete_prepay_credit' AND pronamespace = 'public'::regnamespace;
  IF NOT COALESCE(v_delete_has_sum_applied, false) THEN
    RAISE EXCEPTION 'codex-fix verification: delete_prepay_credit does not compute SUM(applied)';
  END IF;

  RAISE NOTICE 'codex-fix: edit/delete_prepay_credit now use correct 7-arg/4-arg signatures with trigger-aware logic.';
END
$$;
