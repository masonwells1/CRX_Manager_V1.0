-- ============================================================================
-- VOID PAYMENT RPC
-- ============================================================================
-- Reverses a payment allocation set:
--   1. For each invoice allocation: subtract amount from invoice paid_amount_cents,
--      recalculate balance_cents, and restore status if needed.
--   2. If the payment created a prepay credit (overpayment), zero it out and
--      decrement the customer aggregate.
--   3. Mark allocation_set as inactive.
--   4. Log to financial_audit_log.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.void_payment(
  p_allocation_set_id uuid,
  p_reason            text,
  p_performed_by      uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_set            record;
  v_alloc          record;
  v_actor          uuid;
  v_reversed_cents bigint := 0;
  v_invoice_count  int := 0;
  v_prepay_reversed bigint := 0;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());

  -- Lock and fetch the allocation set
  SELECT * INTO v_set
  FROM allocation_sets
  WHERE id = p_allocation_set_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Allocation set not found: %', p_allocation_set_id;
  END IF;

  IF NOT v_set.is_active THEN
    RAISE EXCEPTION 'Payment already voided';
  END IF;

  -- Reverse each invoice allocation
  FOR v_alloc IN
    SELECT ila.invoice_id, SUM(ila.amount_cents) AS total_amount
    FROM invoice_line_allocations ila
    WHERE ila.allocation_set_id = p_allocation_set_id
      AND ila.invoice_id IS NOT NULL
    GROUP BY ila.invoice_id
  LOOP
    -- Subtract paid amount from invoice
    UPDATE invoices
    SET paid_amount_cents = GREATEST(paid_amount_cents - v_alloc.total_amount, 0),
        balance_cents = total_amount_cents - GREATEST(paid_amount_cents - v_alloc.total_amount, 0),
        status = CASE
          WHEN GREATEST(paid_amount_cents - v_alloc.total_amount, 0) = 0
            AND status = 'paid' THEN 'posted'
          WHEN GREATEST(paid_amount_cents - v_alloc.total_amount, 0) < total_amount_cents
            AND status = 'paid' THEN 'posted'
          ELSE status
        END,
        updated_at = now()
    WHERE id = v_alloc.invoice_id;

    v_reversed_cents := v_reversed_cents + v_alloc.total_amount;
    v_invoice_count := v_invoice_count + 1;
  END LOOP;

  -- Check if this payment created an overpayment prepay credit
  UPDATE prepay_credits
  SET balance_cents = 0,
      notes = COALESCE(notes, '') || ' [VOIDED: ' || p_reason || ']',
      updated_at = now()
  WHERE source_type = 'overpayment'
    AND source_reference = p_allocation_set_id::text
    AND balance_cents > 0
  RETURNING balance_cents INTO v_prepay_reversed;

  -- If prepay was reversed, decrement customer aggregate
  IF v_prepay_reversed IS NOT NULL AND v_prepay_reversed > 0 THEN
    UPDATE customers
    SET prepay_balance_cents = GREATEST(prepay_balance_cents - v_prepay_reversed, 0)
    WHERE id = v_set.customer_id;
  END IF;

  -- Mark allocation set as voided
  UPDATE allocation_sets
  SET is_active = false,
      notes = COALESCE(notes, '') || ' [VOIDED: ' || p_reason || ']',
      updated_at = now()
  WHERE id = p_allocation_set_id;

  -- Audit log
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id,
    actor_user_id, old_values, new_values,
    total_impact_cents, description
  ) VALUES (
    'payment_voided', 'allocation_set', p_allocation_set_id,
    v_actor,
    jsonb_build_object(
      'total_payment_cents', v_set.total_payment_cents,
      'total_allocated_cents', v_set.total_allocated_cents,
      'payment_method', v_set.payment_method,
      'check_number', v_set.check_number,
      'customer_id', v_set.customer_id
    ),
    jsonb_build_object(
      'reason', p_reason,
      'invoices_reversed', v_invoice_count,
      'prepay_reversed_cents', COALESCE(v_prepay_reversed, 0)
    ),
    -1 * v_reversed_cents,
    'Voided payment ' || COALESCE(v_set.check_number, v_set.reference_number, v_set.id::text) || ' — ' || p_reason
  );

  RETURN jsonb_build_object(
    'success', true,
    'allocation_set_id', p_allocation_set_id,
    'reversed_cents', v_reversed_cents,
    'invoices_affected', v_invoice_count,
    'prepay_reversed_cents', COALESCE(v_prepay_reversed, 0)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.void_payment(uuid, text, uuid) TO authenticated;
