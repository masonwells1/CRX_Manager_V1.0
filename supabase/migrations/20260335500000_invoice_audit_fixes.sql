-- Invoice Audit Fixes
-- Fixes found by 6-agent audit sweep on 2026-04-02:
--   1. financial_audit_log: add trigger-level DELETE/UPDATE guard (defense-in-depth)
--   2. apply_write_off: auto-set status='paid' when write-off brings balance to 0
--   3. get_detailed_statement_data: fix aging bucket overlap + include 'overdue' invoices

-- =============================================================================
-- FIX 1: Protect financial_audit_log from accidental UPDATE/DELETE
-- RLS already blocks client-side mutations, but SECURITY DEFINER RPCs bypass RLS.
-- This trigger ensures the log is truly append-only at all privilege levels.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.guard_audit_log_immutable()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'financial_audit_log is append-only: % not allowed', TG_OP;
END;
$$;

CREATE TRIGGER trg_guard_audit_log_immutable
  BEFORE UPDATE OR DELETE ON public.financial_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.guard_audit_log_immutable();

-- =============================================================================
-- FIX 2: apply_write_off — auto-set status='paid' when balance reaches 0
-- Previously, a full write-off left status as 'posted' with $0 balance.
-- Now matches behavior of record_invoice_payment and apply_prepay_to_invoice.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.apply_write_off(
  p_invoice_id uuid,
  p_amount_cents bigint,
  p_reason text,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_invoice record;
  v_wo_id uuid;
  v_cached_result jsonb;
  v_new_write_off bigint;
  v_new_balance bigint;
BEGIN
  -- Idempotency guard
  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := public.check_idempotency(p_idempotency_key, 'apply_write_off');
    IF v_cached_result IS NOT NULL THEN
      RETURN (v_cached_result->>'id')::uuid;
    END IF;
  END IF;

  -- Lock invoice
  SELECT id, customer_id, balance_cents, status, write_off_cents,
         invoice_number, invoice_date, total_amount_cents,
         paid_amount_cents, prepay_applied_cents
    INTO v_invoice
    FROM public.invoices
   WHERE id = p_invoice_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found';
  END IF;

  IF v_invoice.status NOT IN ('posted', 'overdue') THEN
    RAISE EXCEPTION 'Can only write off posted or overdue invoices (current status: %)', v_invoice.status;
  END IF;

  -- Enforce accounting period
  PERFORM public.check_period_open(CURRENT_DATE);

  IF p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'Write-off amount must be positive';
  END IF;

  IF p_amount_cents > v_invoice.balance_cents THEN
    RAISE EXCEPTION 'Write-off amount (%) exceeds balance (%)',
      p_amount_cents, v_invoice.balance_cents;
  END IF;

  -- Create write-off record
  INSERT INTO public.write_offs (invoice_id, customer_id, amount_cents, reason, approved_by, created_by)
  VALUES (p_invoice_id, v_invoice.customer_id, p_amount_cents, p_reason, p_performed_by, p_performed_by)
  RETURNING id INTO v_wo_id;

  -- Increment write_off_cents (balance_cents is GENERATED)
  v_new_write_off := COALESCE(v_invoice.write_off_cents, 0) + p_amount_cents;
  -- Calculate what balance will be after the generated column recalculates
  v_new_balance := v_invoice.total_amount_cents
                 - v_invoice.paid_amount_cents
                 - v_invoice.prepay_applied_cents
                 - v_new_write_off;

  UPDATE public.invoices
     SET write_off_cents = v_new_write_off,
         status = CASE WHEN v_new_balance <= 0 THEN 'paid' ELSE status END,
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
    ' on invoice ' || v_invoice.invoice_number || ': ' || p_reason ||
    CASE WHEN v_new_balance <= 0 THEN ' (fully settled — status set to paid)' ELSE '' END
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
$function$;

-- =============================================================================
-- FIX 3: get_detailed_statement_data — two fixes:
--   a) Include 'overdue' status (was only 'posted')
--   b) Fix aging bucket overlap: over_90 now uses > 120 to not double-count
--      with the days_90 bucket (91-120)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_detailed_statement_data(
  p_customer_id uuid,
  p_as_of_date date,
  p_mode text DEFAULT 'summary'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_customer RECORD;
  v_transactions jsonb;
  v_aging jsonb;
  v_balance bigint := 0;
  v_inv RECORD;
  v_items jsonb;
  v_shares jsonb;
  v_finance_cents bigint;
  v_txn_list jsonb := '[]'::jsonb;
  v_days_aged integer;
  v_description text;
  v_grower_names text[];
BEGIN
  SELECT * INTO v_customer FROM customers WHERE id = p_customer_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer not found: %', p_customer_id;
  END IF;

  FOR v_inv IN
    SELECT i.*
    FROM invoices i
    WHERE i.customer_id = p_customer_id
      AND i.status IN ('posted', 'overdue')  -- FIX 3a: include overdue
      AND i.balance_cents > 0
      AND i.deleted_at IS NULL
      AND i.invoice_date <= p_as_of_date
    ORDER BY i.invoice_date, i.invoice_number
  LOOP
    v_balance := v_balance + v_inv.balance_cents;
    v_days_aged := p_as_of_date - v_inv.invoice_date;

    IF v_inv.invoice_type = 'field_application' AND v_inv.crop_type IS NOT NULL THEN
      v_description := COALESCE(v_inv.crop_type, '')
        || ' - ' || COALESCE(v_inv.total_acres::text, '')
        || ' - ' || COALESCE(array_to_string(v_inv.field_names, ', '), '');
    ELSIF v_inv.invoice_type = 'chemical_sale' THEN
      v_description := 'Chemical Sale: ' || COALESCE(v_inv.header_notes, '');
    ELSE
      v_description := COALESCE(v_inv.header_notes, v_inv.invoice_type);
    END IF;

    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'customer_name', s.customer_name,
          'split_percentage', s.split_percentage,
          'acres', s.acres,
          'amount_cents', s.amount_cents,
          'is_primary', s.is_primary,
          'price_per_acre_cents', CASE
            WHEN s.customer_id = p_customer_id THEN s.price_per_acre_cents
            ELSE NULL
          END,
          'pricing_note', CASE
            WHEN s.customer_id = p_customer_id THEN s.pricing_note
            ELSE NULL
          END
        ) ORDER BY s.sort_order
      ),
      '[]'::jsonb
    )
    INTO v_shares
    FROM invoice_shares s
    WHERE s.invoice_id = v_inv.id;

    SELECT array_agg(s.customer_name ORDER BY s.sort_order)
    INTO v_grower_names
    FROM invoice_shares s
    WHERE s.invoice_id = v_inv.id;

    v_items := '[]'::jsonb;
    IF p_mode = 'detailed' THEN
      SELECT COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'product_name', ii.description,
            'epa_registration', ii.epa_registration,
            'rate_per_acre', ii.rate_per_acre,
            'rate_unit', ii.rate_unit,
            'total_applied', ii.total_applied,
            'total_applied_unit', ii.total_applied_unit,
            'total_applied_gl_lb', ii.total_applied_gl_lb,
            'gl_lb_unit', ii.gl_lb_unit,
            'unit_price_cents', ii.unit_price_cents,
            'total_cost_cents', ii.extended_cents,
            'is_application_fee', COALESCE(ii.is_application_fee, false),
            'quantity', ii.quantity,
            'unit_size', ii.unit_size,
            'product_form', ii.product_form
          ) ORDER BY ii.sort_order
        ),
        '[]'::jsonb
      )
      INTO v_items
      FROM invoice_items ii
      WHERE ii.invoice_id = v_inv.id;
    END IF;

    SELECT COALESCE(sum(fc.amount_cents), 0)
    INTO v_finance_cents
    FROM finance_charges fc
    WHERE fc.invoice_id = v_inv.id;

    v_txn_list := v_txn_list || jsonb_build_object(
      'invoice_number', v_inv.invoice_number,
      'invoice_date', v_inv.invoice_date,
      'due_date', v_inv.due_date,
      'invoice_type', v_inv.invoice_type,
      'status', v_inv.status,
      'days_aged', v_days_aged,
      'description', v_description,
      'crop_type', v_inv.crop_type,
      'field_names', v_inv.field_names,
      'total_acres', v_inv.total_acres,
      'grower_names', v_grower_names,
      'total_amount_cents', v_inv.total_amount_cents,
      'paid_amount_cents', v_inv.paid_amount_cents,
      'prepay_applied_cents', v_inv.prepay_applied_cents,
      'balance_cents', v_inv.balance_cents,
      'items', v_items,
      'shares', v_shares,
      'finance_charge_cents', v_finance_cents,
      'net_due_cents', v_inv.balance_cents + v_finance_cents,
      'price_per_acre', CASE
        WHEN v_inv.total_acres > 0 THEN
          round(v_inv.total_amount_cents / 100.0 / v_inv.total_acres, 2)
        ELSE NULL
      END
    );
  END LOOP;

  -- FIX 3a+3b: include overdue status AND fix bucket boundaries
  -- Buckets: current (0-30), 31-60, 61-90, 91-120, over 120 (was > 90, double-counted)
  SELECT jsonb_build_object(
    'current_cents', COALESCE(sum(CASE WHEN p_as_of_date - i.invoice_date <= 30 THEN i.balance_cents ELSE 0 END), 0),
    'days_30_cents', COALESCE(sum(CASE WHEN p_as_of_date - i.invoice_date BETWEEN 31 AND 60 THEN i.balance_cents ELSE 0 END), 0),
    'days_60_cents', COALESCE(sum(CASE WHEN p_as_of_date - i.invoice_date BETWEEN 61 AND 90 THEN i.balance_cents ELSE 0 END), 0),
    'days_90_cents', COALESCE(sum(CASE WHEN p_as_of_date - i.invoice_date BETWEEN 91 AND 120 THEN i.balance_cents ELSE 0 END), 0),
    'over_120_cents', COALESCE(sum(CASE WHEN p_as_of_date - i.invoice_date > 120 THEN i.balance_cents ELSE 0 END), 0)
  )
  INTO v_aging
  FROM invoices i
  WHERE i.customer_id = p_customer_id
    AND i.status IN ('posted', 'overdue')  -- FIX 3a: include overdue
    AND i.balance_cents > 0
    AND i.deleted_at IS NULL
    AND i.invoice_date <= p_as_of_date;

  RETURN jsonb_build_object(
    'customer', jsonb_build_object(
      'id', v_customer.id,
      'farm_name', v_customer.farm_name,
      'contact_name', v_customer.contact_name,
      'account_number', v_customer.account_number,
      'email', v_customer.email,
      'phone', v_customer.phone,
      'billing_address', v_customer.billing_address,
      'city', v_customer.city,
      'state', v_customer.state,
      'zip', v_customer.zip,
      'payment_terms', v_customer.payment_terms
    ),
    'transactions', v_txn_list,
    'aging', v_aging,
    'outstanding_balance_cents', v_balance,
    'as_of_date', p_as_of_date,
    'mode', p_mode
  );
END;
$function$;
