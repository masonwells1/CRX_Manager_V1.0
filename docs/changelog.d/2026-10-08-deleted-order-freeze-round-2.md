## 2026-10-08 - Deleted-order freeze completed; paged billed-outside reads (review round 2, NOT APPLIED)

Codex (Luna) and the RLS reviewer each found a way around the first deleted-order lock:

- **Un-deleting:** clearing `orders.deleted_at` bypassed the status lock and reopened the order to
  `cancel_order`. `guard_deleted_order_status_locked` now also fires on `deleted_at` and refuses an
  un-delete (nothing in the app restores a deleted order).
- **Undoing a delivery on a deleted order with no lines left** (ORD-2026-0345): `cancel_delivery` /
  `void_delivery` put the units back into reservations and stock before touching any line, so they
  slipped past the line lock. New `guard_deleted_order_deliveries_locked` on `deliveries` refuses a
  status change on, or a new delivery for, a soft-deleted order (`ORDER_DELETED_DELIVERIES_LOCKED`).
- Reads of `delivery_external_billings` go through a new paged reader
  (`src/lib/deliveryExternalBilling.ts`), so a server row cap can never silently drop records. The
  Delivery page publishes its "Billed outside CRX" badge only for the delivery still on screen.
- The prover covers un-delete, void and new-delivery refusals and a mutation without the delivery
  lock; `KNOWN_ISSUES.md` records that deliveries on deleted orders can no longer be undone.
