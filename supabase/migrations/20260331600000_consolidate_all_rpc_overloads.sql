-- ============================================================================
-- Migration: 20260331600000_consolidate_all_rpc_overloads.sql
--
-- ROOT CAUSE: Migration 20260306200000 dynamically injected p_idempotency_key
-- into 37 mutating RPCs using pg_get_functiondef(). This created NEW PostgreSQL
-- overloads — the originals remained alongside the injected versions.
--
-- Later audit migrations (20260311+) used CREATE OR REPLACE with the ORIGINAL
-- signatures (no idempotency key), which updated only the non-idempotency
-- overloads. The idempotency overloads kept their STALE pre-March-6 logic.
--
-- Since the frontend ALWAYS sends p_idempotency_key, PostgREST matches the
-- stale idempotency overloads. All bug fixes made to the non-idempotency
-- versions are invisible to the running application.
--
-- Some functions were already consolidated in 20260325100000 and 20260331500000.
-- Some were explicitly rewritten with idempotency in Wave 4 (20260327-20260330).
-- This migration handles ALL remaining cases:
--
-- PART 1: Explicit recreation of 4 functions that are completely missing or
--         only have a stale version (no non-idem to clone from).
-- PART 2: Dynamic consolidation of ~30 remaining functions — drops all
--         overloads and recreates a single unified version with the latest
--         logic + idempotency parameter.
-- PART 3: Verification that each function has exactly 1 overload.
-- ============================================================================


-- ============================================================================
-- PART 1: EXPLICIT RECREATIONS
-- Functions where the non-idempotency version was dropped (by 20260331500000)
-- or never existed, so we must provide the full body explicitly.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1A: create_vendor_bill — MISSING (dropped by 20260331500000, never had idem)
-- Latest body from: 20260311200000_wave2_audit_fixes.sql line 442
-- Added: p_idempotency_key text DEFAULT NULL
-- ────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.create_vendor_bill(uuid, uuid, text, date, date, text, bigint, bigint, text, uuid);
DROP FUNCTION IF EXISTS public.create_vendor_bill(uuid, uuid, text, date, date, text, bigint, bigint, text, uuid, text);

CREATE OR REPLACE FUNCTION public.create_vendor_bill(
  p_vendor_id uuid,
  p_purchase_order_id uuid DEFAULT NULL,
  p_bill_number text DEFAULT '',
  p_bill_date date DEFAULT CURRENT_DATE,
  p_due_date date DEFAULT NULL,
  p_payment_terms text DEFAULT NULL,
  p_subtotal_cents bigint DEFAULT 0,
  p_adjustment_cents bigint DEFAULT 0,
  p_notes text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
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
  -- Role check (admin only)
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
    auth.uid()
  ) RETURNING id INTO v_bill_id;

  RETURN v_bill_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_vendor_bill(uuid, uuid, text, date, date, text, bigint, bigint, text, text) TO authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 1B: record_vendor_payment — MISSING (dropped by 20260331500000, never had idem)
-- Latest body from: 20260311200000_wave2_audit_fixes.sql line 520
-- Added: p_idempotency_key text DEFAULT NULL
-- Removed: p_created_by (use auth.uid() directly)
-- ────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.record_vendor_payment(uuid, bigint, date, text, text, text, uuid);
DROP FUNCTION IF EXISTS public.record_vendor_payment(uuid, bigint, date, text, text, text, text);

CREATE OR REPLACE FUNCTION public.record_vendor_payment(
  p_vendor_bill_id uuid,
  p_amount_cents bigint,
  p_payment_date date DEFAULT CURRENT_DATE,
  p_payment_method text DEFAULT NULL,
  p_reference_number text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
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
  -- Role check (admin only)
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
    auth.uid()
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

GRANT EXECUTE ON FUNCTION public.record_vendor_payment(uuid, bigint, date, text, text, text, text) TO authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 1C: void_vendor_bill — MISSING (dropped by 20260331500000, never had idem)
-- Latest body from: 20260311200000_wave2_audit_fixes.sql line 1013
-- Added: p_idempotency_key text DEFAULT NULL
-- ────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.void_vendor_bill(uuid, text);
DROP FUNCTION IF EXISTS public.void_vendor_bill(uuid, text, text);

CREATE OR REPLACE FUNCTION public.void_vendor_bill(
  p_vendor_bill_id uuid,
  p_reason text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
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

  -- Block voiding partially_paid bills
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

GRANT EXECUTE ON FUNCTION public.void_vendor_bill(uuid, text, text) TO authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- 1D: receive_return — STALE idem-only (non-idem dropped by 20260331500000)
-- Latest body from: 20260330000000_prelaunch_critical_fixes.sql line 881
-- Drop stale injection version, recreate with latest body + idempotency
-- ────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.receive_return(uuid, uuid);
DROP FUNCTION IF EXISTS public.receive_return(uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.receive_return(
  p_return_id uuid,
  p_received_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item RECORD;
  v_return_number text;
BEGIN
  SELECT return_number INTO v_return_number
  FROM returns WHERE id = p_return_id AND status = 'approved';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Return not found or not in approved status';
  END IF;

  FOR v_item IN
    SELECT ri.id AS item_id, ri.product_id, ri.quantity, ri.product_name, ri.condition,
           inv.id AS inv_id, inv.location AS inv_location
    FROM return_items ri
    LEFT JOIN LATERAL (
      SELECT id, location FROM inventory
      WHERE product_id = ri.product_id AND location = 'Main Warehouse'
      LIMIT 1
    ) inv ON true
    WHERE ri.return_id = p_return_id
      AND ri.restock = true
      AND ri.restocked = false
    ORDER BY ri.sort_order
  LOOP
    IF v_item.inv_id IS NOT NULL THEN
      UPDATE inventory
      SET quantity_available = quantity_available + v_item.quantity,
          updated_at = now()
      WHERE id = v_item.inv_id;

      INSERT INTO inventory_transactions (
        product_id, transaction_type, quantity,
        to_location, performed_by, notes
      ) VALUES (
        v_item.product_id, 'returned', v_item.quantity,
        v_item.inv_location, p_received_by,
        'Return ' || v_return_number || ': ' || v_item.product_name ||
        ' (' || v_item.condition || ')'
      );

      UPDATE return_items SET restocked = true WHERE id = v_item.item_id;
    ELSE
      RAISE WARNING 'No inventory row found for product % in return %. Item NOT restocked.',
        v_item.product_id, v_return_number;
    END IF;
  END LOOP;

  UPDATE returns
  SET status = 'received',
      received_by = p_received_by,
      received_at = now(),
      updated_at = now()
  WHERE id = p_return_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.receive_return(uuid, uuid, text) TO authenticated;


-- ============================================================================
-- PART 2: DYNAMIC CONSOLIDATION
--
-- For ALL remaining functions from the original idempotency injection list
-- (minus those already consolidated in 20260325100000 and 20260331500000,
-- and minus the 4 explicitly handled in Part 1 above):
--
-- Algorithm for each function:
--   1. Find all overloads in pg_proc
--   2. If an explicitly-fixed version exists (has BOTH p_idempotency_key in
--      signature AND check_idempotency in body), keep its body
--   3. Otherwise, use the non-idempotency version's body (latest audit logic)
--   4. Drop ALL overloads
--   5. If chosen body lacks p_idempotency_key, inject it into the signature
--   6. Execute CREATE to recreate as a single unified function
--   7. GRANT EXECUTE to authenticated
--
-- This safely handles:
--   - Stale idem overloads (takes non-idem body with latest fixes)
--   - Already-fixed idem overloads (preserves the explicitly fixed version)
--   - Non-stale functions (both overloads identical, just removes orphan)
-- ============================================================================

DO $$
DECLARE
  -- All functions from original injection list (20260306200000),
  -- MINUS already consolidated: complete_job, convert_quote_to_order,
  -- create_quick_delivery, cancel_order, record_invoice_payment
  -- MINUS Part 1 explicit: create_vendor_bill, record_vendor_payment,
  -- void_vendor_bill, receive_return
  v_func_names text[] := ARRAY[
    'save_quote',
    'save_invoice',
    'post_invoice',
    'void_invoice',
    'save_job',
    'transfer_job_to_invoice',
    'edit_delivery',
    'cancel_delivery',
    'create_followup_delivery',
    'confirm_delivery',
    'complete_delivery',
    'reassign_delivery',
    'batch_cancel_deliveries',
    'batch_reschedule_deliveries',
    'batch_post_invoices',
    'batch_void_invoices',
    'save_blend_ticket',
    'link_blend_ticket_to_order',
    'unlink_blend_ticket_from_order',
    'create_order_from_blend_ticket',
    'create_application_record_from_blend_ticket',
    'create_commission_payment',
    'post_commission_payment',
    'close_accounting_period',
    'generate_batch_statements',
    'apply_remaining_prepayments',
    'batch_apply_all_prepayments',
    'approve_return',
    'issue_return_credit',
    'complete_cycle_count',
    'duplicate_quote',
    'save_purchase_order',
    'delete_purchase_order'
  ];
  v_func_name text;
  v_oid oid;
  v_oids oid[];
  v_funcdef text;
  v_best_def text;
  v_best_source text;
  v_has_idem_param boolean;
  v_has_idem_logic boolean;
  v_new_param text := ', p_idempotency_key text DEFAULT NULL';
  v_grant_sig text;
BEGIN
  FOREACH v_func_name IN ARRAY v_func_names
  LOOP
    -- Collect all overloads for this function
    SELECT array_agg(p.oid ORDER BY p.oid DESC)
    INTO v_oids
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE p.proname = v_func_name
      AND n.nspname = 'public';

    IF v_oids IS NULL THEN
      RAISE NOTICE 'SKIP: % — not found in database', v_func_name;
      CONTINUE;
    END IF;

    -- Find the best overload to use as the basis for the unified version
    v_best_def := NULL;
    v_best_source := 'none';

    FOREACH v_oid IN ARRAY v_oids
    LOOP
      v_funcdef := pg_get_functiondef(v_oid);
      v_has_idem_param := v_funcdef ILIKE '%p_idempotency_key%';
      v_has_idem_logic := v_funcdef ILIKE '%check_idempotency%';

      IF v_has_idem_param AND v_has_idem_logic THEN
        -- Best case: explicitly fixed version with full idempotency support
        v_best_def := v_funcdef;
        v_best_source := 'explicit_idem';
      ELSIF NOT v_has_idem_param THEN
        -- Good fallback: non-idem version has latest audit logic
        -- Only prefer this over stale injection (not over explicit idem)
        IF v_best_source NOT IN ('explicit_idem') THEN
          v_best_def := v_funcdef;
          v_best_source := 'non_idem';
        END IF;
      ELSE
        -- Stale injection: has idem param but no check_idempotency logic
        -- Use only if nothing better available
        IF v_best_def IS NULL THEN
          v_best_def := v_funcdef;
          v_best_source := 'stale_idem';
        END IF;
      END IF;
    END LOOP;

    IF v_best_def IS NULL THEN
      RAISE WARNING 'SKIP: % — could not determine best overload', v_func_name;
      CONTINUE;
    END IF;

    -- Drop ALL overloads
    FOREACH v_oid IN ARRAY v_oids
    LOOP
      EXECUTE format('DROP FUNCTION IF EXISTS %s', v_oid::regprocedure);
    END LOOP;

    -- If best definition doesn't have idempotency parameter, inject it
    IF v_best_def NOT ILIKE '%p_idempotency_key%' THEN
      v_best_def := regexp_replace(
        v_best_def,
        E'\\)\n(\\s*RETURNS)',
        v_new_param || E')\n\\1'
      );
    END IF;

    -- Execute the CREATE OR REPLACE to recreate the unified function
    EXECUTE v_best_def;

    -- Grant execute to authenticated
    SELECT p.oid::regprocedure::text
    INTO v_grant_sig
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE p.proname = v_func_name
      AND n.nspname = 'public'
    LIMIT 1;

    IF v_grant_sig IS NOT NULL THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_grant_sig);
    END IF;

    RAISE NOTICE 'CONSOLIDATED: % (source: %)', v_func_name, v_best_source;
  END LOOP;
END;
$$;


-- ============================================================================
-- PART 3: VERIFICATION
-- Ensure every function from the complete list has exactly 1 overload.
-- If any function has 0 or 2+ overloads, the migration fails immediately.
-- ============================================================================

DO $$
DECLARE
  v_all_funcs text[] := ARRAY[
    -- Already consolidated in 20260325100000
    'complete_job', 'convert_quote_to_order', 'create_quick_delivery', 'cancel_order',
    -- Already consolidated in 20260331500000
    'record_invoice_payment',
    -- Part 1 explicit recreations
    'create_vendor_bill', 'record_vendor_payment', 'void_vendor_bill', 'receive_return',
    -- Part 2 dynamic consolidation
    'save_quote', 'save_invoice', 'post_invoice', 'void_invoice',
    'save_job', 'transfer_job_to_invoice',
    'edit_delivery', 'cancel_delivery', 'create_followup_delivery',
    'confirm_delivery', 'complete_delivery', 'reassign_delivery',
    'batch_cancel_deliveries', 'batch_reschedule_deliveries',
    'batch_post_invoices', 'batch_void_invoices',
    'save_blend_ticket', 'link_blend_ticket_to_order',
    'unlink_blend_ticket_from_order', 'create_order_from_blend_ticket',
    'create_application_record_from_blend_ticket',
    'create_commission_payment', 'post_commission_payment',
    'close_accounting_period', 'generate_batch_statements',
    'apply_remaining_prepayments', 'batch_apply_all_prepayments',
    'approve_return', 'issue_return_credit',
    'complete_cycle_count', 'duplicate_quote',
    'save_purchase_order', 'delete_purchase_order'
  ];
  v_func_name text;
  v_count integer;
  v_failures text[] := '{}';
BEGIN
  FOREACH v_func_name IN ARRAY v_all_funcs
  LOOP
    SELECT count(*) INTO v_count
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE p.proname = v_func_name
      AND n.nspname = 'public';

    IF v_count = 0 THEN
      v_failures := array_append(v_failures, v_func_name || ': MISSING (0 overloads)');
    ELSIF v_count > 1 THEN
      v_failures := array_append(v_failures, v_func_name || ': DUPLICATE (' || v_count || ' overloads)');
    END IF;
  END LOOP;

  IF array_length(v_failures, 1) > 0 THEN
    RAISE EXCEPTION E'VERIFICATION FAILED — the following functions have incorrect overload counts:\n%',
      array_to_string(v_failures, E'\n');
  END IF;

  RAISE NOTICE 'VERIFICATION PASSED: All % functions have exactly 1 overload', array_length(v_all_funcs, 1);
END;
$$;
