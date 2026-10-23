## 2026-10-23 - Recorded: invoice posting reads a cost-free view (row 976 live)

- Migration `20261022090000_invoices_postable_view` (migration-history row 976, PR #1057, merged as `604041981`)
  was applied live 2026-10-23 22:38:53 UTC (5:38 PM Central), ledger version `20261023223853`.
- Read-only live check after the merge: `invoices_postable` is a `security_invoker` view without
  `total_cost_cents`, SELECT for `authenticated` and `service_role` only (plus the existing read-only
  `metabase_ro`, which already reads all of `invoices`); `invoice_postable_version` is SECURITY DEFINER with
  `search_path=public, pg_temp`. The full ledger is 1058 rows; the effective ordering high-water is
  `20261022090000`.
- Row 976, a new live capture in `migration-history.md`, the `CURRENT_STATE.md` ledger header, KI-74, To-Do 11.3,
  the `rpc-functions.md` note and the schema registry's applied names and high-water now reflect live.
