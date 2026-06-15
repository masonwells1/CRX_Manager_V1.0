-- Backfill missing commissions for 11 March-2026 orders (Foundation Ultra Review H1, 2026-06-15)
--
-- WHAT: 11 orders booked 2026-03-09..03-13 have no commission rows. They were
-- created BEFORE each customer's commission split was configured, so the commission
-- writer correctly produced nothing at the time. Every order created after that
-- window already has commissions, and the live order-creation RPCs
-- (create_direct_order / convert_quote_to_order / create_quick_delivery /
-- draw_down_quote) all call _insert_commissions_for_order with a real split.
-- This is a one-time HISTORICAL data gap, NOT an active commission-generation bug.
--
-- HOW: Reuse the canonical single commission writer (_insert_commissions_for_order)
-- with the customer's current default_commission_split and the order's finalized
-- total_profit + order_date — exactly as the live RPCs do. Rows land as 'pending'
-- (NOTHING is paid automatically). Recipients verified live to each resolve to
-- exactly one active profile: CMCTW LLC (entity_recipient), Mason Wells (admin),
-- Chance Tuttle (admin) — so every inserted row links to a payable recipient.
--
-- IDEMPOTENT: guarded by NOT EXISTS (live commissions for the order) — re-running
-- inserts nothing. REVERSIBLE: soft-delete (set deleted_at) the rows this inserts.
--
-- Verified via a rolled-back LIVE smoke test 2026-06-15:
--   processed=11  rows_inserted=13  orders_covered=11  total=60599.07
--   breakdown=[Chance Tuttle=10078.45; CMCTW LLC=40442.17; Mason Wells=10078.45]
--
-- idempotency-body-check: exempt (one-time data backfill; calls the canonical
-- commission writer; no idempotency key applies)

DO $$
DECLARE
  r          record;
  v_orders   int := 0;
  v_inserted int := 0;
BEGIN
  FOR r IN
    SELECT o.id, o.customer_id, o.total_profit, o.order_date,
           cu.default_commission_split AS split
    FROM orders o
    JOIN customers cu ON cu.id = o.customer_id
    WHERE o.deleted_at IS NULL
      AND o.order_number IN (
        'ORD-2026-0148','ORD-2026-0150','ORD-2026-0153','ORD-2026-0161',
        'ORD-2026-0162','ORD-2026-0177','ORD-2026-0178','ORD-2026-0179',
        'ORD-2026-0180','ORD-2026-0186','ORD-2026-0188'
      )
      AND cu.default_commission_split ? 'splits'
      AND NOT EXISTS (
        SELECT 1 FROM commissions c
        WHERE c.order_id = o.id AND c.deleted_at IS NULL
      )
  LOOP
    v_orders   := v_orders + 1;
    v_inserted := v_inserted
      + public._insert_commissions_for_order(
          r.id, r.customer_id, r.total_profit, r.split, r.order_date
        );
  END LOOP;

  RAISE NOTICE 'Commission backfill (H1): % orders processed, % commission rows inserted',
    v_orders, v_inserted;
END $$;
