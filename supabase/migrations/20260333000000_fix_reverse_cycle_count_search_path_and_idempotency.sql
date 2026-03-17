-- ============================================================================
-- Fix reverse_completed_cycle_count():
-- 1. Add pg_temp to search_path (SECURITY DEFINER requirement)
-- 2. Wire up p_idempotency_key (was declared but never used)
-- 3. Add GRANT for authenticated role
-- ============================================================================

DROP FUNCTION IF EXISTS public.reverse_completed_cycle_count(uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.reverse_completed_cycle_count(
  p_cycle_count_id uuid,
  p_reversed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count record;
  v_item  record;
  v_new_qty numeric;
  v_existing jsonb;
BEGIN
  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'reverse_completed_cycle_count');
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;

  -- Lock the cycle count row
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

  -- Reverse each inventory adjustment that was made
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
      -- Reverse the variance: subtract what was added (or add what was subtracted)
      v_new_qty := GREATEST(0, v_item.quantity_available - v_item.variance);

      UPDATE inventory
      SET quantity_available = v_new_qty,
          updated_at = now()
      WHERE id = v_item.inventory_id;

      -- Audit trail: reversed adjustment
      INSERT INTO inventory_transactions (
        product_id, transaction_type, quantity,
        to_location, performed_by, notes
      ) VALUES (
        v_item.product_id, 'adjusted', -v_item.variance,
        (SELECT location FROM inventory WHERE id = v_item.inventory_id),
        p_reversed_by,
        'REVERSED cycle count ' || v_count.count_number ||
        ': undid adjustment of ' || v_item.variance ||
        ' (was ' || v_item.expected_qty || ' -> ' || v_item.counted_qty || ')'
      );
    END IF;
  END LOOP;

  -- Mark cycle count as cancelled
  UPDATE cycle_counts
  SET status = 'cancelled',
      notes = COALESCE(notes || E'\n', '') || 'Reversed on ' || to_char(now(), 'YYYY-MM-DD HH24:MI') || ' by user ' || p_reversed_by::text
  WHERE id = p_cycle_count_id;

  -- Save idempotency
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'reverse_completed_cycle_count', '{}'::jsonb);
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reverse_completed_cycle_count(uuid, uuid, text) TO authenticated;

-- Verify no overloads
DO $$
BEGIN
  IF (SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
      WHERE n.nspname = 'public' AND p.proname = 'reverse_completed_cycle_count') != 1 THEN
    RAISE EXCEPTION 'OVERLOAD DETECTED for reverse_completed_cycle_count';
  END IF;
END;
$$;
