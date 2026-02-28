-- ===========================================================================
-- Migration: 20260315200001_accounting_and_integrity_fixes.sql
-- Purpose: Phases 2-4 audit findings — accounting period enforcement,
--          financial audit logging, defensive hardening across 10 RPCs
-- Depends on: 20260315200000_emergency_rpc_fixes.sql (Phase 1)
-- ===========================================================================

-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 0: Schema Preparation
-- ═══════════════════════════════════════════════════════════════════════════

-- 0a: Expand financial_audit_log operation_type CHECK constraint
-- The original constraint only allowed invoice/payment/prepay types.
-- Functions like generate_finance_charges() and issue_return_credit()
-- already insert other types → they CRASH at runtime.
ALTER TABLE financial_audit_log
  DROP CONSTRAINT IF EXISTS financial_audit_log_operation_type_check;

ALTER TABLE financial_audit_log
  ADD CONSTRAINT financial_audit_log_operation_type_check
  CHECK (operation_type IN (
    -- Original types
    'invoice_created', 'invoice_posted', 'invoice_voided',
    'invoice_cancelled', 'payment_recorded', 'split_modified',
    'prepay_created', 'prepay_applied', 'split_invoices_generated',
    -- New types for this migration
    'write_off_applied',
    'prepay_batch_applied',
    'commission_payment_created',
    'commission_payment_posted',
    'finance_charge',
    'return_credit_issued',
    'cycle_count_completed'
  ));

-- 0b: Backfill invoice_line_allocations.invoice_id from invoice_items
-- Phase 1 added the column; this populates it for historical records
-- so void_invoice can find allocations by invoice_id.
UPDATE invoice_line_allocations ila SET
  invoice_id = ii.invoice_id
FROM invoice_items ii
WHERE ila.invoice_item_id = ii.id
  AND ila.invoice_id IS NULL;

-- 0c: Index for void_invoice lookups
CREATE INDEX IF NOT EXISTS idx_ila_invoice_id
  ON invoice_line_allocations(invoice_id);

-- 0d: Expand entity_type CHECK to include new types
ALTER TABLE financial_audit_log
  DROP CONSTRAINT IF EXISTS financial_audit_log_entity_type_check;

ALTER TABLE financial_audit_log
  ADD CONSTRAINT financial_audit_log_entity_type_check
  CHECK (entity_type IN (
    'invoice', 'payment', 'split', 'prepay',
    'commission_payment', 'write_off', 'return', 'cycle_count'
  ));


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 1: void_invoice()
-- Findings: #10 (no check_period_open), #14 (column bugs + logic bug)
-- Fixes:
--   - Add check_period_open(invoice_date) to prevent voiding in closed periods
--   - Fix allocated_cents → amount_cents (column doesn't exist)
--   - Collect allocation_set_ids BEFORE deleting ILAs (old code queried
--     deleted rows, finding nothing, so allocation_sets never got updated)
--   - Fix prepay_applications column: amount_cents → applied_amount_cents
--   - Remove deprecated orders.total_paid/balance_due update
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION void_invoice(
  p_invoice_id uuid,
  p_void_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv record;
  v_total_allocations_reversed bigint := 0;
  v_total_prepay_restored bigint := 0;
  v_alloc_set_ids uuid[];
BEGIN
  -- Lock the invoice
  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found: %', p_invoice_id;
  END IF;

  IF v_inv.status = 'voided' THEN
    RAISE EXCEPTION 'Invoice already voided';
  END IF;

  IF v_inv.status = 'cancelled' THEN
    RAISE EXCEPTION 'Cannot void a cancelled invoice';
  END IF;

  -- FIX #10: Enforce accounting period
  PERFORM check_period_open(v_inv.invoice_date::date);

  -- ── Reverse payment allocations ──
  -- FIX #14a: Collect set IDs and total BEFORE deleting (old code
  -- deleted rows first, then tried to SELECT from them → found nothing)
  -- FIX #14b: Column is amount_cents, not allocated_cents
  SELECT COALESCE(SUM(ila.amount_cents), 0),
         array_agg(DISTINCT ila.allocation_set_id)
    INTO v_total_allocations_reversed, v_alloc_set_ids
    FROM invoice_line_allocations ila
   WHERE ila.invoice_id = p_invoice_id;

  -- Delete the allocations
  DELETE FROM invoice_line_allocations WHERE invoice_id = p_invoice_id;

  -- Recalculate allocation_sets totals using the pre-collected IDs
  IF v_total_allocations_reversed > 0 AND v_alloc_set_ids IS NOT NULL THEN
    UPDATE allocation_sets SET
      total_allocated_cents = (
        SELECT COALESCE(SUM(amount_cents), 0)
        FROM invoice_line_allocations
        WHERE allocation_set_id = allocation_sets.id
      ),
      updated_at = now()
    WHERE id = ANY(v_alloc_set_ids);

    -- Reduce invoice paid_amount_cents
    UPDATE invoices SET
      paid_amount_cents = GREATEST(paid_amount_cents - v_total_allocations_reversed, 0),
      updated_at = now()
    WHERE id = p_invoice_id;
  END IF;

  -- ── Restore prepay credits ──
  -- FIX #14c: Column is applied_amount_cents, not amount_cents
  SELECT COALESCE(SUM(pa.applied_amount_cents), 0)
    INTO v_total_prepay_restored
    FROM prepay_applications pa
   WHERE pa.invoice_id = p_invoice_id;

  IF v_total_prepay_restored > 0 THEN
    -- Restore each credit's balance (grouped by credit)
    UPDATE prepay_credits pc SET
      balance_cents = pc.balance_cents + pa_sum.restored,
      updated_at = now()
    FROM (
      SELECT prepay_credit_id, SUM(applied_amount_cents) AS restored
        FROM prepay_applications
       WHERE invoice_id = p_invoice_id
       GROUP BY prepay_credit_id
    ) pa_sum
    WHERE pc.id = pa_sum.prepay_credit_id;

    -- Delete application records
    DELETE FROM prepay_applications WHERE invoice_id = p_invoice_id;

    -- Restore customer prepay balance
    UPDATE customers SET
      prepay_balance_cents = COALESCE(prepay_balance_cents, 0) + v_total_prepay_restored,
      updated_at = now()
    WHERE id = v_inv.customer_id;

    -- Reduce invoice prepay_applied_cents
    UPDATE invoices SET
      prepay_applied_cents = GREATEST(prepay_applied_cents - v_total_prepay_restored, 0)
    WHERE id = p_invoice_id;
  END IF;

  -- Reverse any write-offs
  IF v_inv.write_off_cents > 0 THEN
    UPDATE invoices SET write_off_cents = 0 WHERE id = p_invoice_id;
  END IF;

  -- Void the invoice (balance_cents is GENERATED — zeroing total makes it 0)
  UPDATE invoices SET
    status = 'voided',
    voided_by = auth.uid(),
    voided_at = now(),
    void_reason = p_void_reason,
    total_amount_cents = 0,
    updated_at = now()
  WHERE id = p_invoice_id;

  -- FIX #14d: REMOVED deprecated orders.total_paid/balance_due update
  -- AR is now tracked exclusively via invoices.balance_cents (GENERATED column)

  -- Audit log
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'invoice_voided', 'invoice', p_invoice_id,
    (SELECT role FROM profiles WHERE id = (select auth.uid())),
    jsonb_build_object(
      'status', v_inv.status,
      'total_cents', v_inv.total_amount_cents,
      'paid_amount_cents', v_inv.paid_amount_cents,
      'prepay_applied_cents', v_inv.prepay_applied_cents,
      'write_off_cents', v_inv.write_off_cents
    ),
    jsonb_build_object(
      'status', 'voided',
      'void_reason', p_void_reason,
      'allocations_reversed_cents', v_total_allocations_reversed,
      'prepay_restored_cents', v_total_prepay_restored
    ),
    -1 * v_inv.total_amount_cents,
    'Voided ' || v_inv.invoice_number || ' — ' || p_void_reason ||
      CASE WHEN v_total_allocations_reversed > 0
        THEN '. Reversed $' || (v_total_allocations_reversed / 100.0)::text || ' in allocations.'
        ELSE '' END ||
      CASE WHEN v_total_prepay_restored > 0
        THEN ' Restored $' || (v_total_prepay_restored / 100.0)::text || ' in prepay credits.'
        ELSE '' END
  );

  -- Activity log
  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_voided',
    'Voided invoice ' || v_inv.invoice_number || ' — ' || p_void_reason,
    (select auth.uid()), 'invoice', p_invoice_id, v_inv.customer_id
  );

  -- Notify admins
  IF v_total_allocations_reversed > 0 OR v_total_prepay_restored > 0 THEN
    INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
    SELECT p.id,
      'Invoice Voided — Allocations Reversed',
      'Invoice ' || v_inv.invoice_number || ' voided. $' ||
        (v_total_allocations_reversed / 100.0)::text || ' in allocations reversed, $' ||
        (v_total_prepay_restored / 100.0)::text || ' in prepay credits restored.',
      'invoice_void_reversal', 'invoice', p_invoice_id
    FROM profiles p
    WHERE p.role = 'admin' AND p.is_active = true;
  END IF;
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 2: apply_write_off()
-- Findings: #11 (no check_period_open), #15 (no financial_audit_log)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.apply_write_off(
  p_invoice_id   uuid,
  p_amount_cents bigint,
  p_reason       text,
  p_performed_by uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_invoice record;
  v_wo_id uuid;
BEGIN
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

  -- FIX #11: Enforce accounting period
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

  -- FIX #15: Add financial audit log
  INSERT INTO public.financial_audit_log (
    operation_type, entity_type, entity_id,
    actor_user_id, total_impact_cents, description
  ) VALUES (
    'write_off_applied', 'write_off', v_wo_id,
    p_performed_by, -p_amount_cents,
    'Write-off of $' || (p_amount_cents / 100.0)::numeric(12,2) ||
    ' on invoice ' || v_invoice.invoice_number || ': ' || p_reason
  );

  RETURN v_wo_id;
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 3: apply_remaining_prepayments()
-- Findings: #12 (no check_period_open), #16 (no audit log)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.apply_remaining_prepayments(
  p_customer_id  uuid,
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_available bigint;
  v_invoice record;
  v_apply bigint;
  v_applied_total bigint := 0;
  v_count integer := 0;
BEGIN
  -- FIX #12: Enforce accounting period
  PERFORM public.check_period_open(CURRENT_DATE);

  -- Get available prepay balance
  SELECT COALESCE(c.prepay_balance_cents, 0)
    INTO v_available
    FROM public.customers c
   WHERE c.id = p_customer_id
     FOR UPDATE;

  IF v_available <= 0 THEN
    RETURN jsonb_build_object('applied_count', 0, 'applied_cents', 0, 'message', 'No prepay balance available');
  END IF;

  -- Apply to oldest unpaid invoices first
  FOR v_invoice IN
    SELECT id, invoice_number, balance_cents
      FROM public.invoices
     WHERE customer_id = p_customer_id
       AND status = 'posted'
       AND balance_cents > 0
       AND deleted_at IS NULL
     ORDER BY invoice_date ASC, created_at ASC
       FOR UPDATE
  LOOP
    EXIT WHEN v_available <= 0;

    v_apply := LEAST(v_available, v_invoice.balance_cents);

    -- Update prepay_applied_cents; balance_cents is GENERATED
    UPDATE public.invoices
       SET prepay_applied_cents = COALESCE(prepay_applied_cents, 0) + v_apply,
           updated_at = now()
     WHERE id = v_invoice.id;

    v_available := v_available - v_apply;
    v_applied_total := v_applied_total + v_apply;
    v_count := v_count + 1;
  END LOOP;

  -- Update customer prepay balance
  UPDATE public.customers
     SET prepay_balance_cents = GREATEST(0, COALESCE(prepay_balance_cents, 0) - v_applied_total),
         updated_at = now()
   WHERE id = p_customer_id;

  -- FIX #16: Add financial audit log
  IF v_applied_total > 0 THEN
    INSERT INTO public.financial_audit_log (
      operation_type, entity_type, entity_id,
      actor_user_id, total_impact_cents, description
    ) VALUES (
      'prepay_batch_applied', 'prepay', p_customer_id,
      p_performed_by, v_applied_total,
      'Batch applied $' || (v_applied_total / 100.0)::numeric(12,2) ||
      ' prepay across ' || v_count || ' invoice(s) for customer ' ||
      (SELECT farm_name FROM public.customers WHERE id = p_customer_id)
    );
  END IF;

  -- TODO: Future enhancement — create prepay_applications ledger entries
  -- linking specific prepay_credits to invoices for full traceability.
  -- Currently tracks at aggregate customer level only.

  RETURN jsonb_build_object(
    'applied_count', v_count,
    'applied_cents', v_applied_total,
    'remaining_prepay_cents', v_available
  );
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 4: generate_finance_charges()
-- Finding: #13 (no check_period_open)
-- Note: Already has audit log + idempotency guard — only adding period check
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
  -- FIX #13: Enforce accounting period
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
        (p_as_of_date + interval '30 days')::date,
        v_charge_amount, 0,
        'Finance charge: ' || v_customer.finance_charge_rate || '% annual on overdue balance of $' ||
        to_char(v_customer.overdue_balance / 100.0, 'FM999,999,990.00') ||
        CASE WHEN v_customer.grace_days > 0
             THEN ' (after ' || v_customer.grace_days || ' day grace period)'
             ELSE '' END,
        CASE WHEN extract(month FROM p_as_of_date) >= 7
             THEN extract(year FROM p_as_of_date)::integer + 1
             ELSE extract(year FROM p_as_of_date)::integer END,
        p_performed_by
      ) RETURNING id INTO v_invoice_id;

      INSERT INTO public.invoice_items (
        invoice_id, description, quantity, unit_price_cents, extended_cents,
        cost_cents, is_application_fee, sort_order
      ) VALUES (
        v_invoice_id,
        'Finance Charge — ' || v_customer.finance_charge_rate || '% annual rate on overdue balance',
        1, v_charge_amount, v_charge_amount,
        0, false, 1
      );

      INSERT INTO public.finance_charges (
        customer_id, invoice_id, amount_cents, charge_rate,
        base_amount_cents, period_start, period_end, created_by
      ) VALUES (
        v_customer.customer_id, v_invoice_id, v_charge_amount,
        v_customer.finance_charge_rate, v_customer.overdue_balance,
        (p_as_of_date - interval '30 days')::date, p_as_of_date,
        p_performed_by
      );

      -- Audit log
      INSERT INTO public.financial_audit_log (
        operation_type, entity_type, entity_id,
        actor_user_id, total_impact_cents, description
      ) VALUES (
        'finance_charge', 'invoice', v_invoice_id,
        p_performed_by, v_charge_amount,
        'Finance charge generated for ' || v_customer.farm_name ||
        ': $' || to_char(v_charge_amount / 100.0, 'FM999,999,990.00') ||
        ' at ' || v_customer.finance_charge_rate || '% on $' ||
        to_char(v_customer.overdue_balance / 100.0, 'FM999,999,990.00') || ' overdue'
      );

      v_count := v_count + 1;
      v_charges := v_charges || jsonb_build_object(
        'customer', v_customer.farm_name,
        'base_balance_cents', v_customer.overdue_balance,
        'charge_cents', v_charge_amount,
        'rate', v_customer.finance_charge_rate,
        'invoice_number', v_inv_num,
        'grace_days', v_customer.grace_days
      );
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'charges_generated', v_count,
    'skipped_already_charged', v_skipped,
    'details', v_charges
  );
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 5: apply_prepay_to_invoice()
-- Finding: #22 (no check_period_open, no invoice status check)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION apply_prepay_to_invoice(
  p_prepay_credit_id uuid,
  p_invoice_id       uuid,
  p_amount_cents     bigint
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_credit    record;
  v_inv       record;
  v_app_id    uuid;
BEGIN
  SELECT * INTO v_credit FROM prepay_credits WHERE id = p_prepay_credit_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Prepay credit not found';
  END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found';
  END IF;

  -- FIX #22a: Invoice status check — only apply to posted invoices
  IF v_inv.status NOT IN ('posted') THEN
    RAISE EXCEPTION 'Can only apply prepay to posted invoices (current status: %)', v_inv.status;
  END IF;

  -- FIX #22b: Enforce accounting period
  PERFORM check_period_open(CURRENT_DATE);

  IF p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'Application amount must be positive';
  END IF;

  IF p_amount_cents > v_credit.balance_cents THEN
    RAISE EXCEPTION 'Amount exceeds prepay balance ($%)', (v_credit.balance_cents / 100.0)::numeric(12,2);
  END IF;

  IF p_amount_cents > v_inv.balance_cents THEN
    RAISE EXCEPTION 'Amount exceeds invoice balance ($%)', (v_inv.balance_cents / 100.0)::numeric(12,2);
  END IF;

  -- Create application record
  INSERT INTO prepay_applications (prepay_credit_id, invoice_id, applied_amount_cents)
  VALUES (p_prepay_credit_id, p_invoice_id, p_amount_cents)
  RETURNING id INTO v_app_id;

  -- Update prepay balance
  UPDATE prepay_credits SET
    balance_cents = balance_cents - p_amount_cents,
    updated_at = now()
  WHERE id = p_prepay_credit_id;

  -- Update invoice prepay applied
  UPDATE invoices SET
    prepay_applied_cents = prepay_applied_cents + p_amount_cents,
    updated_at = now()
  WHERE id = p_invoice_id;

  -- Audit
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'prepay_applied', 'prepay', v_app_id,
    (SELECT role FROM profiles WHERE id = (select auth.uid())),
    jsonb_build_object(
      'prepay_credit_id', p_prepay_credit_id,
      'invoice_id', p_invoice_id,
      'invoice_number', v_inv.invoice_number,
      'amount_cents', p_amount_cents,
      'remaining_credit', v_credit.balance_cents - p_amount_cents
    ),
    p_amount_cents,
    'Applied $' || (p_amount_cents / 100.0)::numeric(12,2) || ' prepay to ' || v_inv.invoice_number
  );

  RETURN v_app_id;
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 6: create_commission_payment()
-- Findings: #17 (no FOR UPDATE → double-pay risk), #18 (no check_period_open),
--           #20 (no financial_audit_log), #24 (season convention inconsistency)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.create_commission_payment(
  p_commission_ids uuid[],
  p_payment_method text,
  p_reference      text,
  p_payment_date   date,
  p_notes          text,
  p_performed_by   uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_payment_id   uuid;
  v_payment_num  text;
  v_total        numeric := 0;
  v_recipient_id uuid;
  v_commission   record;
  v_season       integer;
  v_payment_dt   date;
BEGIN
  v_payment_dt := COALESCE(p_payment_date, CURRENT_DATE);

  -- FIX #18: Enforce accounting period
  PERFORM public.check_period_open(v_payment_dt);

  -- Validate at least one commission
  IF array_length(p_commission_ids, 1) IS NULL OR array_length(p_commission_ids, 1) = 0 THEN
    RAISE EXCEPTION 'No commissions selected for payment';
  END IF;

  -- FIX #17: Lock commissions FOR UPDATE to prevent double-pay
  -- Verify all exist, are unpaid, and belong to the same recipient
  SELECT DISTINCT c.recipient_user_id
    INTO v_recipient_id
    FROM public.commissions c
   WHERE c.id = ANY(p_commission_ids)
     AND c.status != 'paid'
     FOR UPDATE;

  IF v_recipient_id IS NULL THEN
    RAISE EXCEPTION 'No unpaid commissions found for the given IDs';
  END IF;

  IF (SELECT count(DISTINCT c.recipient_user_id)
      FROM public.commissions c
      WHERE c.id = ANY(p_commission_ids) AND c.status != 'paid') > 1 THEN
    RAISE EXCEPTION 'All commissions in a payment must belong to the same recipient';
  END IF;

  -- Calculate total
  SELECT sum(c.commission_amount)
    INTO v_total
    FROM public.commissions c
   WHERE c.id = ANY(p_commission_ids)
     AND c.status != 'paid';

  -- FIX #24: Season uses end-year convention to match generate_finance_charges
  -- July 2025 → season 2026 (the 2025-2026 season ending June 2026)
  v_season := CASE
    WHEN extract(month FROM v_payment_dt) >= 7
    THEN extract(year FROM v_payment_dt)::integer + 1
    ELSE extract(year FROM v_payment_dt)::integer
  END;

  -- Generate payment number
  v_payment_num := public.next_commission_payment_number();

  -- Create the payment
  INSERT INTO public.commission_payments (
    payment_number, recipient_id, total_amount, status,
    payment_method, reference_number, payment_date, notes, season, created_by
  ) VALUES (
    v_payment_num, v_recipient_id, v_total, 'unposted',
    p_payment_method, p_reference, v_payment_dt,
    p_notes, v_season, p_performed_by
  ) RETURNING id INTO v_payment_id;

  -- Create line items
  FOR v_commission IN
    SELECT c.id, c.commission_amount
      FROM public.commissions c
     WHERE c.id = ANY(p_commission_ids)
       AND c.status != 'paid'
  LOOP
    INSERT INTO public.commission_payment_items (
      commission_payment_id, commission_id, amount
    ) VALUES (
      v_payment_id, v_commission.id, v_commission.commission_amount
    );
  END LOOP;

  -- Mark commissions as paid
  UPDATE public.commissions
     SET status = 'paid', updated_at = now()
   WHERE id = ANY(p_commission_ids)
     AND status != 'paid';

  -- FIX #20: Add financial audit log
  INSERT INTO public.financial_audit_log (
    operation_type, entity_type, entity_id,
    actor_user_id, total_impact_cents, description
  ) VALUES (
    'commission_payment_created', 'commission_payment', v_payment_id,
    p_performed_by, (v_total * 100)::bigint,
    'Commission payment ' || v_payment_num || ' created for $' ||
    to_char(v_total, 'FM999,999,990.00') || ' to ' ||
    (SELECT full_name FROM public.profiles WHERE id = v_recipient_id)
  );

  RETURN v_payment_id;
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 7: post_commission_payment()
-- Findings: #19 (no check_period_open), #21 (no financial_audit_log)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.post_commission_payment(
  p_payment_id   uuid,
  p_performed_by uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_payment record;
BEGIN
  SELECT * INTO v_payment
    FROM public.commission_payments
   WHERE id = p_payment_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Commission payment not found';
  END IF;

  IF v_payment.status = 'posted' THEN
    RAISE EXCEPTION 'Commission payment is already posted';
  END IF;

  -- FIX #19: Enforce accounting period
  PERFORM public.check_period_open(COALESCE(v_payment.payment_date, CURRENT_DATE));

  UPDATE public.commission_payments
     SET status = 'posted',
         posted_by = p_performed_by,
         posted_at = now(),
         updated_at = now()
   WHERE id = p_payment_id;

  -- FIX #21: Add financial audit log
  INSERT INTO public.financial_audit_log (
    operation_type, entity_type, entity_id,
    actor_user_id, total_impact_cents, description
  ) VALUES (
    'commission_payment_posted', 'commission_payment', p_payment_id,
    p_performed_by, (v_payment.total_amount * 100)::bigint,
    'Posted commission payment ' || v_payment.payment_number ||
    ' for $' || to_char(v_payment.total_amount, 'FM999,999,990.00')
  );
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 8: complete_cycle_count()
-- Findings: #25 (no status check), #26 (no FOR UPDATE),
--           #27 (no negative quantity guard)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION complete_cycle_count(
  p_cycle_count_id uuid,
  p_completed_by uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item RECORD;
  v_count record;
  v_new_qty numeric;
BEGIN
  -- FIX #26: Lock the cycle count row FOR UPDATE
  SELECT * INTO v_count
    FROM cycle_counts
   WHERE id = p_cycle_count_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cycle count not found';
  END IF;

  -- FIX #25: Only in_progress counts can be completed
  IF v_count.status != 'in_progress' THEN
    RAISE EXCEPTION 'Cycle count is not in progress (current status: %)', v_count.status;
  END IF;

  -- Process each counted item that has a variance
  FOR v_item IN
    SELECT cci.*, i.quantity_available, i.location
    FROM cycle_count_items cci
    LEFT JOIN inventory i ON i.id = cci.inventory_id
    WHERE cci.cycle_count_id = p_cycle_count_id
      AND cci.is_counted = true
      AND cci.variance IS NOT NULL
      AND cci.variance <> 0
  LOOP
    IF v_item.inventory_id IS NOT NULL THEN
      -- FIX #27: Negative quantity guard — cap at zero
      v_new_qty := GREATEST(0, v_item.quantity_available + v_item.variance);

      IF v_item.quantity_available + v_item.variance < 0 THEN
        RAISE WARNING 'Cycle count adjustment would make inventory negative for product %. Capping at 0 (expected: %, counted: %)',
          v_item.product_id, v_item.expected_qty, v_item.counted_qty;
      END IF;

      UPDATE inventory
      SET quantity_available = v_new_qty,
          last_counted_at = now(),
          updated_at = now()
      WHERE id = v_item.inventory_id;

      -- Audit trail transaction
      INSERT INTO inventory_transactions (
        product_id, transaction_type, quantity,
        to_location, performed_by, notes
      ) VALUES (
        v_item.product_id, 'adjusted', v_item.variance,
        v_item.location, p_completed_by,
        'Cycle count ' || v_count.count_number || ': adjusted from ' ||
        v_item.expected_qty || ' to ' || v_item.counted_qty
      );
    END IF;
  END LOOP;

  -- Update last_counted_at for zero-variance items
  UPDATE inventory
  SET last_counted_at = now(), updated_at = now()
  WHERE id IN (
    SELECT cci.inventory_id FROM cycle_count_items cci
    WHERE cci.cycle_count_id = p_cycle_count_id
      AND cci.is_counted = true
      AND cci.inventory_id IS NOT NULL
  );

  -- Mark cycle count as completed
  UPDATE cycle_counts
  SET status = 'completed',
      completed_by = p_completed_by,
      completed_at = now()
  WHERE id = p_cycle_count_id;
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 9: receive_return()
-- Finding: #28 (marks restocked=true even when no inventory row found,
--          LEFT JOIN can produce duplicates across warehouses)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION receive_return(
  p_return_id uuid,
  p_received_by uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item RECORD;
  v_return_number text;
BEGIN
  -- Get return info (must be in approved status)
  SELECT return_number INTO v_return_number
  FROM returns WHERE id = p_return_id AND status = 'approved';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Return not found or not in approved status';
  END IF;

  -- Process each item that should be restocked
  -- FIX #28b: Use LATERAL to pick exactly one inventory row per item
  -- (prevents duplicate processing when product exists in multiple warehouses)
  FOR v_item IN
    SELECT ri.id AS item_id, ri.product_id, ri.quantity, ri.product_name, ri.condition,
           inv.id AS inv_id, inv.location AS inv_location
    FROM return_items ri
    LEFT JOIN LATERAL (
      SELECT id, location FROM inventory WHERE product_id = ri.product_id LIMIT 1
    ) inv ON true
    WHERE ri.return_id = p_return_id
      AND ri.restock = true
      AND ri.restocked = false
    ORDER BY ri.sort_order
  LOOP
    -- FIX #28a: Only update inventory AND mark restocked when row exists
    IF v_item.inv_id IS NOT NULL THEN
      UPDATE inventory
      SET quantity_available = quantity_available + v_item.quantity,
          updated_at = now()
      WHERE id = v_item.inv_id;

      -- Audit trail
      INSERT INTO inventory_transactions (
        product_id, transaction_type, quantity,
        to_location, performed_by, notes
      ) VALUES (
        v_item.product_id, 'returned', v_item.quantity,
        v_item.inv_location, p_received_by,
        'Return ' || v_return_number || ': ' || v_item.product_name ||
        ' (' || v_item.condition || ')'
      );

      -- Only mark restocked when inventory was actually updated
      UPDATE return_items SET restocked = true WHERE id = v_item.item_id;
    ELSE
      -- No inventory row — log warning, do NOT mark as restocked
      RAISE WARNING 'No inventory row found for product % in return %. Item NOT restocked.',
        v_item.product_id, v_return_number;
    END IF;
  END LOOP;

  -- Update return status
  UPDATE returns
  SET status = 'received',
      received_by = p_received_by,
      received_at = now(),
      updated_at = now()
  WHERE id = p_return_id;
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- SECTION 10: issue_return_credit()
-- Finding: #29 (no check_period_open)
-- Note: Already has financial_audit_log entry.
-- TODO: Future enhancement — create credit invoice for full AR integration.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION issue_return_credit(
  p_return_id uuid,
  p_actor_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total bigint;
BEGIN
  -- FIX #29: Enforce accounting period
  PERFORM check_period_open(CURRENT_DATE);

  -- Calculate total credit from items
  SELECT COALESCE(SUM(extended_cents), 0) INTO v_total
  FROM return_items
  WHERE return_id = p_return_id;

  -- Update return with credit amount and status
  UPDATE returns
  SET status = 'credited',
      total_credit_cents = v_total,
      credited_at = now(),
      updated_at = now()
  WHERE id = p_return_id
    AND status = 'received';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Return not found or not in received status';
  END IF;

  -- Log in financial audit
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id,
    actor_user_id, total_impact_cents, description
  ) VALUES (
    'return_credit_issued', 'return', p_return_id,
    p_actor_id, -v_total,
    'Credit issued for return ' || (SELECT return_number FROM returns WHERE id = p_return_id)
  );

  -- TODO: Create credit invoice (negative total) to properly reduce AR.
  -- Currently, credits only update the return record but don't flow to
  -- the invoice/AR system. Requires business decision on credit memo format.
END;
$$;
