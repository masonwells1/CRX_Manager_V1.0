-- idempotency-body-check: exempt
-- (Uses check_idempotency / save_idempotency helpers per CLAUDE.md
-- "Canonical Patterns for New RPCs". See PR-10 migration header.)
-- ============================================================================
-- Audit fix sprint PR-22b — Deferred AP polish completion
-- ============================================================================
-- Plan: docs/audits/2026-05-09-implementation-plan.md (PR-22)
-- Audit findings: P3 items #1, #2, #3 from the AP-polish bundle. PR-22 (the
-- Sprint 2 partial) closed items #4, #5, #6; this migration closes the
-- remaining 3 by modifying 3 RPC bodies that PR-04 / PR-10 owned.
--
-- ⚠️ NOT YET APPLIED to live Supabase (rhyzpcqhnizqbxphqdkr).
-- ⚠️ DEPENDS ON BOTH:
--   - PR-04 (20260510030000_ap_structural_fixes.sql) — for create_vendor_bill
--     base body (with idempotency, period guard, audit log)
--   - PR-10 (20260510080000_bulk_idempotency_wiring.sql) — for the
--     delete_purchase_order body with canonical idempotency
--
-- This migration is the LATEST DEFINITIVE BODY for these 3 functions; it
-- supersedes both PR-04's create_vendor_bill and PR-10's delete_purchase_order.
-- Apply order: PR-04 → PR-10 → PR-13 → PR-14 → PR-22 → PR-22b. Each step is
-- idempotent if applied alone.
--
-- Items applied:
--   ✅ #1 — PO cancel/delete: refuse if any active vendor_bills are linked
--           (cancel_purchase_order + delete_purchase_order both gain the
--           pre-check raising 'PO_HAS_ACTIVE_BILLS' on linked unpaid bills).
--   ✅ #2 — create_vendor_bill PO-to-bill amount soft warn (>5% off PO total
--           when p_purchase_order_id IS NOT NULL). Inserts notification rows
--           for admins; never blocks the bill creation itself.
--   ✅ #3 — create_vendor_bill PO-to-bill vendor consistency. Verifies that
--           vendors.name (looked up via p_vendor_id) matches
--           purchase_orders.vendor (legacy TEXT column). Raises
--           'VENDOR_PO_MISMATCH' on mismatch.
--
-- Note on #2 5% threshold: the comparison uses `ABS(bill - po) > po * 0.05`.
-- POs can have line items added/removed after creation, so a small drift is
-- normal. >5% suggests a typo or wrong-PO selection — worth a notification
-- but not blocking. Mason can tune the threshold by editing this RPC.
--
-- Note on #3: `purchase_orders.vendor` is the legacy TEXT column (the FK
-- migration to vendor_id is documented as out of scope in CLAUDE.md). When
-- a vendor's name changes, this check might false-positive on old POs. The
-- right long-term fix is the vendor_id FK migration; this is a defensive
-- check until that lands.
-- ============================================================================

-- ─── #1a — cancel_purchase_order with linked-bill guard ───────────────────

CREATE OR REPLACE FUNCTION public.cancel_purchase_order(
  p_po_id uuid,
  p_reason text DEFAULT 'Cancelled',
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_po record;
  v_actor uuid;
  v_cached_result jsonb;
  v_result jsonb;
  v_received_qty numeric;
  v_active_bill_count integer;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by <> v_actor THEN
    RAISE EXCEPTION 'Actor mismatch';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := check_idempotency(p_idempotency_key, 'cancel_purchase_order');
    IF v_cached_result IS NOT NULL THEN RETURN v_cached_result; END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Only admins can cancel purchase orders';
  END IF;

  SELECT * INTO v_po FROM purchase_orders WHERE id = p_po_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase order not found'; END IF;

  IF v_po.status = 'cancelled' THEN
    v_result := jsonb_build_object('status', 'already_cancelled', 'po_id', p_po_id, 'po_number', v_po.po_number);
    IF p_idempotency_key IS NOT NULL THEN
      PERFORM save_idempotency(p_idempotency_key, 'cancel_purchase_order', v_result);
    END IF;
    RETURN v_result;
  END IF;

  -- PR-22b #1: refuse if active vendor_bills are linked
  SELECT count(*) INTO v_active_bill_count
  FROM vendor_bills
  WHERE purchase_order_id = p_po_id
    AND status NOT IN ('voided')
    AND deleted_at IS NULL;

  IF v_active_bill_count > 0 THEN
    RAISE EXCEPTION 'PO_HAS_ACTIVE_BILLS: cannot cancel PO % — % active vendor bill(s) reference it. Void the bill(s) first.',
      v_po.po_number, v_active_bill_count;
  END IF;

  SELECT COALESCE(SUM(quantity_received), 0) INTO v_received_qty
  FROM purchase_order_items
  WHERE purchase_order_id = p_po_id;

  IF v_received_qty > 0 THEN
    RAISE EXCEPTION 'Cannot cancel PO %: % units already received. Use partial receive workflow instead.',
      v_po.po_number, v_received_qty;
  END IF;

  IF v_po.status = 'fully_received' THEN
    RAISE EXCEPTION 'Cannot cancel PO %: already fully received', v_po.po_number;
  END IF;

  UPDATE purchase_orders SET
    status = 'cancelled',
    cancelled_at = now(),
    cancelled_by = v_actor,
    cancel_reason = COALESCE(NULLIF(TRIM(p_reason), ''), 'Cancelled'),
    updated_at = now()
  WHERE id = p_po_id;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id
  ) VALUES (
    'po_cancelled',
    'Purchase order ' || v_po.po_number || ' cancelled. Reason: '
      || COALESCE(NULLIF(TRIM(p_reason), ''), 'Cancelled'),
    v_actor, 'purchase_order', p_po_id
  );

  v_result := jsonb_build_object('status', 'cancelled', 'po_id', p_po_id, 'po_number', v_po.po_number);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'cancel_purchase_order', v_result);
  END IF;

  RETURN v_result;
END;
$$;

-- ─── #1b — delete_purchase_order with linked-bill guard ───────────────────

CREATE OR REPLACE FUNCTION public.delete_purchase_order(
  p_po_id uuid,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_po record;
  v_has_received boolean;
  v_active_bill_count integer;
  v_result jsonb;
  v_existing jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Actor mismatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Only admins can delete purchase orders';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'delete_purchase_order');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_po FROM purchase_orders WHERE id = p_po_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase order not found'; END IF;

  -- PR-22b #1: refuse if any vendor_bills (active or voided) are linked.
  -- Stricter than cancel — delete is permanent, so even voided bills are
  -- a reason to refuse (they're audit history).
  SELECT count(*) INTO v_active_bill_count
  FROM vendor_bills
  WHERE purchase_order_id = p_po_id AND deleted_at IS NULL;

  IF v_active_bill_count > 0 THEN
    RAISE EXCEPTION 'PO_HAS_LINKED_BILLS: cannot delete PO % — % vendor bill(s) reference it. Cancel the PO instead.',
      v_po.po_number, v_active_bill_count;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM purchase_order_items
    WHERE purchase_order_id = p_po_id AND quantity_received > 0
  ) INTO v_has_received;

  IF v_has_received THEN
    RAISE EXCEPTION 'Cannot delete PO % — items have already been received. Cancel instead.', v_po.po_number;
  END IF;

  DELETE FROM purchase_order_items WHERE purchase_order_id = p_po_id;
  DELETE FROM purchase_orders WHERE id = p_po_id;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id
  ) VALUES (
    'po_deleted',
    'PO ' || v_po.po_number || ' deleted',
    v_actor, 'purchase_order', p_po_id
  );

  v_result := jsonb_build_object('status', 'deleted');

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'delete_purchase_order', v_result);
  END IF;

  RETURN v_result;
END;
$$;

-- ─── #2 + #3 — create_vendor_bill with PO consistency + soft-warn ─────────
-- Body verbatim from PR-04 (20260510030000) + new PO-link checks added
-- after the vendor-active check, before the INSERT.

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

  -- PR-22b #3: PO-to-bill vendor consistency check.
  -- purchase_orders.vendor is the legacy TEXT column (vendor_id FK is out
  -- of scope per CLAUDE.md). Compare vendor.name with po.vendor.
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
    -- PO total is computed from purchase_order_items: SUM(qty * unit_cost) * 100.
    SELECT COALESCE(SUM(quantity_ordered * unit_cost * 100)::bigint, 0)
      INTO v_po_total_cents
    FROM purchase_order_items
    WHERE purchase_order_id = p_purchase_order_id;

    IF v_po_total_cents > 0 THEN
      v_amount_drift_pct := ABS(v_total - v_po_total_cents)::numeric / v_po_total_cents::numeric;
      IF v_amount_drift_pct > 0.05 THEN
        -- Insert notification for every active admin. Soft warn — does NOT block.
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

  -- Resolve payment terms
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

  -- Insert bill (balance_cents GENERATED post-PR-04)
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

  -- Audit log
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
  v_cancel_has_check boolean;
  v_delete_has_check boolean;
  v_create_has_consistency_check boolean;
  v_create_has_soft_warn boolean;
BEGIN
  SELECT prosrc ~ 'PO_HAS_ACTIVE_BILLS' INTO v_cancel_has_check
  FROM pg_proc WHERE proname='cancel_purchase_order' AND pronamespace='public'::regnamespace;
  IF NOT COALESCE(v_cancel_has_check, false) THEN
    RAISE EXCEPTION 'PR-22b verification: cancel_purchase_order missing PO_HAS_ACTIVE_BILLS check';
  END IF;

  SELECT prosrc ~ 'PO_HAS_LINKED_BILLS' INTO v_delete_has_check
  FROM pg_proc WHERE proname='delete_purchase_order' AND pronamespace='public'::regnamespace;
  IF NOT COALESCE(v_delete_has_check, false) THEN
    RAISE EXCEPTION 'PR-22b verification: delete_purchase_order missing PO_HAS_LINKED_BILLS check';
  END IF;

  SELECT prosrc ~ 'VENDOR_PO_MISMATCH' INTO v_create_has_consistency_check
  FROM pg_proc WHERE proname='create_vendor_bill' AND pronamespace='public'::regnamespace;
  IF NOT COALESCE(v_create_has_consistency_check, false) THEN
    RAISE EXCEPTION 'PR-22b verification: create_vendor_bill missing VENDOR_PO_MISMATCH check';
  END IF;

  SELECT prosrc ~ 'vendor_bill_drift' INTO v_create_has_soft_warn
  FROM pg_proc WHERE proname='create_vendor_bill' AND pronamespace='public'::regnamespace;
  IF NOT COALESCE(v_create_has_soft_warn, false) THEN
    RAISE EXCEPTION 'PR-22b verification: create_vendor_bill missing vendor_bill_drift soft-warn';
  END IF;

  RAISE NOTICE 'PR-22b verification passed: all 3 deferred AP polish items applied.';
END;
$$;
