-- ============================================================================
-- Draws-ledger backfill completeness: quotes-with-orders in NON-accepted statuses
-- ----------------------------------------------------------------------------
-- Follow-up to 20260610145253_partial_quote_draw_down.sql §2, per the
-- error-prevention review docs/audits/2026-06-10-error-prevention-review.md §3
-- (the "backfill scoped to status='accepted'" finding, verified and held at
-- LOW: backfill-completeness follow-up).
--
-- THREAT MODEL
-- The original backfill marked only status='accepted' quotes-with-orders as
-- fully drawn. Quotes with linked orders exist in OTHER statuses (live at
-- draft time: exactly ONE — a cancelled quote, Q-2026-1811, one booked
-- product at 247 units, zero quote_product_draws rows; notably live has ZERO
-- accepted quotes-with-orders, so the original §2 backfill inserted nothing).
-- If such a quote is ever admin-reverted to 'sent' via revert_quote_status,
-- its EMPTY draw ledger would present the full booked quantity as
-- never-drawn, allowing a full re-draw / double conversion of quantities
-- that already produced an order. This is DEFENSE-IN-DEPTH: the revert path
-- itself is admin-only and strict-actor gated, so this is not an open
-- exploit — it closes the ledger gap so the draw guards stay truthful no
-- matter what an admin later does to the quote's status.
--
-- SCOPE — why this is NOT a blind any-status backfill
-- Candidate set: every quote with >= 1 linked order where EITHER
--   (a) status NOT IN ('sent','revised')  — closed/draft bookings: any order
--       they have came from a conversion or a since-closed draw; a missing
--       ledger row means a legacy conversion that must be marked drawn; OR
--   (b) status IN ('sent','revised') AND the quote has ZERO draw rows — an
--       open booking with an order but an empty ledger is a legacy anomaly
--       (impossible going forward: draw_down_quote inserts the order and its
--       ledger row in the same transaction). Live-verified at draft time:
--       this set is empty.
-- Deliberately EXCLUDED: sent/revised quotes that already have draw rows —
-- those are ACTIVE partial bookings whose partial ledger is the CORRECT
-- state; inserting full-booked rows for their not-yet-drawn products would
-- destroy the open booking balance. This matters for re-runs on branch /
-- shadow databases at a future date, not just for today's live apply.
--
-- WHY ON CONFLICT DO NOTHING (same shape as the original §2 backfill)
-- Any pre-existing quote_product_draws row was written transactionally by
-- draw_down_quote / convert_quote_to_order and is ground truth. A quote that
-- was partially drawn and then cancelled keeps its true drawn quantity, so a
-- later admin revert reopens exactly the legitimate remainder — topping such
-- rows up to fully-drawn would erase that remainder. Only MISSING rows are
-- filled, at the full booked quantity (missing == never tracked == the
-- legacy whole-conversion case).
--
-- IDEMPOTENT + NO-OP SAFE
-- Re-running this migration, or running it on a database with zero
-- candidates, changes nothing (ON CONFLICT DO NOTHING; INSERT...SELECT over
-- an empty candidate set inserts zero rows). Expected effect on live at
-- draft time: exactly 1 row inserted.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Backfill: fill missing ledger rows for quotes-with-orders (any status)
-- ----------------------------------------------------------------------------
INSERT INTO public.quote_product_draws (quote_id, product_id, quantity_drawn)
SELECT qi.quote_id, qi.product_id, SUM(COALESCE(qi.total_units_needed, 0))
FROM public.quote_items qi
JOIN public.quotes q ON q.id = qi.quote_id
WHERE EXISTS (SELECT 1 FROM public.orders o WHERE o.quote_id = q.id)
  AND (
    q.status NOT IN ('sent', 'revised')
    OR NOT EXISTS (
      SELECT 1 FROM public.quote_product_draws d WHERE d.quote_id = q.id
    )
  )
GROUP BY qi.quote_id, qi.product_id
HAVING SUM(COALESCE(qi.total_units_needed, 0)) > 0
ON CONFLICT (quote_id, product_id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 2. Self-verification: zero quotes-with-orders remain without full ledger
--    coverage. "Full coverage" = a quote_product_draws row exists for every
--    booked (quote, product) pair. The only exempt set is active partial
--    bookings (sent/revised WITH existing draw rows), whose partial coverage
--    is correct by design and is maintained by draw_down_quote itself.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_uncovered int;
BEGIN
  SELECT count(*) INTO v_uncovered
  FROM (
    SELECT qi.quote_id, qi.product_id
    FROM public.quote_items qi
    JOIN public.quotes q ON q.id = qi.quote_id
    WHERE EXISTS (SELECT 1 FROM public.orders o WHERE o.quote_id = q.id)
      AND NOT (
        q.status IN ('sent', 'revised')
        AND EXISTS (
          SELECT 1 FROM public.quote_product_draws d2 WHERE d2.quote_id = q.id
        )
      )
    GROUP BY qi.quote_id, qi.product_id
    HAVING SUM(COALESCE(qi.total_units_needed, 0)) > 0
  ) booked
  LEFT JOIN public.quote_product_draws d
    ON d.quote_id = booked.quote_id AND d.product_id = booked.product_id
  WHERE d.id IS NULL;

  IF v_uncovered <> 0 THEN
    RAISE EXCEPTION
      'draws backfill incomplete: % booked (quote, product) pair(s) on quotes-with-orders still lack a quote_product_draws row',
      v_uncovered;
  END IF;
END $$;
