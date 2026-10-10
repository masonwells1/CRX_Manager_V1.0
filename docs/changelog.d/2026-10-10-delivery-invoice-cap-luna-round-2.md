## 2026-10-10 - Delivery invoice cap: Luna review round 2 (NOT APPLIED)

- `20261010120000`: the lock that serializes concurrent billing on one delivery now targets the
  delivery's own order (read from the delivery, not the invoice).
- Two HIGHs refuted with evidence: detaching an over-billed invoice from its delivery and posting it,
  and a delivery invoice with no or another order. `trg_guard_invoice_terminal_order` already refuses
  both (`INVOICE_SOURCE_LINEAGE_IMMUTABLE`, `INVOICE_DELIVERY_LINEAGE_INVALID`); the prover now shows
  the detach-and-post refused.
- Accepted and documented in the migration header: rounding each delivery line to 4 decimals (at
  most 0.00005 of a unit per line), and delivery edits after posting (a posted delivery invoice needs a
  completed delivery, whose items are already frozen).
