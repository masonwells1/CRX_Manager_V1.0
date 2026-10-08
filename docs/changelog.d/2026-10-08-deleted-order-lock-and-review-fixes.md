## 2026-10-08 - Freeze soft-deleted orders; review fixes for the integrity-report migrations (NOT APPLIED)

Both database reviewers independently found that releasing the reservations of the four orders
soft-deleted while still `confirmed` (ORD-2026-0181/0184/0185/0187) left them releasable a second
time: `cancel_order` / `void_order` and `update_order_items` never check whether an order is deleted,
and OrderDetail still offers Cancel Order on a deleted order opened by URL.

- New schema migration `20261007150050_lock_soft_deleted_orders.sql`: refuses any status change
  (`ORDER_DELETED_STATUS_LOCKED`) and any line add/remove/requantify (`ORDER_DELETED_LINES_LOCKED`)
  on a soft-deleted order; refuses to install while a deleted order has an open delivery. The release
  migration now requires it.
- `20261007150100` and `20261007150200` are registered in `supabase/baselines/one-shot-migrations.json`
  (bound to live rows; withheld from rebuild replays). New preflights: no split-billed order, no
  booking draw / quote / open delivery on a released order, active admin recorder, recording guard
  present; the release locks inventory in product order and its postflight recomputes live demand
  and checks on-hand stock and the ledger total.
- `delivery_external_billings` is readable by sales reps too, so the shared Office Cockpit tile hides
  those deliveries for them as well. Check 7 skips soft-deleted deliveries. The refusals show in
  plain English (`errorSanitizer`). DeliveryDetail clears the badge between deliveries.
- `docs/manual/KNOWN_ISSUES.md` records what the fixes deliberately leave open.
- `npm run proof:billed-outside-crx` now also proves the lock file, the role reads and that a
  released deleted order cannot be cancelled into a second release.
