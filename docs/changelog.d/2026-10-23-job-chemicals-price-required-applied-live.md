## 2026-10-23 - Recorded: job chemical lines refuse an unpriced $0 line (row 981 live)

- Migration `20261022087000_job_chemicals_refuse_unpriced_zero_price_line` (migration-history row 981, PR #1060,
  merged as `52a67ab2a`) was applied live 2026-10-23 19:57:46 UTC (2:57 PM Central), ledger version
  `20261023195746`, just before the merge.
- Read-only live check after the merge: `_job_chemical_price_required` equals its postflight md5 pin and is
  SECURITY DEFINER, owner `postgres`, `search_path=public, pg_temp`, EXECUTE for `postgres` only; trigger
  `job_chemicals_price_required` is enabled on `job_chemicals`. The full ledger is 1057 rows; the effective
  ordering high-water is `20261022087000`.
- Row 981, a new live capture in `migration-history.md`, the `CURRENT_STATE.md` ledger header, the `save_job`
  note in `rpc-functions.md` and the schema registry's applied names and high-water now reflect live. The
  migration adds no table, column or CHECK, so no other registry section changes.
