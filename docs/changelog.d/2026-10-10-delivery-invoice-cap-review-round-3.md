## 2026-10-10 - Delivery invoice cap: database re-reviews (NOT APPLIED)

- rls-security and migration-drift re-reviewed the revised `20261010120000`: 0 BLOCKER, 0 MED; the
  drift HIGH is a pre-apply step (recompute the live ledger high-water after `20261007150200` lands).
- Change: the "set a linked line to exactly what was delivered" exception now applies to DRAFT
  invoices only (the only writer that uses it, complete_delivery's partial trim, touches drafts only).
- Docs: the migration header now says accurately what cancel/void delivery do to invoices; KNOWN_ISSUES
  notes that a scheduled delivery lowered after its up-front invoice leaves the draft over until the
  office lowers that line, and that manual order-level invoices made after delivery invoices are not
  capped; migration-history's header points at the 04:30 UTC apply of `20261007150100`.
