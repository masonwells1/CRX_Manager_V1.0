## 2026-10-08 - Rep scoping for order invoices (work in progress, NOT applied)

- New migration `20261008120000_scope_order_invoices_to_rep.sql` (written, **not applied to live**;
  it waits for Mason's explicit approval because it changes what sales reps may do).
- Rule (Mason, 2026-10-06): a sales rep may create invoices from an order only for customers assigned
  to them and only under their own name; admins are unrestricted. `create_split_invoices_from_order`
  also gets the CRX-LIFE-001 invoice-type allow-list before any invoice number is drawn.
- Adds a real-schema container prover (`scripts/smoke/prove-order-invoice-rep-scope-real-schema.mjs`)
  and a smoke chain (`scripts/smoke/smoke-order-invoice-rep-scope.sql`); keeps the CRX-LIFE-001
  prover reproducible.
- This entry is finalized when the change is complete; it is not yet reviewed.
