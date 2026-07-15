# Money and Inventory Hardening — Live Read-Only Evidence

Verified against linked production schema `rhyzpcqhnizqbxphqdkr` on 2026-07-14 (America/Chicago). All database commands were `SELECT` queries or explicit transaction smokes ending in `SMOKE_PASS_ROLLBACK`. No migration or live-data mutation was applied.

## Legacy return compatibility

A read-only query inspected every non-deleted return in `requested`, `approved`, or `received` status and joined every line to `order_items`.

- Invalid/open-or-received source count: **1**.
- The only row is the already-pinned compatibility record: return `0cb556ed-467a-4949-866d-8d9edbb09522`, `RMA-2026-0001`, status `approved`, `order_id IS NULL`.
- There are **zero** open linked returns with a null, missing, or cross-order `order_item_id`.
- There are **zero** `return_items` rows with `quantity <= 0`.

This confirms the exact-record legacy branch in migration `20260714222000` covers the sole live exception and the positive-quantity constraint validates on current production data.

## Financial dashboard definition

`pg_proc.prosrc` was inspected read-only for the four re-emitted report functions. The current live `financial_dashboard_summary()` already excludes `draft` orders in every affected order aggregate with `status NOT IN ('cancelled', 'draft')`. It does not yet exclude `voided`; migration `20260714223000` adds only `voided` to those existing status lists and replaces the legacy role-string gate with the repository's active-admin check. The detail and summary reports currently exclude `cancelled` and the migration adds `voided`.

## UI and permission checks

- The Returns detail workflow renders `Issue Credit` only inside the existing `isAdmin` action block.
- The general invoice batch confirmation explicitly states that selecting any split invoice posts every current member of that split group, including invoices outside current filters or loaded results. This avoids treating the browser's 2,000-row result window as authoritative group membership.
- Anonymous execution of `get_gross_sales_report` is explicitly revoked and asserted by the migration and rollback smoke.

## Execution proof

- The five pending migrations plus `smoke-return-credit-chain.sql` completed through the expected terminal `SMOKE_PASS_ROLLBACK`, including the partially-fulfilled order guard.
- The five pending migrations plus `smoke-remaining-money-inventory-hardening.sql` completed through `SMOKE_PASS_ROLLBACK`, including the sales-rep `NULL` over-receive case and anonymous report grant check.
- Production data and migration history remained unchanged.
