## 2026-10-06 - CRX-LIFE-001: the order pipeline can no longer create a field-application invoice

`create_invoice_from_order` and `create_split_invoices_from_order` took the invoice type from the
caller, so any admin or sales rep could turn an order into a `field_application` invoice with no
field, grower share, job, blend ticket or season workflow behind it. Mason approved the fix and a
read-only exposure count on 2026-10-06.

**Exposure (read-only, 2026-10-06 Chicago):** 13 invoices live; 12 `chemical_sale` (all from
orders) and one `field_application`, which has no order. Nothing was ever created through the hole,
so there is nothing to repair.

**The fix, `supabase/migrations/20261006200000_refuse_field_invoice_through_order_rpcs.sql`** (no rows
changed, no GRANT or REVOKE):
- A VALID CHECK `invoices_field_application_has_no_order`: a `field_application` invoice never carries
  an `order_id`. Only the owner can write `invoices`, so this binds every SECURITY DEFINER writer,
  including the split engine's direct INSERT and any future path. Every live field-invoice creator
  (`save_field_app_invoice`, `save_field_app_split_invoice`, `transfer_job_to_invoice`,
  `create_invoice_from_blend_ticket`) leaves `order_id` NULL.
- A pinned re-emit of the thin public `create_invoice_from_order` wrapper that accepts only
  `chemical_sale` (the default the app sends) or `misc_charge` and raises
  `ORDER_INVOICE_TYPE_NOT_ALLOWED` (SQLSTATE 23514) for anything else, before any lock or replay
  lookup. Same OID, owner, `search_path` and ACL, proven by the postflight. `credit_memo` is refused
  too: credit memos come only from `issue_return_credit`.
- The split wrapper and the three private implementations are deliberately not re-emitted; the CHECK
  refuses a `field_application` split, and a `credit_memo` split can never produce a row.

**Proof (disposable container, not live):** `scripts/smoke/prove-order-invoice-type-gate-real-schema.mjs`
(`npm run proof:order-invoice-type-gate`) restores the 2026-07-27 baseline and replays the 102 later
migrations, then checks that the five order-path function bodies match live (by md5 with carriage
returns removed; live stores the idem impl's body with CRLF). It reproduces the bug before the fix
(a sales rep's order becomes a `field_application` invoice, and the split engine makes order-backed
field invoices too), shows the preflight blocks the apply while such a row exists, applies the fix,
and proves: rep and admin `field_application`, `credit_memo` and NULL-typed calls refused with nothing
written; the rep's `chemical_sale`, the app's default-typed call and an admin's `misc_charge` still
work; the owner cannot insert an order-backed field invoice but can insert an orderless one; anon
still cannot execute; a second apply fails closed on its own pins. Mutations: without the CHECK the
split and direct-insert steps fail; with the old wrapper the type-gate chain fails. The real
field-invoice creator chain (`smoke-field-app-split-penny-exact.sql`) passes after the fix.

**Smoke chains:** new registered chain `scripts/smoke/smoke-order-invoice-type-gate.sql` (spec
`order_invoice_type_gate`, fail-first), and a new refusal step in
`smoke-backfill-refuse-split-billing.sql`. That chain's fixture inserted a pricing-free product and
aborted on `COST_BASIS_REQUIRED` at its first quote line, so it checked nothing against the current
schema; it now borrows a priced product, the `smoke-save-job-parity.sql` pattern.

**Found, not fixed here:** `smoke-govern-invoice-order-money-lifecycle.sql` is stale the same way, and
`smoke-money-lifecycle-idempotency-required.sql` fails with `FUTURE_FINANCE_CHARGE_DATE` between
00:00 UTC and Chicago midnight. Listed in `KNOWN_ISSUES.md` for a separate test-fixture change.

**Not verified on live:** the migration is not applied by this entry; under the landing rule it applies
before the PR merges and the PR records `Applied live:`. The post-apply smoke chains and invariant
sweeps run then.

Docs: `KNOWN_ISSUES.md` (CRX-LIFE-001 to the archive as FIXED; ledger stamp re-verified),
`CURRENT_STATE.md`, `migration-history.md` (row 937), `rpc-functions.md`, `database-schema.md`,
`QUOTE_TO_DELIVERY.md` (field-invoice entry points, now three), `.gitattributes` (LF pin for the new
migration, whose postflight pins an LF body md5).
