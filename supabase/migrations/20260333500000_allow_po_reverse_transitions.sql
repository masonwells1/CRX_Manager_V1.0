-- ============================================================================
-- Migration: 20260333500000_allow_po_reverse_transitions.sql
--
-- FIX: reverse_receiving_record fails with:
--   "Invalid purchase order status transition: fully_received → partially_received"
--
-- The PO status guard only allowed forward transitions. When reversing a
-- receiving record, the PO needs to go backward:
--   fully_received → partially_received (some items still received)
--   fully_received → submitted          (all items reversed, none received)
--   partially_received → submitted      (last partial reversed)
--
-- Two fixes:
--   1. Add reverse transitions to _enforce_po_status_transition()
--   2. Set app.admin_override in reverse_receiving_record() so the guard
--      allows the transition
-- ============================================================================


-- ============================================================================
-- 1. Update PO status transition guard to allow reversals
-- ============================================================================
CREATE OR REPLACE FUNCTION _enforce_po_status_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF _is_admin_override() THEN RETURN NEW; END IF;

  -- Forward transitions
  IF (OLD.status = 'draft' AND NEW.status IN ('submitted', 'cancelled'))
  OR (OLD.status = 'submitted' AND NEW.status IN ('partially_received', 'fully_received', 'cancelled'))
  OR (OLD.status = 'partially_received' AND NEW.status IN ('fully_received', 'cancelled'))
  -- Reverse transitions (receiving reversals)
  OR (OLD.status = 'fully_received' AND NEW.status IN ('partially_received', 'submitted'))
  OR (OLD.status = 'partially_received' AND NEW.status = 'submitted')
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Invalid purchase order status transition: % → %', OLD.status, NEW.status;
END;
$$;


-- ============================================================================
-- 2. Update reverse_receiving_record to set admin override before PO update
--    (Belt-and-suspenders: the transition guard now allows it explicitly,
--     AND the admin override is set as a safety net)
-- ============================================================================
DROP FUNCTION IF EXISTS public.reverse_receiving_record(uuid, text, uuid, text);

CREATE OR REPLACE FUNCTION public.reverse_receiving_record(
  p_record_id        uuid,
  p_reason           text    DEFAULT 'Manually reversed',
  p_performed_by     uuid    DEFAULT NULL,
  p_idempotency_key  text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rec    record;
  v_actor  uuid;
  v_existing jsonb;
BEGIN
  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN
      RETURN jsonb_build_object('success', true, 'record_id', p_record_id, 'idempotent', true);
    END IF;
  END IF;

  v_actor := COALESCE(p_performed_by, auth.uid());

  -- Admin-only: receiving reversals are inventory adjustments
  IF (SELECT role FROM profiles WHERE id = v_actor) != 'admin' THEN
    RAISE EXCEPTION 'Admin access required to reverse receiving records';
  END IF;

  -- Lock and fetch the record
  SELECT * INTO v_rec
  FROM receiving_records
  WHERE id = p_record_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Receiving record not found: %', p_record_id;
  END IF;

  -- Set flags for safety trigger + status transition guard
  PERFORM set_config('app.reversal_rpc_active', 'true', true);
  PERFORM set_config('app.admin_override', 'true', true);

  -- Reverse inventory: subtract what was added at receive time
  UPDATE inventory
  SET quantity_available = GREATEST(quantity_available - v_rec.quantity_received, 0),
      updated_at         = now()
  WHERE product_id = v_rec.product_id
    AND location   = v_rec.storage_location;

  -- Log the inventory adjustment
  INSERT INTO inventory_transactions (
    product_id, transaction_type, quantity, to_location,
    notes, performed_by
  ) VALUES (
    v_rec.product_id,
    'adjusted',
    -1 * v_rec.quantity_received,
    v_rec.storage_location,
    'Reversed receiving record ' || p_record_id::text || ': ' || p_reason,
    v_actor
  );

  -- Roll back the PO item quantity_received counter
  UPDATE purchase_order_items
  SET quantity_received = GREATEST(quantity_received - v_rec.quantity_received, 0)
  WHERE id = v_rec.po_item_id;

  -- Re-evaluate PO status after rolling back the item
  UPDATE purchase_orders
  SET status = CASE
    WHEN (
      SELECT bool_and(quantity_received = 0)
      FROM purchase_order_items
      WHERE purchase_order_id = v_rec.purchase_order_id
    ) THEN 'submitted'
    WHEN (
      SELECT bool_and(quantity_received >= quantity_ordered)
      FROM purchase_order_items
      WHERE purchase_order_id = v_rec.purchase_order_id
    ) THEN 'fully_received'
    ELSE 'partially_received'
  END,
  updated_at = now()
  WHERE id = v_rec.purchase_order_id;

  -- Delete the receiving record and its photos
  DELETE FROM receiving_photos WHERE receiving_record_id = p_record_id;
  DELETE FROM receiving_records WHERE id = p_record_id;

  -- Save idempotency key
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'reverse_receiving_record', to_jsonb(p_record_id::text));
  END IF;

  RETURN jsonb_build_object(
    'success',             true,
    'record_id',           p_record_id,
    'product_id',          v_rec.product_id,
    'quantity_reversed',   v_rec.quantity_received,
    'storage_location',    v_rec.storage_location
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.reverse_receiving_record(uuid, text, uuid, text) TO authenticated;


-- ============================================================================
-- VERIFICATION
-- ============================================================================
DO $$
DECLARE v_count integer;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE p.proname = 'reverse_receiving_record' AND n.nspname = 'public';

  IF v_count != 1 THEN
    RAISE EXCEPTION 'VERIFICATION FAILED: reverse_receiving_record has % overloads (expected 1)', v_count;
  END IF;

  SELECT count(*) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE p.proname = '_enforce_po_status_transition' AND n.nspname = 'public';

  IF v_count != 1 THEN
    RAISE EXCEPTION 'VERIFICATION FAILED: _enforce_po_status_transition has % overloads (expected 1)', v_count;
  END IF;

  RAISE NOTICE 'VERIFICATION PASSED: Both functions have exactly 1 overload';
END;
$$;
