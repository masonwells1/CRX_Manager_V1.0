-- ============================================================================
-- FIX: Remove updated_at references on commissions table
-- ============================================================================
--
-- ROOT CAUSE: Both create_commission_payment and void_commission_payment do
--   UPDATE commissions SET ... updated_at = now()
-- but the commissions table does NOT have an updated_at column.
--
-- create_commission_payment crashes when paying commissions.
-- void_commission_payment crashes when voiding a commission payment.
--
-- Found by deep audit: cross-referencing all function bodies against table
-- schemas for non-existent column references.
-- ============================================================================


-- ============================================================================
-- FIX 1: create_commission_payment — remove updated_at on commissions
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_commission_payment(
  p_commission_ids   uuid[],
  p_payment_method   text,
  p_reference        text,
  p_payment_date     date,
  p_notes            text,
  p_performed_by     uuid,
  p_idempotency_key  text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_payment_id   uuid;
  v_payment_num  text;
  v_total        numeric := 0;
  v_recipient_id uuid;
  v_commission   record;
  v_season       integer;
  v_payment_dt   date;
BEGIN

  -- Authorization check (added by wave3 audit)
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin')
  ) THEN
    RAISE EXCEPTION 'Not authorized: requires admin role';
  END IF;
  v_payment_dt := COALESCE(p_payment_date, CURRENT_DATE);

  -- Enforce accounting period
  PERFORM public.check_period_open(v_payment_dt);

  -- Validate at least one commission
  IF array_length(p_commission_ids, 1) IS NULL OR array_length(p_commission_ids, 1) = 0 THEN
    RAISE EXCEPTION 'No commissions selected for payment';
  END IF;

  -- Lock commissions FOR UPDATE to prevent double-pay
  SELECT DISTINCT c.recipient_user_id
    INTO v_recipient_id
    FROM public.commissions c
   WHERE c.id = ANY(p_commission_ids)
     AND c.status != 'paid'
     FOR UPDATE;

  IF v_recipient_id IS NULL THEN
    RAISE EXCEPTION 'No unpaid commissions found for the given IDs';
  END IF;

  IF (SELECT count(DISTINCT c.recipient_user_id)
      FROM public.commissions c
      WHERE c.id = ANY(p_commission_ids) AND c.status != 'paid') > 1 THEN
    RAISE EXCEPTION 'All commissions in a payment must belong to the same recipient';
  END IF;

  -- Calculate total
  SELECT sum(c.commission_amount)
    INTO v_total
    FROM public.commissions c
   WHERE c.id = ANY(p_commission_ids)
     AND c.status != 'paid';

  -- Season uses end-year convention
  -- Oct 2025 → season 2026 (the 2025-2026 season ending Sep 2026)
  v_season := compute_season(v_payment_dt);

  -- Generate payment number
  v_payment_num := public.next_commission_payment_number();

  -- Create the payment
  INSERT INTO public.commission_payments (
    payment_number, recipient_id, total_amount, status,
    payment_method, reference_number, payment_date, notes, season, created_by
  ) VALUES (
    v_payment_num, v_recipient_id, v_total, 'unposted',
    p_payment_method, p_reference, v_payment_dt,
    p_notes, v_season, p_performed_by
  ) RETURNING id INTO v_payment_id;

  -- Create line items
  FOR v_commission IN
    SELECT c.id, c.commission_amount
      FROM public.commissions c
     WHERE c.id = ANY(p_commission_ids)
       AND c.status != 'paid'
  LOOP
    INSERT INTO public.commission_payment_items (
      commission_payment_id, commission_id, amount
    ) VALUES (
      v_payment_id, v_commission.id, v_commission.commission_amount
    );
  END LOOP;

  -- FIX: Remove updated_at — column does not exist on commissions table
  UPDATE public.commissions
     SET status = 'paid'
   WHERE id = ANY(p_commission_ids)
     AND status != 'paid';

  -- Financial audit log
  INSERT INTO public.financial_audit_log (
    operation_type, entity_type, entity_id,
    actor_user_id, total_impact_cents, description
  ) VALUES (
    'commission_payment_created', 'commission_payment', v_payment_id,
    p_performed_by, (v_total * 100)::bigint,
    'Commission payment ' || v_payment_num || ' created for $' ||
    to_char(v_total, 'FM999,999,990.00') || ' to ' ||
    (SELECT full_name FROM public.profiles WHERE id = v_recipient_id)
  );

  RETURN v_payment_id;
END;
$function$;


-- ============================================================================
-- FIX 2: void_commission_payment — remove updated_at on commissions
-- ============================================================================

CREATE OR REPLACE FUNCTION public.void_commission_payment(
  p_payment_id       uuid,
  p_reason           text,
  p_performed_by     uuid DEFAULT NULL,
  p_idempotency_key  text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor       uuid;
  v_payment     record;
  v_reset_count integer;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  -- Admin-only
  IF (SELECT role FROM profiles WHERE id = v_actor) != 'admin' THEN
    RAISE EXCEPTION 'Admin access required to void a commission payment';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Reason is required to void a commission payment';
  END IF;

  -- Idempotency
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM 1 FROM idempotency_keys
    WHERE idempotency_key = p_idempotency_key AND operation = 'void_commission_payment';
    IF FOUND THEN
      RETURN jsonb_build_object('status', 'already_processed');
    END IF;
  END IF;

  -- Lock and fetch payment
  SELECT * INTO v_payment
  FROM commission_payments
  WHERE id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Commission payment not found: %', p_payment_id;
  END IF;

  IF v_payment.status != 'posted' THEN
    RAISE EXCEPTION 'Only posted commission payments can be voided (current status: %)', v_payment.status;
  END IF;

  -- FIX: Remove updated_at — column does not exist on commissions table
  UPDATE commissions SET
    status     = 'pending',
    paid_date  = NULL
  WHERE id IN (
    SELECT commission_id FROM commission_payment_items
    WHERE commission_payment_id = p_payment_id
  );

  GET DIAGNOSTICS v_reset_count = ROW_COUNT;

  -- Mark payment as voided
  UPDATE commission_payments SET
    status     = 'voided',
    updated_at = now()
  WHERE id = p_payment_id;

  -- Financial audit log
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, description
  ) VALUES (
    'commission_payment_voided', 'commission_payment', p_payment_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object('status', 'posted', 'total_amount', v_payment.total_amount),
    jsonb_build_object('status', 'voided', 'commissions_reset', v_reset_count),
    'Commission payment ' || v_payment.payment_number || ' voided: ' || p_reason
  );

  -- Activity feed
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id
  ) VALUES (
    'commission_payment_voided',
    'Commission payment ' || v_payment.payment_number || ' voided: ' || p_reason,
    v_actor, 'commission_payment', p_payment_id
  );

  -- Record idempotency key
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at)
    VALUES (p_idempotency_key, 'void_commission_payment', to_jsonb(p_payment_id), now() + interval '24 hours')
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'success',           true,
    'payment_id',        p_payment_id,
    'payment_number',    v_payment.payment_number,
    'commissions_reset', v_reset_count
  );
END;
$$;


-- ============================================================================
-- Verification: no overloads
-- ============================================================================
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
        AND proname = 'create_commission_payment') != 1 THEN
    RAISE EXCEPTION 'create_commission_payment overload detected — aborting';
  END IF;
  IF (SELECT count(*) FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
        AND proname = 'void_commission_payment') != 1 THEN
    RAISE EXCEPTION 'void_commission_payment overload detected — aborting';
  END IF;
END $$;
