-- ════════════════════════════════════════════════════════════════════════════
-- Migration: 20260316200000_additional_audit_gap_fixes.sql
-- Purpose:   Fix 3 RPC gaps found during secondary audit verification
--   NEW-1: Add idempotency guard to apply_write_off
--   NEW-2: Add idempotency guard to batch_apply_prepayments
--   NEW-7: Add admin role check to generate_finance_charges
-- ════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 1: apply_write_off — add p_idempotency_key parameter
-- ═══════════════════════════════════════════════════════════════════════════

-- Drop old signature so CREATE OR REPLACE works with the new parameter list
DROP FUNCTION IF EXISTS public.apply_write_off(uuid, bigint, text, uuid);

CREATE OR REPLACE FUNCTION public.apply_write_off(
  p_invoice_id       uuid,
  p_amount_cents     bigint,
  p_reason           text,
  p_performed_by     uuid,
  p_idempotency_key  text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_invoice record;
  v_wo_id uuid;
  v_cached_result jsonb;
BEGIN
  -- Idempotency guard
  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := public.check_idempotency(p_idempotency_key, 'apply_write_off');
    IF v_cached_result IS NOT NULL THEN
      RETURN (v_cached_result->>'id')::uuid;
    END IF;
  END IF;

  -- Lock invoice
  SELECT id, customer_id, balance_cents, status, write_off_cents, invoice_number, invoice_date
    INTO v_invoice
    FROM public.invoices
   WHERE id = p_invoice_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found';
  END IF;

  IF v_invoice.status != 'posted' THEN
    RAISE EXCEPTION 'Can only write off posted invoices (current status: %)', v_invoice.status;
  END IF;

  -- Enforce accounting period
  PERFORM public.check_period_open(CURRENT_DATE);

  IF p_amount_cents > v_invoice.balance_cents THEN
    RAISE EXCEPTION 'Write-off amount (%) exceeds balance (%)',
      p_amount_cents, v_invoice.balance_cents;
  END IF;

  -- Create write-off record
  INSERT INTO public.write_offs (invoice_id, customer_id, amount_cents, reason, approved_by, created_by)
  VALUES (p_invoice_id, v_invoice.customer_id, p_amount_cents, p_reason, p_performed_by, p_performed_by)
  RETURNING id INTO v_wo_id;

  -- Increment write_off_cents (balance_cents is GENERATED)
  UPDATE public.invoices
     SET write_off_cents = COALESCE(write_off_cents, 0) + p_amount_cents,
         updated_at = now()
   WHERE id = p_invoice_id;

  -- Financial audit log
  INSERT INTO public.financial_audit_log (
    operation_type, entity_type, entity_id,
    actor_user_id, total_impact_cents, description
  ) VALUES (
    'write_off_applied', 'write_off', v_wo_id,
    p_performed_by, -p_amount_cents,
    'Write-off of $' || (p_amount_cents / 100.0)::numeric(12,2) ||
    ' on invoice ' || v_invoice.invoice_number || ': ' || p_reason
  );

  -- Save idempotency
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(
      p_idempotency_key,
      'apply_write_off',
      jsonb_build_object('id', v_wo_id)
    );
  END IF;

  RETURN v_wo_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_write_off(uuid, bigint, text, uuid, text) TO authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 2: batch_apply_prepayments — add p_idempotency_key parameter
-- ═══════════════════════════════════════════════════════════════════════════

-- Drop old signature so CREATE OR REPLACE works with the new parameter list
DROP FUNCTION IF EXISTS public.batch_apply_prepayments(jsonb, uuid);

CREATE OR REPLACE FUNCTION public.batch_apply_prepayments(
  p_allocations      jsonb,
  p_performed_by     uuid,
  p_idempotency_key  text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_alloc jsonb;
  v_result_ids uuid[] := ARRAY[]::uuid[];
  v_result_id uuid;
  v_total_applied bigint := 0;
  v_count integer := 0;
  v_cached_result jsonb;
  v_result jsonb;
BEGIN
  -- Idempotency guard
  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := check_idempotency(p_idempotency_key, 'batch_apply_prepayments');
    IF v_cached_result IS NOT NULL THEN
      RETURN v_cached_result;
    END IF;
  END IF;

  -- Enforce accounting period
  PERFORM check_period_open(CURRENT_DATE);

  FOR v_alloc IN SELECT * FROM jsonb_array_elements(p_allocations)
  LOOP
    -- Call the correct 3-parameter overload that updates prepay_applied_cents
    v_result_id := apply_prepay_to_invoice(
      (v_alloc->>'prepay_credit_id')::uuid,
      (v_alloc->>'invoice_id')::uuid,
      (v_alloc->>'amount_cents')::bigint
    );
    v_result_ids := array_append(v_result_ids, v_result_id);
    v_total_applied := v_total_applied + (v_alloc->>'amount_cents')::bigint;
    v_count := v_count + 1;
  END LOOP;

  v_result := jsonb_build_object(
    'success', true,
    'applied_count', v_count,
    'total_applied_cents', v_total_applied,
    'application_ids', to_jsonb(v_result_ids)
  );

  -- Save idempotency
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'batch_apply_prepayments', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.batch_apply_prepayments(jsonb, uuid, text) TO authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 3: generate_finance_charges — add admin role check
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.generate_finance_charges(
  p_as_of_date    date,
  p_performed_by  uuid,
  p_customer_ids  uuid[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_customer record;
  v_charge_amount bigint;
  v_invoice_id uuid;
  v_inv_num text;
  v_charges jsonb := '[]'::jsonb;
  v_count integer := 0;
  v_skipped integer := 0;
  v_min_balance bigint;
BEGIN
  -- NEW-7: Admin role check (defense in depth — route also checks)
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = p_performed_by AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Only admin users can generate finance charges';
  END IF;

  -- Enforce accounting period
  PERFORM public.check_period_open(p_as_of_date);

  -- Read minimum balance threshold
  SELECT COALESCE(s.setting_value::bigint, 500)
    INTO v_min_balance
    FROM public.app_settings s
   WHERE s.setting_key = 'finance_charge_min_balance_cents';

  IF v_min_balance IS NULL THEN
    v_min_balance := 500;
  END IF;

  FOR v_customer IN
    SELECT c.id AS customer_id, c.farm_name, c.finance_charge_rate,
           COALESCE(c.finance_charge_grace_days, 0) AS grace_days,
           COALESCE(sum(i.balance_cents), 0) AS overdue_balance
      FROM public.customers c
      INNER JOIN public.invoices i
        ON i.customer_id = c.id
        AND i.status = 'posted'
        AND i.balance_cents > 0
        AND i.deleted_at IS NULL
        AND i.due_date IS NOT NULL
        AND i.due_date < (p_as_of_date - (COALESCE(c.finance_charge_grace_days, 0) || ' days')::interval)
      WHERE c.finance_charge_rate > 0
        AND c.is_active = true
        AND COALESCE(c.finance_charge_enabled, true) = true
        AND (p_customer_ids IS NULL OR c.id = ANY(p_customer_ids))
      GROUP BY c.id, c.farm_name, c.finance_charge_rate, c.finance_charge_grace_days
      HAVING sum(i.balance_cents) >= v_min_balance
  LOOP
    -- Idempotency guard — skip if already charged for this period
    IF EXISTS (
      SELECT 1 FROM public.finance_charges
      WHERE customer_id = v_customer.customer_id
        AND period_end = p_as_of_date
    ) THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    -- Monthly rate = annual rate / 12
    v_charge_amount := ROUND(v_customer.overdue_balance * (v_customer.finance_charge_rate / 100.0 / 12.0));

    IF v_charge_amount > 0 THEN
      -- Generate invoice number
      PERFORM pg_advisory_xact_lock(hashtext('invoice_number'));
      SELECT 'FC-' || to_char(CURRENT_DATE, 'YYYY') || '-' ||
             lpad((COALESCE(MAX(regexp_replace(invoice_number, '^FC-\d{4}-', '')::integer), 0) + 1)::text, 4, '0')
        INTO v_inv_num
        FROM public.invoices
       WHERE invoice_number LIKE 'FC-' || to_char(CURRENT_DATE, 'YYYY') || '-%';

      INSERT INTO public.invoices (
        invoice_number, customer_id, invoice_type, status, invoice_date, due_date,
        total_amount_cents, total_cost_cents,
        header_notes, season, created_by
      ) VALUES (
        v_inv_num, v_customer.customer_id, 'misc_charge', 'unposted', p_as_of_date,
        p_as_of_date + interval '30 days',
        v_charge_amount, 0,
        'Finance charge on overdue balance of $' || (v_customer.overdue_balance / 100.0)::numeric(12,2) ||
        ' at ' || v_customer.finance_charge_rate || '% annually',
        to_char(p_as_of_date, 'YYYY'),
        p_performed_by
      )
      RETURNING id INTO v_invoice_id;

      -- Add invoice item
      INSERT INTO public.invoice_items (
        invoice_id, description, quantity, unit_price_cents, extended_cents, sort_order
      ) VALUES (
        v_invoice_id, 'Finance charge — ' || v_customer.finance_charge_rate || '% annual rate',
        1, v_charge_amount, v_charge_amount, 1
      );

      -- Record the finance charge
      INSERT INTO public.finance_charges (
        customer_id, invoice_id, charge_amount_cents,
        overdue_balance_cents, rate_applied, period_end, created_by
      ) VALUES (
        v_customer.customer_id, v_invoice_id, v_charge_amount,
        v_customer.overdue_balance, v_customer.finance_charge_rate,
        p_as_of_date, p_performed_by
      );

      -- Audit log
      INSERT INTO public.financial_audit_log (
        operation_type, entity_type, entity_id,
        actor_user_id, total_impact_cents, description
      ) VALUES (
        'finance_charge_generated', 'invoice', v_invoice_id,
        p_performed_by, v_charge_amount,
        'Finance charge of $' || (v_charge_amount / 100.0)::numeric(12,2) ||
        ' for ' || v_customer.farm_name ||
        ' on overdue balance of $' || (v_customer.overdue_balance / 100.0)::numeric(12,2)
      );

      v_charges := v_charges || jsonb_build_object(
        'customer_id', v_customer.customer_id,
        'farm_name', v_customer.farm_name,
        'invoice_id', v_invoice_id,
        'invoice_number', v_inv_num,
        'charge_amount_cents', v_charge_amount,
        'overdue_balance_cents', v_customer.overdue_balance
      );
      v_count := v_count + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'charges_generated', v_count,
    'charges_skipped', v_skipped,
    'charges', v_charges
  );
END;
$$;
