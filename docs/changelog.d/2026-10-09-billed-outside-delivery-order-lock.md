## 2026-10-09 - Billed-outside-CRX: a recorded delivery stays on its order (NOT APPLIED)

- Sol exact-SHA review HIGH: the invoice guard finds deliveries billed outside CRX through their
  current order, and a delivery's order could still be changed while both orders were live. Moving
  a recorded delivery to another order would then let a whole-order invoice on the original order
  bill those goods again.
- `20261007150000` now adds `guard_billed_outside_delivery_order_locked` on `deliveries`: a recorded
  delivery can never be moved to another order or detached from its order
  (`BILLED_OUTSIDE_DELIVERY_ORDER_LOCKED`, shown in the app as "Nothing was changed. This delivery
  was billed outside CRX, so it cannot be moved to another order").
- `npm run proof:billed-outside-crx` proves the move is refused (as an admin and as postgres), an
  update that keeps the order still works, and, with the lock dropped, the moved delivery lets the
  original order be billed whole again.
- Review follow-ups: the postflight also pins the lock's trigger type (BEFORE UPDATE, per row) and
  its function's volatility (VOLATILE, so its check sees a recording committed while it waited);
  the proof shows an assigned driver, who cannot read the records, is refused too, and that the
  lock would let the driver through if it ran with the driver's rights instead of its owner's.
- Checked on live, read-only: order lines cannot be re-pointed by the app (no UPDATE grant on
  order_items.order_id), and delivery lines on a completed delivery are already locked.
