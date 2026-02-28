-- Apply a specific prepay bucket to a specific invoice with full audit trail

CREATE OR REPLACE FUNCTION public.apply_prepay_to_invoice(
  p_prepay_credit_id uuid,
  p_invoice_id uuid,
  p_amount_cents bigint,
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_credit record;
  v_invoice record;
  v_applied_id uuid;
BEGIN
  -- Lock and read the prepay credit (bucket)
  SELECT * INTO v_credit
    FROM public.prepay_credits
    WHERE id = p_prepay_credit_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Prepay credit not found';
  END IF;

  IF v_credit.balance_cents < p_amount_cents THEN
    RAISE EXCEPTION 'Insufficient prepay balance: % available, % requested',
      v_credit.balance_cents, p_amount_cents;
  END IF;

  -- Lock and read the invoice
  SELECT * INTO v_invoice
    FROM public.invoices
    WHERE id = p_invoice_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found';
  END IF;

  IF v_invoice.balance_cents < p_amount_cents THEN
    RAISE EXCEPTION 'Amount exceeds invoice balance: % owed, % applied',
      v_invoice.balance_cents, p_amount_cents;
  END IF;

  -- Create immutable application record
  INSERT INTO public.prepay_applications (
    prepay_credit_id, invoice_id, applied_amount_cents, applied_by
  ) VALUES (
    p_prepay_credit_id, p_invoice_id, p_amount_cents, p_performed_by
  ) RETURNING id INTO v_applied_id;

  -- Deduct from prepay credit bucket
  UPDATE public.prepay_credits
    SET balance_cents = balance_cents - p_amount_cents,
        updated_at = now()
    WHERE id = p_prepay_credit_id;

  -- Deduct from invoice balance
  UPDATE public.invoices
    SET balance_cents = balance_cents - p_amount_cents,
        updated_at = now()
    WHERE id = p_invoice_id;

  -- Update customer aggregate prepay_balance_cents
  UPDATE public.customers
    SET prepay_balance_cents = prepay_balance_cents - p_amount_cents,
        updated_at = now()
    WHERE id = v_credit.customer_id;

  -- Audit log
  INSERT INTO public.financial_audit_log (
    action, entity_type, entity_id, performed_by, details
  ) VALUES (
    'prepay_applied', 'prepay_application', v_applied_id, p_performed_by,
    jsonb_build_object(
      'prepay_credit_id', p_prepay_credit_id,
      'invoice_id', p_invoice_id,
      'amount_cents', p_amount_cents,
      'bucket_label', v_credit.bucket_label,
      'check_reference', v_credit.reference_number
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'application_id', v_applied_id,
    'prepay_remaining', v_credit.balance_cents - p_amount_cents,
    'invoice_remaining', v_invoice.balance_cents - p_amount_cents
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_prepay_to_invoice(uuid, uuid, bigint, uuid) TO authenticated;

-- Batch apply multiple allocations atomically (for "Save Allocations" button)

CREATE OR REPLACE FUNCTION public.batch_apply_prepayments(
  p_allocations jsonb,  -- [{prepay_credit_id, invoice_id, amount_cents}]
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_alloc jsonb;
  v_results jsonb[] := ARRAY[]::jsonb[];
  v_result jsonb;
  v_total_applied bigint := 0;
  v_count integer := 0;
BEGIN
  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations)
  LOOP
    v_result := public.apply_prepay_to_invoice(
      (v_alloc->>'prepay_credit_id')::uuid,
      (v_alloc->>'invoice_id')::uuid,
      (v_alloc->>'amount_cents')::bigint,
      p_performed_by
    );
    v_results := array_append(v_results, v_result);
    v_total_applied := v_total_applied + (v_alloc->>'amount_cents')::bigint;
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'applied_count', v_count,
    'total_applied_cents', v_total_applied,
    'details', to_jsonb(v_results)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.batch_apply_prepayments(jsonb, uuid) TO authenticated;
