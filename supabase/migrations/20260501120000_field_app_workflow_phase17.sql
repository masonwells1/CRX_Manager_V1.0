-- =============================================================================
-- Migration: 20260501120000_field_app_workflow_phase17.sql
-- Phase 17 — Sprint E #2: cycle count clamp/ledger drift fix (E2a — block)
--
-- Closes audit finding P1-4 from
-- docs/audits/2026-04-30-data-integrity-workflow-locks-audit-findings.md.
--
-- The previous behavior of `complete_cycle_count` and `reverse_completed_cycle_count`
-- silently clamped inventory.quantity_available at zero with GREATEST(0, ...) but
-- recorded the FULL variance in inventory_transactions. The result was permanent
-- drift between the ledger ("we removed 10") and the on-hand ("we removed 5,
-- the rest was clamped"). Reversing such a count compounded the drift.
--
-- Mason chose option E2a: block when math would drive on-hand negative, with a
-- clear actionable error pointing at the upstream issue (missing delivery,
-- unlogged return, etc.). Cycle count remains in_progress until reconciled.
--
-- Also closes a latent bug: the frontend at src/pages/CycleCounts.tsx:300
-- passes `p_idempotency_key` but the previous `complete_cycle_count` signature
-- did not declare it, so the key was silently dropped. Phase 17 wires it up.
--
-- Auth gate: admin-only (matches retire_inventory_item from Phase 16, which is
-- the closest analog — both are destructive inventory operations).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- complete_cycle_count
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.complete_cycle_count(uuid, uuid);
DROP FUNCTION IF EXISTS public.complete_cycle_count(uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.complete_cycle_count(
  p_cycle_count_id  uuid,
  p_completed_by    uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor    uuid;
  v_item     RECORD;
  v_count    record;
  v_new_qty  numeric;
  v_existing jsonb;
BEGIN
  -- ---- Auth gate (matches retire_inventory_item / Phase 16 pattern) -----
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_completed_by IS NOT NULL AND p_completed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_completed_by does not match authenticated user';
  END IF;
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Admin access required to complete a cycle count';
  END IF;

  -- ---- Idempotency check ------------------------------------------------
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'complete_cycle_count');
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;

  -- ---- Lock the cycle count row ----------------------------------------
  SELECT * INTO v_count
    FROM cycle_counts
   WHERE id = p_cycle_count_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cycle count not found';
  END IF;

  IF v_count.status != 'in_progress' THEN
    RAISE EXCEPTION 'Cycle count is not in progress (current status: %)', v_count.status;
  END IF;

  -- ---- Apply each variance, blocking if math would go negative --------
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
      -- E2a: block when on-hand + variance would go below zero. The whole
      -- transaction rolls back; cycle count stays in_progress so a manager
      -- can investigate the upstream discrepancy before retrying.
      IF COALESCE(v_item.quantity_available, 0) + v_item.variance < 0 THEN
        RAISE EXCEPTION 'Cycle count adjustment for product % would set on-hand to % (currently %, variance %). Resolve upstream discrepancy (missing delivery, unlogged return, prior reconciliation gap) before completing this count.',
          v_item.product_id,
          COALESCE(v_item.quantity_available, 0) + v_item.variance,
          COALESCE(v_item.quantity_available, 0),
          v_item.variance;
      END IF;

      v_new_qty := COALESCE(v_item.quantity_available, 0) + v_item.variance;

      UPDATE inventory
      SET quantity_available = v_new_qty,
          last_counted_at    = now(),
          updated_at         = now()
      WHERE id = v_item.inventory_id;

      INSERT INTO inventory_transactions (
        product_id, transaction_type, quantity,
        to_location, performed_by, notes
      ) VALUES (
        v_item.product_id, 'adjusted', v_item.variance,
        v_item.location, v_actor,
        'Cycle count ' || v_count.count_number || ': adjusted from ' ||
        v_item.expected_qty || ' to ' || v_item.counted_qty
      );
    END IF;
  END LOOP;

  -- Update last_counted_at for zero-variance items (no inventory change)
  UPDATE inventory
  SET last_counted_at = now(), updated_at = now()
  WHERE id IN (
    SELECT cci.inventory_id FROM cycle_count_items cci
    WHERE cci.cycle_count_id = p_cycle_count_id
      AND cci.is_counted = true
      AND cci.inventory_id IS NOT NULL
  );

  -- Mark cycle count as completed (cycle_counts has no updated_at column —
  -- intentionally last so the SQL safety hook does not false-positive).
  UPDATE cycle_counts
  SET status       = 'completed',
      completed_by = v_actor,
      completed_at = now()
  WHERE id = p_cycle_count_id;

  -- Save idempotency
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'complete_cycle_count', '{}'::jsonb);
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.complete_cycle_count(uuid, uuid, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- reverse_completed_cycle_count
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.reverse_completed_cycle_count(uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.reverse_completed_cycle_count(
  p_cycle_count_id  uuid,
  p_reversed_by     uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor    uuid;
  v_count    record;
  v_item     record;
  v_new_qty  numeric;
  v_existing jsonb;
BEGIN
  -- ---- Auth gate ---------------------------------------------------------
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_reversed_by IS NOT NULL AND p_reversed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_reversed_by does not match authenticated user';
  END IF;
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Admin access required to reverse a cycle count';
  END IF;

  -- ---- Idempotency check -----------------------------------------------
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'reverse_completed_cycle_count');
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;

  -- ---- Lock the cycle count row ----------------------------------------
  SELECT * INTO v_count
    FROM cycle_counts
   WHERE id = p_cycle_count_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cycle count not found';
  END IF;

  IF v_count.status != 'completed' THEN
    RAISE EXCEPTION 'Only completed cycle counts can be reversed (current status: %)', v_count.status;
  END IF;

  -- ---- Reverse each variance, blocking if math would go negative ------
  FOR v_item IN
    SELECT cci.*, i.quantity_available
    FROM cycle_count_items cci
    LEFT JOIN inventory i ON i.id = cci.inventory_id
    WHERE cci.cycle_count_id = p_cycle_count_id
      AND cci.is_counted = true
      AND cci.variance IS NOT NULL
      AND cci.variance <> 0
  LOOP
    IF v_item.inventory_id IS NOT NULL AND v_item.quantity_available IS NOT NULL THEN
      -- E2a: block when reversing the variance would drive on-hand below
      -- zero. This happens when inventory has moved (deliveries, sales)
      -- between the original count completion and this reversal — manual
      -- reconciliation is required.
      IF COALESCE(v_item.quantity_available, 0) - v_item.variance < 0 THEN
        RAISE EXCEPTION 'Reversing cycle count for product % would set on-hand to % (currently %, would subtract %). Inventory has changed since the count completed; manual reconciliation required before reversing.',
          v_item.product_id,
          COALESCE(v_item.quantity_available, 0) - v_item.variance,
          COALESCE(v_item.quantity_available, 0),
          v_item.variance;
      END IF;

      v_new_qty := COALESCE(v_item.quantity_available, 0) - v_item.variance;

      UPDATE inventory
      SET quantity_available = v_new_qty,
          updated_at         = now()
      WHERE id = v_item.inventory_id;

      INSERT INTO inventory_transactions (
        product_id, transaction_type, quantity,
        to_location, performed_by, notes
      ) VALUES (
        v_item.product_id, 'adjusted', -v_item.variance,
        (SELECT location FROM inventory WHERE id = v_item.inventory_id),
        v_actor,
        'REVERSED cycle count ' || v_count.count_number ||
        ': undid adjustment of ' || v_item.variance ||
        ' (was ' || v_item.expected_qty || ' -> ' || v_item.counted_qty || ')'
      );
    END IF;
  END LOOP;

  -- Mark cycle count as cancelled (cycle_counts has no updated_at — last).
  UPDATE cycle_counts
  SET status = 'cancelled',
      notes  = COALESCE(notes || E'\n', '') || 'Reversed on ' ||
               to_char(now(), 'YYYY-MM-DD HH24:MI') || ' by user ' || v_actor::text
  WHERE id = p_cycle_count_id;

  -- Save idempotency
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'reverse_completed_cycle_count', '{}'::jsonb);
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reverse_completed_cycle_count(uuid, uuid, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- Verify no overloads — single signature each, per migration safety rules
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF (SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
      WHERE n.nspname = 'public' AND p.proname = 'complete_cycle_count') != 1 THEN
    RAISE EXCEPTION 'OVERLOAD DETECTED for complete_cycle_count';
  END IF;
  IF (SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
      WHERE n.nspname = 'public' AND p.proname = 'reverse_completed_cycle_count') != 1 THEN
    RAISE EXCEPTION 'OVERLOAD DETECTED for reverse_completed_cycle_count';
  END IF;
END;
$$;
