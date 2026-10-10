## 2026-10-10 - An order is billed per delivery or whole-order, never both (NOT APPLIED)

- Luna round 3 HIGH: the delivery cap cannot see an order-level invoice (no delivery), so a manual
  whole-order invoice saved after delivery invoices (save_invoice can create one) could bill the same
  goods twice. Delivery-invoice writers already refused the other direction.
- `20261010120000` now also adds `zz_refuse_overlapping_order_delivery_invoices` on `invoices`
  (`ORDER_INVOICE_OVERLAPS_DELIVERY_INVOICE`): an active billing invoice of one kind is refused while
  the order has one of the other kind, under the order lock every invoice writer takes. Live
  2026-10-10: no order-level invoices exist; the preflight refuses to install if any order mixes them.
- The app explains both refusals in plain English; a cap refusal now reads "Nothing was changed"
  (it can come from a save or a post). KNOWN_ISSUES no longer claims a posted delivery invoice can
  sit over a later-shortened delivery: posting now needs a completed delivery, whose items are frozen.
- Proof: the prover refuses a whole-order invoice through the real save_invoice and by direct write
  on an order billed per delivery, refuses the reverse, and lets it through with the trigger dropped.
