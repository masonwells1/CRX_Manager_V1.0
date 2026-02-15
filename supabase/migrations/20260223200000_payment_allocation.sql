-- ─── Sprint 16: Unified Payment Allocation ──────────────────────────────
--
-- New RPC:
--   allocate_payment(p_customer_id, p_total_cents, p_allocations jsonb,
--                    p_payment_method, p_reference, p_notes,
--                    p_performed_by, p_idempotency_key) → jsonb
--
-- Allows a single check to be split across multiple invoices,
-- with any remainder becoming a prepay credit.

CREATE OR REPLACE FUNCTION public.allocate_payment(
  p_customer_id     uuid,
  p_total_cents     bigint,
  p_allocations     jsonb,            -- array of {invoice_id, amount_cents}
  p_payment_method  text DEFAULT 'check',
  p_reference       text DEFAULT NULL,
  p_notes           text DEFAULT NULL,
  p_performed_by    uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor           uuid;
  v_actor_role      text;
  v_idem_result     jsonb;
  v_alloc           jsonb;
  v_inv             record;
  v_alloc_cents     bigint;
  v_sum_allocated   bigint := 0;
  v_prepay_cents    bigint := 0;
  v_prepay_id       uuid;
  v_payment_id      uuid;
  v_allocations_out jsonb := '[]'::jsonb;
  v_cust            record;
  v_current_season  integer;
BEGIN
  -- ── Resolve actor ──
  v_actor := COALESCE(p_performed_by, auth.uid());
  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor;

  -- ── Idempotency check ──
  IF p_idempotency_key IS NOT NULL THEN
    v_idem_result := check_idempotency(p_idempotency_key, 'allocate_payment');
    IF v_idem_result IS NOT NULL THEN
      RETURN v_idem_result;
    END IF;
  END IF;

  -- ── Validate inputs ──
  IF p_total_cents <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be positive';
  END IF;

  -- Lock customer row
  SELECT * INTO v_cust FROM customers WHERE id = p_customer_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer not found: %', p_customer_id;
  END IF;

  -- Get current season from app_settings
  SELECT COALESCE(
    (SELECT setting_value::integer FROM app_settings WHERE setting_key = 'current_season'),
    EXTRACT(YEAR FROM CURRENT_DATE)::integer
  ) INTO v_current_season;

  -- ── Process each allocation ──
  IF p_allocations IS NOT NULL AND jsonb_array_length(p_allocations) > 0 THEN
    FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations)
    LOOP
      v_alloc_cents := (v_alloc->>'amount_cents')::bigint;

      IF v_alloc_cents <= 0 THEN
        CONTINUE;  -- Skip zero/negative allocations
      END IF;

      -- Lock invoice row, validate ownership + status
      SELECT * INTO v_inv
        FROM invoices
       WHERE id = (v_alloc->>'invoice_id')::uuid
         AND deleted_at IS NULL
         FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Invoice not found: %', v_alloc->>'invoice_id';
      END IF;

      IF v_inv.customer_id != p_customer_id THEN
        RAISE EXCEPTION 'Invoice % does not belong to this customer', v_inv.invoice_number;
      END IF;

      IF v_inv.status != 'posted' THEN
        RAISE EXCEPTION 'Invoice % is not posted (status: %)', v_inv.invoice_number, v_inv.status;
      END IF;

      IF v_alloc_cents > v_inv.balance_cents THEN
        RAISE EXCEPTION 'Allocation ($%) exceeds balance ($%) on invoice %',
          (v_alloc_cents / 100.0)::numeric(12,2),
          (v_inv.balance_cents / 100.0)::numeric(12,2),
          v_inv.invoice_number;
      END IF;

      -- Insert payment record (reuse existing payments table, converting cents → dollars)
      INSERT INTO payments (
        order_id, amount, payment_method, payment_date, reference_number,
        notes, recorded_by
      ) VALUES (
        v_inv.order_id,
        (v_alloc_cents / 100.0)::numeric(12,2),
        p_payment_method,
        CURRENT_DATE,
        p_reference,
        COALESCE(p_notes, '') || ' [Invoice: ' || v_inv.invoice_number || ']',
        v_actor
      )
      RETURNING id INTO v_payment_id;

      -- Update invoice paid_amount_cents
      UPDATE invoices SET
        paid_amount_cents = paid_amount_cents + v_alloc_cents,
        updated_at = now()
      WHERE id = v_inv.id;

      -- Update linked order balance if exists
      IF v_inv.order_id IS NOT NULL THEN
        UPDATE orders SET
          total_paid = total_paid + (v_alloc_cents / 100.0)::numeric(12,2),
          balance_due = balance_due - (v_alloc_cents / 100.0)::numeric(12,2),
          updated_at = now()
        WHERE id = v_inv.order_id;
      END IF;

      -- Per-invoice audit log
      INSERT INTO financial_audit_log (
        operation_type, entity_type, entity_id, actor_role,
        new_values, total_impact_cents, description
      ) VALUES (
        'payment_recorded', 'payment', v_payment_id,
        v_actor_role,
        jsonb_build_object(
          'invoice_id', v_inv.id,
          'invoice_number', v_inv.invoice_number,
          'amount_cents', v_alloc_cents,
          'method', p_payment_method,
          'reference', p_reference,
          'allocation_batch', true
        ),
        v_alloc_cents,
        'Payment of $' || (v_alloc_cents / 100.0)::numeric(12,2) || ' on ' || v_inv.invoice_number
      );

      -- Activity feed
      INSERT INTO activity_feed (
        event_type, description, performed_by,
        related_entity_type, related_entity_id, customer_id
      ) VALUES (
        'payment_recorded',
        'Payment of $' || (v_alloc_cents / 100.0)::numeric(12,2) || ' applied to ' || v_inv.invoice_number,
        v_actor, 'invoice', v_inv.id, p_customer_id
      );

      v_sum_allocated := v_sum_allocated + v_alloc_cents;
      v_allocations_out := v_allocations_out || jsonb_build_object(
        'invoice_id', v_inv.id,
        'invoice_number', v_inv.invoice_number,
        'amount_cents', v_alloc_cents,
        'payment_id', v_payment_id
      );
    END LOOP;
  END IF;

  -- ── Validate total ──
  IF v_sum_allocated > p_total_cents THEN
    RAISE EXCEPTION 'Sum of allocations ($%) exceeds check amount ($%)',
      (v_sum_allocated / 100.0)::numeric(12,2),
      (p_total_cents / 100.0)::numeric(12,2);
  END IF;

  -- ── Handle overpayment → prepay credit ──
  v_prepay_cents := p_total_cents - v_sum_allocated;
  IF v_prepay_cents > 0 THEN
    INSERT INTO prepay_credits (
      customer_id, season, original_amount_cents, balance_cents,
      payment_method, reference_number, notes, created_by
    ) VALUES (
      p_customer_id,
      v_current_season,
      v_prepay_cents,
      v_prepay_cents,
      p_payment_method,
      p_reference,
      COALESCE(p_notes, '') || ' [Overpayment from check allocation]',
      v_actor
    )
    RETURNING id INTO v_prepay_id;

    -- Update customer prepay balance
    UPDATE customers SET
      prepay_balance_cents = COALESCE(prepay_balance_cents, 0) + v_prepay_cents,
      updated_at = now()
    WHERE id = p_customer_id;

    -- Audit
    INSERT INTO financial_audit_log (
      operation_type, entity_type, entity_id, actor_role,
      new_values, total_impact_cents, description
    ) VALUES (
      'prepay_credit_created', 'prepay_credit', v_prepay_id,
      v_actor_role,
      jsonb_build_object(
        'customer_id', p_customer_id,
        'amount_cents', v_prepay_cents,
        'from_allocation', true,
        'reference', p_reference
      ),
      v_prepay_cents,
      'Prepay credit of $' || (v_prepay_cents / 100.0)::numeric(12,2) ||
        ' created from check overpayment'
    );

    -- Activity feed
    INSERT INTO activity_feed (
      event_type, description, performed_by,
      related_entity_type, related_entity_id, customer_id
    ) VALUES (
      'prepay_credit_created',
      'Prepay credit of $' || (v_prepay_cents / 100.0)::numeric(12,2) ||
        ' created from check overpayment',
      v_actor, 'prepay_credit', v_prepay_id, p_customer_id
    );
  END IF;

  -- ── Batch-level audit entry ──
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'payment_allocation', 'customer', p_customer_id,
    v_actor_role,
    jsonb_build_object(
      'total_cents', p_total_cents,
      'allocated_cents', v_sum_allocated,
      'prepay_created_cents', v_prepay_cents,
      'invoice_count', jsonb_array_length(v_allocations_out),
      'method', p_payment_method,
      'reference', p_reference
    ),
    p_total_cents,
    'Payment allocation: $' || (p_total_cents / 100.0)::numeric(12,2) ||
      ' check — $' || (v_sum_allocated / 100.0)::numeric(12,2) ||
      ' to ' || jsonb_array_length(v_allocations_out) || ' invoice(s)' ||
      CASE WHEN v_prepay_cents > 0
        THEN ', $' || (v_prepay_cents / 100.0)::numeric(12,2) || ' to prepay'
        ELSE '' END
  );

  -- ── Build result ──
  DECLARE
    v_result jsonb;
  BEGIN
    v_result := jsonb_build_object(
      'success', true,
      'total_cents', p_total_cents,
      'allocated_cents', v_sum_allocated,
      'prepay_created_cents', v_prepay_cents,
      'prepay_credit_id', v_prepay_id,
      'allocations', v_allocations_out
    );

    -- Save idempotency key
    IF p_idempotency_key IS NOT NULL THEN
      PERFORM save_idempotency(p_idempotency_key, 'allocate_payment', v_result);
    END IF;

    RETURN v_result;
  END;
END;
$$;
