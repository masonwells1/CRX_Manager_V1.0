-- ============================================================================
-- void_vendor_payment: vendor-liveness gate (Section 9 follow-up, MEDIUM-1)
--
-- ⚠️ NOT YET APPLIED to live Supabase (rhyzpcqhnizqbxphqdkr). Requires the
-- governed migration-apply gate (write-apply-proofs.mjs, both reviewer
-- charters CLEAN) plus Mason's explicit in-chat approval before any apply.
--
-- Finding (Section 9 PO/AP review, 2026-07-26): void_vendor_payment reverts a
-- bill from paid back to unpaid/partially_paid without ever touching the
-- parent vendor row. delete_vendor's only guard is "no bills outside
-- (paid, voided)" — a plain read, checked while holding the vendor lock. The
-- two therefore do not serialize:
--
--   T1 void_vendor_payment: locks payment + bill, computes unpaid …
--   T2 delete_vendor:       locks vendor, counts unpaid bills → sees 0
--                           (T1 uncommitted), soft-deletes vendor, commits
--   T1: commits bill status = 'unpaid'
--   Result: a soft-deleted vendor carrying an open AP liability, violating
--   the invariant delete_vendor exists to enforce, and reappearing in AP
--   aging against a vendor no page can open.
--
-- Fix: after locking the payment and bill, lock the parent vendor row with
-- the same predicate delete_vendor uses (deleted_at IS NULL … FOR UPDATE).
-- Under READ COMMITTED, FOR UPDATE re-evaluates the predicate on the latest
-- committed row version, so both interleavings now resolve correctly:
--   - void first: delete_vendor blocks on the vendor lock, then re-reads
--     bills, sees the reverted bill, and refuses (VENDOR_HAS_UNPAID_BILLS);
--   - delete first: this function finds no live vendor row and raises
--     VENDOR_DELETED without mutating anything.
--
-- Lock-order note: this takes payment → bill → vendor, while the
-- vendor-first paths (delete_vendor, create_vendor_bill, save_vendor) take
-- the vendor lock and then row-lock NO existing vendor_bills or
-- vendor_payments rows (delete_vendor plain-reads bills; create_vendor_bill
-- locks only the PO and INSERTs a new bill; save_vendor touches only
-- vendors). No lock cycle is possible, so no new deadlock.
--
-- Behavior consequence (deliberate, strict): payments on a soft-deleted
-- vendor's bills cannot be voided. There is currently no vendor-restore RPC
-- (save_vendor refuses deleted rows), so unwinding such a payment would
-- first need the vendor restored by an admin. This is the reviewed
-- remediation: re-opening AP against a deleted vendor is worse than
-- requiring an explicit restore first.
--
-- Guard-only change: the function is re-emitted byte-identical to the live
-- body (md5 81d7a3f899106cabdabe93f0ff493c6b, verified live 2026-07-26)
-- except the ONE added vendor-lock block below check_period_open's gate
-- inputs (payment + bill locks).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.void_vendor_payment(p_payment_id uuid, p_reason text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid; v_payment record; v_bill record; v_new_paid_cents bigint;
  v_new_status text; v_result jsonb; v_existing jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: only admins can void vendor payments';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'void_vendor_payment');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_payment FROM vendor_payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_NOT_FOUND'; END IF;
  IF v_payment.voided_at IS NOT NULL THEN RAISE EXCEPTION 'PAYMENT_ALREADY_VOIDED'; END IF;

  SELECT * INTO v_bill FROM vendor_bills WHERE id = v_payment.vendor_bill_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILL_NOT_FOUND: parent vendor_bill of this payment is missing'; END IF;

  -- Vendor-liveness gate: serialize with delete_vendor. See migration header.
  PERFORM 1 FROM vendors WHERE id = v_bill.vendor_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'VENDOR_DELETED: vendor % of this bill is soft-deleted; restore the vendor before voiding its payments',
      v_bill.vendor_id;
  END IF;

  PERFORM check_period_open(v_payment.payment_date);

  v_new_paid_cents := GREATEST(v_bill.paid_cents - v_payment.amount_cents, 0);
  v_new_status := CASE
    WHEN v_new_paid_cents = 0 THEN 'unpaid'
    WHEN v_new_paid_cents < v_bill.total_cents THEN 'partially_paid'
    ELSE 'paid' END;

  UPDATE vendor_bills SET paid_cents = v_new_paid_cents, status = v_new_status, updated_at = now()
    WHERE id = v_bill.id;

  UPDATE vendor_payments SET voided_at = now(), voided_by = v_actor, void_reason = p_reason
    WHERE id = p_payment_id;

  INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, total_impact_cents, description)
  VALUES ('vendor_payment_voided', 'vendor_payment', p_payment_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object('amount_cents', v_payment.amount_cents,
      'bill_id', v_bill.id, 'bill_status_before', v_bill.status,
      'bill_paid_cents_before', v_bill.paid_cents),
    jsonb_build_object('voided_at', now()::text, 'void_reason', p_reason,
      'bill_status_after', v_new_status, 'bill_paid_cents_after', v_new_paid_cents),
    -1 * v_payment.amount_cents,
    'Voided vendor payment of $' || (v_payment.amount_cents / 100.0)::numeric(12,2) ||
    ' on bill — ' || p_reason);

  INSERT INTO activity_feed (event_type, description, performed_by,
    related_entity_type, related_entity_id)
  VALUES ('vendor_payment_voided',
    'Voided vendor payment $' || (v_payment.amount_cents / 100.0)::numeric(12,2) || ' — ' || p_reason,
    v_actor, 'vendor_payment', p_payment_id);

  v_result := jsonb_build_object('success', true, 'payment_id', p_payment_id,
    'bill_id', v_bill.id, 'voided_amount_cents', v_payment.amount_cents,
    'new_paid_cents', v_new_paid_cents, 'new_bill_status', v_new_status);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'void_vendor_payment', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

-- Restate the ACL so this migration is self-evidently safe. CREATE OR REPLACE
-- preserves the existing ACL, and the live ACL (verified 2026-07-26) is
-- exactly postgres/authenticated/service_role EXECUTE with no anon or PUBLIC
-- grant — these statements change nothing live.
REVOKE ALL ON FUNCTION public.void_vendor_payment(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.void_vendor_payment(uuid, text, text) TO authenticated, service_role;

-- ─── Verification ─────────────────────────────────────────────────────────

DO $$
DECLARE
  v_overload_count integer;
  v_is_secdef boolean;
  v_search_path text;
  v_body text;
BEGIN
  SELECT count(*), bool_and(prosecdef)
    INTO v_overload_count, v_is_secdef
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace
    AND proname = 'void_vendor_payment';

  IF v_overload_count <> 1 THEN
    RAISE EXCEPTION 'vendor-liveness verification: expected 1 overload of void_vendor_payment, found %', v_overload_count;
  END IF;
  IF NOT v_is_secdef THEN
    RAISE EXCEPTION 'vendor-liveness verification: void_vendor_payment is not SECURITY DEFINER';
  END IF;

  SELECT array_to_string(proconfig, ', '), prosrc
    INTO v_search_path, v_body
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace
    AND proname = 'void_vendor_payment';

  IF v_search_path NOT LIKE '%pg_temp%' THEN
    RAISE EXCEPTION 'vendor-liveness verification: search_path missing pg_temp (got: %)', v_search_path;
  END IF;
  IF v_body NOT LIKE '%deleted_at IS NULL FOR UPDATE%' THEN
    RAISE EXCEPTION 'vendor-liveness verification: vendor-liveness lock missing from installed body';
  END IF;
  IF v_body NOT LIKE '%VENDOR_DELETED%' THEN
    RAISE EXCEPTION 'vendor-liveness verification: VENDOR_DELETED guard missing from installed body';
  END IF;
  IF v_body NOT LIKE '%check_period_open%' THEN
    RAISE EXCEPTION 'vendor-liveness verification: period gate lost — refusing to regress 20260712200000';
  END IF;

  IF has_function_privilege('anon', 'public.void_vendor_payment(uuid, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'vendor-liveness verification: anon must not be able to execute void_vendor_payment';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.void_vendor_payment(uuid, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'vendor-liveness verification: authenticated lost EXECUTE on void_vendor_payment';
  END IF;

  RAISE NOTICE 'vendor-liveness verification passed: void_vendor_payment serializes with delete_vendor.';
END;
$$;
