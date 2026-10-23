## 2026-10-23 - Recorded: product brands list is live (row 975)

- Migration `20261022086500_product_brands` (migration-history row 975, PR #1050 merged as `9ec42855c`) was applied
  live 2026-10-23 19:38:16 UTC (2:38 PM Central), ledger version `20261023193816`, through fix-forward PR #1072
  (merged as `09ef4c124`) because #1050 merged before its apply.
- Read-only live check: `product_brands` has RLS on, a single SELECT policy, SELECT-only grants for
  `authenticated`, and 0 rows; `upsert_product_brand` is SECURITY DEFINER with `search_path=public, pg_temp` and
  EXECUTE for exactly `postgres` and `authenticated`. The full ledger is 1056 rows; the effective ordering
  high-water is `20261022086500`.
- Row 975, a new live capture in `migration-history.md`, the `CURRENT_STATE.md` ledger header, the product-brands
  headings in `database-schema.md` and `rpc-functions.md`, To-Do 2.8 and the schema registry now reflect live.
