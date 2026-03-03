-- ============================================================================
-- Fix record_invoice_payment: switch from allocation_sets to payments table
--
-- Bug: The previous version used allocation_sets + invoice_line_allocations,
-- but allocation_sets has NOT NULL entity_type/entity_id columns (not provided)
-- and a UNIQUE(entity_type, entity_id, version) constraint that prevents
-- recording multiple payments against the same invoice. Both issues caused
-- every call to fail silently (error JSON returned instead of payment id),
-- leaving paid_amount_cents = 0 on all invoices.
--
-- Fix: Use the payments table, which is purpose-built for cash receipt
-- tracking and is already queried by close_accounting_period for period
-- summaries. Amounts stored as numeric dollars (payments.amount); cents
-- conversion done at INSERT and reporting time.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.record_invoice_payment(
  p_invoice_id       uuid,
  p_amount_cents     bigint,
  p_payment_method   text,
  p_reference_number text DEFAULT NULL,
  p_notes            text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_inv    record;
  v_pay_id uuid;
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

  -- balance_cents is a GENERATED ALWAYS column: total - paid - prepay - writeoff
  IF p_amount_cents > v_inv.balance_cents THEN
    RAISE EXCEPTION 'Payment ($%) exceeds invoice balance ($%)',
      (p_amount_cents / 100.0)::numeric(12,2),
      (v_inv.balance_cents / 100.0)::numeric(12,2);
  END IF;

  -- payments.amount is stored as numeric dollars (not cents)
  INSERT INTO public.payments (
    order_id, customer_id, amount, payment_method,
    reference_number, notes, recorded_by
  ) VALUES (
    v_inv.order_id,
    v_inv.customer_id,
    (p_amount_cents / 100.0)::numeric(12,2),
    p_payment_method,
    p_reference_number,
    p_notes,
    auth.uid()
  ) RETURNING id INTO v_pay_id;

  -- balance_cents auto-updates (generated column) when paid_amount_cents changes
  UPDATE public.invoices SET
    paid_amount_cents = paid_amount_cents + p_amount_cents,
    status = CASE
      WHEN (total_amount_cents - (paid_amount_cents + p_amount_cents)
            - prepay_applied_cents - write_off_cents) <= 0
      THEN 'paid'
      ELSE status
    END,
    updated_at = now()
  WHERE id = p_invoice_id;

  INSERT INTO public.financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'payment_recorded', 'payment', v_pay_id,
    (SELECT role FROM public.profiles WHERE id = auth.uid()),
    jsonb_build_object(
      'invoice_id',     p_invoice_id,
      'invoice_number', v_inv.invoice_number,
      'amount_cents',   p_amount_cents,
      'method',         p_payment_method,
      'reference',      p_reference_number
    ),
    p_amount_cents,
    'Payment of $' || (p_amount_cents / 100.0)::numeric(12,2) || ' on ' || v_inv.invoice_number
  );

  RETURN v_pay_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_invoice_payment(uuid, bigint, text, text, text) TO authenticated;
