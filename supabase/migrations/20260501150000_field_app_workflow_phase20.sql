-- =============================================================================
-- Migration: 20260501150000_field_app_workflow_phase20.sql
-- Phase 20 — Cleanup Sprint G1: Commission lifecycle fix
--
-- Closes the audit finding flagged in 2026-04-30-six-phase-deep-audit
-- Phase 1 P1 / Phase 2 P1: commissions get marked `paid` when a payment
-- is created with status `unposted`. That overstates "paid" liability,
-- understates "pending" reports, and breaks month-end close attestation.
--
-- Original behavior:
--   create_commission_payment:
--     - inserts commission_payments row with status='unposted'
--     - inserts commission_payment_items rows
--     - UPDATE commissions SET status='paid'   <-- WRONG, payment isn't posted
--   post_commission_payment:
--     - flips payment status to 'posted'
--     - never touches commissions  <-- they were already 'paid'
--   void_commission_payment:
--     - resets paid commissions to 'pending'   <-- works, but only because
--                                                 of the bug above
--
-- New behavior:
--   create_commission_payment:
--     - inserts payment + items (unchanged)
--     - REJECTS commissions that are already in a non-voided payment
--       (replaces the old `status != 'paid'` filter — that filter only
--       worked because of the bug we're now removing)
--     - DOES NOT change commissions.status
--   post_commission_payment:
--     - flips payment status to 'posted'
--     - UPDATE commissions SET status='paid', paid_date = payment_date
--     - now properly idempotent (was missing p_idempotency_key)
--   void_commission_payment:
--     - unchanged behavior (Phase 13 already hardened it). Resetting
--       commissions to 'pending' is still correct: if payment was
--       posted, commissions are 'paid' and need to flip back. If
--       payment was unposted (not allowed today, but defensive), the
--       UPDATE is a no-op since status is already 'pending'.
--
-- Auth gates: all three RPCs use the strict pattern from Phase 13
--   Sprint A4 (auth.uid() not null + p_performed_by mismatch reject +
--   admin role check). create_commission_payment had a non-strict
--   pattern; this migration upgrades it.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. create_commission_payment — no longer marks commissions as paid
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.create_commission_payment(uuid[], text, text, date, text, uuid, text);

CREATE OR REPLACE FUNCTION public.create_commission_payment(
  p_commission_ids   uuid[],
  p_payment_method   text,
  p_reference        text,
  p_payment_date     date,
  p_notes            text,
  p_performed_by     uuid DEFAULT NULL,
  p_idempotency_key  text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor        uuid;
  v_existing     jsonb;
  v_payment_id   uuid;
  v_payment_num  text;
  v_total        numeric := 0;
  v_recipient_id uuid;
  v_commission   record;
  v_season       integer;
  v_payment_dt   date;
  v_already_in_payment integer;
BEGIN
  -- ---- Strict auth gate (matches Phase 13 pattern) -----------------------
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Admin access required to create a commission payment';
  END IF;

  -- ---- Idempotency replay --------------------------------------------------
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'create_commission_payment');
    IF v_existing IS NOT NULL THEN RETURN (v_existing #>> '{}')::uuid; END IF;
  END IF;

  v_payment_dt := COALESCE(p_payment_date, CURRENT_DATE);

  -- ---- Period gate --------------------------------------------------------
  PERFORM check_period_open(v_payment_dt);

  -- ---- Validate input -----------------------------------------------------
  IF array_length(p_commission_ids, 1) IS NULL OR array_length(p_commission_ids, 1) = 0 THEN
    RAISE EXCEPTION 'No commissions selected for payment';
  END IF;

  -- ---- Reject commissions already in a non-voided payment -----------------
  -- Replaces the old `c.status != 'paid'` filter. Membership in a
  -- non-voided commission_payment_items row is the canonical signal that
  -- a commission is already committed to a payment.
  SELECT count(*) INTO v_already_in_payment
  FROM commission_payment_items cpi
  JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
  WHERE cpi.commission_id = ANY(p_commission_ids)
    AND cp.status != 'voided';

  IF v_already_in_payment > 0 THEN
    RAISE EXCEPTION 'One or more commissions are already in an existing (non-voided) payment. Void that payment first or remove those commissions from the selection.';
  END IF;

  -- ---- Lock candidate commissions ----------------------------------------
  -- Status filter changes: was `status != 'paid'`. Now `status = 'pending'`
  -- — a more precise check that excludes 'cancelled' and any future states.
  SELECT DISTINCT c.recipient_user_id
    INTO v_recipient_id
    FROM commissions c
   WHERE c.id = ANY(p_commission_ids)
     AND c.status = 'pending'
     FOR UPDATE;

  IF v_recipient_id IS NULL THEN
    RAISE EXCEPTION 'No pending commissions found for the given IDs (commissions must be status=pending and not in any non-voided payment)';
  END IF;

  IF (SELECT count(DISTINCT c.recipient_user_id)
      FROM commissions c
      WHERE c.id = ANY(p_commission_ids) AND c.status = 'pending') > 1 THEN
    RAISE EXCEPTION 'All commissions in a payment must belong to the same recipient';
  END IF;

  -- ---- Total + season + payment number ----------------------------------
  SELECT sum(c.commission_amount)
    INTO v_total
    FROM commissions c
   WHERE c.id = ANY(p_commission_ids)
     AND c.status = 'pending';

  v_season := compute_season(v_payment_dt);
  v_payment_num := next_commission_payment_number();

  -- ---- Create payment row ------------------------------------------------
  INSERT INTO commission_payments (
    payment_number, recipient_id, total_amount, status,
    payment_method, reference_number, payment_date, notes, season, created_by
  ) VALUES (
    v_payment_num, v_recipient_id, v_total, 'unposted',
    p_payment_method, p_reference, v_payment_dt,
    p_notes, v_season, v_actor
  ) RETURNING id INTO v_payment_id;

  -- ---- Create line items -------------------------------------------------
  FOR v_commission IN
    SELECT c.id, c.commission_amount
      FROM commissions c
     WHERE c.id = ANY(p_commission_ids)
       AND c.status = 'pending'
  LOOP
    INSERT INTO commission_payment_items (
      commission_payment_id, commission_id, amount
    ) VALUES (
      v_payment_id, v_commission.id, v_commission.commission_amount
    );
  END LOOP;

  -- NOTE: commissions.status is intentionally NOT changed here. The 'paid'
  -- transition happens in post_commission_payment when the payment is
  -- actually committed.

  -- ---- Financial audit log -----------------------------------------------
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id,
    actor_user_id, total_impact_cents, description
  ) VALUES (
    'commission_payment_created', 'commission_payment', v_payment_id,
    v_actor, (v_total * 100)::bigint,
    'Commission payment ' || v_payment_num || ' created (UNPOSTED) for $' ||
    to_char(v_total, 'FM999,999,990.00') || ' to ' ||
    (SELECT full_name FROM profiles WHERE id = v_recipient_id)
  );

  -- ---- Save idempotency --------------------------------------------------
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_commission_payment', to_jsonb(v_payment_id::text));
  END IF;

  RETURN v_payment_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_commission_payment(uuid[], text, text, date, text, uuid, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 2. post_commission_payment — now marks commissions paid + idempotent
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.post_commission_payment(uuid, uuid);
DROP FUNCTION IF EXISTS public.post_commission_payment(uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.post_commission_payment(
  p_payment_id      uuid,
  p_performed_by    uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor    uuid;
  v_existing jsonb;
  v_payment  record;
  v_count    integer;
  v_result   jsonb;
BEGIN
  -- ---- Strict auth gate -----------------------------------------------
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Admin access required to post a commission payment';
  END IF;

  -- ---- Idempotency replay -----------------------------------------------
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'post_commission_payment');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  -- ---- Lock and validate payment ---------------------------------------
  SELECT * INTO v_payment FROM commission_payments WHERE id = p_payment_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Commission payment not found';
  END IF;

  IF v_payment.status = 'posted' THEN
    RAISE EXCEPTION 'Commission payment is already posted';
  END IF;
  IF v_payment.status = 'voided' THEN
    RAISE EXCEPTION 'Cannot post a voided commission payment';
  END IF;

  -- ---- Period gate ------------------------------------------------------
  PERFORM check_period_open(COALESCE(v_payment.payment_date, CURRENT_DATE));

  -- ---- Mark payment posted ---------------------------------------------
  UPDATE commission_payments
     SET status = 'posted',
         posted_by = v_actor,
         posted_at = now(),
         updated_at = now()
   WHERE id = p_payment_id;

  -- ---- NEW: Mark all included commissions as paid ----------------------
  -- (commissions table has no updated_at column — do NOT add it)
  UPDATE commissions
     SET status = 'paid',
         paid_date = v_payment.payment_date
   WHERE id IN (
     SELECT commission_id FROM commission_payment_items
     WHERE commission_payment_id = p_payment_id
   );
  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- ---- Financial audit log --------------------------------------------
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id,
    actor_user_id, total_impact_cents, description
  ) VALUES (
    'commission_payment_posted', 'commission_payment', p_payment_id,
    v_actor, (v_payment.total_amount * 100)::bigint,
    'Posted commission payment ' || v_payment.payment_number ||
    ' for $' || to_char(v_payment.total_amount, 'FM999,999,990.00') ||
    ' (' || v_count || ' commissions marked paid)'
  );

  v_result := jsonb_build_object(
    'success',           true,
    'payment_id',        p_payment_id,
    'payment_number',    v_payment.payment_number,
    'commissions_paid',  v_count
  );

  -- ---- Save idempotency -----------------------------------------------
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'post_commission_payment', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.post_commission_payment(uuid, uuid, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- Verify no overloads
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
      AND proname = 'create_commission_payment') != 1 THEN
    RAISE EXCEPTION 'OVERLOAD DETECTED for create_commission_payment';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
      AND proname = 'post_commission_payment') != 1 THEN
    RAISE EXCEPTION 'OVERLOAD DETECTED for post_commission_payment';
  END IF;
END $$;
