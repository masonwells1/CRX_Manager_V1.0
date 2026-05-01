-- =============================================================================
-- Migration: 20260501130000_field_app_workflow_phase18.sql
-- Phase 18 — Sprint E #3: cycle count item edit gating
--
-- Closes the gap noted in
-- docs/audits/2026-04-30-data-integrity-workflow-locks-audit-findings.md
-- (referenced in the v2 handoff). cycle_count_items rows were directly
-- editable from React via PostgREST `.update()` calls without any check
-- of the parent cycle_counts.status. After a cycle count completed, an
-- admin could still mutate counted_qty/variance — the row's evidence
-- would disagree with the inventory_transactions row that completion
-- already wrote.
--
-- This migration adds two RPCs and tightens RLS:
--
-- 1. update_cycle_count_item(p_item_id, p_counted_qty, p_notes,
--                            p_performed_by, p_idempotency_key)
--    Locks the parent cycle_counts row, validates status='in_progress',
--    computes variance + variance_pct server-side (single source of
--    truth), and updates the item.
--
-- 2. cancel_cycle_count(p_cycle_count_id, p_performed_by, p_idempotency_key)
--    Replaces the direct UPDATE in CycleCounts.tsx:333-338. Validates
--    status='in_progress' before flipping to 'cancelled'. Auth-gated
--    admin-only.
--
-- 3. RLS WITH CHECK on cycle_count_items UPDATE/DELETE:
--    Adds a parent-status guard so even if a future bug bypassed the
--    RPC, PostgREST direct writes would be blocked when parent is not
--    in_progress. Defense in depth — the RPC and the RLS both enforce
--    the same invariant.
--
-- Auth gate: admin-only (matches Phases 16+17, all destructive
-- inventory operations). Strict pattern: auth.uid() not null +
-- p_performed_by mismatch reject + is_admin() role check.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. update_cycle_count_item
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.update_cycle_count_item(uuid, numeric, text, uuid, text);

CREATE OR REPLACE FUNCTION public.update_cycle_count_item(
  p_item_id         uuid,
  p_counted_qty     numeric DEFAULT NULL,
  p_notes           text DEFAULT NULL,
  p_performed_by    uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor        uuid;
  v_existing     jsonb;
  v_item         record;
  v_count        record;
  v_variance     numeric;
  v_variance_pct numeric;
  v_result       jsonb;
BEGIN
  -- ---- Auth gate ---------------------------------------------------------
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Admin access required to update cycle count items';
  END IF;

  -- ---- Idempotency -------------------------------------------------------
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'update_cycle_count_item');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  -- ---- Lock the parent cycle count ---------------------------------------
  SELECT cc.* INTO v_count
    FROM cycle_count_items cci
    JOIN cycle_counts cc ON cc.id = cci.cycle_count_id
   WHERE cci.id = p_item_id
     FOR UPDATE OF cc;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cycle count item not found: %', p_item_id;
  END IF;

  IF v_count.status != 'in_progress' THEN
    RAISE EXCEPTION 'Cannot edit cycle count item: parent count is % (only in_progress counts can be edited)', v_count.status;
  END IF;

  -- ---- Load the item row (now safe; parent is locked) -------------------
  SELECT * INTO v_item FROM cycle_count_items WHERE id = p_item_id;

  -- ---- Compute variance server-side (single source of truth) ------------
  IF p_counted_qty IS NOT NULL THEN
    v_variance := p_counted_qty - v_item.expected_qty;
    IF v_item.expected_qty <> 0 THEN
      v_variance_pct := round((v_variance / v_item.expected_qty) * 100, 2);
    ELSE
      v_variance_pct := NULL;
    END IF;
  ELSE
    v_variance := NULL;
    v_variance_pct := NULL;
  END IF;

  -- ---- Apply update ------------------------------------------------------
  UPDATE cycle_count_items
  SET counted_qty  = p_counted_qty,
      variance     = v_variance,
      variance_pct = v_variance_pct,
      is_counted   = (p_counted_qty IS NOT NULL),
      counted_by   = CASE WHEN p_counted_qty IS NOT NULL THEN v_actor ELSE NULL END,
      counted_at   = CASE WHEN p_counted_qty IS NOT NULL THEN now() ELSE NULL END,
      notes        = COALESCE(p_notes, notes)
  WHERE id = p_item_id;

  v_result := jsonb_build_object(
    'item_id',      p_item_id,
    'counted_qty',  p_counted_qty,
    'variance',     v_variance,
    'variance_pct', v_variance_pct,
    'is_counted',   (p_counted_qty IS NOT NULL)
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'update_cycle_count_item', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_cycle_count_item(uuid, numeric, text, uuid, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 2. cancel_cycle_count
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.cancel_cycle_count(uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.cancel_cycle_count(
  p_cycle_count_id  uuid,
  p_performed_by    uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor    uuid;
  v_existing jsonb;
  v_count    record;
  v_result   jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Admin access required to cancel a cycle count';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'cancel_cycle_count');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_count FROM cycle_counts WHERE id = p_cycle_count_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cycle count not found: %', p_cycle_count_id;
  END IF;

  IF v_count.status != 'in_progress' THEN
    RAISE EXCEPTION 'Cannot cancel: cycle count is % (only in_progress counts can be cancelled)', v_count.status;
  END IF;

  UPDATE cycle_counts
  SET status = 'cancelled',
      notes  = COALESCE(notes || E'\n', '') || 'Cancelled on ' ||
               to_char(now(), 'YYYY-MM-DD HH24:MI') || ' by user ' || v_actor::text
  WHERE id = p_cycle_count_id;

  v_result := jsonb_build_object(
    'cycle_count_id', p_cycle_count_id,
    'status',         'cancelled'
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'cancel_cycle_count', v_result);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cancel_cycle_count(uuid, uuid, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 3. RLS guard on cycle_count_items — defense in depth
--    Even if a future code path bypassed the RPC, direct PostgREST
--    .update() / .delete() are now blocked when the parent is not
--    in_progress. Insert is unchanged (admin-only) since items are
--    typically inserted at count creation, before in_progress flips
--    are even meaningful — but we still gate insert on the parent
--    being in_progress for symmetry.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS cycle_count_items_insert ON cycle_count_items;
CREATE POLICY cycle_count_items_insert ON cycle_count_items
  FOR INSERT WITH CHECK (
    is_admin() AND EXISTS (
      SELECT 1 FROM cycle_counts cc
      WHERE cc.id = cycle_count_id AND cc.status = 'in_progress'
    )
  );

DROP POLICY IF EXISTS cycle_count_items_update ON cycle_count_items;
CREATE POLICY cycle_count_items_update ON cycle_count_items
  FOR UPDATE
  USING (
    is_admin() AND EXISTS (
      SELECT 1 FROM cycle_counts cc
      WHERE cc.id = cycle_count_id AND cc.status = 'in_progress'
    )
  )
  WITH CHECK (
    is_admin() AND EXISTS (
      SELECT 1 FROM cycle_counts cc
      WHERE cc.id = cycle_count_id AND cc.status = 'in_progress'
    )
  );

DROP POLICY IF EXISTS cycle_count_items_delete ON cycle_count_items;
CREATE POLICY cycle_count_items_delete ON cycle_count_items
  FOR DELETE
  USING (
    is_admin() AND EXISTS (
      SELECT 1 FROM cycle_counts cc
      WHERE cc.id = cycle_count_id AND cc.status = 'in_progress'
    )
  );

-- -----------------------------------------------------------------------------
-- Verify no overloads
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF (SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
      WHERE n.nspname = 'public' AND p.proname = 'update_cycle_count_item') != 1 THEN
    RAISE EXCEPTION 'OVERLOAD DETECTED for update_cycle_count_item';
  END IF;
  IF (SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
      WHERE n.nspname = 'public' AND p.proname = 'cancel_cycle_count') != 1 THEN
    RAISE EXCEPTION 'OVERLOAD DETECTED for cancel_cycle_count';
  END IF;
END;
$$;
