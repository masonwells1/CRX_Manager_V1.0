-- idempotency-body-check: exempt
-- (Uses check_idempotency / save_idempotency helpers per CLAUDE.md
-- "Canonical Patterns for New RPCs". See PR-10 migration header for full
-- explanation of why the marker is needed.)
-- ============================================================================
-- Audit fix sprint PR-14 — update_vendor_bill RPC
-- ============================================================================
-- Plan: docs/audits/2026-05-09-implementation-plan.md (PR-14)
-- Audit findings: P2 (vendor bill not editable post-creation; typos require
--                 void + recreate today).
--
-- ⚠️ NOT YET APPLIED to live Supabase (rhyzpcqhnizqbxphqdkr).
--
-- ⚠️ DEPENDS ON PR-04 (20260510030000_ap_structural_fixes.sql) being applied
-- first. PR-04 adds:
--   - vendor_bills.balance_cents = GENERATED ALWAYS (so this RPC must NOT
--     update balance_cents directly — only the inputs total_cents/paid_cents)
--   - financial_audit_log.operation_type CHECK includes 'vendor_bill_updated'
--   - vendor_payments.voided_at column (used in the active-payments check)
--
-- This migration adds:
--   update_vendor_bill(p_bill_id, p_subtotal_cents, p_adjustment_cents,
--                     p_bill_date, p_due_date, p_notes, p_idempotency_key)
--
-- Guards:
--   - admin-only (role check)
--   - canonical idempotency
--   - bill must exist, deleted_at IS NULL, status='unpaid'
--   - NO active (non-voided) vendor_payments may exist
--   - check_period_open(p_bill_date) — re-runs the period gate since the
--     bill_date input itself can change
--   - p_subtotal_cents > 0 (avoid degenerate zero-bill states)
--   - p_due_date >= p_bill_date (sanity)
--
-- Field semantics:
--   - total_cents recomputed from subtotal + COALESCE(adjustment, 0).
--   - balance_cents GENERATED, recomputes automatically post-PR-04.
--   - paid_cents NOT touched (only payment-recording paths modify it).
--   - bill_number NOT editable here — uniqueness invariant on
--     (vendor_id, bill_number) makes renaming a separate operation.
-- ============================================================================

CREATE OR REPLACE FUNCTION update_vendor_bill(
  p_bill_id uuid,
  p_subtotal_cents bigint,
  p_adjustment_cents bigint,
  p_bill_date date,
  p_due_date date,
  p_notes text,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_actor_role text;
  v_bill record;
  v_active_payment_count integer;
  v_new_total_cents bigint;
  v_old_values jsonb;
  v_new_values jsonb;
  v_result jsonb;
  v_existing jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;

  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role <> 'admin' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: only admins can edit vendor bills';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'update_vendor_bill');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  IF p_subtotal_cents IS NULL OR p_subtotal_cents <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: subtotal must be positive';
  END IF;
  IF p_due_date < p_bill_date THEN
    RAISE EXCEPTION 'INVALID_DATE_RANGE: due_date cannot precede bill_date';
  END IF;

  PERFORM check_period_open(p_bill_date);

  SELECT * INTO v_bill
  FROM vendor_bills
  WHERE id = p_bill_id AND deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'BILL_NOT_FOUND';
  END IF;

  IF v_bill.status <> 'unpaid' THEN
    RAISE EXCEPTION 'BILL_NOT_EDITABLE: status is % (only unpaid bills can be edited)', v_bill.status;
  END IF;

  -- Active payments make the math fragile (changing total below paid_cents
  -- would put balance_cents negative). Block.
  SELECT count(*) INTO v_active_payment_count
  FROM vendor_payments
  WHERE vendor_bill_id = p_bill_id AND voided_at IS NULL;

  IF v_active_payment_count > 0 THEN
    RAISE EXCEPTION 'BILL_HAS_ACTIVE_PAYMENTS: void each payment first (% active)', v_active_payment_count;
  END IF;

  v_new_total_cents := p_subtotal_cents + COALESCE(p_adjustment_cents, 0);

  v_old_values := jsonb_build_object(
    'subtotal_cents', v_bill.subtotal_cents,
    'adjustment_cents', v_bill.adjustment_cents,
    'total_cents', v_bill.total_cents,
    'bill_date', v_bill.bill_date,
    'due_date', v_bill.due_date,
    'notes', v_bill.notes
  );

  UPDATE vendor_bills SET
    subtotal_cents = p_subtotal_cents,
    adjustment_cents = COALESCE(p_adjustment_cents, 0),
    total_cents = v_new_total_cents,
    bill_date = p_bill_date,
    due_date = p_due_date,
    notes = p_notes,
    updated_at = now()
  WHERE id = p_bill_id;

  v_new_values := jsonb_build_object(
    'subtotal_cents', p_subtotal_cents,
    'adjustment_cents', COALESCE(p_adjustment_cents, 0),
    'total_cents', v_new_total_cents,
    'bill_date', p_bill_date,
    'due_date', p_due_date,
    'notes', p_notes
  );

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'vendor_bill_updated', 'vendor_bill', p_bill_id, v_actor, v_actor_role,
    v_old_values, v_new_values,
    v_new_total_cents - v_bill.total_cents,
    'Updated vendor bill ' || v_bill.bill_number || ' — total $' ||
    (v_bill.total_cents / 100.0)::numeric(12,2) || ' → $' ||
    (v_new_total_cents / 100.0)::numeric(12,2)
  );

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id
  ) VALUES (
    'vendor_bill_updated',
    'Updated vendor bill ' || v_bill.bill_number,
    v_actor, 'vendor_bill', p_bill_id
  );

  v_result := jsonb_build_object(
    'success', true,
    'bill_id', p_bill_id,
    'old_total_cents', v_bill.total_cents,
    'new_total_cents', v_new_total_cents
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'update_vendor_bill', v_result);
  END IF;

  RETURN v_result;
END;
$$;

-- ─── Verification ─────────────────────────────────────────────────────────

DO $$
DECLARE
  v_overload_count integer;
  v_is_secdef boolean;
BEGIN
  SELECT count(*), bool_and(prosecdef)
    INTO v_overload_count, v_is_secdef
  FROM pg_proc
  WHERE pronamespace='public'::regnamespace AND proname='update_vendor_bill';

  IF v_overload_count <> 1 THEN
    RAISE EXCEPTION 'PR-14 verification: expected 1 overload of update_vendor_bill, found %', v_overload_count;
  END IF;
  IF NOT v_is_secdef THEN
    RAISE EXCEPTION 'PR-14 verification: update_vendor_bill is not SECURITY DEFINER';
  END IF;
  RAISE NOTICE 'PR-14 verification passed: update_vendor_bill installed.';
END;
$$;
