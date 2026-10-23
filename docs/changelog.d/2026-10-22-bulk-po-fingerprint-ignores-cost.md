## 2026-10-22 — an admin re-importing a rep's vendor invoice is told it is already imported

- Migration `20261022100000_bulk_po_fingerprint_ignores_cost` (row 978): the bulk purchase-order import's content
  fingerprint leaves out `unit_cost` and `unit_cost_cents` for everyone. Since purchase cost became admin-only
  (row 962) a rep's import is saved without cost, so an admin importing the same document with cost was refused
  with `BULK_PO_DOCUMENT_CONTENT_CONFLICT`; now the admin gets `already_imported` and the rep's purchase order stays
  the only one. The admin sets cost on it with `set_purchase_order_item_costs`.
- Because a re-import never changes costs, the bulk-import screen now tells an admin, when it skips a document as already
  imported, to check costs in Supplier POs (`BulkPOImport.tsx`); a sales rep's message is unchanged.
- A changed quantity, product, unit or invoice date is still refused with `BULK_PO_DOCUMENT_CONTENT_CONFLICT`. A
  same-key retry (a lost response) must be the exact request, cost included: the import binds a cost-inclusive request
  fingerprint to its idempotency receipt (`_bind_replay_receipt_20261015`), so an admin's retry that changed only a
  cost is refused rather than replayed as saved (a rep's cost is stripped before it reaches the database, so a rep's
  retry replays), and the same key without the bulk-import marker is refused.
- The migration refuses to apply while any import claim exists (live had none), so no claim keeps a fingerprint made
  under the old rule.
- Proof: `node scripts/smoke/prove-bulk-po-fingerprint-ignores-cost-real-schema.mjs`. The live smoke chain
  `smoke-adversarial-money-inventory-closeout.sql` checks rep-then-admin-with-cost and a date change.
- `docs/reference/migration-history.md` updated (row 978). The old "Smoke chains rotted by the PO cost lock"
  write-up now lives unchanged in `docs/manual/archive/KNOWN_ISSUES-history-2026-10.md` (the 2026-10-23 trim
  dropped it from the open list), so this change no longer edits `KNOWN_ISSUES.md`.
