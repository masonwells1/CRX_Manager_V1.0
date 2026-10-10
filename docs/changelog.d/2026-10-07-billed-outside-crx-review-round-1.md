## 2026-10-07 - Billed-outside-CRX guard: close the whole-order double-billing path (review round 1)

Review of `20261007150000_record_deliveries_billed_outside_crx.sql` (still NOT APPLIED) found the
invoice guard only blocked invoices that name a delivery. `save_invoice` and the split-by-field
engine both create whole-order invoices (no `delivery_id`) on a fully delivered order, so a delivery
recorded as billed outside CRX could still be billed again through them. Changes:

- The invoice guard (`zz_guard_invoice_delivery_billed_outside_crx`) now also refuses a whole-order,
  non-credit invoice on any order that has a delivery billed outside CRX, and re-checks on changes to
  `delivery_id`, `order_id` or `invoice_type`. Named `zz_` so it fires after
  `trg_guard_invoice_terminal_order`, which locks the order.
- The recording guard locks the delivery and then its order, the lock order the existing invoice
  writers and `void_delivery` use.
- `get_dashboard_action_items` "Delivered, not invoiced" skips those deliveries (live body copied
  verbatim, md5-pinned in a preflight); the Delivery page shows "Billed outside CRX" in place of
  Create Invoice.
- Stronger postflight (security mode, search_path, triggers enabled, table shape, dashboard grants);
  `recorded_by` is `ON DELETE SET NULL`.

Open for the owner: whether return credits or voids against a delivery billed outside CRX should be
refused (today they are allowed).
