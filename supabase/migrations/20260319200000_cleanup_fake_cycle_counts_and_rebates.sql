-- ============================================================================
-- ONE-TIME CLEANUP: Reverse all completed cycle counts & delete fake rebates
-- All cycle count data is fake test data. Completed counts already adjusted
-- inventory, so we reverse those adjustments before cancelling.
-- All rebate programs and claims are also fake test data.
-- ============================================================================

DO $$
DECLARE
  v_admin_id uuid := '22c1fc50-4d2a-4baa-8ff8-341c0c7edd4f';
  v_count record;
  v_item  record;
  v_new_qty numeric;
  v_reversed_count integer := 0;
  v_cancelled_count integer := 0;
BEGIN
  -- Reverse all completed cycle counts
  FOR v_count IN
    SELECT * FROM cycle_counts WHERE status = 'completed' FOR UPDATE
  LOOP
    FOR v_item IN
      SELECT cci.*, i.quantity_available, i.location
      FROM cycle_count_items cci
      LEFT JOIN inventory i ON i.id = cci.inventory_id
      WHERE cci.cycle_count_id = v_count.id
        AND cci.is_counted = true
        AND cci.variance IS NOT NULL
        AND cci.variance <> 0
    LOOP
      IF v_item.inventory_id IS NOT NULL AND v_item.quantity_available IS NOT NULL THEN
        v_new_qty := GREATEST(0, v_item.quantity_available - v_item.variance);

        UPDATE inventory
        SET quantity_available = v_new_qty,
            updated_at = now()
        WHERE id = v_item.inventory_id;

        INSERT INTO inventory_transactions (
          product_id, transaction_type, quantity,
          to_location, performed_by, notes
        ) VALUES (
          v_item.product_id, 'adjusted', -v_item.variance,
          v_item.location, v_admin_id,
          'DATA CLEANUP: reversed fake cycle count ' || v_count.count_number
        );
      END IF;
    END LOOP;

    UPDATE cycle_counts
    SET status = 'cancelled',
        notes = COALESCE(notes || E'\n', '') || 'Data cleanup: reversed fake test data on ' || to_char(now(), 'YYYY-MM-DD')
    WHERE id = v_count.id;

    v_reversed_count := v_reversed_count + 1;
  END LOOP;

  -- Cancel all in-progress cycle counts (no inventory impact to reverse)
  UPDATE cycle_counts
  SET status = 'cancelled',
      notes = COALESCE(notes || E'\n', '') || 'Data cleanup: cancelled fake test data on ' || to_char(now(), 'YYYY-MM-DD')
  WHERE status = 'in_progress';

  GET DIAGNOSTICS v_cancelled_count = ROW_COUNT;

  RAISE NOTICE 'Cycle counts: reversed % completed, cancelled % in-progress',
    v_reversed_count, v_cancelled_count;
END;
$$;

-- Delete all fake rebate data (claims first due to FK)
DELETE FROM rebate_claims;
DELETE FROM rebate_programs;
