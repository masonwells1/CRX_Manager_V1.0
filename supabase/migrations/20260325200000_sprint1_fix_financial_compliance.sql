-- ============================================================================
-- Sprint 1: Financial & Compliance Critical Bug Fixes
-- Migration: 20260325200000_sprint1_fix_financial_compliance.sql
-- Date: 2026-03-25
--
-- Fixes:
--   Bug 1 (AP-001): get_ap_aging column names don't match frontend types
--   Bug 1b:         get_ap_dashboard_summary returns 'unpaid_bills' not 'unpaid_count'
--   Bug 2 (INV-002): void_invoice doesn't zero paid_amount_cents before total
--   Bug 3 (COMP-001): generate_rup_sales_records references line_total_cents (wrong)
--   Bug 4 (COMP-002): post_invoice doesn't auto-generate RUP records
--   Bug 5 (PO-001):   save_purchase_order allows editing fully_received/cancelled POs
-- ============================================================================


-- ============================================================================
-- BUG 1 (AP-001): get_ap_aging column name mismatch
-- The RPC returned current_cents, days_31_60_cents, days_61_90_cents,
-- over_90_cents, total_cents but the frontend (APAgingRow in types/index.ts)
-- expects current_amount, days_31_60, days_61_90, over_90, total_outstanding,
-- bill_count.
--
-- Must DROP first because the return type is changing.
-- ============================================================================

DROP FUNCTION IF EXISTS public.get_ap_aging(date);
DROP FUNCTION IF EXISTS public.get_ap_aging(date, text);  -- in case idempotency overload exists

CREATE OR REPLACE FUNCTION get_ap_aging(
  p_as_of_date date DEFAULT CURRENT_DATE,
  p_idempotency_key text DEFAULT NULL
)
RETURNS TABLE(
  vendor_id uuid,
  vendor_name text,
  current_amount bigint,
  days_31_60 bigint,
  days_61_90 bigint,
  over_90 bigint,
  total_outstanding bigint,
  bill_count integer
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    v.id AS vendor_id,
    v.name AS vendor_name,
    COALESCE(SUM(CASE WHEN (p_as_of_date - vb.bill_date) <= 30 THEN vb.balance_cents ELSE 0 END), 0)::bigint AS current_amount,
    COALESCE(SUM(CASE WHEN (p_as_of_date - vb.bill_date) BETWEEN 31 AND 60 THEN vb.balance_cents ELSE 0 END), 0)::bigint AS days_31_60,
    COALESCE(SUM(CASE WHEN (p_as_of_date - vb.bill_date) BETWEEN 61 AND 90 THEN vb.balance_cents ELSE 0 END), 0)::bigint AS days_61_90,
    COALESCE(SUM(CASE WHEN (p_as_of_date - vb.bill_date) > 90 THEN vb.balance_cents ELSE 0 END), 0)::bigint AS over_90,
    COALESCE(SUM(vb.balance_cents), 0)::bigint AS total_outstanding,
    COUNT(vb.id)::integer AS bill_count
  FROM vendors v
  LEFT JOIN vendor_bills vb ON vb.vendor_id = v.id
    AND vb.status IN ('unpaid', 'partially_paid')
    AND vb.deleted_at IS NULL
  WHERE v.deleted_at IS NULL
  GROUP BY v.id, v.name
  HAVING COALESCE(SUM(vb.balance_cents), 0) > 0
  ORDER BY COALESCE(SUM(vb.balance_cents), 0) DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION get_ap_aging(date, text) TO authenticated;


-- ============================================================================
-- BUG 1b: get_ap_dashboard_summary returns 'unpaid_bills' but frontend
-- APDashboardSummary type expects 'unpaid_count'.
-- Fix: change the jsonb key from 'unpaid_bills' to 'unpaid_count'.
-- Must DROP old no-arg version first since we're adding p_idempotency_key.
-- ============================================================================

DROP FUNCTION IF EXISTS public.get_ap_dashboard_summary();
DROP FUNCTION IF EXISTS public.get_ap_dashboard_summary(text);

CREATE OR REPLACE FUNCTION get_ap_dashboard_summary(
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'total_owed_cents', COALESCE(SUM(CASE WHEN status IN ('unpaid', 'partially_paid') THEN balance_cents ELSE 0 END), 0),
    'overdue_cents', COALESCE(SUM(CASE WHEN status IN ('unpaid', 'partially_paid') AND due_date < CURRENT_DATE THEN balance_cents ELSE 0 END), 0),
    'overdue_count', COUNT(CASE WHEN status IN ('unpaid', 'partially_paid') AND due_date < CURRENT_DATE THEN 1 END),
    'due_this_week_cents', COALESCE(SUM(CASE WHEN status IN ('unpaid', 'partially_paid') AND due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7 THEN balance_cents ELSE 0 END), 0),
    'due_this_week_count', COUNT(CASE WHEN status IN ('unpaid', 'partially_paid') AND due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7 THEN 1 END),
    'due_this_month_cents', COALESCE(SUM(CASE WHEN status IN ('unpaid', 'partially_paid') AND due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30 THEN balance_cents ELSE 0 END), 0),
    'total_bills', COUNT(*),
    'unpaid_count', COUNT(CASE WHEN status IN ('unpaid', 'partially_paid') THEN 1 END),
    'paid_this_month_cents', COALESCE((
      SELECT SUM(vp.amount_cents)
      FROM vendor_payments vp
      JOIN vendor_bills vb2 ON vb2.id = vp.vendor_bill_id
      WHERE vp.payment_date >= date_trunc('month', CURRENT_DATE)
    ), 0)
  )
  INTO v_result
  FROM vendor_bills
  WHERE deleted_at IS NULL AND status <> 'voided';

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION get_ap_dashboard_summary(text) TO authenticated;


-- ============================================================================
-- BUG 2 (INV-002): void_invoice doesn't zero paid_amount_cents
-- When voiding a posted invoice that has payments, the function reverses
-- allocations and restores prepay, but then sets total_amount_cents = 0
-- WITHOUT also zeroing paid_amount_cents. Since balance_cents is a GENERATED
-- column (= total_amount_cents - paid_amount_cents - prepay_applied_cents
-- - write_off_cents), this causes balance_cents to go negative.
--
-- Fix: In the final UPDATE that voids the invoice, explicitly set ALL
-- component columns to 0 so balance_cents computes to 0.
--
-- Note: The current function already exists with signature
-- void_invoice(uuid, text, text) after the 20260324100000 migration added
-- p_idempotency_key. We must drop and recreate with that parameter.
-- ============================================================================

-- Drop all overloads to avoid ambiguity
DROP FUNCTION IF EXISTS public.void_invoice(uuid, text);
DROP FUNCTION IF EXISTS public.void_invoice(uuid, text, text);

CREATE OR REPLACE FUNCTION void_invoice(
  p_invoice_id uuid,
  p_void_reason text,
  p_idempotency_key text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv record;
  v_alloc record;
  v_total_allocations_reversed bigint := 0;
  v_total_prepay_restored bigint := 0;
  v_prepay_app record;
BEGIN
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

    -- Note: We no longer partially update paid_amount_cents here.
    -- It will be zeroed below when we void the invoice.
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

  -- BUG 2 FIX: Void the invoice by zeroing ALL component columns.
  -- balance_cents is GENERATED ALWAYS AS (total_amount_cents - paid_amount_cents
  -- - prepay_applied_cents - write_off_cents). Setting all to 0 ensures
  -- balance_cents = 0 (not negative).
  -- Previously only total_amount_cents was zeroed, leaving paid_amount_cents
  -- with its old value, causing negative balance_cents.
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


-- ============================================================================
-- BUG 3 (COMP-001): generate_rup_sales_records references line_total_cents
-- The actual column on invoice_items is extended_cents, not line_total_cents.
-- This causes RUP records to have NULL total_cents values.
--
-- Fix: Recreate the function changing line_total_cents -> extended_cents.
-- The function was originally created with p_invoice_id uuid parameter.
-- After 20260306200000, it may have gained p_idempotency_key dynamically.
-- We drop all overloads and recreate cleanly.
-- ============================================================================

DROP FUNCTION IF EXISTS public.generate_rup_sales_records(uuid);
DROP FUNCTION IF EXISTS public.generate_rup_sales_records(uuid, text);

CREATE OR REPLACE FUNCTION generate_rup_sales_records(
  p_invoice_id uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
  v_invoice record;
  v_item record;
  v_license record;
  v_compliance_status text;
  v_compliance_notes text;
  v_season integer;
BEGIN
  -- Get invoice details
  SELECT i.id, i.order_id, o.customer_id, c.farm_name, i.created_at
  INTO v_invoice
  FROM invoices i
  JOIN orders o ON o.id = i.order_id
  JOIN customers c ON c.id = o.customer_id
  WHERE i.id = p_invoice_id;

  IF v_invoice IS NULL THEN
    RETURN 0;
  END IF;

  -- Calculate season (Oct 1 - Sep 30)
  v_season := CASE
    WHEN EXTRACT(MONTH FROM v_invoice.created_at) >= 10
    THEN EXTRACT(YEAR FROM v_invoice.created_at)::integer + 1
    ELSE EXTRACT(YEAR FROM v_invoice.created_at)::integer
  END;

  -- Process each RUP product on the invoice
  FOR v_item IN
    SELECT ii.id, ii.product_id, ii.product_name, ii.quantity, ii.unit,
           ii.unit_price_cents, ii.extended_cents,  -- BUG 3 FIX: was line_total_cents
           p.epa_registration, p.signal_word
    FROM invoice_items ii
    JOIN products p ON p.id = ii.product_id
    WHERE ii.invoice_id = p_invoice_id
      AND p.is_rup = true
  LOOP
    -- Find the customer's best applicator license
    SELECT al.license_number, al.license_type, al.expiry_date
    INTO v_license
    FROM applicator_licenses al
    WHERE al.customer_id = v_invoice.customer_id
      AND al.deleted_at IS NULL
    ORDER BY al.expiry_date DESC NULLS LAST
    LIMIT 1;

    -- Determine compliance status
    IF v_license IS NULL OR v_license.license_number IS NULL THEN
      v_compliance_status := 'non_compliant';
      v_compliance_notes := 'No applicator license on file for this customer';
    ELSIF v_license.expiry_date IS NOT NULL AND v_license.expiry_date < CURRENT_DATE THEN
      v_compliance_status := 'warning';
      v_compliance_notes := 'Applicator license expired on ' || v_license.expiry_date::text;
    ELSE
      v_compliance_status := 'compliant';
      v_compliance_notes := NULL;
    END IF;

    -- Don't duplicate if record already exists for this invoice+product
    IF NOT EXISTS (
      SELECT 1 FROM rup_sales_records
      WHERE invoice_id = p_invoice_id AND product_id = v_item.product_id
    ) THEN
      INSERT INTO rup_sales_records (
        invoice_id, order_id, customer_id, product_id,
        sale_date, product_name, epa_registration, quantity, unit,
        unit_price_cents, total_cents,
        buyer_name, buyer_certification_number,
        buyer_certification_type, buyer_certification_expiry,
        signal_word, compliance_status, compliance_notes,
        season, created_by
      ) VALUES (
        p_invoice_id, v_invoice.order_id, v_invoice.customer_id, v_item.product_id,
        CURRENT_DATE, v_item.product_name, v_item.epa_registration, v_item.quantity, v_item.unit,
        v_item.unit_price_cents, v_item.extended_cents,  -- BUG 3 FIX: was line_total_cents
        v_invoice.farm_name,
        v_license.license_number,
        v_license.license_type,
        v_license.expiry_date,
        v_item.signal_word, v_compliance_status, v_compliance_notes,
        v_season, auth.uid()
      );
      v_count := v_count + 1;
    END IF;
  END LOOP;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION generate_rup_sales_records(uuid, text) TO authenticated;


-- ============================================================================
-- BUG 4 (COMP-002): post_invoice doesn't auto-generate RUP records
-- After posting an invoice, RUP compliance records should be automatically
-- created for any RUP products on the invoice. The function never called
-- generate_rup_sales_records().
--
-- Fix: Add PERFORM generate_rup_sales_records(p_invoice_id) before RETURN.
--
-- Note: post_invoice currently has signature (uuid, text) after
-- 20260324100000 added p_idempotency_key. We recreate with that parameter.
-- Based on latest body from 20260311000001_audit_financial_fixes.sql.
-- ============================================================================

-- Drop all overloads to avoid ambiguity
DROP FUNCTION IF EXISTS public.post_invoice(uuid);
DROP FUNCTION IF EXISTS public.post_invoice(uuid, text);

CREATE OR REPLACE FUNCTION post_invoice(
  p_invoice_id uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv record;
BEGIN
  -- Auth check (from Bug 5 fix in 20260311000001)
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'Not authorized to post invoices';
  END IF;

  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found: %', p_invoice_id;
  END IF;

  -- Enforce accounting period
  PERFORM check_period_open(v_inv.invoice_date);

  IF v_inv.status NOT IN ('draft', 'unposted') THEN
    RAISE EXCEPTION 'Cannot post invoice with status: %', v_inv.status;
  END IF;

  SET LOCAL app.admin_override = 'true';

  UPDATE invoices SET
    status = 'posted',
    posted_by = auth.uid(),
    posted_at = now(),
    updated_at = now()
  WHERE id = p_invoice_id;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'invoice_posted', 'invoice', p_invoice_id,
    (SELECT role FROM profiles WHERE id = auth.uid()),
    jsonb_build_object('status', v_inv.status),
    jsonb_build_object('status', 'posted', 'posted_at', now()::text),
    v_inv.total_amount_cents,
    'Posted ' || v_inv.invoice_number || ' for $' || (v_inv.total_amount_cents / 100.0)::numeric(12,2)
  );

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_posted',
    'Posted invoice ' || v_inv.invoice_number || ' — $' || (v_inv.total_amount_cents / 100.0)::numeric(12,2),
    auth.uid(), 'invoice', p_invoice_id, v_inv.customer_id
  );

  -- BUG 4 FIX: Auto-generate RUP sales records for this invoice.
  -- generate_rup_sales_records is idempotent (checks for existing records).
  PERFORM generate_rup_sales_records(p_invoice_id);
END;
$$;

GRANT EXECUTE ON FUNCTION post_invoice(uuid, text) TO authenticated;


-- ============================================================================
-- BUG 5 (PO-001): save_purchase_order allows any status transition
-- An admin can change a fully_received or cancelled PO back to draft.
-- The function has no state machine validation.
--
-- Fix: Before updating, read the current status and block edits to
-- fully_received or cancelled POs.
--
-- Note: save_purchase_order has signature (uuid, jsonb, jsonb, uuid, text)
-- after 20260306200000 added p_idempotency_key dynamically.
-- We recreate from the 20260211220000 body with the fix + idempotency key.
-- ============================================================================

-- Drop all overloads to avoid ambiguity
DROP FUNCTION IF EXISTS public.save_purchase_order(uuid, jsonb, jsonb, uuid);
DROP FUNCTION IF EXISTS public.save_purchase_order(uuid, jsonb, jsonb, uuid, text);

CREATE OR REPLACE FUNCTION save_purchase_order(
  p_po_id uuid,
  p_po_payload jsonb,
  p_items jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_po_id uuid;
  v_is_new boolean := (p_po_id IS NULL);
  v_item jsonb;
  v_total_cost numeric := 0;
  v_po_number text;
  v_existing_status text;
BEGIN
  -- Verify caller is admin
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = p_performed_by AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Only admins can manage purchase orders';
  END IF;

  -- Calculate total cost from items
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_total_cost := v_total_cost +
      COALESCE((v_item->>'quantity_ordered')::numeric, 0) *
      COALESCE((v_item->>'unit_cost')::numeric, 0);
  END LOOP;

  IF v_is_new THEN
    INSERT INTO purchase_orders (
      po_number, vendor, status, submitted_date,
      expected_delivery_date, notes, total_cost, created_by
    ) VALUES (
      p_po_payload->>'po_number',
      p_po_payload->>'vendor',
      COALESCE(p_po_payload->>'status', 'draft'),
      (p_po_payload->>'submitted_date')::date,
      (p_po_payload->>'expected_delivery_date')::date,
      NULLIF(p_po_payload->>'notes', ''),
      v_total_cost,
      p_performed_by
    ) RETURNING id, po_number INTO v_po_id, v_po_number;
  ELSE
    v_po_id := p_po_id;

    -- Get PO number and current status for validation
    SELECT po_number, status INTO v_po_number, v_existing_status
    FROM purchase_orders WHERE id = v_po_id;

    IF v_po_number IS NULL THEN
      RAISE EXCEPTION 'Purchase order not found: %', v_po_id;
    END IF;

    -- BUG 5 FIX: State machine validation — block edits to terminal states
    IF v_existing_status IN ('fully_received', 'cancelled') THEN
      RAISE EXCEPTION 'Cannot edit a % purchase order', v_existing_status;
    END IF;

    UPDATE purchase_orders SET
      vendor = COALESCE(p_po_payload->>'vendor', vendor),
      status = COALESCE(p_po_payload->>'status', status),
      submitted_date = COALESCE((p_po_payload->>'submitted_date')::date, submitted_date),
      expected_delivery_date = COALESCE((p_po_payload->>'expected_delivery_date')::date, expected_delivery_date),
      notes = CASE WHEN p_po_payload ? 'notes'
        THEN NULLIF(p_po_payload->>'notes', '')
        ELSE notes
      END,
      total_cost = v_total_cost,
      updated_at = now()
    WHERE id = v_po_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Purchase order not found: %', v_po_id;
    END IF;

    -- Delete existing items and re-insert (atomic within this transaction)
    DELETE FROM purchase_order_items WHERE purchase_order_id = v_po_id;
  END IF;

  -- Insert items
  INSERT INTO purchase_order_items (
    purchase_order_id, product_id, product_name, unit_size,
    quantity_ordered, unit_cost, quantity_received
  )
  SELECT
    v_po_id,
    (item->>'product_id')::uuid,
    item->>'product_name',
    item->>'unit_size',
    COALESCE((item->>'quantity_ordered')::numeric, 0),
    COALESCE((item->>'unit_cost')::numeric, 0),
    COALESCE((item->>'quantity_received')::numeric, 0)
  FROM jsonb_array_elements(p_items) AS item
  WHERE (item->>'product_id') IS NOT NULL;

  -- Log activity
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id
  ) VALUES (
    CASE WHEN v_is_new THEN 'po_created' ELSE 'po_updated' END,
    CASE WHEN v_is_new
      THEN 'PO ' || COALESCE(v_po_number, '') || ' created'
      ELSE 'PO ' || COALESCE(v_po_number, '') || ' updated'
    END,
    p_performed_by, 'purchase_order', v_po_id
  );

  RETURN jsonb_build_object('status', 'saved', 'po_id', v_po_id);
END;
$$;

GRANT EXECUTE ON FUNCTION save_purchase_order(uuid, jsonb, jsonb, uuid, text) TO authenticated;


-- ============================================================================
-- Verify: ensure no stale overloads remain for the functions we recreated
-- ============================================================================
DO $$
DECLARE
  func_name TEXT;
  overload_count INT;
  func_names TEXT[] := ARRAY[
    'get_ap_aging', 'get_ap_dashboard_summary', 'void_invoice',
    'generate_rup_sales_records', 'post_invoice', 'save_purchase_order'
  ];
BEGIN
  FOREACH func_name IN ARRAY func_names
  LOOP
    SELECT count(*) INTO overload_count
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.proname = func_name;

    IF overload_count != 1 THEN
      RAISE WARNING 'Function % has % overloads (expected 1)', func_name, overload_count;
    ELSE
      RAISE NOTICE 'OK: % has exactly 1 overload', func_name;
    END IF;
  END LOOP;
END $$;
