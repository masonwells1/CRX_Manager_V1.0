-- ============================================================================
-- Codex remediation-batch review (2026-06-10) — HIGH: the 20260610133241
-- commission recalc updated commission_amount but NOT the denormalized
-- commissions.order_profit, leaving the 4 rows internally inconsistent
-- (e.g. ORD-2026-0189: amount $2,455.37 vs stored profit $250). Reports.tsx
-- displays the stored order_profit, so reports showed the stale figure.
--
-- Fix (data-only): sync order_profit to the order's current total_profit for
-- exactly the same 4 pending rows. All 4 carry a 100% split_percentage, so
-- amount = profit and the row is self-consistent after this UPDATE.
--
-- ORD-2026-0189's prior $50 amount: Mason reviewed on 2026-06-10 and chose
-- to let the canonical recalc stand (chat decision; nothing has been paid).
-- ============================================================================

DO $$
DECLARE v_updated int;
BEGIN
  UPDATE commissions cm
  SET order_profit = o.total_profit
  FROM orders o
  WHERE o.id = cm.order_id
    AND cm.status = 'pending'
    AND o.order_number IN ('ORD-2026-0175','ORD-2026-0176','ORD-2026-0189','ORD-2026-0343');
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 4 THEN
    RAISE EXCEPTION 'Expected to sync exactly 4 commission rows, got % — aborting (rows may have changed status since review)', v_updated;
  END IF;
END $$;

-- Verification: the 4 rows are now internally consistent
DO $$
DECLARE v_bad int;
BEGIN
  SELECT count(*) INTO v_bad
  FROM commissions cm
  JOIN orders o ON o.id = cm.order_id
  WHERE o.order_number IN ('ORD-2026-0175','ORD-2026-0176','ORD-2026-0189','ORD-2026-0343')
    AND cm.status = 'pending'
    AND (
      cm.order_profit IS DISTINCT FROM o.total_profit
      OR round(cm.commission_amount::numeric, 2) IS DISTINCT FROM
         round(GREATEST(cm.order_profit, 0) * cm.split_percentage / 100.0, 2)
    );
  IF v_bad <> 0 THEN
    RAISE EXCEPTION '% commission row(s) still inconsistent after sync', v_bad;
  END IF;
END $$;
