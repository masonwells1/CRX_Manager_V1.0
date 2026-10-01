## 2026-09-21 — qualify the generic field-edit statement and name the commission-first boundary

Documentation only; no migration, hash or behaviour change.

- `docs/reference/rpc-functions.md` said existing generic field edits "remain unchanged", which
  could be read as those edits bypassing the filed-season guards (CodeRabbit, PR #754). It now
  names the two exceptions the row trigger enforces on every writer: a date or `invoice_type`
  change on an invoice that is, or becomes, a field-application invoice must pass the filed-season
  date validation, and a change to the filed `season` is refused. Wording checked against the
  trigger body in `20260914101100_preserve_unchanged_source_invoice_dates.sql`.
- `docs/reference/migration-history.md`'s COMMISSION-FIRST RULE now names the exact boundary:
  the four field-invoice candidates apply only after `20260914100900` is applied live. The
  commission cohort is planned in two batches, and applying after the first alone would strand
  `20260914100800` and `20260914100900`.
