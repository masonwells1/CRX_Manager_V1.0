-- ============================================================================
-- SECURITY AUDIT REMEDIATION — Phase 2
-- Migration: 20260317200001_po_cancel_soft_delete.sql
--
-- Fixes: P1-005 (PO soft-delete)
--
-- Changes:
--   1. Add cancel metadata columns to purchase_orders
--   2. Create cancel_purchase_order() RPC with auth.uid() enforcement
--   3. Keep delete_purchase_order as-is (hardened in Phase 1)
-- ============================================================================


-- ============================================================================
-- 1. Add cancel metadata columns to purchase_orders
--
-- The table already has 'cancelled' in its status CHECK constraint, so we
-- only need the metadata columns to track who cancelled and why.
-- ============================================================================

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS cancelled_at  timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by  uuid REFERENCES profiles(id),
  ADD COLUMN IF NOT EXISTS cancel_reason text;


-- ============================================================================
-- 2. cancel_purchase_order() — Soft-cancel a PO
--
-- Rules:
--   - Admin-only
--   - Blocks if ANY items have been received (quantity_received > 0)
--   - Sets status = 'cancelled' + fills cancel metadata
--   - Logs to activity_feed
--   - auth.uid() enforced (Phase 1 pattern)
--   - Idempotent via idempotency_keys
-- ============================================================================

CREATE OR REPLACE FUNCTION cancel_purchase_order(
  p_po_id           uuid,
  p_reason          text DEFAULT 'Cancelled',
  p_performed_by    uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_po            record;
  v_actor         uuid;
  v_cached_result jsonb;
  v_result        jsonb;
  v_received_qty  numeric;
BEGIN
  -- ── auth.uid() enforcement (Phase 1 pattern) ──
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by <> v_actor THEN
    RAISE EXCEPTION 'Actor mismatch';
  END IF;

  -- ── Idempotency check ──
  IF p_idempotency_key IS NOT NULL THEN
    v_cached_result := check_idempotency(p_idempotency_key, 'cancel_purchase_order');
    IF v_cached_result IS NOT NULL THEN
      RETURN v_cached_result;
    END IF;
  END IF;

  -- ── Verify caller is admin ──
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Only admins can cancel purchase orders';
  END IF;

  -- ── Lock the PO row ──
  SELECT * INTO v_po
  FROM purchase_orders WHERE id = p_po_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase order not found';
  END IF;

  -- ── Idempotent: already cancelled ──
  IF v_po.status = 'cancelled' THEN
    v_result := jsonb_build_object(
      'status',    'already_cancelled',
      'po_id',     p_po_id,
      'po_number', v_po.po_number
    );
    IF p_idempotency_key IS NOT NULL THEN
      PERFORM save_idempotency(p_idempotency_key, 'cancel_purchase_order', v_result);
    END IF;
    RETURN v_result;
  END IF;

  -- ── Block if any items have been received ──
  SELECT COALESCE(SUM(quantity_received), 0) INTO v_received_qty
  FROM purchase_order_items
  WHERE purchase_order_id = p_po_id;

  IF v_received_qty > 0 THEN
    RAISE EXCEPTION 'Cannot cancel PO %: % units already received. Use partial receive workflow instead.',
      v_po.po_number, v_received_qty;
  END IF;

  -- ── Block if fully received ──
  IF v_po.status = 'fully_received' THEN
    RAISE EXCEPTION 'Cannot cancel PO %: already fully received', v_po.po_number;
  END IF;

  -- ── Soft-cancel: update status + metadata ──
  UPDATE purchase_orders SET
    status       = 'cancelled',
    cancelled_at = now(),
    cancelled_by = v_actor,
    cancel_reason = COALESCE(NULLIF(TRIM(p_reason), ''), 'Cancelled'),
    updated_at   = now()
  WHERE id = p_po_id;

  -- ── Activity log ──
  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id
  ) VALUES (
    'po_cancelled',
    'Purchase order ' || v_po.po_number || ' cancelled. Reason: '
      || COALESCE(NULLIF(TRIM(p_reason), ''), 'Cancelled'),
    v_actor,
    'purchase_order', p_po_id
  );

  -- ── Build result ──
  v_result := jsonb_build_object(
    'status',    'cancelled',
    'po_id',     p_po_id,
    'po_number', v_po.po_number
  );

  -- ── Save idempotency key ──
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'cancel_purchase_order', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION cancel_purchase_order(uuid, text, uuid, text) TO authenticated;
