-- ============================================================================
-- Fix record_invoice_payment: invoice_line_allocations.allocated_cents
-- does not exist — correct column is amount_cents
--
-- Bug: The 20260311200000 migration wrote record_invoice_payment() using
-- `allocated_cents` when inserting into invoice_line_allocations. The actual
-- column name (from 20260213100000 schema) is `amount_cents`. This caused
-- every call to record_invoice_payment to fail with a PostgreSQL column-not-
-- found error, leaving paid_amount_cents = 0 on the invoice.
-- Fix: Use correct column name `amount_cents`.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.record_invoice_payment(
  p_invoice_id      uuid,
  p_amount_cents    bigint,
  p_payment_method  text,
  p_reference_number text DEFAULT NULL,
  p_notes           text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_inv          record;
  v_alloc_set_id uuid;
BEGIN
  SELECT * INTO v_inv FROM public.invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found: %', p_invoice_id;
  END IF;

  IF v_inv.status != 'posted' THEN
    RAISE EXCEPTION 'Can only record payments on posted invoices (current status: %)', v_inv.status;
  END IF;

  IF p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be positive';
  END IF;

  IF p_amount_cents > v_inv.balance_cents THEN
    RAISE EXCEPTION 'Payment ($%) exceeds invoice balance ($%)',
      (p_amount_cents / 100.0)::numeric(12,2),
      (v_inv.balance_cents / 100.0)::numeric(12,2);
  END IF;

  -- Create allocation set for audit trail
  INSERT INTO public.allocation_sets (
    customer_id, total_payment_cents, payment_method,
    reference_number, payment_date, notes, total_allocated_cents, created_by
  ) VALUES (
    v_inv.customer_id, p_amount_cents, p_payment_method,
    p_reference_number, CURRENT_DATE, p_notes, p_amount_cents, auth.uid()
  ) RETURNING id INTO v_alloc_set_id;

  -- FIX: use amount_cents (correct column), not allocated_cents (does not exist)
  INSERT INTO public.invoice_line_allocations (
    allocation_set_id, invoice_id, amount_cents
  ) VALUES (
    v_alloc_set_id, p_invoice_id, p_amount_cents
  );

  -- Update invoice paid amount
  UPDATE public.invoices SET
    paid_amount_cents = paid_amount_cents + p_amount_cents,
    status = CASE
      WHEN (total_amount_cents - (paid_amount_cents + p_amount_cents) - prepay_applied_cents - write_off_cents) <= 0
      THEN 'paid'
      ELSE status
    END,
    updated_at = now()
  WHERE id = p_invoice_id;

  -- Audit
  INSERT INTO public.financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'payment_recorded', 'allocation_set', v_alloc_set_id,
    (SELECT role FROM public.profiles WHERE id = auth.uid()),
    jsonb_build_object(
      'invoice_id', p_invoice_id,
      'invoice_number', v_inv.invoice_number,
      'amount_cents', p_amount_cents,
      'method', p_payment_method,
      'reference', p_reference_number
    ),
    p_amount_cents,
    'Payment of $' || (p_amount_cents / 100.0)::numeric(12,2) || ' on ' || v_inv.invoice_number
  );

  RETURN v_alloc_set_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_invoice_payment(uuid, bigint, text, text, text) TO authenticated;
