-- ============================================================================
-- FIX: allocate_payment double-counting orders.total_paid
--
-- BUG: allocate_payment manually updates orders.total_paid AND the
-- trg_payment_update_order trigger ALSO fires on the INSERT INTO payments,
-- causing total_paid to be incremented TWICE for every payment made through
-- the allocate_payment RPC.
--
-- EVIDENCE: ORD-2026-0003 has real_payments=$85,558 but total_paid=$171,116
--
-- FIX: Remove the manual UPDATE orders from allocate_payment (the trigger
-- handles it correctly). Also repair all corrupted order balances.
-- ============================================================================

-- STEP 1: Fix the allocate_payment RPC (overload with p_reference text parameter)
-- Remove the UPDATE orders block that duplicates the trigger's work
CREATE OR REPLACE FUNCTION public.allocate_payment(
  p_customer_id uuid,
  p_total_cents bigint,
  p_allocations jsonb,
  p_payment_method text DEFAULT 'check',
  p_reference text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
  PERFORM require_admin_or_sales_rep();
  PERFORM check_rate_limit(auth.uid(), 'allocate_payment', 10, 60);
  v_actor := COALESCE(p_performed_by, auth.uid());
  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor;

  IF p_idempotency_key IS NOT NULL THEN
    v_idem_result := check_idempotency(p_idempotency_key, 'allocate_payment');
    IF v_idem_result IS NOT NULL THEN RETURN v_idem_result; END IF;
  END IF;

  IF p_total_cents <= 0 THEN RAISE EXCEPTION 'Payment amount must be positive'; END IF;

  SELECT * INTO v_cust FROM customers WHERE id = p_customer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found: %', p_customer_id; END IF;

  SELECT COALESCE(
    (SELECT setting_value::integer FROM app_settings WHERE setting_key = 'current_season'),
    EXTRACT(YEAR FROM CURRENT_DATE)::integer
  ) INTO v_current_season;

  IF p_allocations IS NOT NULL AND jsonb_array_length(p_allocations) > 0 THEN
    FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations)
    LOOP
      v_alloc_cents := (v_alloc->>'amount_cents')::bigint;
      IF v_alloc_cents <= 0 THEN CONTINUE; END IF;

      SELECT * INTO v_inv FROM invoices
       WHERE id = (v_alloc->>'invoice_id')::uuid AND deleted_at IS NULL FOR UPDATE;

      IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found: %', v_alloc->>'invoice_id'; END IF;
      IF v_inv.customer_id != p_customer_id THEN
        RAISE EXCEPTION 'Invoice % does not belong to this customer', v_inv.invoice_number;
      END IF;
      IF v_inv.status NOT IN ('posted', 'overdue') THEN
        RAISE EXCEPTION 'Invoice % is not posted (status: %)', v_inv.invoice_number, v_inv.status;
      END IF;
      IF v_alloc_cents > v_inv.balance_cents THEN
        RAISE EXCEPTION 'Allocation ($%) exceeds balance ($%) on invoice %',
          (v_alloc_cents/100.0)::numeric(12,2), (v_inv.balance_cents/100.0)::numeric(12,2), v_inv.invoice_number;
      END IF;

      -- Insert payment — trg_payment_update_order trigger will update orders.total_paid
      INSERT INTO payments (
        order_id, customer_id, amount, payment_method, payment_date,
        reference_number, notes, recorded_by, season
      ) VALUES (
        v_inv.order_id, p_customer_id,
        (v_alloc_cents / 100.0)::numeric(12,2),
        p_payment_method, CURRENT_DATE, p_reference,
        COALESCE(p_notes, '') || ' [Invoice: ' || v_inv.invoice_number || ']',
        v_actor, v_current_season
      ) RETURNING id INTO v_payment_id;

      -- Update invoice paid amount (no trigger overlap — invoices don't have a payment trigger)
      UPDATE invoices SET
        paid_amount_cents = paid_amount_cents + v_alloc_cents,
        status = CASE
          WHEN (total_amount_cents - (paid_amount_cents + v_alloc_cents) - prepay_applied_cents - write_off_cents) <= 0
          THEN 'paid' ELSE status
        END,
        updated_at = now()
      WHERE id = v_inv.id;

      -- NOTE: Removed manual UPDATE orders — the trg_payment_update_order trigger handles this
      -- Previously this caused double-counting of total_paid on orders

      INSERT INTO financial_audit_log (
        operation_type, entity_type, entity_id, actor_role, new_values, total_impact_cents, description
      ) VALUES (
        'payment_recorded', 'payment', v_payment_id, v_actor_role,
        jsonb_build_object('invoice_id', v_inv.id, 'invoice_number', v_inv.invoice_number,
          'amount_cents', v_alloc_cents, 'method', p_payment_method, 'reference', p_reference),
        v_alloc_cents,
        'Payment of $' || (v_alloc_cents/100.0)::numeric(12,2) || ' on ' || v_inv.invoice_number
      );

      INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
      VALUES (
        'payment_recorded',
        'Payment of $' || (v_alloc_cents/100.0)::numeric(12,2) || ' applied to ' || v_inv.invoice_number,
        v_actor, 'invoice', v_inv.id, p_customer_id
      );

      v_sum_allocated := v_sum_allocated + v_alloc_cents;
      v_allocations_out := v_allocations_out || jsonb_build_object(
        'invoice_id', v_inv.id, 'invoice_number', v_inv.invoice_number,
        'amount_cents', v_alloc_cents, 'payment_id', v_payment_id
      );
    END LOOP;
  END IF;

  IF v_sum_allocated > p_total_cents THEN
    RAISE EXCEPTION 'Sum of allocations ($%) exceeds check amount ($%)',
      (v_sum_allocated/100.0)::numeric(12,2), (p_total_cents/100.0)::numeric(12,2);
  END IF;

  v_prepay_cents := p_total_cents - v_sum_allocated;
  IF v_prepay_cents > 0 THEN
    INSERT INTO prepay_credits (
      customer_id, season, original_amount_cents, balance_cents,
      payment_method, reference_number, notes, created_by
    ) VALUES (
      p_customer_id, v_current_season, v_prepay_cents, v_prepay_cents,
      p_payment_method, p_reference,
      COALESCE(p_notes, '') || ' [Overpayment from check allocation]',
      v_actor
    ) RETURNING id INTO v_prepay_id;

    UPDATE customers SET
      prepay_balance_cents = COALESCE(prepay_balance_cents, 0) + v_prepay_cents,
      updated_at = now()
    WHERE id = p_customer_id;

    INSERT INTO financial_audit_log (
      operation_type, entity_type, entity_id, actor_role, new_values, total_impact_cents, description
    ) VALUES (
      'prepay_credit_created', 'prepay_credit', v_prepay_id, v_actor_role,
      jsonb_build_object('customer_id', p_customer_id, 'amount_cents', v_prepay_cents,
        'from_allocation', true, 'reference', p_reference),
      v_prepay_cents,
      'Prepay credit of $' || (v_prepay_cents/100.0)::numeric(12,2) || ' created from overpayment'
    );

    INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
    VALUES (
      'prepay_credit_created',
      'Prepay credit of $' || (v_prepay_cents/100.0)::numeric(12,2) || ' created from overpayment',
      v_actor, 'prepay_credit', v_prepay_id, p_customer_id
    );
  END IF;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role, new_values, total_impact_cents, description
  ) VALUES (
    'payment_allocation', 'customer', p_customer_id, v_actor_role,
    jsonb_build_object('total_cents', p_total_cents, 'allocated_cents', v_sum_allocated,
      'prepay_created_cents', v_prepay_cents, 'invoice_count', jsonb_array_length(v_allocations_out),
      'method', p_payment_method, 'reference', p_reference),
    p_total_cents,
    'Payment allocation: $' || (p_total_cents/100.0)::numeric(12,2) || ' — $' ||
      (v_sum_allocated/100.0)::numeric(12,2) || ' to ' || jsonb_array_length(v_allocations_out) || ' invoice(s)' ||
      CASE WHEN v_prepay_cents > 0 THEN ', $' || (v_prepay_cents/100.0)::numeric(12,2) || ' to prepay' ELSE '' END
  );

  DECLARE v_result jsonb;
  BEGIN
    v_result := jsonb_build_object(
      'success', true, 'total_cents', p_total_cents,
      'allocated_cents', v_sum_allocated, 'prepay_created_cents', v_prepay_cents,
      'prepay_credit_id', v_prepay_id, 'allocations', v_allocations_out
    );
    IF p_idempotency_key IS NOT NULL THEN
      PERFORM save_idempotency(p_idempotency_key, 'allocate_payment', v_result);
    END IF;
    RETURN v_result;
  END;
END;
$function$;


-- STEP 2: Fix the second overload of allocate_payment (with p_reference_number, p_check_number, p_payment_date)
CREATE OR REPLACE FUNCTION public.allocate_payment(
  p_customer_id uuid,
  p_total_cents bigint,
  p_payment_method text,
  p_reference_number text DEFAULT NULL,
  p_check_number text DEFAULT NULL,
  p_payment_date date DEFAULT CURRENT_DATE,
  p_notes text DEFAULT NULL,
  p_allocations jsonb DEFAULT '[]'::jsonb,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid;
  v_actor_role text;
  v_cached_result jsonb;
  v_alloc jsonb;
  v_inv record;
  v_alloc_cents bigint;
  v_sum_allocated bigint := 0;
  v_prepay_cents bigint;
  v_prepay_id uuid;
  v_payment_id uuid;
  v_result jsonb;
  v_allocation_count integer := 0;
  v_current_season integer;
  v_ref text;
  v_remaining bigint;
BEGIN
  v_actor := COALESCE(p_performed_by, auth.uid());
  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor;
  v_ref := COALESCE(p_reference_number, p_check_number);

  PERFORM check_rate_limit(auth.uid(), 'allocate_payment', 10, 60);

  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := check_idempotency(p_idempotency_key, 'allocate_payment');
    IF v_cached_result IS NOT NULL THEN RETURN v_cached_result; END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN RAISE EXCEPTION 'Not authorized to allocate payments'; END IF;

  IF p_total_cents <= 0 THEN RAISE EXCEPTION 'Payment amount must be positive'; END IF;

  v_current_season := CASE WHEN extract(month FROM CURRENT_DATE) >= 7
    THEN extract(year FROM CURRENT_DATE)::integer + 1
    ELSE extract(year FROM CURRENT_DATE)::integer END;

  IF p_allocations IS NOT NULL AND jsonb_array_length(p_allocations) > 0 THEN
    FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations)
    LOOP
      v_alloc_cents := (v_alloc->>'amount_cents')::bigint;
      IF v_alloc_cents <= 0 THEN CONTINUE; END IF;

      SELECT * INTO v_inv FROM invoices
      WHERE id = (v_alloc->>'invoice_id')::uuid
        AND customer_id = p_customer_id
        AND status IN ('posted', 'overdue')
        AND deleted_at IS NULL
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Invoice % not found or not eligible for payment', (v_alloc->>'invoice_id');
      END IF;

      IF v_alloc_cents > v_inv.balance_cents THEN
        RAISE EXCEPTION 'Allocation ($%) exceeds balance ($%) on invoice %',
          v_alloc_cents, v_inv.balance_cents, v_inv.invoice_number;
      END IF;

      -- Insert payment — trg_payment_update_order trigger will update orders.total_paid
      INSERT INTO payments (
        order_id, customer_id, amount, payment_method, payment_date,
        reference_number, notes, recorded_by, season
      ) VALUES (
        v_inv.order_id, p_customer_id,
        (v_alloc_cents / 100.0)::numeric(12,2),
        p_payment_method, p_payment_date, v_ref,
        COALESCE(p_notes, '') || ' [Invoice: ' || v_inv.invoice_number || ']',
        v_actor, v_current_season
      ) RETURNING id INTO v_payment_id;

      -- Update invoice paid amount
      UPDATE invoices SET
        paid_amount_cents = paid_amount_cents + v_alloc_cents,
        status = CASE
          WHEN (total_amount_cents - (paid_amount_cents + v_alloc_cents) - prepay_applied_cents - write_off_cents) <= 0
          THEN 'paid' ELSE status
        END,
        updated_at = now()
      WHERE id = v_inv.id;

      -- NOTE: Removed manual UPDATE orders — the trg_payment_update_order trigger handles this

      v_sum_allocated := v_sum_allocated + v_alloc_cents;
      v_allocation_count := v_allocation_count + 1;
    END LOOP;
  ELSE
    -- Auto-allocate mode: oldest invoices first
    v_remaining := p_total_cents;
    FOR v_inv IN
      SELECT * FROM invoices
      WHERE customer_id = p_customer_id
        AND status IN ('posted', 'overdue')
        AND deleted_at IS NULL
        AND balance_cents > 0
      ORDER BY invoice_date ASC, created_at ASC
      FOR UPDATE
    LOOP
      EXIT WHEN v_remaining <= 0;

      v_alloc_cents := LEAST(v_remaining, v_inv.balance_cents);

      -- Insert payment — trg_payment_update_order trigger will update orders.total_paid
      INSERT INTO payments (
        order_id, customer_id, amount, payment_method, payment_date,
        reference_number, notes, recorded_by, season
      ) VALUES (
        v_inv.order_id, p_customer_id,
        (v_alloc_cents / 100.0)::numeric(12,2),
        p_payment_method, p_payment_date, v_ref,
        COALESCE(p_notes, '') || ' [Invoice: ' || v_inv.invoice_number || ']',
        v_actor, v_current_season
      ) RETURNING id INTO v_payment_id;

      -- Update invoice paid amount
      UPDATE invoices SET
        paid_amount_cents = paid_amount_cents + v_alloc_cents,
        status = CASE
          WHEN (total_amount_cents - (paid_amount_cents + v_alloc_cents) - prepay_applied_cents - write_off_cents) <= 0
          THEN 'paid' ELSE status
        END,
        updated_at = now()
      WHERE id = v_inv.id;

      -- NOTE: Removed manual UPDATE orders — the trg_payment_update_order trigger handles this

      v_remaining := v_remaining - v_alloc_cents;
      v_sum_allocated := v_sum_allocated + v_alloc_cents;
      v_allocation_count := v_allocation_count + 1;
    END LOOP;
  END IF;

  v_prepay_cents := p_total_cents - v_sum_allocated;
  IF v_prepay_cents > 0 THEN
    INSERT INTO prepay_credits (
      customer_id, season, original_amount_cents, balance_cents,
      payment_method, reference_number, notes, created_by
    ) VALUES (
      p_customer_id, v_current_season, v_prepay_cents, v_prepay_cents,
      p_payment_method, v_ref,
      COALESCE(p_notes, '') || ' [Overpayment from payment allocation]',
      v_actor
    ) RETURNING id INTO v_prepay_id;

    UPDATE customers SET
      prepay_balance_cents = COALESCE(prepay_balance_cents, 0) + v_prepay_cents,
      updated_at = now()
    WHERE id = p_customer_id;
  END IF;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES (
    'payment_allocated',
    'Payment of $' || (p_total_cents/100.0)::text || ' allocated (' || v_allocation_count || ' invoices)',
    v_actor, 'customer', p_customer_id, p_customer_id
  );

  v_result := jsonb_build_object(
    'success', true,
    'total_allocated_cents', v_sum_allocated,
    'prepay_created_cents', v_prepay_cents,
    'prepay_credit_id', v_prepay_id,
    'invoices_paid', v_allocation_count
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'allocate_payment', v_result);
  END IF;

  RETURN v_result;
END;
$function$;


-- STEP 3: Repair ALL corrupted order balances
-- Recompute total_paid from actual payments for every order
UPDATE orders o SET
  total_paid = sub.real_paid,
  balance_due = COALESCE(o.total_price, 0) - sub.real_paid,
  updated_at = now()
FROM (
  SELECT o2.id,
    COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.order_id = o2.id AND p.deleted_at IS NULL), 0) as real_paid
  FROM orders o2
) sub
WHERE o.id = sub.id
AND o.total_paid != sub.real_paid;
