-- idempotency-body-check: exempt
-- (Uses check_idempotency / save_idempotency helpers per CLAUDE.md
-- "Canonical Patterns for New RPCs".)
-- ============================================================================
-- Codex review fix for PR #59 (P2, 2026-05-13) — Gate allocate_payment on the
-- payment date, not the invoice date.
-- ============================================================================
-- Audit finding: 20260430260000_field_app_workflow_phase14.sql:118 runs
--   PERFORM check_period_open(v_inv.invoice_date);
-- inside the allocation loop, gating period-close on each invoice's date
-- rather than on the payment's date.
--
-- The previous `record_invoice_payment` RPC (which InvoiceDetail used before
-- the recent unification) gated on the payment date — so admins could record
-- today's payment against last month's invoice even after the prior period
-- was closed (which is the expected accounting behavior: the payment belongs
-- to today's open period, the invoice's period being closed shouldn't matter).
--
-- After Sprint 2 switched InvoiceDetail to allocate_payment, recording a
-- payment against any older posted/overdue invoice from /invoices/:id fails
-- whenever the invoice's accounting period is closed — a UX regression.
--
-- Fix: move the period gate OUT of the per-invoice loop and run it once on
-- p_payment_date. Period semantics restored to "gate on the date the payment
-- is being recorded for." Body otherwise reproduced verbatim from
-- 20260430260000 lines 16-209.
--
-- Frontend impact: none. allocate_payment signature unchanged.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.allocate_payment(
  p_customer_id     uuid,
  p_total_cents     bigint,
  p_payment_method  text,
  p_reference_number text DEFAULT NULL,
  p_check_number    text DEFAULT NULL,
  p_payment_date    date DEFAULT CURRENT_DATE,
  p_notes           text DEFAULT NULL,
  p_allocations     jsonb DEFAULT '[]'::jsonb,
  p_performed_by    uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_cached_result jsonb;
  v_alloc jsonb;
  v_inv record;
  v_alloc_cents bigint;
  v_sum_allocated bigint := 0;
  v_set_id uuid;
  v_current_season integer;
  v_prepay_cents bigint;
  v_result jsonb;
  v_allocation_count integer := 0;
  v_next_version integer;
  v_customer_name text;
BEGIN
  -- Phase 14 strict actor check (preserved verbatim)
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := check_idempotency(p_idempotency_key, 'allocate_payment');
    IF v_cached_result IS NOT NULL THEN
      RETURN v_cached_result;
    END IF;
  END IF;

  -- Existing role check: admin/sales (preserved verbatim)
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized to allocate payments';
  END IF;

  IF p_total_cents <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be positive';
  END IF;

  -- Codex P2 fix (PR #59, 2026-05-13): period gate runs ONCE on payment_date
  -- here, no longer per-invoice on v_inv.invoice_date inside the loop.
  -- A payment belongs to its own period — older invoices whose original
  -- period has since closed remain payable so long as the payment_date is
  -- in an open period.
  PERFORM check_period_open(p_payment_date);

  SELECT farm_name INTO v_customer_name FROM customers WHERE id = p_customer_id;

  v_current_season := CASE WHEN extract(month FROM CURRENT_DATE) >= 10
    THEN extract(year FROM CURRENT_DATE)::integer + 1
    ELSE extract(year FROM CURRENT_DATE)::integer END;

  SELECT COALESCE(MAX(version), 0) + 1 INTO v_next_version
  FROM allocation_sets
  WHERE entity_type = 'payment' AND entity_id = p_customer_id;

  INSERT INTO allocation_sets (
    entity_type, entity_id, version,
    customer_id, total_payment_cents, payment_method,
    reference_number, check_number, payment_date,
    notes, season, created_by
  ) VALUES (
    'payment', p_customer_id, v_next_version,
    p_customer_id, p_total_cents, p_payment_method,
    p_reference_number, p_check_number, p_payment_date,
    p_notes, v_current_season, v_actor
  ) RETURNING id INTO v_set_id;

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

    -- (period gate moved above the loop — gates on p_payment_date now)

    INSERT INTO invoice_line_allocations (
      allocation_set_id, invoice_id, amount_cents,
      bill_to_customer_id, split_percentage
    ) VALUES (
      v_set_id, v_inv.id, v_alloc_cents,
      p_customer_id, 100
    );

    UPDATE invoices SET
      paid_amount_cents = paid_amount_cents + v_alloc_cents,
      status = CASE
        WHEN (total_amount_cents - (paid_amount_cents + v_alloc_cents) - prepay_applied_cents - write_off_cents) <= 0
        THEN 'paid'
        ELSE status
      END,
      updated_at = now()
    WHERE id = v_inv.id;

    v_sum_allocated := v_sum_allocated + v_alloc_cents;
    v_allocation_count := v_allocation_count + 1;
  END LOOP;

  UPDATE allocation_sets SET
    total_allocated_cents = v_sum_allocated,
    updated_at = now()
  WHERE id = v_set_id;

  v_prepay_cents := p_total_cents - v_sum_allocated;
  IF v_prepay_cents > 0 THEN
    INSERT INTO prepay_credits (
      customer_id, season, original_amount_cents, balance_cents,
      source_type, source_reference, created_by
    ) VALUES (
      p_customer_id, v_current_season, v_prepay_cents, v_prepay_cents,
      'overpayment', 'From payment ' || COALESCE(p_reference_number, p_check_number, v_set_id::text),
      v_actor
    );

    UPDATE customers SET
      prepay_balance_cents = COALESCE(prepay_balance_cents, 0) + v_prepay_cents,
      updated_at = now()
    WHERE id = p_customer_id;
  END IF;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'payment_allocated',
    'Payment of $' || (p_total_cents / 100.0)::text || ' allocated (' || v_allocation_count || ' invoices)',
    v_actor, 'allocation_set', v_set_id, p_customer_id
  );

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'payment_allocated', 'allocation_set', v_set_id,
    (SELECT role FROM profiles WHERE id = v_actor),
    jsonb_build_object(
      'customer_id', p_customer_id,
      'customer_name', v_customer_name,
      'payment_method', p_payment_method,
      'reference_number', p_reference_number,
      'total_cents', p_total_cents,
      'allocated_cents', v_sum_allocated,
      'prepay_cents', v_prepay_cents,
      'invoices_paid', v_allocation_count
    ),
    p_total_cents,
    'Payment $' || (p_total_cents / 100.0)::numeric(12,2) || ' from ' ||
    COALESCE(v_customer_name, 'customer') || ' via ' || p_payment_method ||
    CASE WHEN v_prepay_cents > 0 THEN ' ($' || (v_prepay_cents / 100.0)::numeric(12,2) || ' to prepay)' ELSE '' END
  );

  v_result := jsonb_build_object(
    'success', true,
    'allocation_set_id', v_set_id,
    'total_allocated_cents', v_sum_allocated,
    'prepay_created_cents', v_prepay_cents,
    'invoices_paid', v_allocation_count
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'allocate_payment', v_result);
  END IF;

  RETURN v_result;
END;
$$;

-- ─── Verification ────────────────────────────────────────────

DO $$
DECLARE
  v_overload_count integer;
  v_gates_payment_date boolean;
  v_no_invoice_date_gate boolean;
BEGIN
  SELECT count(*) INTO v_overload_count
  FROM pg_proc
  WHERE proname = 'allocate_payment' AND pronamespace = 'public'::regnamespace;
  IF v_overload_count <> 1 THEN
    RAISE EXCEPTION 'codex-fix verification: expected 1 overload of allocate_payment, found %', v_overload_count;
  END IF;

  SELECT prosrc ~ 'check_period_open\s*\(\s*p_payment_date\s*\)'
    INTO v_gates_payment_date
  FROM pg_proc
  WHERE proname = 'allocate_payment' AND pronamespace = 'public'::regnamespace;
  IF NOT COALESCE(v_gates_payment_date, false) THEN
    RAISE EXCEPTION 'codex-fix verification: allocate_payment missing check_period_open(p_payment_date)';
  END IF;

  SELECT prosrc !~ 'check_period_open\s*\(\s*v_inv\.invoice_date\s*\)'
    INTO v_no_invoice_date_gate
  FROM pg_proc
  WHERE proname = 'allocate_payment' AND pronamespace = 'public'::regnamespace;
  IF NOT COALESCE(v_no_invoice_date_gate, false) THEN
    RAISE EXCEPTION 'codex-fix verification: allocate_payment still gates on v_inv.invoice_date';
  END IF;

  RAISE NOTICE 'codex-fix: allocate_payment period gate moved from invoice_date to payment_date.';
END
$$;
