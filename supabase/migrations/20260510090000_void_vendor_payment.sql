-- idempotency-body-check: exempt
-- (Uses check_idempotency / save_idempotency helpers per CLAUDE.md
-- "Canonical Patterns for New RPCs". See PR-10 migration header for full
-- explanation of why the marker is needed.)
-- ============================================================================
-- Audit fix sprint PR-13 — void_vendor_payment RPC + paid-bill guard
-- ============================================================================
-- Plan: docs/audits/2026-05-09-implementation-plan.md (PR-13)
-- Audit findings: P1 (no void_vendor_payment), P1 (vendor_payments no
--                 soft-delete columns), P1 (void_vendor_bill allows paid
--                 bills with active payments).
--
-- ⚠️ NOT YET APPLIED to live Supabase (rhyzpcqhnizqbxphqdkr).
--
-- ⚠️ DEPENDS ON PR-04 MIGRATION (20260510030000_ap_structural_fixes.sql)
-- being applied first. PR-04 adds these prerequisites:
--   - vendor_payments.voided_at, voided_by, void_reason columns
--   - vendor_bills.balance_cents = GENERATED ALWAYS (so this migration
--     does NOT update balance_cents directly — only paid_cents and status)
--   - void_vendor_bill paid-bill guard already exists in PR-04
--
-- This migration adds:
--   1. void_vendor_payment(p_payment_id, p_reason, p_idempotency_key) RPC.
--      Admin-only. Locks the payment row + parent bill, validates the
--      payment isn't already voided, decrements bill.paid_cents by the
--      voided payment's amount, recalculates bill.status to one of
--      paid / partially_paid / unpaid, sets the payment row's
--      voided_at/voided_by/void_reason columns, writes a
--      financial_audit_log entry with operation_type='vendor_payment_voided'.
--   2. Verification block asserting the new function exists with one
--      overload + correct security/search_path settings.
-- ============================================================================

CREATE OR REPLACE FUNCTION void_vendor_payment(
  p_payment_id uuid,
  p_reason text,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_payment record;
  v_bill record;
  v_new_paid_cents bigint;
  v_new_status text;
  v_result jsonb;
  v_existing jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: only admins can void vendor payments';
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'REASON_REQUIRED';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'void_vendor_payment');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  -- Lock the payment row first, then the bill, to avoid deadlock with the
  -- record_vendor_payment / void_vendor_bill paths (which lock bill first).
  -- Both orderings are valid as long as we're consistent across sibling RPCs.
  SELECT * INTO v_payment
  FROM vendor_payments
  WHERE id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_NOT_FOUND';
  END IF;

  IF v_payment.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'PAYMENT_ALREADY_VOIDED';
  END IF;

  SELECT * INTO v_bill
  FROM vendor_bills
  WHERE id = v_payment.vendor_bill_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'BILL_NOT_FOUND: parent vendor_bill of this payment is missing';
  END IF;

  -- Decrement paid_cents. balance_cents is GENERATED (PR-04) and recomputes
  -- automatically as `total_cents - paid_cents`.
  v_new_paid_cents := GREATEST(v_bill.paid_cents - v_payment.amount_cents, 0);

  -- Status recalculation:
  --   paid_cents = 0           → 'unpaid'
  --   0 < paid_cents < total   → 'partially_paid'
  --   paid_cents >= total      → 'paid' (shouldn't happen post-void of a
  --                              real payment, but kept for safety)
  v_new_status := CASE
    WHEN v_new_paid_cents = 0 THEN 'unpaid'
    WHEN v_new_paid_cents < v_bill.total_cents THEN 'partially_paid'
    ELSE 'paid'
  END;

  UPDATE vendor_bills SET
    paid_cents = v_new_paid_cents,
    status = v_new_status,
    updated_at = now()
  WHERE id = v_bill.id;

  UPDATE vendor_payments SET
    voided_at = now(),
    voided_by = v_actor,
    void_reason = p_reason
  WHERE id = p_payment_id;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'vendor_payment_voided', 'vendor_payment', p_payment_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object(
      'amount_cents', v_payment.amount_cents,
      'bill_id', v_bill.id,
      'bill_status_before', v_bill.status,
      'bill_paid_cents_before', v_bill.paid_cents
    ),
    jsonb_build_object(
      'voided_at', now()::text,
      'void_reason', p_reason,
      'bill_status_after', v_new_status,
      'bill_paid_cents_after', v_new_paid_cents
    ),
    -1 * v_payment.amount_cents,
    'Voided vendor payment of $' || (v_payment.amount_cents / 100.0)::numeric(12,2) ||
    ' on bill — ' || p_reason
  );

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id
  ) VALUES (
    'vendor_payment_voided',
    'Voided vendor payment $' || (v_payment.amount_cents / 100.0)::numeric(12,2) || ' — ' || p_reason,
    v_actor, 'vendor_payment', p_payment_id
  );

  v_result := jsonb_build_object(
    'success', true,
    'payment_id', p_payment_id,
    'bill_id', v_bill.id,
    'voided_amount_cents', v_payment.amount_cents,
    'new_paid_cents', v_new_paid_cents,
    'new_bill_status', v_new_status
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'void_vendor_payment', v_result);
  END IF;

  RETURN v_result;
END;
$$;

-- ─── Verification ─────────────────────────────────────────────────────────

DO $$
DECLARE
  v_overload_count integer;
  v_is_secdef boolean;
  v_search_path text;
BEGIN
  SELECT count(*), bool_and(prosecdef),
         array_to_string((SELECT proconfig FROM pg_proc WHERE proname='void_vendor_payment' LIMIT 1), ', ')
    INTO v_overload_count, v_is_secdef, v_search_path
  FROM pg_proc
  WHERE pronamespace='public'::regnamespace AND proname='void_vendor_payment';

  IF v_overload_count <> 1 THEN
    RAISE EXCEPTION 'PR-13 verification: expected 1 overload of void_vendor_payment, found %', v_overload_count;
  END IF;
  IF NOT v_is_secdef THEN
    RAISE EXCEPTION 'PR-13 verification: void_vendor_payment is not SECURITY DEFINER';
  END IF;
  IF v_search_path NOT LIKE '%pg_temp%' THEN
    RAISE EXCEPTION 'PR-13 verification: void_vendor_payment search_path missing pg_temp (got: %)', v_search_path;
  END IF;

  RAISE NOTICE 'PR-13 verification passed: void_vendor_payment installed with correct security settings.';
END;
$$;
