## 2026-10-08 - Billed-outside-CRX review round 4: lock on invoice reactivation (NOT APPLIED)

- Codex (Luna) round 3 HIGH: an invoice restored or un-voided at the same moment its delivery is
  recorded as billed outside CRX could slip past both guards. The invoice guard now takes the same
  order lock the recording guard takes before checking, so the two always serialize.
- The delivery_external_billings reason must contain a non-whitespace character (newline-only or
  tab-only reasons were accepted by the `btrim` check).
- The invoice-payment check (3/4) reads invoices and allocations page by page too.
- The invoice guard's postflight now pins the trigger function and its five event columns.
- Accepted and recorded in KNOWN_ISSUES: offset paging can shift by a row if data changes between
  pages of one integrity run.
