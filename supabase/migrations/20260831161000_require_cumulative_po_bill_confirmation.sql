-- STATUS: PARKED - NOT APPLIED
-- Gauntlet Section 9: prevent cumulative PO-linked bills from silently
-- exceeding 105% of the purchase-order total.

-- Hold receipt writers until the public function has been replaced. An
-- unexpired legacy success has no recoverable request intent, so deploying the
-- actor-bound wrapper over it could turn an uncertain retry into a second bill.
LOCK TABLE public.idempotency_keys IN SHARE ROW EXCLUSIVE MODE;
DO $section9_bill_create_cutover$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.idempotency_keys
    WHERE operation = 'create_vendor_bill'
      AND (expires_at IS NULL OR expires_at >= transaction_timestamp())
      AND (request_actor_id IS NULL OR request_fingerprint IS NULL)
  ) THEN
    RAISE EXCEPTION 'SECTION9_INTENT_CUTOVER_BLOCKED: unexpired unbound create_vendor_bill receipt exists';
  END IF;
END;
$section9_bill_create_cutover$;

ALTER FUNCTION public.create_vendor_bill(uuid, uuid, text, date, date, text, bigint, bigint, text, text)
  RENAME TO _section9_create_vendor_bill_cumulative_impl;

REVOKE ALL ON FUNCTION public._section9_create_vendor_bill_cumulative_impl(
  uuid, uuid, text, date, date, text, bigint, bigint, text, text
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.create_vendor_bill(
  p_vendor_id uuid,
  p_purchase_order_id uuid DEFAULT NULL,
  p_bill_number text DEFAULT '',
  p_bill_date date DEFAULT CURRENT_DATE,
  p_due_date date DEFAULT NULL,
  p_payment_terms text DEFAULT NULL,
  p_subtotal_cents bigint DEFAULT 0,
  p_adjustment_cents bigint DEFAULT 0,
  p_notes text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_confirm_po_overage boolean DEFAULT false,
  p_po_overage_reason text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid;
  v_fingerprint text;
  v_replay jsonb;
  v_bill_id uuid;
  v_candidate_total bigint;
  v_po_total bigint;
  v_active_billed_total bigint;
  v_cumulative_total bigint;
  v_overage_confirmed boolean := false;
  v_reason text := btrim(COALESCE(p_po_overage_reason, ''));
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: admin role required to create vendor bills';
  END IF;
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '[^[:space:]]'
     OR p_idempotency_key COLLATE "C" !~ '[!-~]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_vendor_bill requires p_idempotency_key';
  END IF;
  IF p_due_date IS NOT NULL AND p_due_date < p_bill_date THEN
    RAISE EXCEPTION 'INVALID_DUE_DATE: due date cannot precede bill date';
  END IF;

  v_fingerprint := encode(
    extensions.digest(
      convert_to(jsonb_build_object(
        'actor_id', v_actor,
        'vendor_id', p_vendor_id,
        'purchase_order_id', p_purchase_order_id,
        -- These nullable text inputs are passed to the mature implementation
        -- unchanged. Keep their exact SQL values in the fingerprint too:
        -- notably, NULL payment terms invoke vendor defaults while '' means an
        -- explicit empty term with the implementation's fallback due interval.
        'bill_number', p_bill_number,
        'bill_date', p_bill_date,
        'due_date', p_due_date,
        'payment_terms', p_payment_terms,
        'subtotal_cents', p_subtotal_cents,
        'adjustment_cents', COALESCE(p_adjustment_cents, 0),
        'notes', p_notes,
        'confirm_po_overage', COALESCE(p_confirm_po_overage, false),
        'po_overage_reason', v_reason
      )::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'create_vendor_bill', v_actor, v_fingerprint
  );
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL
       OR jsonb_typeof(v_replay -> 'result') = 'null'
       OR NULLIF(v_replay #>> '{result,bill_id}', '') IS NULL THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN (v_replay #>> '{result,bill_id}')::uuid;
  END IF;

  v_candidate_total := p_subtotal_cents + COALESCE(p_adjustment_cents, 0);

  -- Preserve the established financial lock order used by the delegated bill
  -- implementation and supplier-cost application: vendor before optional PO.
  -- Taking the PO first here would deadlock with vendor -> PO writers.
  PERFORM 1
  FROM public.vendors v
  WHERE v.id = p_vendor_id
    AND v.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VENDOR_NOT_FOUND: vendor % does not exist or is soft-deleted', p_vendor_id;
  END IF;

  IF p_purchase_order_id IS NOT NULL THEN
    SELECT po.total_cost_cents
    INTO v_po_total
    FROM public.purchase_orders po
    WHERE po.id = p_purchase_order_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PO_NOT_FOUND: purchase order % does not exist', p_purchase_order_id;
    END IF;

    SELECT COALESCE(SUM(vb.total_cents), 0)::bigint
    INTO v_active_billed_total
    FROM public.vendor_bills vb
    WHERE vb.purchase_order_id = p_purchase_order_id
      AND vb.deleted_at IS NULL
      AND vb.status <> 'voided';

    v_cumulative_total := v_active_billed_total + v_candidate_total;
    IF v_cumulative_total > 0
       AND (v_po_total <= 0 OR v_cumulative_total * 100 > v_po_total * 105) THEN
      IF COALESCE(p_confirm_po_overage, false) IS NOT TRUE THEN
        RAISE EXCEPTION 'PO_CUMULATIVE_BILLING_CONFIRMATION_REQUIRED'
          USING ERRCODE = '22023',
                DETAIL = jsonb_build_object(
                  'po_total_cents', v_po_total,
                  'active_billed_cents', v_active_billed_total,
                  'candidate_bill_cents', v_candidate_total,
                  'cumulative_bill_cents', v_cumulative_total
                )::text;
      END IF;
      IF v_reason = '' THEN
        RAISE EXCEPTION 'PO_CUMULATIVE_BILLING_REASON_REQUIRED';
      END IF;
      v_overage_confirmed := true;
    END IF;
  END IF;

  v_bill_id := public._section9_create_vendor_bill_cumulative_impl(
    p_vendor_id,
    p_purchase_order_id,
    p_bill_number,
    p_bill_date,
    p_due_date,
    p_payment_terms,
    p_subtotal_cents,
    p_adjustment_cents,
    p_notes,
    p_idempotency_key
  );

  UPDATE public.idempotency_keys
  SET request_fingerprint = v_fingerprint,
      request_actor_id = v_actor
  WHERE idempotency_key = p_idempotency_key
    AND operation = 'create_vendor_bill';
  IF NOT FOUND THEN RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'; END IF;

  IF v_overage_confirmed THEN
    INSERT INTO public.activity_feed (
      event_type, description, performed_by, related_entity_type, related_entity_id
    ) VALUES (
      'po_cumulative_billing_overage_confirmed',
      'Vendor bill ' || v_bill_id::text || ' exceeded the cumulative PO billing threshold: ' || v_reason,
      v_actor,
      'purchase_order',
      p_purchase_order_id
    );
  END IF;

  RETURN v_bill_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_vendor_bill(
  uuid, uuid, text, date, date, text, bigint, bigint, text, text, boolean, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_vendor_bill(
  uuid, uuid, text, date, date, text, bigint, bigint, text, text, boolean, text
) TO authenticated, service_role;

-- Vendor-bill money and PO controls are authoritative in SECURITY DEFINER
-- RPCs. Keep browser roles read-only on the table so PostgREST cannot bypass
-- cumulative-billing confirmation, period locks, audit rows, or idempotency.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.vendor_bills
FROM PUBLIC, anon, authenticated;

DO $verify$
DECLARE
  v_count integer;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace AND proname = 'create_vendor_bill';
  IF v_count <> 1 THEN RAISE EXCEPTION 'create_vendor_bill overload count = %', v_count; END IF;

  IF (CASE
       WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
       THEN has_function_privilege(
         'anon',
         'public.create_vendor_bill(uuid,uuid,text,date,date,text,bigint,bigint,text,text,boolean,text)',
         'EXECUTE'
       )
       ELSE false
     END) THEN
    RAISE EXCEPTION 'anonymous create_vendor_bill execution remains';
  END IF;

  IF (CASE
       WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
       THEN has_function_privilege(
         'authenticated',
         'public._section9_create_vendor_bill_cumulative_impl(uuid,uuid,text,date,date,text,bigint,bigint,text,text)',
         'EXECUTE'
       )
       ELSE false
     END) THEN
    RAISE EXCEPTION 'unguarded create_vendor_bill implementation is browser-executable';
  END IF;

  IF (CASE
       WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
       THEN has_table_privilege('authenticated', 'public.vendor_bills', 'INSERT')
         OR has_table_privilege('authenticated', 'public.vendor_bills', 'UPDATE')
         OR has_table_privilege('authenticated', 'public.vendor_bills', 'DELETE')
         OR has_table_privilege('authenticated', 'public.vendor_bills', 'TRUNCATE')
       ELSE false
     END) THEN
    RAISE EXCEPTION 'authenticated retains direct vendor_bills write privilege';
  END IF;
END;
$verify$;
