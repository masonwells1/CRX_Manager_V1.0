## 2026-10-10 - A delivery invoice can bill only what its delivery delivered (NOT APPLIED)

- Sol exact-SHA review HIGH on PR #889: save_invoice let an admin, or a sales rep on their own
  customer, raise a delivery invoice's quantities or add products while it was a draft, so goods
  billed on another delivery's invoice, or billed outside CRX, could be billed again. Posting did
  not re-check.
- New migration `20261010120000_cap_delivery_invoice_at_delivered.sql`: two triggers refuse any
  active delivery invoice that bills more of a
  product or order line than the delivery delivered (summed over every active invoice for that
  delivery), a product the delivery did not carry, a product-less or negative line, and posting,
  restoring or un-voiding such an invoice, and posting one before its delivery is completed
  (`DELIVERY_INVOICE_EXCEEDS_DELIVERED`, shown in the app as
  "Nothing was saved. This invoice is for one delivery, so it can bill only the products and
  quantities that delivery delivered (…)").
- Review rounds (Luna, rls-security, migration-drift) shaped the design: the checks run at the end of
  each statement (not at commit) so batch posting and offline completions still catch a refusal;
  lowering a line, or a delivery completion trimming a linked line to what was delivered, always
  passes, so a driver is never blocked; writes that add billing take the order lock every invoice
  line writer already holds, so two concurrent over-bills on one delivery cannot both commit; and
  the file refuses to apply before `20261007150200`.
- Live check before writing (read-only): all 12 active delivery invoices are within their
  completed deliveries; the preflight refuses to install otherwise.
- Proof: `node scripts/smoke/prove-delivery-invoice-cap-real-schema.mjs` reproduces the over-bill
  first, then shows it refused through the real save_invoice for an admin and a rep, by a direct
  write, and on posting/restoring; shows normal edits, posting, batch posting, quick deliveries and
  partial completions still work; shows the second of two concurrent over-bills refused; and shows
  the over-bill (and the concurrent one, without the order lock) going through again when mutated.
