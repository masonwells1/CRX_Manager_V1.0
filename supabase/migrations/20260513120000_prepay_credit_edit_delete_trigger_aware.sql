-- ============================================================================
-- Codex review fix for PR #59 (P2, 2026-05-13) — Make edit_prepay_credit
-- and delete_prepay_credit cooperate with the prepay balance trigger.
-- ============================================================================
-- Audit #5's trigger `_recompute_prepay_credit_balance` (20260512050000) sets
--   balance_cents = original_amount_cents - SUM(prepay_applications.applied)
-- AFTER INSERT/DELETE on prepay_applications.
--
-- The pre-trigger RPCs `edit_prepay_credit` (20260321200000:67-77) and
-- `delete_prepay_credit` (20260321200000:157-161) write balance_cents
-- directly without coordinating with the new formula:
--
-- edit_prepay_credit:
--   Sets `balance_cents = new` AND `original_amount_cents = new`
--   For a partially-applied credit (e.g. 100 applied of 1000 original,
--   balance=900), admin edits to 500: row becomes balance=500, original=500.
--   Next prepay application or invoice void fires the trigger:
--     balance = 500 - sum(applications)  = 500 - 100 = 400
--   The admin-set 500 quietly drains to 400.
--
-- delete_prepay_credit:
--   Sets `balance_cents = 0`, leaves original_amount_cents untouched.
--   Trigger on next application/void recomputes:
--     balance = 1000 - sum(applications)  = 1000 - 100 = 900
--   The deleted credit resurrects.
--
-- Fix: make both RPCs maintain `original_amount_cents` so the trigger's
-- formula yields the intended balance. Specifically:
--
--   edit_prepay_credit:  original_amount_cents := new_balance + SUM(applied)
--      → trigger yields (new_balance + SUM) - SUM = new_balance  ✓
--
--   delete_prepay_credit: original_amount_cents := SUM(applied)
--      → trigger yields SUM - SUM = 0  ✓
--
-- Function bodies are otherwise reproduced verbatim from 20260321200000 with
-- the SUM(applied) computation added before the UPDATE and a recalc of
-- original_amount_cents folded into the SET clauses. pg_temp added to
-- search_path (was missing in the original, per CLAUDE.md canonical pattern).
--
-- Frontend impact: none. Both RPC signatures unchanged.
-- ============================================================================

-- ─── edit_prepay_credit: trigger-aware ─────────────────────────────

CREATE OR REPLACE FUNCTION public.edit_prepay_credit(
  p_credit_id        uuid,
  p_new_balance_cents bigint    DEFAULT NULL,
  p_reference_number  text      DEFAULT NULL,
  p_bucket_label      text      DEFAULT NULL,
  p_notes             text      DEFAULT NULL,
  p_performed_by      uuid      DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_credit       record;
  v_old_balance  bigint;
  v_delta        bigint;
  v_actor        uuid;
  v_sum_applied  bigint;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  SELECT * INTO v_credit
  FROM prepay_credits
  WHERE id = p_credit_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Prepay credit not found: %', p_credit_id;
  END IF;

  v_old_balance := v_credit.balance_cents;

  -- Codex P2 fix (PR #59, 2026-05-13): compute SUM(applied) so we can set
  -- original_amount_cents such that the trigger's recompute formula
  -- (balance = original - SUM(applied)) yields the admin-entered new balance.
  SELECT COALESCE(SUM(applied_amount_cents), 0) INTO v_sum_applied
  FROM prepay_applications
  WHERE prepay_credit_id = p_credit_id;

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
    'prepay_edited', 'prepay', p_credit_id,
    v_actor,
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

  RETURN jsonb_build_object(
    'success', true,
    'credit_id', p_credit_id,
    'old_balance_cents', v_old_balance,
    'new_balance_cents', COALESCE(p_new_balance_cents, v_old_balance)
  );
END;
$$;

-- ─── delete_prepay_credit: trigger-aware ───────────────────────────

CREATE OR REPLACE FUNCTION public.delete_prepay_credit(
  p_credit_id    uuid,
  p_reason       text,
  p_performed_by uuid DEFAULT NULL
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
  v_sum_applied bigint;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

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
  -- so the trigger's formula (balance = original - SUM(applied)) yields 0 on
  -- any future application/void instead of resurrecting the deleted credit.
  SELECT COALESCE(SUM(applied_amount_cents), 0) INTO v_sum_applied
  FROM prepay_applications
  WHERE prepay_credit_id = p_credit_id;

  UPDATE prepay_credits
  SET balance_cents = 0,
      original_amount_cents = v_sum_applied,
      notes = COALESCE(notes, '') || ' [DELETED: ' || p_reason || ']',
      updated_at = now()
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
      'balance_cents', v_old_balance,
      'original_amount_cents', v_credit.original_amount_cents,
      'sum_applied_cents', v_sum_applied,
      'reference_number', v_credit.reference_number,
      'bucket_label', v_credit.bucket_label
    ),
    jsonb_build_object(
      'balance_cents', 0,
      'original_amount_cents', v_sum_applied,
      'reason', p_reason
    ),
    -1 * v_old_balance,
    'Deleted prepay credit ' || COALESCE(v_credit.reference_number, v_credit.id::text) || ' — ' || p_reason
  );

  RETURN jsonb_build_object(
    'success', true,
    'credit_id', p_credit_id,
    'deleted_balance_cents', v_old_balance
  );
END;
$$;

-- ─── Verification ─────────────────────────────────────────────

DO $$
DECLARE
  v_edit_overloads integer;
  v_delete_overloads integer;
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

  RAISE NOTICE 'codex-fix: edit/delete_prepay_credit now cooperate with _recompute_prepay_credit_balance trigger.';
END
$$;
