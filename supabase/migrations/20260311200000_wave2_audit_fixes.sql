-- ============================================================================
-- Wave 2 Audit Fixes
-- Migration: 20260311200000_wave2_audit_fixes.sql
-- Date: 2026-03-11
--
-- Fixes:
--   ROLE-1..5,8: Add role checks to SECURITY DEFINER RPCs
--   STATE-1: Return cancel transitions (requested/approved -> cancelled)
--   STATE-2: Quote revert transition (accepted -> sent)
--   STATE-3: Quote status CHECK constraint (add 'cancelled')
--   STATE-4: void_vendor_bill rejects partially_paid bills
--   IDEMP-2..5,8: Add idempotency guards to RPCs
--   SEARCH_PATH: Set search_path on 7 SECURITY DEFINER RPCs
--   STALE: Drop 11 stale function overloads
-- ============================================================================

BEGIN;

-- ============================================================================
-- SECTION 1: Drop stale overloads FIRST (before recreating functions)
-- ============================================================================

DROP FUNCTION IF EXISTS reassign_delivery(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS batch_post_invoices(uuid[]);
DROP FUNCTION IF EXISTS cancel_purchase_order(uuid, uuid);
DROP FUNCTION IF EXISTS batch_adjust_inventory(jsonb, uuid);
DROP FUNCTION IF EXISTS record_inventory_transfer(uuid, uuid, text, text, uuid);
DROP FUNCTION IF EXISTS link_blend_ticket_to_order(uuid, uuid);
DROP FUNCTION IF EXISTS unlink_blend_ticket_from_order(uuid, uuid);
DROP FUNCTION IF EXISTS manual_inventory_add(uuid, text, numeric, text, uuid);
DROP FUNCTION IF EXISTS release_inventory_hold(uuid, uuid);
DROP FUNCTION IF EXISTS record_invoice_payment(uuid, bigint, text, text, text, uuid);
DROP FUNCTION IF EXISTS void_invoice(uuid, text, uuid);


-- ============================================================================
-- SECTION 2: ROLE CHECKS for SECURITY DEFINER RPCs
-- ============================================================================

-- ─── ROLE-1: void_invoice — add admin-only check ───────────────────────────
-- Current signature: void_invoice(uuid, text, text) from sprint1_fix_financial_compliance
CREATE OR REPLACE FUNCTION void_invoice(
  p_invoice_id uuid,
  p_void_reason text,
  p_idempotency_key text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_inv record;
  v_alloc record;
  v_total_allocations_reversed bigint := 0;
  v_total_prepay_restored bigint := 0;
  v_prepay_app record;
BEGIN
  -- Role check (ROLE-1)
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid() AND is_active = true AND role IN ('admin')
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

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

  -- Reverse payment allocations
  FOR v_alloc IN
    SELECT ila.id, ila.allocated_cents, ila.allocation_set_id
    FROM invoice_line_allocations ila
    WHERE ila.invoice_id = p_invoice_id
  LOOP
    v_total_allocations_reversed := v_total_allocations_reversed + v_alloc.allocated_cents;
    DELETE FROM invoice_line_allocations WHERE id = v_alloc.id;
  END LOOP;

  -- Update allocation_sets: recalculate total_allocated_cents
  IF v_total_allocations_reversed > 0 THEN
    UPDATE allocation_sets SET
      total_allocated_cents = (
        SELECT COALESCE(SUM(allocated_cents), 0)
        FROM invoice_line_allocations
        WHERE allocation_set_id = allocation_sets.id
      ),
      updated_at = now()
    WHERE id IN (
      SELECT DISTINCT allocation_set_id FROM invoice_line_allocations
      WHERE invoice_id = p_invoice_id
    );
  END IF;

  -- Restore prepay credits
  FOR v_prepay_app IN
    SELECT pa.id, pa.amount_cents, pa.prepay_credit_id
    FROM prepay_applications pa
    WHERE pa.invoice_id = p_invoice_id
  LOOP
    v_total_prepay_restored := v_total_prepay_restored + v_prepay_app.amount_cents;

    UPDATE prepay_credits SET
      balance_cents = balance_cents + v_prepay_app.amount_cents,
      updated_at = now()
    WHERE id = v_prepay_app.prepay_credit_id;

    DELETE FROM prepay_applications WHERE id = v_prepay_app.id;
  END LOOP;

  IF v_total_prepay_restored > 0 THEN
    UPDATE customers SET
      prepay_balance_cents = COALESCE(prepay_balance_cents, 0) + v_total_prepay_restored,
      updated_at = now()
    WHERE id = v_inv.customer_id;
  END IF;

  -- Void the invoice by zeroing ALL component columns
  UPDATE invoices SET
    status = 'voided',
    voided_by = auth.uid(),
    voided_at = now(),
    void_reason = p_void_reason,
    total_amount_cents = 0,
    paid_amount_cents = 0,
    prepay_applied_cents = 0,
    write_off_cents = 0,
    updated_at = now()
  WHERE id = p_invoice_id;

  -- Audit log
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'invoice_voided', 'invoice', p_invoice_id,
    (SELECT role FROM profiles WHERE id = auth.uid()),
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
    'Voided invoice ' || v_inv.invoice_number || ' — ' || p_void_reason ||
      CASE WHEN v_total_allocations_reversed > 0
        THEN '. Reversed $' || (v_total_allocations_reversed / 100.0)::text || ' in allocations.'
        ELSE '' END ||
      CASE WHEN v_total_prepay_restored > 0
        THEN ' Restored $' || (v_total_prepay_restored / 100.0)::text || ' in prepay credits.'
        ELSE '' END,
    auth.uid(), 'invoice', p_invoice_id, v_inv.customer_id
  );

  -- Notify admin about reversals
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

GRANT EXECUTE ON FUNCTION void_invoice(uuid, text, text) TO authenticated;


-- ─── ROLE-2 + IDEMP-3: void_payment — add admin-only check + idempotency ──
CREATE OR REPLACE FUNCTION public.void_payment(
  p_allocation_set_id uuid,
  p_reason            text,
  p_performed_by      uuid DEFAULT NULL,
  p_idempotency_key   text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_set            record;
  v_alloc          record;
  v_actor          uuid;
  v_reversed_cents bigint := 0;
  v_invoice_count  int := 0;
  v_prepay_reversed bigint := 0;
  v_existing       jsonb;
  v_result         jsonb;
BEGIN
  -- Role check (ROLE-2)
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid() AND is_active = true AND role IN ('admin')
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- Idempotency guard (IDEMP-3)
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'void_payment');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

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

  v_result := jsonb_build_object(
    'success', true,
    'allocation_set_id', p_allocation_set_id,
    'reversed_cents', v_reversed_cents,
    'invoices_affected', v_invoice_count,
    'prepay_reversed_cents', COALESCE(v_prepay_reversed, 0)
  );

  -- Save idempotency (IDEMP-3)
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'void_payment', v_result);
  END IF;

  RETURN v_result;
END;
$$;

-- Drop old 3-param overload, grant on new 4-param
DROP FUNCTION IF EXISTS public.void_payment(uuid, text, uuid);
GRANT EXECUTE ON FUNCTION public.void_payment(uuid, text, uuid, text) TO authenticated;


-- ─── ROLE-3: record_invoice_payment — add admin + sales_rep check ──────────
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
SET search_path = public, extensions
AS $$
DECLARE
  v_inv    record;
  v_pay_id uuid;
BEGIN
  -- Role check (ROLE-3)
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

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


-- ─── ROLE-4: create_vendor_bill — add admin-only check ─────────────────────
CREATE OR REPLACE FUNCTION create_vendor_bill(
  p_vendor_id uuid,
  p_purchase_order_id uuid DEFAULT NULL,
  p_bill_number text DEFAULT '',
  p_bill_date date DEFAULT CURRENT_DATE,
  p_due_date date DEFAULT NULL,
  p_payment_terms text DEFAULT NULL,
  p_subtotal_cents bigint DEFAULT 0,
  p_adjustment_cents bigint DEFAULT 0,
  p_notes text DEFAULT NULL,
  p_created_by uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_total bigint;
  v_bill_id uuid;
  v_terms_days integer;
  v_terms text;
BEGIN
  -- Role check (ROLE-4)
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid() AND is_active = true AND role IN ('admin')
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- Get vendor default terms if not provided
  IF p_payment_terms IS NULL THEN
    SELECT default_payment_terms, default_payment_terms_days
    INTO v_terms, v_terms_days
    FROM vendors WHERE id = p_vendor_id;
  ELSE
    v_terms := p_payment_terms;
    v_terms_days := CASE
      WHEN p_payment_terms ILIKE '%90%' THEN 90
      WHEN p_payment_terms ILIKE '%60%' THEN 60
      WHEN p_payment_terms ILIKE '%45%' THEN 45
      WHEN p_payment_terms ILIKE '%30%' THEN 30
      WHEN p_payment_terms ILIKE '%15%' THEN 15
      WHEN p_payment_terms ILIKE '%10%' THEN 10
      ELSE 30
    END;
  END IF;

  v_total := p_subtotal_cents + COALESCE(p_adjustment_cents, 0);

  INSERT INTO vendor_bills (
    vendor_id, purchase_order_id, bill_number, bill_date,
    due_date, payment_terms, subtotal_cents, adjustment_cents,
    total_cents, paid_cents, balance_cents, status, notes, created_by
  ) VALUES (
    p_vendor_id,
    p_purchase_order_id,
    p_bill_number,
    p_bill_date,
    COALESCE(p_due_date, p_bill_date + (COALESCE(v_terms_days, 30) || ' days')::interval),
    v_terms,
    p_subtotal_cents,
    COALESCE(p_adjustment_cents, 0),
    v_total,
    0,
    v_total,
    'unpaid',
    p_notes,
    COALESCE(p_created_by, auth.uid())
  ) RETURNING id INTO v_bill_id;

  RETURN v_bill_id;
END;
$$;

GRANT EXECUTE ON FUNCTION create_vendor_bill(uuid, uuid, text, date, date, text, bigint, bigint, text, uuid) TO authenticated;


-- ─── ROLE-5: record_vendor_payment — add admin-only check ──────────────────
CREATE OR REPLACE FUNCTION record_vendor_payment(
  p_vendor_bill_id uuid,
  p_amount_cents bigint,
  p_payment_date date DEFAULT CURRENT_DATE,
  p_payment_method text DEFAULT NULL,
  p_reference_number text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_created_by uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_payment_id uuid;
  v_current_balance bigint;
  v_new_paid bigint;
  v_new_balance bigint;
  v_new_status text;
  v_total bigint;
BEGIN
  -- Role check (ROLE-5)
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid() AND is_active = true AND role IN ('admin')
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- Lock the bill row
  SELECT balance_cents, paid_cents, total_cents
  INTO v_current_balance, v_new_paid, v_total
  FROM vendor_bills
  WHERE id = p_vendor_bill_id
  FOR UPDATE;

  IF v_current_balance IS NULL THEN
    RAISE EXCEPTION 'Vendor bill not found';
  END IF;

  IF p_amount_cents > v_current_balance THEN
    RAISE EXCEPTION 'Payment amount (%) exceeds balance (%)', p_amount_cents, v_current_balance;
  END IF;

  IF p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'Payment amount must be positive';
  END IF;

  -- Insert payment
  INSERT INTO vendor_payments (
    vendor_bill_id, payment_date, amount_cents,
    payment_method, reference_number, notes, created_by
  ) VALUES (
    p_vendor_bill_id, p_payment_date, p_amount_cents,
    p_payment_method, p_reference_number, p_notes,
    COALESCE(p_created_by, auth.uid())
  ) RETURNING id INTO v_payment_id;

  -- Update bill
  v_new_paid := v_new_paid + p_amount_cents;
  v_new_balance := v_total - v_new_paid;
  v_new_status := CASE
    WHEN v_new_balance <= 0 THEN 'paid'
    WHEN v_new_paid > 0 THEN 'partially_paid'
    ELSE 'unpaid'
  END;

  UPDATE vendor_bills
  SET paid_cents = v_new_paid,
      balance_cents = v_new_balance,
      status = v_new_status,
      updated_at = now()
  WHERE id = p_vendor_bill_id;

  RETURN v_payment_id;
END;
$$;

GRANT EXECUTE ON FUNCTION record_vendor_payment(uuid, bigint, date, text, text, text, uuid) TO authenticated;


-- ─── ROLE-8: operational_dashboard_summary — add admin + sales_rep check ────
CREATE OR REPLACE FUNCTION public.operational_dashboard_summary()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  result       jsonb;
  _season_start date;
  _season_end   date;
BEGIN
  -- Role check (ROLE-8)
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- Calculate season boundaries (Oct 1 – Sep 30)
  IF EXTRACT(MONTH FROM CURRENT_DATE) >= 10 THEN
    _season_start := MAKE_DATE(EXTRACT(YEAR FROM CURRENT_DATE)::int, 10, 1);
    _season_end   := MAKE_DATE(EXTRACT(YEAR FROM CURRENT_DATE)::int + 1, 9, 30);
  ELSE
    _season_start := MAKE_DATE(EXTRACT(YEAR FROM CURRENT_DATE)::int - 1, 10, 1);
    _season_end   := MAKE_DATE(EXTRACT(YEAR FROM CURRENT_DATE)::int, 9, 30);
  END IF;

  WITH
  active_orders AS (
    SELECT COUNT(*) AS cnt
    FROM orders
    WHERE status IN ('confirmed', 'partially_fulfilled')
      AND deleted_at IS NULL
  ),
  open_quotes AS (
    SELECT
      COUNT(*) FILTER (WHERE status = 'draft') AS draft_cnt,
      COUNT(*) FILTER (WHERE status = 'sent')  AS sent_cnt
    FROM quotes
  ),
  pending_deliveries AS (
    SELECT COUNT(*) AS cnt
    FROM deliveries
    WHERE status IN ('scheduled', 'in_progress')
  ),
  open_pos AS (
    SELECT COUNT(*) AS cnt
    FROM purchase_orders
    WHERE status IN ('submitted', 'partially_received')
  ),
  inv_agg AS (
    SELECT
      COALESCE(SUM(quantity_available), 0) AS total_available,
      COALESCE(SUM(quantity_prebooked), 0) AS total_prebooked
    FROM inventory
  ),
  on_order_units AS (
    SELECT
      COALESCE(SUM(poi.quantity_ordered - COALESCE(poi.quantity_received, 0)), 0) AS units,
      COUNT(DISTINCT po.id) AS po_count
    FROM purchase_order_items poi
    JOIN purchase_orders po ON po.id = poi.purchase_order_id
    WHERE po.status IN ('submitted', 'partially_received')
  ),
  committed_units AS (
    SELECT
      COALESCE(SUM(oi.quantity_remaining), 0) AS units,
      COUNT(DISTINCT o.id) AS order_count
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.status IN ('confirmed', 'partially_fulfilled')
      AND o.deleted_at IS NULL
      AND oi.quantity_remaining > 0
  ),
  upcoming AS (
    SELECT jsonb_agg(row_to_json(ud)::jsonb ORDER BY ud.scheduled_date ASC) AS arr
    FROM (
      SELECT
        d.id,
        d.delivery_number,
        d.scheduled_date::text AS scheduled_date,
        d.status,
        cust.farm_name AS customer_name,
        drv.full_name  AS driver_name,
        d.assigned_driver
      FROM deliveries d
      LEFT JOIN customers cust ON cust.id = d.customer_id
      LEFT JOIN profiles  drv  ON drv.id  = d.assigned_driver
      WHERE d.status IN ('scheduled', 'in_progress')
      ORDER BY d.scheduled_date ASC
      LIMIT 10
    ) ud
  ),
  delivery_stats AS (
    SELECT
      COUNT(*) FILTER (WHERE d.scheduled_date = CURRENT_DATE)                                AS today_count,
      COUNT(*) FILTER (WHERE d.scheduled_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 6)     AS this_week_count,
      COUNT(*) FILTER (WHERE d.assigned_driver IS NULL)                                       AS unassigned_count
    FROM deliveries d
    WHERE d.status IN ('scheduled', 'in_progress')
  ),
  remainder_count AS (
    SELECT COUNT(*) AS cnt
    FROM delivery_remainders
    WHERE status = 'pending'
  ),
  quote_pipeline AS (
    SELECT
      COUNT(*) FILTER (WHERE status = 'draft')    AS draft_cnt,
      COUNT(*) FILTER (WHERE status = 'sent')     AS sent_cnt,
      COUNT(*) FILTER (WHERE status = 'accepted') AS accepted_cnt
    FROM quotes
  ),
  orders_ytd AS (
    SELECT
      COUNT(*) AS season_total,
      COUNT(*) FILTER (
        WHERE DATE_TRUNC('month', COALESCE(order_date, created_at::date)) = DATE_TRUNC('month', CURRENT_DATE)
      ) AS this_month
    FROM orders
    WHERE COALESCE(order_date, created_at::date) >= _season_start
      AND deleted_at IS NULL
  ),
  deliveries_completed AS (
    SELECT
      COUNT(*) AS season_total,
      COUNT(*) FILTER (
        WHERE DATE_TRUNC('month', completed_at) = DATE_TRUNC('month', CURRENT_DATE)
      ) AS this_month
    FROM deliveries
    WHERE status = 'completed'
      AND completed_at >= _season_start
  ),
  low_stock AS (
    SELECT COUNT(*) AS cnt
    FROM inventory
    WHERE reorder_point > 0
      AND quantity_available <= reorder_point
  ),
  driver_issues AS (
    SELECT COUNT(*) AS cnt
    FROM deliveries
    WHERE issue_type IS NOT NULL
      AND status = 'completed'
  ),
  expired_holds AS (
    SELECT COUNT(DISTINCT q.id) AS cnt
    FROM quotes q
    JOIN inventory_holds ih ON ih.source_id = q.id AND ih.is_active = true
    WHERE q.status IN ('expired', 'declined')
  ),
  cancelled_posted AS (
    SELECT COUNT(DISTINCT d.id) AS cnt
    FROM deliveries d
    JOIN orders o ON o.id = d.order_id
    JOIN invoices i ON i.order_id = o.id
    WHERE d.status = 'cancelled'
      AND i.status = 'posted'
  ),
  expiring_quotes AS (
    SELECT COUNT(*) AS cnt
    FROM quotes
    WHERE status IN ('draft', 'sent')
      AND expires_at IS NOT NULL
      AND expires_at BETWEEN CURRENT_DATE AND CURRENT_DATE + 3
  ),
  overdue_deliveries AS (
    SELECT COUNT(*) AS cnt
    FROM deliveries
    WHERE scheduled_date < CURRENT_DATE
      AND status IN ('scheduled', 'in_progress')
  ),
  pos_expected_today AS (
    SELECT COUNT(*) AS cnt
    FROM purchase_orders
    WHERE expected_delivery_date = CURRENT_DATE
      AND status IN ('submitted', 'partially_received')
  ),
  expiring_licenses AS (
    SELECT COUNT(*) AS cnt
    FROM applicator_licenses
    WHERE is_active = true
      AND expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30
  ),
  monthly_activity AS (
    SELECT jsonb_agg(row_to_json(ma)::jsonb ORDER BY ma.month) AS arr
    FROM (
      SELECT
        m.month,
        COALESCE(oc.cnt, 0) AS orders_created,
        COALESCE(dc.cnt, 0) AS deliveries_completed,
        COALESCE(pr.cnt, 0) AS pos_received
      FROM (
        SELECT TO_CHAR(d, 'YYYY-MM') AS month
        FROM generate_series(
          DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '11 months',
          DATE_TRUNC('month', CURRENT_DATE),
          '1 month'::interval
        ) d
      ) m
      LEFT JOIN (
        SELECT TO_CHAR(COALESCE(order_date, created_at::date), 'YYYY-MM') AS month, COUNT(*) AS cnt
        FROM orders WHERE deleted_at IS NULL GROUP BY 1
      ) oc ON oc.month = m.month
      LEFT JOIN (
        SELECT TO_CHAR(completed_at, 'YYYY-MM') AS month, COUNT(*) AS cnt
        FROM deliveries WHERE status = 'completed' AND completed_at IS NOT NULL GROUP BY 1
      ) dc ON dc.month = m.month
      LEFT JOIN (
        SELECT TO_CHAR(received_at, 'YYYY-MM') AS month, COUNT(*) AS cnt
        FROM receiving_records GROUP BY 1
      ) pr ON pr.month = m.month
      ORDER BY m.month
    ) ma
  ),
  period_info AS (
    SELECT
      COALESCE(TO_CHAR(period_start, 'Mon YYYY'), TO_CHAR(NOW(), 'Mon YYYY')) AS name,
      COALESCE(status, 'open') AS status,
      CASE
        WHEN period_end IS NOT NULL
          THEN GREATEST(EXTRACT(DAY FROM period_end - NOW())::int, 0)
        ELSE EXTRACT(DAY FROM (DATE_TRUNC('month', NOW()) + INTERVAL '1 month' - INTERVAL '1 day') - NOW())::int
      END AS days_remaining
    FROM accounting_periods
    WHERE status = 'open'
    ORDER BY period_start DESC
    LIMIT 1
  ),
  activity AS (
    SELECT jsonb_agg(row_to_json(af)::jsonb ORDER BY af.created_at DESC) AS arr
    FROM (
      SELECT id, event_type, description, created_at
      FROM activity_feed
      ORDER BY created_at DESC
      LIMIT 15
    ) af
  ),
  team_action_items AS (
    SELECT jsonb_agg(row_to_json(ti)::jsonb) AS arr
    FROM (
      SELECT
        tn.id,
        tn.title,
        tn.priority,
        tn.due_date::text AS due_date,
        tn.note_type,
        tn.is_pinned,
        tn.assigned_to,
        p.full_name AS assignee_name
      FROM team_notes tn
      LEFT JOIN profiles p ON p.id = tn.assigned_to
      WHERE tn.is_completed = false
        AND tn.deleted_at IS NULL
        AND (
          tn.is_pinned = true
          OR tn.priority IN ('urgent', 'high')
          OR (tn.due_date IS NOT NULL AND tn.due_date < CURRENT_DATE)
          OR tn.assigned_to = auth.uid()
        )
      ORDER BY
        CASE WHEN tn.is_pinned THEN 0 ELSE 1 END,
        CASE tn.priority
          WHEN 'urgent' THEN 0
          WHEN 'high'   THEN 1
          WHEN 'medium' THEN 2
          ELSE 3
        END,
        tn.due_date NULLS LAST
      LIMIT 10
    ) ti
  )

  SELECT jsonb_build_object(
    'active_orders_count',        ao.cnt,
    'open_quotes_draft',          oq.draft_cnt,
    'open_quotes_sent',           oq.sent_cnt,
    'pending_deliveries_count',   pd.cnt,
    'open_pos_count',             op.cnt,
    'team_action_items',          COALESCE(tai.arr, '[]'::jsonb),
    'inventory_available',        ia.total_available,
    'inventory_prebooked',        ia.total_prebooked,
    'on_order_units',             oou.units,
    'on_order_po_count',          oou.po_count,
    'committed_units',            cu.units,
    'committed_order_count',      cu.order_count,
    'upcoming_deliveries',        COALESCE(ud.arr, '[]'::jsonb),
    'delivery_today',             ds.today_count,
    'delivery_this_week',         ds.this_week_count,
    'delivery_unassigned',        ds.unassigned_count,
    'delivery_remainders_count',  rc.cnt,
    'quote_pipeline_draft',       qp.draft_cnt,
    'quote_pipeline_sent',        qp.sent_cnt,
    'quote_pipeline_accepted',    qp.accepted_cnt,
    'orders_ytd_total',           oytd.season_total,
    'orders_this_month',          oytd.this_month,
    'deliveries_completed_total', dcomp.season_total,
    'deliveries_completed_this_month', dcomp.this_month,
    'low_stock_count',            ls.cnt,
    'driver_issues_count',        di.cnt,
    'expired_holds_count',        eh.cnt,
    'cancelled_posted_count',     cp.cnt,
    'expiring_quotes_count',      eq.cnt,
    'overdue_deliveries_count',   od.cnt,
    'pos_expected_today_count',   pet.cnt,
    'expiring_licenses_count',    el.cnt,
    'monthly_activity',           COALESCE(mact.arr, '[]'::jsonb),
    'season_label',               CASE WHEN EXTRACT(MONTH FROM CURRENT_DATE) >= 10
                                    THEN EXTRACT(YEAR FROM CURRENT_DATE)::int || '-' || (EXTRACT(YEAR FROM CURRENT_DATE)::int + 1)
                                    ELSE (EXTRACT(YEAR FROM CURRENT_DATE)::int - 1) || '-' || EXTRACT(YEAR FROM CURRENT_DATE)::int
                                  END,
    'season_days_remaining',      (_season_end - CURRENT_DATE),
    'season_days_elapsed',        (CURRENT_DATE - _season_start),
    'period_name',                COALESCE(pi.name, TO_CHAR(NOW(), 'Mon YYYY')),
    'period_status',              COALESCE(pi.status, 'open'),
    'period_days_remaining',      COALESCE(pi.days_remaining, 0),
    'recent_activity',            COALESCE(act.arr, '[]'::jsonb)
  ) INTO result
  FROM active_orders       ao
  CROSS JOIN open_quotes        oq
  CROSS JOIN pending_deliveries pd
  CROSS JOIN open_pos           op
  CROSS JOIN inv_agg            ia
  CROSS JOIN on_order_units     oou
  CROSS JOIN committed_units    cu
  CROSS JOIN upcoming           ud
  CROSS JOIN delivery_stats     ds
  CROSS JOIN remainder_count    rc
  CROSS JOIN quote_pipeline     qp
  CROSS JOIN orders_ytd         oytd
  CROSS JOIN deliveries_completed dcomp
  CROSS JOIN low_stock          ls
  CROSS JOIN driver_issues      di
  CROSS JOIN expired_holds      eh
  CROSS JOIN cancelled_posted   cp
  CROSS JOIN expiring_quotes    eq
  CROSS JOIN overdue_deliveries od
  CROSS JOIN pos_expected_today pet
  CROSS JOIN expiring_licenses  el
  CROSS JOIN monthly_activity   mact
  CROSS JOIN activity           act
  CROSS JOIN team_action_items  tai
  LEFT JOIN  period_info        pi ON true;

  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.operational_dashboard_summary() TO authenticated;


-- ============================================================================
-- SECTION 3: STATE MACHINE TRIGGER FIXES
-- ============================================================================

-- ─── STATE-1: Return cancel transitions ────────────────────────────────────
-- Allow cancelled from requested and approved
CREATE OR REPLACE FUNCTION _enforce_return_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF _is_admin_override() THEN RETURN NEW; END IF;

  IF (OLD.status = 'requested' AND NEW.status IN ('approved', 'rejected', 'cancelled'))
  OR (OLD.status = 'approved' AND NEW.status IN ('received', 'cancelled'))
  OR (OLD.status = 'received' AND NEW.status = 'credited')
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Invalid return status transition: % → %', OLD.status, NEW.status;
END;
$$;


-- ─── STATE-2: Quote revert transition (accepted -> sent) ───────────────────
-- Allow accepted -> sent for failed order conversion rollback
CREATE OR REPLACE FUNCTION _enforce_quote_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF _is_admin_override() THEN RETURN NEW; END IF;

  IF (OLD.status = 'draft' AND NEW.status IN ('sent', 'cancelled'))
  OR (OLD.status = 'sent' AND NEW.status IN ('revised', 'accepted', 'declined', 'expired', 'cancelled'))
  OR (OLD.status = 'revised' AND NEW.status IN ('sent', 'accepted', 'declined', 'expired', 'cancelled'))
  OR (OLD.status = 'accepted' AND NEW.status = 'sent')
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Invalid quote status transition: % → %', OLD.status, NEW.status;
END;
$$;


-- ─── STATE-3: Quote CHECK constraint — add 'cancelled' ────────────────────
ALTER TABLE quotes DROP CONSTRAINT IF EXISTS quotes_status_check;
ALTER TABLE quotes ADD CONSTRAINT quotes_status_check
  CHECK (status IN ('draft', 'sent', 'revised', 'accepted', 'declined', 'expired', 'cancelled'));


-- ============================================================================
-- SECTION 4: VENDOR BILL VOID FIX (STATE-4)
-- ============================================================================

-- Reject voiding partially_paid bills — must reverse payments first
CREATE OR REPLACE FUNCTION void_vendor_bill(
  p_vendor_bill_id uuid,
  p_reason text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_current_status text;
BEGIN
  -- Get current status
  SELECT status INTO v_current_status
  FROM vendor_bills
  WHERE id = p_vendor_bill_id;

  IF v_current_status IS NULL THEN
    RAISE EXCEPTION 'Vendor bill not found';
  END IF;

  IF v_current_status = 'voided' THEN
    RAISE EXCEPTION 'Bill not found or already voided';
  END IF;

  -- STATE-4: Block voiding partially_paid bills
  IF v_current_status = 'partially_paid' THEN
    RAISE EXCEPTION 'Cannot void a partially paid bill. Reverse payments first.';
  END IF;

  UPDATE vendor_bills
  SET status = 'voided',
      notes = COALESCE(notes || E'\n', '') || 'VOIDED: ' || COALESCE(p_reason, 'No reason provided'),
      updated_at = now()
  WHERE id = p_vendor_bill_id
    AND status <> 'voided';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bill not found or already voided';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION void_vendor_bill(uuid, text) TO authenticated;


-- ============================================================================
-- SECTION 5: IDEMPOTENCY ADDITIONS
-- ============================================================================

-- ─── IDEMP-2: create_invoice_from_order — add idempotency ──────────────────
CREATE OR REPLACE FUNCTION create_invoice_from_order(
  p_order_id     uuid,
  p_salesman_id  uuid DEFAULT NULL,
  p_invoice_type text DEFAULT 'chemical_sale',
  p_idempotency_key text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_order       record;
  v_invoice_id  uuid;
  v_item        record;
  v_total_cents bigint := 0;
  v_existing    jsonb;
BEGIN
  -- Idempotency guard (IDEMP-2)
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'create_invoice_from_order');
    IF v_existing IS NOT NULL THEN RETURN (v_existing->>'invoice_id')::uuid; END IF;
  END IF;

  -- Get order
  SELECT * INTO v_order FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found: %', p_order_id;
  END IF;

  -- Create invoice
  INSERT INTO invoices (
    order_id, customer_id, invoice_type, status, season,
    salesman_id, created_by, total_amount_cents, invoice_date
  ) VALUES (
    p_order_id, v_order.customer_id, p_invoice_type, 'draft',
    COALESCE(v_order.season, (SELECT current_season())),
    COALESCE(p_salesman_id, v_order.salesman_id),
    (SELECT auth.uid()), 0, CURRENT_DATE
  )
  RETURNING id INTO v_invoice_id;

  -- Copy order items to invoice items
  FOR v_item IN
    SELECT * FROM order_items WHERE order_id = p_order_id ORDER BY sort_order NULLS LAST, id
  LOOP
    INSERT INTO invoice_items (
      invoice_id, order_item_id, product_id, description,
      quantity, unit_price_cents, extended_cents, cost_cents,
      sort_order, rate_per_acre, acres, unit_size
    ) VALUES (
      v_invoice_id, v_item.id, v_item.product_id,
      COALESCE(v_item.product_name, ''),
      v_item.total_units_needed,
      round(v_item.price_per_unit * 100)::bigint,
      round(v_item.total_price * 100)::bigint,
      round(v_item.cost_per_unit * 100)::bigint,
      COALESCE(v_item.sort_order, 0),
      v_item.actual_rate,
      v_item.acres,
      v_item.unit_size
    );
    v_total_cents := v_total_cents + round(v_item.total_price * 100)::bigint;
  END LOOP;

  -- Update invoice total
  UPDATE invoices SET total_amount_cents = v_total_cents WHERE id = v_invoice_id;

  -- Audit log
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'invoice_created', 'invoice', v_invoice_id,
    (SELECT role FROM profiles WHERE id = (SELECT auth.uid())),
    jsonb_build_object(
      'invoice_number', (SELECT invoice_number FROM invoices WHERE id = v_invoice_id),
      'order_number', v_order.order_number,
      'customer_id', v_order.customer_id,
      'total_cents', v_total_cents
    ),
    v_total_cents,
    'Invoice created from order ' || v_order.order_number
  );

  -- Activity feed
  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_created',
    'Invoice created from order ' || v_order.order_number,
    (SELECT auth.uid()), 'invoice', v_invoice_id, v_order.customer_id
  );

  -- Save idempotency (IDEMP-2)
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_invoice_from_order', jsonb_build_object('invoice_id', v_invoice_id));
  END IF;

  RETURN v_invoice_id;
END;
$$;

-- Drop old overloads and grant on new signature
DROP FUNCTION IF EXISTS create_invoice_from_order(uuid, uuid, text);
GRANT EXECUTE ON FUNCTION create_invoice_from_order(uuid, uuid, text, text) TO authenticated;


-- ─── IDEMP-4: manual_inventory_add — add idempotency ───────────────────────
CREATE OR REPLACE FUNCTION manual_inventory_add(
  p_product_id      uuid,
  p_location        text,
  p_quantity        numeric,
  p_unit_size       text    DEFAULT NULL,
  p_performed_by    uuid    DEFAULT NULL,
  p_notes           text    DEFAULT NULL,
  p_unit_cost       numeric DEFAULT NULL,
  p_idempotency_key text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_actor    uuid;
  v_existing record;
  v_product  record;
  v_note     text;
  v_idemp_existing jsonb;
  v_result   jsonb;
BEGIN
  -- Idempotency guard (IDEMP-4)
  IF p_idempotency_key IS NOT NULL THEN
    v_idemp_existing := check_idempotency(p_idempotency_key, 'manual_inventory_add');
    IF v_idemp_existing IS NOT NULL THEN RETURN v_idemp_existing; END IF;
  END IF;

  v_actor := COALESCE(p_performed_by, auth.uid());

  -- Verify admin or sales_rep
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- Check for existing record
  SELECT * INTO v_existing
  FROM inventory WHERE product_id = p_product_id AND location = COALESCE(p_location, 'Main Warehouse');

  IF FOUND THEN
    RAISE EXCEPTION 'Inventory record already exists for this product at this location. Use Receive or Adjust instead.';
  END IF;

  -- Get product for unit_size fallback
  SELECT * INTO v_product FROM products WHERE id = p_product_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product not found';
  END IF;

  -- Insert inventory record
  INSERT INTO inventory (product_id, location, quantity_available, unit_size)
  VALUES (
    p_product_id,
    COALESCE(p_location, 'Main Warehouse'),
    GREATEST(p_quantity, 0),
    COALESCE(p_unit_size, v_product.unit_size)
  );

  -- Build the transaction note with cost info for audit trail
  v_note := COALESCE(p_notes, 'Initial inventory record created with ' || p_quantity || ' units');
  IF p_unit_cost IS NOT NULL AND p_unit_cost > 0 THEN
    v_note := v_note || ' (purchased @ $' || TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM p_unit_cost::text)) || '/unit)';
  END IF;

  -- Create audit trail (in same transaction)
  IF p_quantity > 0 THEN
    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity,
      to_location, performed_by, notes
    ) VALUES (
      p_product_id, 'adjusted', p_quantity,
      COALESCE(p_location, 'Main Warehouse'), v_actor,
      v_note
    );
  END IF;

  v_result := jsonb_build_object('success', true);

  -- Save idempotency (IDEMP-4)
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'manual_inventory_add', v_result);
  END IF;

  RETURN v_result;
END;
$$;

-- Drop old overload and grant on new signature
DROP FUNCTION IF EXISTS manual_inventory_add(uuid, text, numeric, text, uuid, text, numeric);
GRANT EXECUTE ON FUNCTION manual_inventory_add(uuid, text, numeric, text, uuid, text, numeric, text) TO authenticated;


-- ─── IDEMP-5: release_inventory_hold — add idempotency ─────────────────────
CREATE OR REPLACE FUNCTION release_inventory_hold(
  p_hold_id uuid,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_actor uuid;
  v_hold record;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  -- Idempotency guard (IDEMP-5)
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'release_inventory_hold');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  v_actor := COALESCE(p_performed_by, auth.uid());

  -- Verify caller is admin
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND is_active = true AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Only admins can release inventory holds';
  END IF;

  SELECT * INTO v_hold FROM inventory_holds WHERE id = p_hold_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory hold not found';
  END IF;

  IF NOT v_hold.is_active THEN
    RETURN jsonb_build_object('status', 'already_released');
  END IF;

  UPDATE inventory_holds SET is_active = false WHERE id = p_hold_id;

  -- Audit trail
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id
  ) VALUES (
    'inventory_hold_released',
    'Inventory hold released for product ' || v_hold.product_id::text,
    v_actor, 'inventory_hold', p_hold_id
  );

  v_result := jsonb_build_object('status', 'released', 'hold_id', p_hold_id);

  -- Save idempotency (IDEMP-5)
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'release_inventory_hold', v_result);
  END IF;

  RETURN v_result;
END;
$$;

-- Drop old overload and grant on new signature
DROP FUNCTION IF EXISTS release_inventory_hold(uuid, uuid);
GRANT EXECUTE ON FUNCTION release_inventory_hold(uuid, uuid, text) TO authenticated;


-- ─── IDEMP-8a: edit_prepay_credit — add idempotency ────────────────────────
CREATE OR REPLACE FUNCTION public.edit_prepay_credit(
  p_credit_id        uuid,
  p_new_balance_cents bigint    DEFAULT NULL,
  p_reference_number  text      DEFAULT NULL,
  p_bucket_label      text      DEFAULT NULL,
  p_notes             text      DEFAULT NULL,
  p_performed_by      uuid      DEFAULT NULL,
  p_idempotency_key   text      DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_credit       record;
  v_old_balance  bigint;
  v_delta        bigint;
  v_actor        uuid;
  v_existing     jsonb;
  v_result       jsonb;
BEGIN
  -- Idempotency guard (IDEMP-8a)
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'edit_prepay_credit');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  v_actor := COALESCE(p_performed_by, auth.uid());

  -- Lock and fetch the credit
  SELECT * INTO v_credit
  FROM prepay_credits
  WHERE id = p_credit_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Prepay credit not found: %', p_credit_id;
  END IF;

  v_old_balance := v_credit.balance_cents;

  -- Update fields that were provided
  UPDATE prepay_credits SET
    balance_cents    = COALESCE(p_new_balance_cents, balance_cents),
    original_amount_cents = CASE
      WHEN p_new_balance_cents IS NOT NULL THEN p_new_balance_cents
      ELSE original_amount_cents
    END,
    reference_number = COALESCE(p_reference_number, reference_number),
    bucket_label     = COALESCE(p_bucket_label, bucket_label),
    notes            = COALESCE(p_notes, notes),
    updated_at       = now()
  WHERE id = p_credit_id;

  -- Update customer aggregate if balance changed
  IF p_new_balance_cents IS NOT NULL AND p_new_balance_cents != v_old_balance THEN
    v_delta := p_new_balance_cents - v_old_balance;

    UPDATE customers
    SET prepay_balance_cents = GREATEST(prepay_balance_cents + v_delta, 0)
    WHERE id = v_credit.customer_id;
  END IF;

  -- Audit log
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id,
    actor_user_id, old_values, new_values,
    total_impact_cents, description
  ) VALUES (
    'prepay_edited', 'prepay', p_credit_id,
    v_actor,
    jsonb_build_object(
      'balance_cents', v_old_balance,
      'reference_number', v_credit.reference_number,
      'bucket_label', v_credit.bucket_label
    ),
    jsonb_build_object(
      'balance_cents', COALESCE(p_new_balance_cents, v_old_balance),
      'reference_number', COALESCE(p_reference_number, v_credit.reference_number),
      'bucket_label', COALESCE(p_bucket_label, v_credit.bucket_label)
    ),
    COALESCE(p_new_balance_cents - v_old_balance, 0),
    'Edited prepay credit ' || COALESCE(v_credit.reference_number, v_credit.id::text)
  );

  v_result := jsonb_build_object(
    'success', true,
    'credit_id', p_credit_id,
    'old_balance_cents', v_old_balance,
    'new_balance_cents', COALESCE(p_new_balance_cents, v_old_balance)
  );

  -- Save idempotency (IDEMP-8a)
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'edit_prepay_credit', v_result);
  END IF;

  RETURN v_result;
END;
$$;

-- Drop old overload and grant on new signature
DROP FUNCTION IF EXISTS public.edit_prepay_credit(uuid, bigint, text, text, text, uuid);
GRANT EXECUTE ON FUNCTION public.edit_prepay_credit(uuid, bigint, text, text, text, uuid, text) TO authenticated;


-- ─── IDEMP-8b: delete_prepay_credit — add idempotency ─────────────────────
CREATE OR REPLACE FUNCTION public.delete_prepay_credit(
  p_credit_id    uuid,
  p_reason       text,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_credit      record;
  v_old_balance bigint;
  v_actor       uuid;
  v_existing    jsonb;
  v_result      jsonb;
BEGIN
  -- Idempotency guard (IDEMP-8b)
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'delete_prepay_credit');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  v_actor := COALESCE(p_performed_by, auth.uid());

  -- Lock and fetch
  SELECT * INTO v_credit
  FROM prepay_credits
  WHERE id = p_credit_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Prepay credit not found: %', p_credit_id;
  END IF;

  v_old_balance := v_credit.balance_cents;

  IF v_old_balance = 0 THEN
    RAISE EXCEPTION 'Prepay credit already has zero balance';
  END IF;

  -- Zero out the credit balance
  UPDATE prepay_credits
  SET balance_cents = 0,
      notes = COALESCE(notes, '') || ' [DELETED: ' || p_reason || ']',
      updated_at = now()
  WHERE id = p_credit_id;

  -- Decrement customer aggregate
  UPDATE customers
  SET prepay_balance_cents = GREATEST(prepay_balance_cents - v_old_balance, 0)
  WHERE id = v_credit.customer_id;

  -- Audit log
  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id,
    actor_user_id, old_values, new_values,
    total_impact_cents, description
  ) VALUES (
    'prepay_deleted', 'prepay', p_credit_id,
    v_actor,
    jsonb_build_object(
      'balance_cents', v_old_balance,
      'reference_number', v_credit.reference_number,
      'bucket_label', v_credit.bucket_label
    ),
    jsonb_build_object('balance_cents', 0, 'reason', p_reason),
    -1 * v_old_balance,
    'Deleted prepay credit ' || COALESCE(v_credit.reference_number, v_credit.id::text) || ' — ' || p_reason
  );

  v_result := jsonb_build_object(
    'success', true,
    'credit_id', p_credit_id,
    'deleted_balance_cents', v_old_balance
  );

  -- Save idempotency (IDEMP-8b)
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'delete_prepay_credit', v_result);
  END IF;

  RETURN v_result;
END;
$$;

-- Drop old overload and grant on new signature
DROP FUNCTION IF EXISTS public.delete_prepay_credit(uuid, text, uuid);
GRANT EXECUTE ON FUNCTION public.delete_prepay_credit(uuid, text, uuid, text) TO authenticated;


-- ============================================================================
-- SECTION 6: SET search_path on SECURITY DEFINER RPCs (ALTER only)
-- ============================================================================
-- For functions NOT fully recreated above, use ALTER to add search_path.
-- Functions already recreated above have search_path set inline.

-- batch_post_invoices: was dynamically modified by 20260306200000, may have
-- various signatures. Use the one with idempotency key.
DO $$
DECLARE
  v_oid oid;
BEGIN
  -- Find the batch_post_invoices function (should be only one after stale drop)
  SELECT p.oid INTO v_oid
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE p.proname = 'batch_post_invoices' AND n.nspname = 'public'
  ORDER BY p.oid DESC LIMIT 1;
  IF v_oid IS NOT NULL THEN
    EXECUTE 'ALTER FUNCTION public.batch_post_invoices(' ||
      pg_get_function_identity_arguments(v_oid) ||
      ') SET search_path = public, extensions';
  END IF;
END $$;

-- approve_return: signature is (uuid, uuid) or may have idempotency key
DO $$
DECLARE
  v_oid oid;
BEGIN
  SELECT p.oid INTO v_oid
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE p.proname = 'approve_return' AND n.nspname = 'public'
  ORDER BY p.oid DESC LIMIT 1;
  IF v_oid IS NOT NULL THEN
    EXECUTE 'ALTER FUNCTION public.approve_return(' ||
      pg_get_function_identity_arguments(v_oid) ||
      ') SET search_path = public, extensions';
  END IF;
END $$;

-- get_customer_statement
DO $$
DECLARE
  v_oid oid;
BEGIN
  SELECT p.oid INTO v_oid
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE p.proname = 'get_customer_statement' AND n.nspname = 'public'
  ORDER BY p.oid DESC LIMIT 1;
  IF v_oid IS NOT NULL THEN
    EXECUTE 'ALTER FUNCTION public.get_customer_statement(' ||
      pg_get_function_identity_arguments(v_oid) ||
      ') SET search_path = public, extensions';
  END IF;
END $$;

-- link_blend_ticket_to_order
DO $$
DECLARE
  v_oid oid;
BEGIN
  SELECT p.oid INTO v_oid
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE p.proname = 'link_blend_ticket_to_order' AND n.nspname = 'public'
  ORDER BY p.oid DESC LIMIT 1;
  IF v_oid IS NOT NULL THEN
    EXECUTE 'ALTER FUNCTION public.link_blend_ticket_to_order(' ||
      pg_get_function_identity_arguments(v_oid) ||
      ') SET search_path = public, extensions';
  END IF;
END $$;

-- unlink_blend_ticket_from_order
DO $$
DECLARE
  v_oid oid;
BEGIN
  SELECT p.oid INTO v_oid
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE p.proname = 'unlink_blend_ticket_from_order' AND n.nspname = 'public'
  ORDER BY p.oid DESC LIMIT 1;
  IF v_oid IS NOT NULL THEN
    EXECUTE 'ALTER FUNCTION public.unlink_blend_ticket_from_order(' ||
      pg_get_function_identity_arguments(v_oid) ||
      ') SET search_path = public, extensions';
  END IF;
END $$;

-- create_prepay_credit
DO $$
DECLARE
  v_oid oid;
BEGIN
  SELECT p.oid INTO v_oid
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE p.proname = 'create_prepay_credit' AND n.nspname = 'public'
  ORDER BY p.oid DESC LIMIT 1;
  IF v_oid IS NOT NULL THEN
    EXECUTE 'ALTER FUNCTION public.create_prepay_credit(' ||
      pg_get_function_identity_arguments(v_oid) ||
      ') SET search_path = public, extensions';
  END IF;
END $$;

-- create_invoice_from_order already recreated above with search_path set


COMMIT;
