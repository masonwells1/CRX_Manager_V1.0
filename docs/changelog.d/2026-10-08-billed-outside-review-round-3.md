## 2026-10-08 - Billed-outside-CRX review round 3: invoice restore guard, paged integrity checks (NOT APPLIED)

- Codex (Luna) round 2 HIGH: a soft-deleted or voided invoice for a delivery that was then recorded as
  billed outside CRX could be restored without the invoice guard running. The guard
  (`zz_guard_invoice_delivery_billed_outside_crx`, `20261007150000`) now also fires on
  `deleted_at` / `status` and re-checks whenever an invoice becomes active again; inactive invoices
  are never refused. Proved in `npm run proof:billed-outside-crx`.
- The integrity report's large reads (orders, order lines, inventory, the stock ledger — 705 rows on
  2026-10-08 — delivery lines and invoice lines) now page through `fetchAllRows`, so the PostgREST
  row cap can no longer silently cut a check's input short.
- Final database review items: the release (`20261007150200`) also requires the delivery lock; the
  lock file names the blocking order/delivery if it refuses; header and test wording updated.
