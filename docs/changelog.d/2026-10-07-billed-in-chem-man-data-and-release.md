## 2026-10-07 - Owner-approved data fixes for the 2026-10-01 integrity report (NOT APPLIED)

Mason approved in chat (2026-10-07): the spring 2026 orders with no CRX invoice were billed in
Chem Man, CRX's predecessor; release the stock still reserved for orders deleted without being
cancelled; no physical count; returns and voids against those deliveries stay allowed.

- `20261007150100_mark_spring_2026_deliveries_billed_in_chem_man.sql`: records 53 completed
  deliveries on 33 orders in `delivery_external_billings` (26 fulfilled orders, ORD-2026-0186's
  uninvoiced delivery, and the completed deliveries of six partially fulfilled orders). No
  invoice, revenue, AR or stock change. ORD-2026-0186's DEL-00074, covered by the never-posted CRX
  draft CS-2026-0055, is deliberately not recorded.
- `20261007150200_release_reservations_of_deleted_spring_orders.sql`: releases 4,607.1 reserved
  units on 27 products held by ORD-2026-0181/0184/0185/0187 (soft-deleted while still confirmed
  before the 2026-07-21 delete guard existed) and 36 on the inactive test product (deleted test
  order ORD-2026-0345). Each product's reservation ends equal to what live open orders owe; on-hand
  stock is unchanged; one signed `prebook_reconciliation` ledger row per order+product; refuses to
  run twice. The root cause is already fixed: `guard_order_delivered_activity_cancel` refuses to
  soft-delete an order that is not cancelled or voided.
- Check 2 (inventory ledger) now skips the five historical `adjusted` rows that recorded
  prebooked-only corrections, as `docs/workflows/INVENTORY_RULES.md` directs, instead of adding
  offsetting ledger rows. Five products remain flagged until counted (Black Strap Molasses Tote,
  Start Right 2.0 Tote, 2,4D Amine 2.5 Gal and Bulk, Start Right 2.5 Gal); the owner chose no count.
- New real-schema prover `npm run proof:billed-outside-crx` (Docker, no network): replays the
  production schema, seeds the same delivery/order numbers and the live reservation quantities,
  and proves the guards, the dashboard exclusion, the 53-row marking, the reservation release,
  re-run safety, and (by mutation) that the invoice guard is what stops a double bill.
