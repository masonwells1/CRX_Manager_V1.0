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
field invoices too), shows the file stops when run outside one transaction by a client that stops
on the first error (as every sanctioned apply path does) and that its preflight
blocks the apply while such a row exists, applies the fix, and proves: the rep's
`field_application`, `credit_memo` and NULL-typed calls and an admin's `field_application` call are
refused with nothing written; the rep's `chemical_sale`, the app's default-typed call and an
admin's `misc_charge` still work; the owner cannot insert an order-backed field invoice but can
insert an orderless one; anon still cannot execute; a second apply fails closed on its own pins
(wrapper drift, and with the old wrapper back, the existing CHECK). Mutations: without the CHECK the
split and direct-insert steps fail; with the old wrapper the type-gate chain fails. The three
registered chains covering `create_invoice_from_order` and the split-billing chain covering
`create_split_invoices_from_order` pass after the fix, and so does the chain for one real
field-invoice creator, `save_field_app_invoice` (`smoke-field-app-split-penny-exact.sql`).

**Smoke chains:** new registered chain `scripts/smoke/smoke-order-invoice-type-gate.sql` (spec
`order_invoice_type_gate`, fail-first, the rep's own customer and orders), and a new refusal step in
`smoke-backfill-refuse-split-billing.sql`. Three existing chains (two covering `create_invoice_from_order`, the split-billing one covering `create_split_invoices_from_order`)
were broken against the current schema and are repaired here, because the ship rule requires every
covering chain to pass after the apply:
- `smoke-backfill-refuse-split-billing.sql` and `smoke-govern-invoice-order-money-lifecycle.sql`
  inserted pricing-free products and aborted on `COST_BASIS_REQUIRED` at their first line, so they
  checked nothing. Their fresh products are now priced through the governed
  `preview_product_pricing_changes` / `apply_product_pricing_change_set` path (the
  `smoke-return-credit-chain.sql` pattern): no live catalog row is borrowed and no trigger disabled.
- Past that, `smoke-govern-invoice-order-money-lifecycle.sql` had four more stale fixtures, each a
  later rule it was never re-run against: commission rows without `recipient_user_id`
  (`COMMISSION_RECIPIENT_UNRESOLVED`; now linked to the chain's admin, labels unchanged), invoices
  set to `posted` without `posted_at` (`invoices_financial_status_requires_posted_at`), UTC
  `current_date` used as the business date (`COMMISSION_PAYMENT_DATE_AFTER_BUSINESS_TODAY` between
  00:00 UTC and Chicago midnight; now the Chicago business date throughout), and only
  `request.jwt.claims` set (the disposable-database image's `auth.uid()` reads
  `request.jwt.claim.sub`; both are set now, as the other chains do). No assertion was changed.
- `smoke-money-lifecycle-idempotency-required.sql` passed the UTC `current_date` to
  `generate_finance_charges`, which refuses a date after the Chicago business date, so it failed
  with `FUTURE_FINANCE_CHARGE_DATE` between 00:00 UTC and Chicago midnight. It now passes the Chicago
  business date.

**Reviews (review round 1, on commit `08cac5de4`):** `rls-security-reviewer`, `migration-drift-reviewer`,
`typescript-types-drift-reviewer`, `compliance-reviewer` and two adversarial reviewers (business logic;
tests and docs), each finding checked by independent skeptics: no BLOCKER or HIGH. Fixed: the two
MEDs (repair every covering chain, above; the archive heading no longer dates the fix before its
apply), and the LOWs worth fixing (an up-front one-transaction guard in the preflight, a proof of the
existing-CHECK preflight branch, the two split refusal paths described exactly, consistent
measurement dates, this review record). Codex Luna round 1 (`gpt-6-luna`/xhigh): one MED (the new
chain's customer and orders were not the rep's), refuted by the container run but fixed anyway.
Accepted as is: the split RPC has no type allow-list of its own (the CHECK binds it; a `credit_memo`
split cannot write a row); a zero-total split of any type returns `[]` and clears
`needs_split_billing` (pre-existing, writes no invoice); `p_salesman_id` is not checked against the
caller (pre-existing, recorded in `KNOWN_ISSUES.md`); the type check runs before the role check (both
refuse, neither writes).

**Not verified on live:** the migration is not applied by this entry; under the landing rule it applies
before the PR merges and the PR records `Applied live:`. The post-apply smoke chains and invariant
sweeps run then.

Docs: `KNOWN_ISSUES.md` (CRX-LIFE-001 kept OPEN as "fix pending apply" until a follow-up verifies
the live state, as the PR #885 review asked; ledger stamp re-verified),
`CURRENT_STATE.md`, `migration-history.md` (row 937), `rpc-functions.md`, `database-schema.md`,
`QUOTE_TO_DELIVERY.md` (field-invoice entry points, now three), `.gitattributes` (LF pin for the new
migration, whose postflight pins an LF body md5).
