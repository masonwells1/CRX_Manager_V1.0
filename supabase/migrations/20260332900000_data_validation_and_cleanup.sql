-- Data Validation & Cleanup
-- =========================
-- Runs corruption checks from NEXT_STEPS.md Phase 2.
-- The overload bug was live Mar 6-14 and may have written incorrect data.
-- This migration checks for and fixes any data integrity issues.

-- 1. Fix negative inventory quantities (should never happen)
UPDATE inventory
SET quantity_available = 0
WHERE quantity_available < 0;

UPDATE inventory
SET quantity_prebooked = 0
WHERE quantity_prebooked < 0;

-- 2. Recalculate prebooked quantities to match actual pending orders
-- This fixes any drift from the frozen RPC period
DO $$
DECLARE
  _rec RECORD;
  _calculated NUMERIC;
  _fixed INT := 0;
BEGIN
  FOR _rec IN
    SELECT i.id, i.product_id, i.location, i.quantity_prebooked AS recorded
    FROM inventory i
    WHERE i.location = 'Main Warehouse'
  LOOP
    -- Calculate what prebooked SHOULD be from confirmed/partial orders
    SELECT COALESCE(SUM(
      GREATEST(oi.total_units_needed - oi.quantity_delivered, 0)
    ), 0)
    INTO _calculated
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE oi.product_id = _rec.product_id
      AND o.status IN ('confirmed', 'partially_fulfilled');

    -- Only fix if there's a mismatch
    IF _rec.recorded != _calculated THEN
      UPDATE inventory
      SET quantity_prebooked = _calculated
      WHERE id = _rec.id;

      _fixed := _fixed + 1;
      RAISE NOTICE 'Fixed prebooked for product %: % -> %',
        _rec.product_id, _rec.recorded, _calculated;
    END IF;
  END LOOP;

  RAISE NOTICE 'Prebooked reconciliation: % inventory records fixed', _fixed;
END $$;

-- 3. Verify commission splits sum to 100% — log violations but don't auto-fix
-- (commissions are financial records, manual review needed)
DO $$
DECLARE
  _rec RECORD;
  _bad INT := 0;
BEGIN
  FOR _rec IN
    SELECT c.order_id, SUM(c.split_percentage) AS total_split
    FROM commissions c
    WHERE c.status != 'cancelled'
    GROUP BY c.order_id
    HAVING SUM(c.split_percentage) != 100
  LOOP
    _bad := _bad + 1;
    RAISE WARNING 'Commission split mismatch on order %: total = %%',
      _rec.order_id, _rec.total_split;
  END LOOP;

  IF _bad = 0 THEN
    RAISE NOTICE 'Commission splits: ALL OK (all sum to 100%%)';
  ELSE
    RAISE WARNING 'Commission splits: % orders have mismatched splits — manual review needed', _bad;
  END IF;
END $$;

-- 4. Verify invoice balance_cents integrity
-- balance_cents is GENERATED ALWAYS so it CANNOT be wrong, but verify the formula inputs
DO $$
DECLARE
  _bad INT := 0;
BEGIN
  SELECT count(*) INTO _bad
  FROM invoices
  WHERE status NOT IN ('voided')
    AND paid_amount_cents < 0;

  IF _bad > 0 THEN
    RAISE WARNING 'Found % invoices with negative paid_amount_cents — investigate manually', _bad;
  ELSE
    RAISE NOTICE 'Invoice integrity: ALL OK (no negative paid_amount_cents)';
  END IF;
END $$;

-- 5. Fix any commissions with invalid status values
-- (The CHECK constraint was restored in migration 20260331800000, but data may predate it)
DO $$
DECLARE
  _bad INT := 0;
BEGIN
  SELECT count(*) INTO _bad
  FROM commissions
  WHERE status NOT IN ('pending', 'paid', 'cancelled');

  IF _bad > 0 THEN
    RAISE WARNING 'Found % commissions with invalid status — setting to pending', _bad;
    UPDATE commissions
    SET status = 'pending'
    WHERE status NOT IN ('pending', 'paid', 'cancelled');
  ELSE
    RAISE NOTICE 'Commission statuses: ALL OK';
  END IF;
END $$;

-- Summary
DO $$
BEGIN
  RAISE NOTICE '========================================';
  RAISE NOTICE 'Data validation and cleanup complete';
  RAISE NOTICE 'Check NOTICE/WARNING messages above for details';
  RAISE NOTICE '========================================';
END $$;
