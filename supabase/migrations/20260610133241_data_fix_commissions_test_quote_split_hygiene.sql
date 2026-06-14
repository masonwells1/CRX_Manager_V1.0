-- ============================================================================
-- Data fixes from the 2026-06-10 foundation ultra review (M3, L-A1, L-A2).
-- Data-only — no schema/function changes.
--
-- 1. M3 — 4 pending commissions out of sync with their orders' profit
--    (orders edited 2026-05-12 after commission creation, no recalc; one row
--    EXCEEDED profit). Canonical model (verified: every other commission row
--    reconciles): commission_amount = order total_profit × split share; all
--    4 orders have commission_split NULL = single 100% recipient, so amount
--    := GREATEST(total_profit, 0). NOTE: ORD-2026-0189 (Mason Wells) moves
--    $50 -> $2,455.37 per the model; row stays 'pending' (reversible) — if
--    the $50 was a deliberate flat amount, revert that one row.
-- 2. L-A1 — accepted quote Q-2026-1811 ("A1 TEST FARM", manual test data
--    without the [E2E] prefix) pollutes prod reports; cancelled here.
--    accepted->cancelled is enforcer-forbidden, so the canonical
--    app.admin_override bracket is used (verified: not planned, 0 active
--    holds — nothing to release).
-- 3. L-A2 — 15 customers carry JSONB null (not SQL NULL) in
--    default_commission_split; passes IS NOT NULL with no usable object.
--    Normalized to SQL NULL.
-- ============================================================================

-- 1. M3: recalc the 4 stale pending commissions (business keys, no UUIDs)
UPDATE commissions cm
SET commission_amount = GREATEST(o.total_profit, 0)
FROM orders o
WHERE o.id = cm.order_id
  AND cm.status = 'pending'
  AND o.order_number IN ('ORD-2026-0175','ORD-2026-0176','ORD-2026-0189','ORD-2026-0343');

-- 2. L-A1: cancel the A1 TEST FARM accepted quote (status-enforcer override)
DO $$
DECLARE v_n int;
BEGIN
  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE quotes SET status = 'cancelled'
  WHERE quote_number = 'Q-2026-1811' AND status = 'accepted';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 1 THEN RAISE EXCEPTION 'expected at most 1 quote, updated %', v_n; END IF;
  PERFORM set_config('app.admin_override', 'false', true);
END $$;

-- 3. L-A2: normalize JSONB null -> SQL NULL
UPDATE customers
SET default_commission_split = NULL
WHERE default_commission_split = 'null'::jsonb;

-- Verification
DO $$
DECLARE v_bad int;
BEGIN
  SELECT count(*) INTO v_bad
  FROM commissions cm JOIN orders o ON o.id = cm.order_id
  WHERE cm.status = 'pending'
    AND o.order_number IN ('ORD-2026-0175','ORD-2026-0176','ORD-2026-0189','ORD-2026-0343')
    AND cm.commission_amount IS DISTINCT FROM GREATEST(o.total_profit, 0);
  IF v_bad <> 0 THEN RAISE EXCEPTION '% commission row(s) still stale', v_bad; END IF;

  SELECT count(*) INTO v_bad FROM quotes WHERE quote_number = 'Q-2026-1811' AND status = 'accepted';
  IF v_bad <> 0 THEN RAISE EXCEPTION 'Q-2026-1811 still accepted'; END IF;

  SELECT count(*) INTO v_bad FROM customers WHERE default_commission_split = 'null'::jsonb;
  IF v_bad <> 0 THEN RAISE EXCEPTION '% customers still carry jsonb null splits', v_bad; END IF;
END $$;
