-- idempotency-body-check: exempt
-- (Uses check_idempotency / save_idempotency helpers per CLAUDE.md
-- "Canonical Patterns for New RPCs".)
-- ============================================================================
-- Codex review fix for PR #59 — restore positive-total guard on vendor bills
-- ============================================================================
-- Audit findings (codex review of PR #59, 2026-05-11, both P2):
--   1. update_vendor_bill (20260510100000) validates p_subtotal_cents > 0 but
--      never re-checks v_new_total_cents after applying p_adjustment_cents.
--      A $100 bill edited with a -$200 adjustment becomes total=-$100,
--      balance=-$100 (GENERATED), status='unpaid' — broken aging/payment.
--   2. create_vendor_bill rewrite in ap_polish_completion (20260510130000)
--      silently dropped the v_total <= 0 guard that codex audit F4 had
--      added in PR-04 (20260510030000_ap_structural_fixes.sql). Same risk:
--      negative adjustment can flip the computed total negative.
--
-- Fix: re-add the canonical guard after computing total = subtotal + adjustment:
--   IF v_total <= 0 THEN
--     RAISE EXCEPTION 'INVALID_AMOUNT: bill total must be positive (got %)', v_total;
--   END IF;
--
-- vendor_bills has no table-level CHECK on total_cents > 0 and balance_cents
-- is GENERATED from total_cents, so the DB has no backstop. Server-side guard
-- is the only line of defense for direct RPC callers and future frontends.
--
-- Bodies are reproduced verbatim from the prior installed migrations with the
-- guard added immediately after the v_total / v_new_total_cents assignment.
-- ============================================================================

-- ─── update_vendor_bill — add v_new_total_cents > 0 guard ────────────────

CREATE OR REPLACE FUNCTION update_vendor_bill(
  p_bill_id uuid,
  p_subtotal_cents bigint,
  p_adjustment_cents bigint,
  p_bill_date date,
  p_due_date date,
  p_notes text,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_actor_role text;
  v_bill record;
  v_active_payment_count integer;
  v_new_total_cents bigint;
  v_old_values jsonb;
  v_new_values jsonb;
  v_result jsonb;
  v_existing jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;

  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role <> 'admin' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: only admins can edit vendor bills';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'update_vendor_bill');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  IF p_subtotal_cents IS NULL OR p_subtotal_cents <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: subtotal must be positive';
  END IF;
  IF p_due_date < p_bill_date THEN
    RAISE EXCEPTION 'INVALID_DATE_RANGE: due_date cannot precede bill_date';
  END IF;

  PERFORM check_period_open(p_bill_date);

  SELECT * INTO v_bill
  FROM vendor_bills
  WHERE id = p_bill_id AND deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'BILL_NOT_FOUND';
  END IF;

  IF v_bill.status <> 'unpaid' THEN
    RAISE EXCEPTION 'BILL_NOT_EDITABLE: status is % (only unpaid bills can be edited)', v_bill.status;
  END IF;

  SELECT count(*) INTO v_active_payment_count
  FROM vendor_payments
  WHERE vendor_bill_id = p_bill_id AND voided_at IS NULL;

  IF v_active_payment_count > 0 THEN
    RAISE EXCEPTION 'BILL_HAS_ACTIVE_PAYMENTS: void each payment first (% active)', v_active_payment_count;
  END IF;

  v_new_total_cents := p_subtotal_cents + COALESCE(p_adjustment_cents, 0);

  IF v_new_total_cents <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: bill total must be positive (got %)', v_new_total_cents;
  END IF;

  v_old_values := jsonb_build_object(
    'subtotal_cents', v_bill.subtotal_cents,
    'adjustment_cents', v_bill.adjustment_cents,
    'total_cents', v_bill.total_cents,
    'bill_date', v_bill.bill_date,
    'due_date', v_bill.due_date,
    'notes', v_bill.notes
  );

  UPDATE vendor_bills SET
    subtotal_cents = p_subtotal_cents,
    adjustment_cents = COALESCE(p_adjustment_cents, 0),
    total_cents = v_new_total_cents,
    bill_date = p_bill_date,
    due_date = p_due_date,
    notes = p_notes,
    updated_at = now()
  WHERE id = p_bill_id;

  v_new_values := jsonb_build_object(
    'subtotal_cents', p_subtotal_cents,
    'adjustment_cents', COALESCE(p_adjustment_cents, 0),
    'total_cents', v_new_total_cents,
    'bill_date', p_bill_date,
    'due_date', p_due_date,
    'notes', p_notes
  );

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'vendor_bill_updated', 'vendor_bill', p_bill_id, v_actor, v_actor_role,
    v_old_values, v_new_values,
    v_new_total_cents - v_bill.total_cents,
    'Updated vendor bill ' || v_bill.bill_number || ' — total $' ||
    (v_bill.total_cents / 100.0)::numeric(12,2) || ' → $' ||
    (v_new_total_cents / 100.0)::numeric(12,2)
  );

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id
  ) VALUES (
    'vendor_bill_updated',
    'Updated vendor bill ' || v_bill.bill_number,
    v_actor, 'vendor_bill', p_bill_id
  );

  v_result := jsonb_build_object(
    'success', true,
    'bill_id', p_bill_id,
    'old_total_cents', v_bill.total_cents,
    'new_total_cents', v_new_total_cents
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'update_vendor_bill', v_result);
  END IF;

  RETURN v_result;
END;
$$;

-- ─── create_vendor_bill — restore v_total > 0 guard lost in PR-22b ───────

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
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_total bigint;
  v_bill_id uuid;
  v_terms_days integer;
  v_terms text;
  v_actor uuid;
  v_actor_role text;
  v_existing jsonb;
  v_vendor_name text;
  v_po_vendor text;
  v_po_total_cents bigint;
  v_amount_drift_pct numeric;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;

  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role <> 'admin' THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: admin role required to create vendor bills';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'create_vendor_bill');
    IF v_existing IS NOT NULL THEN
      RETURN (v_existing->>'bill_id')::uuid;
    END IF;
  END IF;

  PERFORM check_period_open(p_bill_date);

  SELECT name INTO v_vendor_name FROM vendors WHERE id = p_vendor_id AND deleted_at IS NULL;
  IF v_vendor_name IS NULL THEN
    RAISE EXCEPTION 'VENDOR_NOT_FOUND: vendor % does not exist or is soft-deleted', p_vendor_id;
  END IF;

  IF p_subtotal_cents <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: subtotal must be positive';
  END IF;

  v_total := p_subtotal_cents + COALESCE(p_adjustment_cents, 0);

  -- Restored from PR-04 (codex audit F4) — adjustments can flip the total
  -- negative even when the subtotal is positive. Re-added here because the
  -- PR-22b rewrite (20260510130000) dropped this guard.
  IF v_total <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: bill total must be positive (got %)', v_total;
  END IF;

  -- PR-22b #3: PO-to-bill vendor consistency check.
  IF p_purchase_order_id IS NOT NULL THEN
    SELECT vendor INTO v_po_vendor FROM purchase_orders WHERE id = p_purchase_order_id;
    IF v_po_vendor IS NULL THEN
      RAISE EXCEPTION 'PO_NOT_FOUND: purchase order % does not exist', p_purchase_order_id;
    END IF;
    IF lower(trim(v_po_vendor)) <> lower(trim(v_vendor_name)) THEN
      RAISE EXCEPTION 'VENDOR_PO_MISMATCH: bill vendor "%" does not match PO vendor "%"',
        v_vendor_name, v_po_vendor;
    END IF;

    -- PR-22b #2: PO-to-bill amount soft warn (>5% drift).
    SELECT COALESCE(SUM(quantity_ordered * unit_cost * 100)::bigint, 0)
      INTO v_po_total_cents
    FROM purchase_order_items
    WHERE purchase_order_id = p_purchase_order_id;

    IF v_po_total_cents > 0 THEN
      v_amount_drift_pct := ABS(v_total - v_po_total_cents)::numeric / v_po_total_cents::numeric;
      IF v_amount_drift_pct > 0.05 THEN
        INSERT INTO notifications (user_id, title, message, notification_type, related_entity_type, related_entity_id)
        SELECT
          p.id,
          'Vendor bill amount differs from PO',
          'Bill ' || COALESCE(NULLIF(p_bill_number, ''), 'pending') ||
            ' for ' || v_vendor_name ||
            ' is $' || (v_total / 100.0)::numeric(12,2) ||
            ' but PO total is $' || (v_po_total_cents / 100.0)::numeric(12,2) ||
            ' (' || ROUND(v_amount_drift_pct * 100, 1) || '% drift). Verify the bill matches the PO.',
          'vendor_bill_drift',
          'purchase_order',
          p_purchase_order_id
        FROM profiles p
        WHERE p.role = 'admin' AND p.is_active = true;
      END IF;
    END IF;
  END IF;

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

  INSERT INTO vendor_bills (
    vendor_id, purchase_order_id, bill_number, bill_date, due_date,
    payment_terms, subtotal_cents, adjustment_cents, total_cents,
    paid_cents, status, notes, created_by
  ) VALUES (
    p_vendor_id, p_purchase_order_id, p_bill_number, p_bill_date,
    COALESCE(p_due_date, p_bill_date + (COALESCE(v_terms_days, 30) || ' days')::interval),
    v_terms, p_subtotal_cents, COALESCE(p_adjustment_cents, 0), v_total,
    0, 'unpaid', p_notes, v_actor
  )
  RETURNING id INTO v_bill_id;

  INSERT INTO financial_audit_log (
    operation_type, entity_type, entity_id, actor_user_id, actor_role,
    new_values, total_impact_cents, description
  ) VALUES (
    'vendor_bill_created', 'vendor_bill', v_bill_id, v_actor, v_actor_role,
    jsonb_build_object(
      'vendor_id', p_vendor_id,
      'purchase_order_id', p_purchase_order_id,
      'bill_number', p_bill_number,
      'bill_date', p_bill_date,
      'total_cents', v_total,
      'po_total_cents', v_po_total_cents,
      'drift_pct', v_amount_drift_pct
    ),
    v_total,
    'Vendor bill ' || COALESCE(NULLIF(p_bill_number, ''), v_bill_id::text) ||
      ' created for $' || (v_total / 100.0)::numeric(12,2)
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(
      p_idempotency_key,
      'create_vendor_bill',
      jsonb_build_object('bill_id', v_bill_id)
    );
  END IF;

  RETURN v_bill_id;
END;
$$;

-- ─── Verification ─────────────────────────────────────────────────────────

DO $$
DECLARE
  v_update_has_total_guard boolean;
  v_create_has_total_guard boolean;
  v_create_has_consistency_check boolean;
  v_create_has_soft_warn boolean;
  v_update_overload_count integer;
  v_create_overload_count integer;
BEGIN
  -- update_vendor_bill: must have the new v_new_total_cents <= 0 guard
  SELECT prosrc ~ 'bill total must be positive' INTO v_update_has_total_guard
  FROM pg_proc WHERE proname='update_vendor_bill' AND pronamespace='public'::regnamespace;
  IF NOT COALESCE(v_update_has_total_guard, false) THEN
    RAISE EXCEPTION 'codex-fix verification: update_vendor_bill missing positive-total guard';
  END IF;

  -- create_vendor_bill: must have the restored v_total <= 0 guard
  SELECT prosrc ~ 'bill total must be positive' INTO v_create_has_total_guard
  FROM pg_proc WHERE proname='create_vendor_bill' AND pronamespace='public'::regnamespace;
  IF NOT COALESCE(v_create_has_total_guard, false) THEN
    RAISE EXCEPTION 'codex-fix verification: create_vendor_bill missing positive-total guard';
  END IF;

  -- create_vendor_bill: must still have PR-22b polish features (regression guard)
  SELECT prosrc ~ 'VENDOR_PO_MISMATCH' INTO v_create_has_consistency_check
  FROM pg_proc WHERE proname='create_vendor_bill' AND pronamespace='public'::regnamespace;
  IF NOT COALESCE(v_create_has_consistency_check, false) THEN
    RAISE EXCEPTION 'codex-fix verification: create_vendor_bill lost VENDOR_PO_MISMATCH check';
  END IF;

  SELECT prosrc ~ 'vendor_bill_drift' INTO v_create_has_soft_warn
  FROM pg_proc WHERE proname='create_vendor_bill' AND pronamespace='public'::regnamespace;
  IF NOT COALESCE(v_create_has_soft_warn, false) THEN
    RAISE EXCEPTION 'codex-fix verification: create_vendor_bill lost vendor_bill_drift soft-warn';
  END IF;

  -- Overload check — exactly one of each
  SELECT count(*) INTO v_update_overload_count
  FROM pg_proc WHERE proname='update_vendor_bill' AND pronamespace='public'::regnamespace;
  IF v_update_overload_count <> 1 THEN
    RAISE EXCEPTION 'codex-fix verification: expected 1 overload of update_vendor_bill, found %', v_update_overload_count;
  END IF;

  SELECT count(*) INTO v_create_overload_count
  FROM pg_proc WHERE proname='create_vendor_bill' AND pronamespace='public'::regnamespace;
  IF v_create_overload_count <> 1 THEN
    RAISE EXCEPTION 'codex-fix verification: expected 1 overload of create_vendor_bill, found %', v_create_overload_count;
  END IF;

  RAISE NOTICE 'codex-fix verification passed: vendor bill positive-total guards restored.';
END;
$$;
