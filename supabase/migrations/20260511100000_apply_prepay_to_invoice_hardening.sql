-- idempotency-body-check: exempt
-- (Uses check_idempotency / save_idempotency helpers per CLAUDE.md
-- "Canonical Patterns for New RPCs".)
-- ============================================================================
-- Phase 1.D — Harden apply_prepay_to_invoice (closes audit Critical #4)
-- ============================================================================
-- Audit finding (Phase 0 verification, 2026-05-11):
--   `apply_prepay_to_invoice(p_prepay_credit_id, p_invoice_id, p_amount_cents)`
--   is SECURITY DEFINER and writes to `prepay_applications`, `prepay_credits`,
--   `customers.prepay_balance_cents`, `invoices.prepay_applied_cents`, AND
--   `financial_audit_log` — but the body has NO actor check, NO role gate, and
--   NO idempotency parameter at all. A direct PostgREST caller with any
--   authenticated JWT (or a SECURITY DEFINER chain that forgot to verify
--   permissions) could:
--     - apply prepay credit to ANY invoice (since SECURITY DEFINER bypasses
--       table RLS on the affected tables)
--     - double-apply on network retry (no idempotency check) — the same
--       allocation runs twice, draining the prepay credit twice and over-
--       paying the invoice
--
-- Today the function is only called from `batch_apply_prepayments` (which
-- itself has the canonical idempotency + actor pattern), so the practical
-- attack surface is small. This migration adds defense-in-depth so the
-- function is safe for any future caller (direct UI, retry agents, etc.).
--
-- Scope of change (narrowest safe):
--   1. Add `p_performed_by uuid DEFAULT NULL` and `p_idempotency_key text
--      DEFAULT NULL` parameters — existing 3-arg callers (`batch_apply_
--      prepayments`) still work because both defaults are NULL.
--   2. Add `v_actor := auth.uid()` + NULL check (AUTH_REQUIRED token).
--   3. Add role gate (admin or sales_rep) per the rest of the prepay/invoice
--      RPC suite (record_invoice_payment, post_invoice).
--   4. Add strict actor pattern (ACTOR_MISMATCH if p_performed_by is passed
--      and doesn't match v_actor). Uses `IS DISTINCT FROM` for NULL safety.
--   5. Add canonical check_idempotency / save_idempotency calls when
--      p_idempotency_key is non-NULL.
--   6. RETURN type stays `uuid` — `batch_apply_prepayments` calls this and
--      assigns the result to a uuid variable. Changing to jsonb would force a
--      cascade rewrite there for no real benefit (helper-function shape).
--
-- Audit-log entries already write the correct actor_role via the existing
-- `(SELECT role FROM profiles WHERE id = (select auth.uid()))` lookup —
-- left unchanged.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.apply_prepay_to_invoice(
  p_prepay_credit_id uuid,
  p_invoice_id uuid,
  p_amount_cents bigint,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_credit    record;
  v_inv       record;
  v_app_id    uuid;
  v_actor     uuid;
  v_actor_role text;
  v_existing  jsonb;
BEGIN
  -- Phase 1.D — strict actor pattern + role gate + idempotency
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;

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

  -- Body unchanged from prior installed version (verbatim) ------------------

  SELECT * INTO v_credit FROM prepay_credits WHERE id = p_prepay_credit_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Prepay credit not found';
  END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found';
  END IF;

  IF v_inv.status NOT IN ('posted', 'overdue') THEN
    RAISE EXCEPTION 'Can only apply prepay to posted/overdue invoices (current status: %)', v_inv.status;
  END IF;

  PERFORM check_period_open(CURRENT_DATE);

  IF p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'Application amount must be positive';
  END IF;

  IF p_amount_cents > v_credit.balance_cents THEN
    RAISE EXCEPTION 'Amount exceeds prepay balance ($%)', (v_credit.balance_cents / 100.0)::numeric(12,2);
  END IF;

  IF p_amount_cents > v_inv.balance_cents THEN
    RAISE EXCEPTION 'Amount exceeds invoice balance ($%)', (v_inv.balance_cents / 100.0)::numeric(12,2);
  END IF;

  INSERT INTO prepay_applications (prepay_credit_id, invoice_id, applied_amount_cents)
  VALUES (p_prepay_credit_id, p_invoice_id, p_amount_cents)
  RETURNING id INTO v_app_id;

  UPDATE prepay_credits SET
    balance_cents = balance_cents - p_amount_cents,
    updated_at = now()
  WHERE id = p_prepay_credit_id;

  UPDATE customers SET
    prepay_balance_cents = GREATEST(COALESCE(prepay_balance_cents, 0) - p_amount_cents, 0),
    updated_at = now()
  WHERE id = v_inv.customer_id;

  UPDATE invoices SET
    prepay_applied_cents = prepay_applied_cents + p_amount_cents,
    status = CASE
      WHEN (total_amount_cents - (paid_amount_cents + prepay_applied_cents + p_amount_cents) - write_off_cents) <= 0
      THEN 'paid'
      ELSE status
    END,
    updated_at = now()
  WHERE id = p_invoice_id;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'prepay_applied', 'prepay', v_app_id,
    v_actor_role,
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
$$;

COMMENT ON FUNCTION public.apply_prepay_to_invoice IS
  'Phase 1.D — hardened with strict actor pattern, role gate (admin/sales_rep), and optional idempotency. Returns uuid for backward-compat with batch_apply_prepayments. Closes audit Critical #4.';

-- ─── Verification ─────────────────────────────────────────────────────────

DO $$
DECLARE
  v_overload_count integer;
  v_has_auth_required boolean;
  v_has_actor_mismatch boolean;
  v_has_insufficient_role boolean;
  v_has_idempotency_check boolean;
  v_has_idempotency_save boolean;
  v_arg_signature text;
BEGIN
  SELECT count(*) INTO v_overload_count
  FROM pg_proc
  WHERE proname = 'apply_prepay_to_invoice' AND pronamespace = 'public'::regnamespace;
  IF v_overload_count <> 1 THEN
    RAISE EXCEPTION 'phase-1d verification: expected exactly 1 overload of apply_prepay_to_invoice, found %', v_overload_count;
  END IF;

  SELECT pg_get_function_identity_arguments(oid) INTO v_arg_signature
  FROM pg_proc
  WHERE proname = 'apply_prepay_to_invoice' AND pronamespace = 'public'::regnamespace;
  IF v_arg_signature NOT LIKE '%p_performed_by%' OR v_arg_signature NOT LIKE '%p_idempotency_key%' THEN
    RAISE EXCEPTION 'phase-1d verification: signature missing new parameters — got: %', v_arg_signature;
  END IF;

  SELECT
    prosrc ~ 'AUTH_REQUIRED',
    prosrc ~ 'ACTOR_MISMATCH',
    prosrc ~ 'INSUFFICIENT_ROLE',
    prosrc ~ 'check_idempotency',
    prosrc ~ 'save_idempotency'
  INTO v_has_auth_required, v_has_actor_mismatch, v_has_insufficient_role,
       v_has_idempotency_check, v_has_idempotency_save
  FROM pg_proc
  WHERE proname = 'apply_prepay_to_invoice' AND pronamespace = 'public'::regnamespace;

  IF NOT COALESCE(v_has_auth_required, false) THEN
    RAISE EXCEPTION 'phase-1d verification: missing AUTH_REQUIRED check';
  END IF;
  IF NOT COALESCE(v_has_actor_mismatch, false) THEN
    RAISE EXCEPTION 'phase-1d verification: missing ACTOR_MISMATCH check';
  END IF;
  IF NOT COALESCE(v_has_insufficient_role, false) THEN
    RAISE EXCEPTION 'phase-1d verification: missing INSUFFICIENT_ROLE check';
  END IF;
  IF NOT COALESCE(v_has_idempotency_check, false) THEN
    RAISE EXCEPTION 'phase-1d verification: missing check_idempotency call';
  END IF;
  IF NOT COALESCE(v_has_idempotency_save, false) THEN
    RAISE EXCEPTION 'phase-1d verification: missing save_idempotency call';
  END IF;

  RAISE NOTICE 'phase-1d verification passed: apply_prepay_to_invoice hardened with actor + role + idempotency.';
END;
$$;
