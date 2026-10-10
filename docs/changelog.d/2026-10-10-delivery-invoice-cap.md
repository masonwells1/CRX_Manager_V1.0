## 2026-10-10 - A delivery invoice can bill only what its delivery delivered (NOT APPLIED)

- Sol exact-SHA review HIGH on PR #889: save_invoice let an admin, or a sales rep on their own
  customer, raise a delivery invoice's quantities or add products while it was a draft, so goods
  billed on another delivery's invoice, or billed outside CRX, could be billed again. Posting did
  not re-check.
- New migration `20261010120000_cap_delivery_invoice_at_delivered.sql`: two deferred constraint
  triggers refuse, when the transaction commits, any active delivery invoice that bills more of a
  product or order line than the delivery delivered (summed over every active invoice for that
  delivery), a product the delivery did not carry, a product-less or negative line, and posting,
  restoring or un-voiding such an invoice (`DELIVERY_INVOICE_EXCEEDS_DELIVERED`, shown in the app as
  "Nothing was saved. This invoice is for one delivery, so it can bill only the products and
  quantities that delivery delivered (…)").
- Live check before writing (read-only): all 12 active delivery invoices are within their
  deliveries; the preflight refuses to install otherwise.
- Proof: `node scripts/smoke/prove-delivery-invoice-cap-real-schema.mjs` reproduces the over-bill
  first, then shows it refused through the real save_invoice for an admin and a rep, at a real
  COMMIT, and on posting/restoring; shows normal edits, posting, quick deliveries and partial
  completions still work; and shows the over-bill goes through again with the triggers removed.
