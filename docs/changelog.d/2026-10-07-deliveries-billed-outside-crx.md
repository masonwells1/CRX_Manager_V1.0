## 2026-10-07 - Record deliveries billed outside CRX; fix integrity checks 3, 4, 7 and 8

Resolves the failing checks in the 2026-10-01 monthly integrity report (PR #861).

- New migration `20261007150000_record_deliveries_billed_outside_crx.sql` (NOT APPLIED):
  admin-read-only table `delivery_external_billings` for completed deliveries invoiced outside
  CRX (QuickBooks, spring 2026), a guard that only accepts completed, not-yet-invoiced order
  deliveries, and an invoices trigger that refuses to invoice a recorded delivery
  (`DELIVERY_BILLED_OUTSIDE_CRX`). Creates no invoices, revenue or AR. Marking the specific
  deliveries is a separate owner-approved data migration.
- Check 7 (delivery-invoice quantity) skips deliveries billed outside CRX and now counts only
  completed deliveries and active (non-deleted, non-voided/cancelled) invoices.
- Checks 3/4 no longer filter `status = 'posted'` (which matched no live invoice once posted
  invoices became paid/overdue): check 3 covers posted/paid/overdue, check 4 every active invoice.
- Check 8 (prebooked inventory) counts only live open orders (confirmed/partially_fulfilled,
  not soft-deleted), which exposes reservations never released by orders deleted in spring 2026.
- Integrity Cleanup hides deliveries billed outside CRX from "Completed deliveries without
  invoices", so it no longer offers to bill them a second time; if that record cannot be read the
  list is hidden.
