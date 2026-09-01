-- STATUS: PARKED - NOT APPLIED
-- Bind the remaining Section 9 AP/PO replay receipts to actor + exact intent.
--
-- The mature implementations below still own every inventory, PO, AP, money,
-- accounting-period, and audit-log decision.  This migration only places a
-- receipt-binding wrapper before each public entry point, so a retained key
-- cannot report a prior success for a changed batch, amount, date, note, or
-- void reason.  The existing check_idempotency_intent() helper serializes the
-- key, rejects cross-actor/cross-intent reuse, and fails closed for legacy
-- unbound receipts. Vendor-bill edits also enforce the same cumulative PO
-- overage confirmation as creation so the threshold cannot be bypassed after
-- a compliant bill is first saved.

-- The public functions must be exactly the live signatures inspected before
-- this migration.  A transactionally-applied migration cannot leave a rename
-- half complete; refuse unexpected catalog state rather than adopting a body
-- that this migration did not rename.
DO $rename_section9_receiving$
BEGIN
  IF to_regprocedure('public._section9_receive_po_items_intent_impl_20260831(jsonb,uuid,text,boolean)') IS NOT NULL THEN
    RAISE EXCEPTION 'SECTION9_INTENT_PRECONDITION: private receive_po_items implementation already exists';
  END IF;
  IF to_regprocedure('public.receive_po_items(jsonb,uuid,text,boolean)') IS NULL
     OR (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'receive_po_items') <> 1 THEN
    RAISE EXCEPTION 'SECTION9_INTENT_PRECONDITION: receive_po_items signature/overload drift';
  END IF;
  ALTER FUNCTION public.receive_po_items(jsonb, uuid, text, boolean)
    RENAME TO _section9_receive_po_items_intent_impl_20260831;
END
$rename_section9_receiving$;

DO $rename_section9_update_bill$
BEGIN
  IF to_regprocedure('public._section9_update_vendor_bill_intent_impl_20260831(uuid,bigint,bigint,date,date,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'SECTION9_INTENT_PRECONDITION: private update_vendor_bill implementation already exists';
  END IF;
  IF to_regprocedure('public.update_vendor_bill(uuid,bigint,bigint,date,date,text,text)') IS NULL
     OR (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'update_vendor_bill') <> 1 THEN
    RAISE EXCEPTION 'SECTION9_INTENT_PRECONDITION: update_vendor_bill signature/overload drift';
  END IF;
  ALTER FUNCTION public.update_vendor_bill(uuid, bigint, bigint, date, date, text, text)
    RENAME TO _section9_update_vendor_bill_intent_impl_20260831;
END
$rename_section9_update_bill$;

DO $rename_section9_payment$
BEGIN
  IF to_regprocedure('public._section9_record_vendor_payment_intent_impl_20260831(uuid,bigint,date,text,text,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'SECTION9_INTENT_PRECONDITION: private record_vendor_payment implementation already exists';
  END IF;
  IF to_regprocedure('public.record_vendor_payment(uuid,bigint,date,text,text,text,text)') IS NULL
     OR (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'record_vendor_payment') <> 1 THEN
    RAISE EXCEPTION 'SECTION9_INTENT_PRECONDITION: record_vendor_payment signature/overload drift';
  END IF;
  ALTER FUNCTION public.record_vendor_payment(uuid, bigint, date, text, text, text, text)
    RENAME TO _section9_record_vendor_payment_intent_impl_20260831;
END
$rename_section9_payment$;

DO $rename_section9_void_bill$
BEGIN
  IF to_regprocedure('public._section9_void_vendor_bill_intent_impl_20260831(uuid,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'SECTION9_INTENT_PRECONDITION: private void_vendor_bill implementation already exists';
  END IF;
  IF to_regprocedure('public.void_vendor_bill(uuid,text,text)') IS NULL
     OR (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'void_vendor_bill') <> 1 THEN
    RAISE EXCEPTION 'SECTION9_INTENT_PRECONDITION: void_vendor_bill signature/overload drift';
  END IF;
  ALTER FUNCTION public.void_vendor_bill(uuid, text, text)
    RENAME TO _section9_void_vendor_bill_intent_impl_20260831;
END
$rename_section9_void_bill$;

REVOKE ALL ON FUNCTION public._section9_receive_po_items_intent_impl_20260831(jsonb, uuid, text, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._section9_update_vendor_bill_intent_impl_20260831(uuid, bigint, bigint, date, date, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._section9_record_vendor_payment_intent_impl_20260831(uuid, bigint, date, text, text, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._section9_void_vendor_bill_intent_impl_20260831(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._section9_receive_po_items_intent_impl_20260831(jsonb, uuid, text, boolean) TO postgres;
GRANT EXECUTE ON FUNCTION public._section9_update_vendor_bill_intent_impl_20260831(uuid, bigint, bigint, date, date, text, text) TO postgres;
GRANT EXECUTE ON FUNCTION public._section9_record_vendor_payment_intent_impl_20260831(uuid, bigint, date, text, text, text, text) TO postgres;
GRANT EXECUTE ON FUNCTION public._section9_void_vendor_bill_intent_impl_20260831(uuid, text, text) TO postgres;

CREATE FUNCTION public.receive_po_items(
  p_items jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL,
  p_allow_over_receive boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  SELECT role INTO v_actor_role FROM public.profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'Only admin or sales_rep can receive PO items';
  END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: receive_po_items requires p_idempotency_key';
  END IF;

  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'actor_id', v_actor,
    'items', p_items,
    'allow_over_receive', COALESCE(p_allow_over_receive, false)
  )::text, 'UTF8'), 'sha256'), 'hex');
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'receive_po_items', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL OR jsonb_typeof(v_replay -> 'result') = 'null' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  v_result := public._section9_receive_po_items_intent_impl_20260831(
    p_items, p_performed_by, p_idempotency_key, p_allow_over_receive
  );
  UPDATE public.idempotency_keys SET request_fingerprint = v_fingerprint, request_actor_id = v_actor
   WHERE idempotency_key = p_idempotency_key AND operation = 'receive_po_items';
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'; END IF;
  RETURN v_result;
END;
$function$;

CREATE FUNCTION public.update_vendor_bill(
  p_bill_id uuid, p_subtotal_cents bigint, p_adjustment_cents bigint,
  p_bill_date date, p_due_date date, p_notes text,
  p_idempotency_key text DEFAULT NULL,
  p_confirm_po_overage boolean DEFAULT false,
  p_po_overage_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_bill public.vendor_bills%ROWTYPE;
  v_po_total_cents bigint;
  v_vendor_name text;
  v_new_total_cents bigint;
  v_other_active_billed_cents bigint;
  v_cumulative_total_cents bigint;
  v_overage_confirmed boolean := false;
  v_overage_reason text := btrim(COALESCE(p_po_overage_reason, ''));
  v_amount_drift_pct numeric;
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  SELECT role INTO v_actor_role FROM public.profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role <> 'admin' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: only admins can edit vendor bills';
  END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: update_vendor_bill requires p_idempotency_key';
  END IF;
  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'actor_id', v_actor, 'bill_id', p_bill_id,
    'subtotal_cents', p_subtotal_cents, 'adjustment_cents', p_adjustment_cents,
    'bill_date', p_bill_date, 'due_date', p_due_date, 'notes', p_notes,
    'confirm_po_overage', COALESCE(p_confirm_po_overage, false),
    'po_overage_reason', v_overage_reason
  )::text, 'UTF8'), 'sha256'), 'hex');
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'update_vendor_bill', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL OR jsonb_typeof(v_replay -> 'result') = 'null' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;
  IF p_subtotal_cents IS NULL OR p_subtotal_cents <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: subtotal must be positive';
  END IF;
  IF p_due_date < p_bill_date THEN
    RAISE EXCEPTION 'INVALID_DATE_RANGE: due_date cannot precede bill_date';
  END IF;
  SELECT * INTO v_bill FROM public.vendor_bills
   WHERE id = p_bill_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILL_NOT_FOUND'; END IF;
  v_new_total_cents := p_subtotal_cents + COALESCE(p_adjustment_cents, 0);
  IF v_new_total_cents <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: bill total must be positive (got %)', v_new_total_cents;
  END IF;
  -- Serialize with PO lifecycle changes, then enforce the same cumulative
  -- active-billing threshold as create_vendor_bill. Exclude this bill's old
  -- total so the candidate replacement is counted exactly once.
  IF v_bill.purchase_order_id IS NOT NULL THEN
    SELECT total_cost_cents INTO v_po_total_cents
      FROM public.purchase_orders WHERE id = v_bill.purchase_order_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PO_NOT_FOUND: purchase order % does not exist', v_bill.purchase_order_id;
    END IF;

    SELECT COALESCE(SUM(vb.total_cents), 0)::bigint
    INTO v_other_active_billed_cents
    FROM public.vendor_bills vb
    WHERE vb.purchase_order_id = v_bill.purchase_order_id
      AND vb.id <> p_bill_id
      AND vb.deleted_at IS NULL
      AND vb.status <> 'voided';

    v_cumulative_total_cents := v_other_active_billed_cents + v_new_total_cents;
    IF v_po_total_cents > 0
       AND v_cumulative_total_cents * 100 > v_po_total_cents * 105 THEN
      IF COALESCE(p_confirm_po_overage, false) IS NOT TRUE THEN
        RAISE EXCEPTION 'PO_CUMULATIVE_BILLING_CONFIRMATION_REQUIRED'
          USING ERRCODE = '22023',
                DETAIL = jsonb_build_object(
                  'po_total_cents', v_po_total_cents,
                  'other_active_billed_cents', v_other_active_billed_cents,
                  'candidate_bill_cents', v_new_total_cents,
                  'cumulative_bill_cents', v_cumulative_total_cents
                )::text;
      END IF;
      IF v_overage_reason = '' THEN
        RAISE EXCEPTION 'PO_CUMULATIVE_BILLING_REASON_REQUIRED';
      END IF;
      v_overage_confirmed := true;
    END IF;

    IF v_po_total_cents > 0 THEN
      SELECT name INTO v_vendor_name FROM public.vendors WHERE id = v_bill.vendor_id;
      v_amount_drift_pct := ABS(v_new_total_cents - v_po_total_cents)::numeric / v_po_total_cents::numeric;
      IF v_amount_drift_pct > 0.05 THEN
        INSERT INTO public.notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
        SELECT p.id, 'Vendor bill amount differs from PO',
          'Bill ' || COALESCE(NULLIF(v_bill.bill_number, ''), p_bill_id::text) || ' for ' || COALESCE(v_vendor_name, 'Unknown vendor') ||
          ' is $' || (v_new_total_cents / 100.0)::numeric(12,2) || ' but PO total is $' ||
          (v_po_total_cents / 100.0)::numeric(12,2) || ' (' || ROUND(v_amount_drift_pct * 100, 1) || '% drift). Verify the bill matches the PO.',
          'vendor_bill_drift', 'purchase_order', v_bill.purchase_order_id
        FROM public.profiles p WHERE p.role = 'admin' AND p.is_active = true;
      END IF;
    END IF;
  END IF;
  v_result := public._section9_update_vendor_bill_intent_impl_20260831(
    p_bill_id, p_subtotal_cents, p_adjustment_cents, p_bill_date, p_due_date, p_notes, p_idempotency_key
  );
  UPDATE public.idempotency_keys SET request_fingerprint = v_fingerprint, request_actor_id = v_actor
   WHERE idempotency_key = p_idempotency_key AND operation = 'update_vendor_bill';
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'; END IF;
  IF v_overage_confirmed THEN
    INSERT INTO public.activity_feed (
      event_type, description, performed_by, related_entity_type, related_entity_id
    ) VALUES (
      'po_cumulative_billing_overage_confirmed',
      'Vendor bill ' || p_bill_id::text || ' edit raised cumulative active billing above 105%: ' || v_overage_reason,
      v_actor,
      'purchase_order',
      v_bill.purchase_order_id
    );
  END IF;
  RETURN v_result;
END;
$function$;

CREATE FUNCTION public.record_vendor_payment(
  p_vendor_bill_id uuid, p_amount_cents bigint, p_payment_date date DEFAULT CURRENT_DATE,
  p_payment_method text DEFAULT NULL, p_reference_number text DEFAULT NULL,
  p_notes text DEFAULT NULL, p_idempotency_key text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_fingerprint text;
  v_replay jsonb;
  v_payment_id uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  SELECT role INTO v_actor_role FROM public.profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role <> 'admin' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: admin role required to record vendor payments';
  END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: record_vendor_payment requires p_idempotency_key';
  END IF;
  PERFORM 1 FROM public.vendor_bills
   WHERE id = p_vendor_bill_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILL_NOT_FOUND: vendor bill % does not exist', p_vendor_bill_id; END IF;
  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'actor_id', v_actor, 'vendor_bill_id', p_vendor_bill_id,
    'amount_cents', p_amount_cents, 'payment_date', p_payment_date,
    'payment_method', p_payment_method, 'reference_number', p_reference_number,
    'notes', p_notes
  )::text, 'UTF8'), 'sha256'), 'hex');
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'record_vendor_payment', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' ->> 'payment_id' IS NULL THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN (v_replay -> 'result' ->> 'payment_id')::uuid;
  END IF;
  v_payment_id := public._section9_record_vendor_payment_intent_impl_20260831(
    p_vendor_bill_id, p_amount_cents, p_payment_date, p_payment_method,
    p_reference_number, p_notes, p_idempotency_key
  );
  UPDATE public.idempotency_keys SET request_fingerprint = v_fingerprint, request_actor_id = v_actor
   WHERE idempotency_key = p_idempotency_key AND operation = 'record_vendor_payment';
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'; END IF;
  RETURN v_payment_id;
END;
$function$;

CREATE FUNCTION public.void_vendor_bill(
  p_vendor_bill_id uuid, p_reason text DEFAULT NULL, p_idempotency_key text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_fingerprint text;
  v_replay jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  SELECT role INTO v_actor_role FROM public.profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role <> 'admin' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: admin role required to void vendor bills';
  END IF;
  IF p_reason IS NULL OR v_reason = '' THEN
    RAISE EXCEPTION 'REASON_REQUIRED: void requires a reason string';
  END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: void_vendor_bill requires p_idempotency_key';
  END IF;
  PERFORM 1 FROM public.vendor_bills
   WHERE id = p_vendor_bill_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILL_NOT_FOUND: vendor bill % does not exist', p_vendor_bill_id; END IF;
  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'actor_id', v_actor, 'vendor_bill_id', p_vendor_bill_id, 'reason', v_reason
  )::text, 'UTF8'), 'sha256'), 'hex');
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'void_vendor_bill', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL OR jsonb_typeof(v_replay -> 'result') = 'null' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN;
  END IF;
  PERFORM public._section9_void_vendor_bill_intent_impl_20260831(
    p_vendor_bill_id, v_reason, p_idempotency_key
  );
  UPDATE public.idempotency_keys SET request_fingerprint = v_fingerprint, request_actor_id = v_actor
   WHERE idempotency_key = p_idempotency_key AND operation = 'void_vendor_bill';
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'; END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.receive_po_items(jsonb, uuid, text, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_vendor_bill(uuid, bigint, bigint, date, date, text, text, boolean, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_vendor_payment(uuid, bigint, date, text, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.void_vendor_bill(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receive_po_items(jsonb, uuid, text, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_vendor_bill(uuid, bigint, bigint, date, date, text, text, boolean, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_vendor_payment(uuid, bigint, date, text, text, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.void_vendor_bill(uuid, text, text) TO authenticated, service_role;

DO $section9_intent_postcond$
BEGIN
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'receive_po_items') <> 1
     OR to_regprocedure('public.receive_po_items(jsonb,uuid,text,boolean)') IS NULL
     OR (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'update_vendor_bill') <> 1
     OR to_regprocedure('public.update_vendor_bill(uuid,bigint,bigint,date,date,text,text,boolean,text)') IS NULL
     OR to_regprocedure('public.update_vendor_bill(uuid,bigint,bigint,date,date,text,text)') IS NOT NULL
     OR (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'record_vendor_payment') <> 1
     OR to_regprocedure('public.record_vendor_payment(uuid,bigint,date,text,text,text,text)') IS NULL
     OR (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'void_vendor_bill') <> 1
     OR to_regprocedure('public.void_vendor_bill(uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION 'SECTION9_INTENT_POSTCONDITION: public RPC overload/signature drift';
  END IF;
END;
$section9_intent_postcond$;
