-- STATUS: NOT APPLIED.
-- ONE-SHOT DATA migration (owner-approved in chat, 2026-10-07; registered in
-- supabase/baselines/one-shot-migrations.json): release stock still reserved
-- (inventory.quantity_prebooked) for orders that were soft-deleted in spring 2026 without being
-- cancelled first.
--
-- Cause: before 2026-07-21 the Orders page soft-deleted an order by setting deleted_at directly, so
-- a still-"confirmed" order never went through cancel_order, which is what releases its
-- reservation. Since 20260721014858 the trigger guard_order_delivered_activity_cancel refuses to
-- soft-delete any order that is not cancelled/voided (ORDER_MUST_BE_TERMINAL_BEFORE_DELETE), so this
-- cannot recur; this file only clears the leftovers. 20261007150050 (applied first, required by the
-- preflight) freezes soft-deleted orders — no un-delete, no status, line or delivery change — so
-- cancel_order / void_order / update_order_items / cancel_delivery / void_delivery
-- can never release these reservations a second time or put them back.
--
-- What it releases (read-only check 2026-10-07; the preflight re-proves every number):
--   * ORD-2026-0181, 0184, 0185 (deleted 2026-04-28) and 0187 (deleted 2026-03-27), all still
--     status 'confirmed', no booking draw, no quote, no open delivery: 31 open lines, 4,607.1 units,
--     27 products.
--   * ORD-2026-0345, a deleted TEST order on the inactive "1A TEST PRODUCT - FAKE PRODUCT": it
--     booked 50, delivered a net 14 (two of its deliveries were voided), and its remaining 36 were
--     never released; the order has no lines left.
-- For every one of the 28 products, quantity_prebooked minus this release equals exactly what live
-- open orders (confirmed / partially_fulfilled, not deleted) still owe — the preflight refuses
-- otherwise, and the postflight recomputes it after.
--
-- Effect: per product, quantity_prebooked decreases by the released amount, and one
-- 'prebook_reconciliation' ledger row per order+product records it (quantity = the signed change to
-- quantity_prebooked, negative = released — the convention TransactionLedgerModal displays).
-- quantity_available (on-hand) is NOT changed. Orders and order_items rows are not changed: the
-- integrity check already ignores deleted orders.
--
-- Not re-runnable by design: the preflight refuses if this file's ledger marker already exists.
-- Rollback (new reviewed migration): add the same amounts back to quantity_prebooked with offsetting
-- prebook_reconciliation rows.
-- ORDERING: after 20261007150050 and 20261007150100.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE crx_release_lines ON COMMIT DROP AS
SELECT oi.product_id, o.id AS order_id, o.order_number, sum(oi.quantity_remaining) AS qty
  FROM public.order_items oi
  JOIN public.orders o ON o.id = oi.order_id
 WHERE o.order_number IN ('ORD-2026-0181', 'ORD-2026-0184', 'ORD-2026-0185', 'ORD-2026-0187')
   AND o.deleted_at IS NOT NULL
   AND o.status = 'confirmed'
   AND oi.quantity_remaining > 0
 GROUP BY oi.product_id, o.id, o.order_number;

-- The test order has no lines left; its 36 units are the whole reservation on the test product.
INSERT INTO crx_release_lines (product_id, order_id, order_number, qty)
SELECT i.product_id, o.id, o.order_number, 36
  FROM public.inventory i
  JOIN public.products p ON p.id = i.product_id
  JOIN public.orders o ON o.order_number = 'ORD-2026-0345'
 WHERE i.id = '768ff8b5-dd45-4efa-b0b5-48b2c91036f2'
   AND p.product_name = '1A TEST PRODUCT - FAKE PRODUCT'
   AND p.is_active = false
   AND o.deleted_at IS NOT NULL;

-- Lock the affected inventory rows BEFORE reading what live orders owe, in product order — the
-- order complete_delivery locks inventory in — so no reservation can change between the checks
-- below and the update.
DO $lock$
BEGIN
  PERFORM 1 FROM public.inventory i
   WHERE i.product_id IN (SELECT product_id FROM crx_release_lines)
   ORDER BY i.product_id
     FOR UPDATE;
END
$lock$;

CREATE TEMP TABLE crx_release_products ON COMMIT DROP AS
SELECT r.product_id, sum(r.qty) AS qty,
       coalesce((SELECT sum(oi.quantity_remaining)
                   FROM public.order_items oi
                   JOIN public.orders o ON o.id = oi.order_id
                  WHERE oi.product_id = r.product_id
                    AND oi.quantity_remaining > 0
                    AND o.deleted_at IS NULL
                    AND o.status IN ('confirmed', 'partially_fulfilled')), 0) AS live_open,
       (SELECT i.quantity_available FROM public.inventory i WHERE i.product_id = r.product_id) AS available_before
  FROM crx_release_lines r
 GROUP BY r.product_id;

DO $preflight$
BEGIN
  IF EXISTS (SELECT 1 FROM public.inventory_transactions
              WHERE transaction_type = 'prebook_reconciliation'
                AND notes LIKE 'CRX-2026-10-07 release of deleted-order reservation%') THEN
    RAISE EXCEPTION 'RELEASE_PREFLIGHT: already applied — refusing to release twice';
  END IF;
  -- The deleted-order lock must be live first, or cancel_order could release these again.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.orders'::regclass
                  AND tgname = 'guard_deleted_order_status_locked' AND tgenabled = 'O' AND NOT tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.order_items'::regclass
                  AND tgname = 'guard_deleted_order_lines_locked' AND tgenabled = 'O' AND NOT tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.deliveries'::regclass
                  AND tgname = 'guard_deleted_order_deliveries_locked' AND tgenabled = 'O' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'RELEASE_PREFLIGHT: apply 20261007150050_lock_soft_deleted_orders first';
  END IF;
  IF (SELECT count(*) FROM crx_release_lines WHERE order_number <> 'ORD-2026-0345') <> 31
     OR (SELECT sum(qty) FROM crx_release_lines WHERE order_number <> 'ORD-2026-0345') <> 4607.1
     OR (SELECT count(*) FROM crx_release_lines WHERE order_number = 'ORD-2026-0345') <> 1
     OR (SELECT count(*) FROM crx_release_products) <> 28 THEN
    RAISE EXCEPTION 'RELEASE_PREFLIGHT: release set differs from the reviewed one (31 lines / 4607.1 units + test order, 28 products)';
  END IF;
  -- cancel_order also restores booking draws and holds; none of these orders has any.
  IF EXISTS (SELECT 1 FROM public.orders o
              WHERE o.id IN (SELECT order_id FROM crx_release_lines)
                AND (o.booking_draw IS TRUE OR o.quote_id IS NOT NULL
                     OR EXISTS (SELECT 1 FROM public.deliveries d
                                 WHERE d.order_id = o.id AND d.status IN ('scheduled', 'in_progress')))) THEN
    RAISE EXCEPTION 'RELEASE_PREFLIGHT: a released order has a booking draw, a quote or an open delivery';
  END IF;
  -- One inventory row per product, and after the release prebooked equals what live orders owe.
  IF EXISTS (
    SELECT 1
      FROM crx_release_products rp
     WHERE (SELECT count(*) FROM public.inventory i WHERE i.product_id = rp.product_id) <> 1
        OR (SELECT i.quantity_prebooked FROM public.inventory i WHERE i.product_id = rp.product_id)
           - rp.qty <> rp.live_open
  ) THEN
    RAISE EXCEPTION 'RELEASE_PREFLIGHT: a product''s reservation does not reconcile exactly; re-check before applying';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles
                  WHERE id = '22c1fc50-4d2a-4baa-8ff8-341c0c7edd4f' AND role = 'admin' AND is_active) THEN
    RAISE EXCEPTION 'RELEASE_PREFLIGHT: recording profile is not an active admin';
  END IF;
END
$preflight$;

INSERT INTO public.inventory_transactions (product_id, transaction_type, quantity, to_location, order_id, performed_by, notes)
SELECT r.product_id, 'prebook_reconciliation', -r.qty,
       (SELECT i.location FROM public.inventory i WHERE i.product_id = r.product_id),
       r.order_id,
       '22c1fc50-4d2a-4baa-8ff8-341c0c7edd4f'::uuid,
       'CRX-2026-10-07 release of deleted-order reservation: ' || r.order_number
         || ' was soft-deleted without being cancelled, so its reservation was never released (owner-approved)'
  FROM crx_release_lines r
 ORDER BY r.order_number, r.product_id;

UPDATE public.inventory i
   SET quantity_prebooked = i.quantity_prebooked - rp.qty,
       updated_at = now()
  FROM crx_release_products rp
 WHERE i.product_id = rp.product_id;

DO $postflight$
BEGIN
  -- Recomputed now, not the snapshot: every affected reservation equals what live orders owe.
  IF EXISTS (
    SELECT 1
      FROM crx_release_products rp
      JOIN public.inventory i ON i.product_id = rp.product_id
     WHERE i.quantity_prebooked <> coalesce((SELECT sum(oi.quantity_remaining)
                                              FROM public.order_items oi
                                              JOIN public.orders o ON o.id = oi.order_id
                                             WHERE oi.product_id = rp.product_id
                                               AND oi.quantity_remaining > 0
                                               AND o.deleted_at IS NULL
                                               AND o.status IN ('confirmed', 'partially_fulfilled')), 0)
        OR i.quantity_available IS DISTINCT FROM rp.available_before
  ) THEN
    RAISE EXCEPTION 'RELEASE_POSTFLIGHT: a reservation does not equal what live orders owe, or on-hand stock moved';
  END IF;
  IF (SELECT count(*) FROM public.inventory_transactions
       WHERE transaction_type = 'prebook_reconciliation'
         AND notes LIKE 'CRX-2026-10-07 release of deleted-order reservation%')
       <> (SELECT count(*) FROM crx_release_lines)
     OR (SELECT sum(quantity) FROM public.inventory_transactions
          WHERE transaction_type = 'prebook_reconciliation'
            AND notes LIKE 'CRX-2026-10-07 release of deleted-order reservation%')
       IS DISTINCT FROM -(SELECT sum(qty) FROM crx_release_lines) THEN
    RAISE EXCEPTION 'RELEASE_POSTFLIGHT: ledger rows do not match the release lines';
  END IF;
END
$postflight$;
