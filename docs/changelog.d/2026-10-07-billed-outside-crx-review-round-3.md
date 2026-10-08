## 2026-10-07 - Billed-outside-CRX: Office Cockpit tile and split-billing note (review round 3)

RLS-security round 2 on `20261007150000_record_deliveries_billed_outside_crx.sql` (still NOT
APPLIED) found no blocker. Applied:

- Office Cockpit "Delivered, not invoiced" no longer lists deliveries recorded as billed outside
  CRX (the dashboard RPC, Integrity Cleanup and the Delivery page were already updated).
- The migration header now states that on a split-billed order (field allocations) recording any
  delivery leaves the rest unbillable in CRX, so such an order may be recorded only when all of its
  billing happened outside CRX. Checked read-only 2026-10-07: none of the 33 spring 2026 candidate
  orders has field allocations or `needs_split_billing`.

Deferred, with reason: the Order page and Orders list still offer whole-order invoicing on such
orders (the server refuses with `DELIVERY_BILLED_OUTSIDE_CRX`, so no double bill); the new-table
reads are not paginated (at most a few dozen rows, written only by reviewed migrations).
