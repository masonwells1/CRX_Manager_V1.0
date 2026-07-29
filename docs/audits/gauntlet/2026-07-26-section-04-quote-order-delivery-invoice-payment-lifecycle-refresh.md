# CRX Live Foundation Gauntlet - Section 4 Refresh

Date: 2026-07-26

Section: Quote to order to delivery to invoice to payment lifecycle wiring

Mode: read-only audit of current repo code plus live Supabase database structure only. No Sentry, Vercel, GitHub PR, browser-session, production telemetry, code edits, migrations, data mutation, commit, push, deploy, or delete actions were performed.

## Verdict

No confirmed Section 4 product findings.

Severity counts: 0 BLOCKER / 0 HIGH / 0 MED / 0 LOW.

Production risk: no quote -> order -> delivery -> invoice -> payment wiring defect was proven in this pass. Scope warning only: this detached checkout is behind `origin/main` and the live migration ledger is newer than the disk migration high-water, so this report proves the checked-out code and live catalog inspected here, not every commit currently ahead on `origin/main`.

## Starting State

`git status --short --branch` at run start:

```text
## HEAD (no branch)
 M docs/audits/gauntlet/live-foundation-gauntlet-index.md
 M docs/audits/gauntlet/live-foundation-gauntlet-summary.md
?? docs/audits/2026-07-22-codex-to-claude-supplier-pricing-phase3-handoff.md
?? docs/audits/2026-07-25-codex-to-claude-phase3-stage-b-handoff.md
?? docs/audits/gauntlet/2026-07-22-section-03-inventory-holds-prebooks-deliveries-receiving-refresh.md
?? scripts/smoke/prove-supplier-pricing-phase3-return-policy-concurrency.mjs
?? scripts/smoke/smoke-supplier-pricing-phase3-return-policy.sql
?? supabase/migrations/20260722222743_product_families_return_policy_foundation.sql
```

These files existed before this run. This run only wrote the Section 4 report plus the allowed gauntlet index/summary updates.

Repo freshness observed without fetching: `git rev-parse HEAD` returned `bf2a60efeff0f82a9749067ea8710737232eb8c9`; `git rev-list --left-right --count origin/main...HEAD` returned `27 0`. Because the task allowed writes only under `docs/audits/gauntlet/`, I did not run `git fetch`.

Graphify note: `graphify-out/GRAPH_REPORT.md` exists and was built from commit `bf2a60ef`, matching this checkout. I did not run `npm run graph:refresh` because it writes outside the allowed audit folder.

## Evidence Reviewed

Required instruction docs read:

- `CLAUDE.md`
- `AGENTS.md`
- `docs/workflows/SAFE_DEVELOPMENT_RULES.md`
- `docs/reference/gotchas.md`
- `docs/workflows/CODEX_REVIEW_GAUNTLET.md`
- `docs/workflows/QUOTE_TO_DELIVERY.md`

Source/code evidence:

- Quote list conversion calls `convert_quote_to_order` with `p_performed_by` and `p_idempotency_key`, unwraps via `assertRpcResult`, and suppresses duplicate side effects on idempotency replay: `src/pages/Quotes.tsx:183`, `src/pages/Quotes.tsx:191`, `src/pages/Quotes.tsx:205`.
- QuoteBuilder blocks whole-booking conversion before marking a quote accepted when order/job draw ledgers show partial draw-downs, then calls the same atomic RPC with actor and idempotency key: `src/pages/QuoteBuilder.tsx:2049`, `src/pages/QuoteBuilder.tsx:2057`, `src/pages/QuoteBuilder.tsx:2097`, `src/pages/QuoteBuilder.tsx:2102`, `src/pages/QuoteBuilder.tsx:2108`.
- Direct order creation passes `p_performed_by` and `p_idempotency_key`, unwraps `create_direct_order`, and only sends non-blocking follow-up notifications after the order exists: `src/pages/NewOrder.tsx:514`, `src/pages/NewOrder.tsx:520`, `src/pages/NewOrder.tsx:528`, `src/pages/NewOrder.tsx:562`.
- New delivery creation uses `create_delivery_with_items` with an idempotency key and unwraps the atomic response: `src/pages/NewDelivery.tsx:50`, `src/pages/NewDelivery.tsx:410`, `src/pages/NewDelivery.tsx:426`, `src/pages/NewDelivery.tsx:436`.
- Delivery completion builds `complete_delivery` params with actor, idempotency key, optional partial quantities, and offline replay payload including `p_completed_at`: `src/pages/DeliveryDetail.tsx:778`, `src/pages/DeliveryDetail.tsx:790`, `src/pages/DeliveryDetail.tsx:801`.
- Order-level invoice creation is blocked in the UI when active delivery/invoice state would make a stale whole-order invoice dangerous, and it routes split versus non-split invoice creation through idempotent RPC calls: `src/pages/OrderDetail.tsx:891`, `src/pages/OrderDetail.tsx:897`, `src/pages/OrderDetail.tsx:900`, `src/pages/OrderDetail.tsx:845`, `src/pages/OrderDetail.tsx:856`, `src/pages/OrderDetail.tsx:872`.
- Delivery-level invoice backfill calls `create_invoice_for_unbilled_delivery` with actor and idempotency key: `src/pages/DeliveryDetail.tsx:1095`, `src/pages/DeliveryDetail.tsx:1098`, `src/pages/DeliveryDetail.tsx:1102`.
- Invoice posting routes grouped invoices through `post_invoice_group`, standalone invoices through `post_invoice`, and uses the same idempotency key for the target action: `src/pages/InvoiceDetail.tsx:761`, `src/pages/InvoiceDetail.tsx:766`, `src/pages/InvoiceDetail.tsx:775`.
- Payment allocation uses `allocate_payment` with actor, idempotency key, allocations, and `assertRpcResult`: `src/pages/PaymentAllocation.tsx:285`, `src/pages/PaymentAllocation.tsx:293`, `src/pages/PaymentAllocation.tsx:299`.

Disk migration evidence:

- `convert_quote_to_order` actor/idempotency/partial-draw safeguards are present on disk: `supabase/migrations/20260702172500_layer2_convert_quote_to_order_job_aware.sql:27`, `supabase/migrations/20260702172500_layer2_convert_quote_to_order_job_aware.sql:42`, `supabase/migrations/20260702172500_layer2_convert_quote_to_order_job_aware.sql:53`, `supabase/migrations/20260702172500_layer2_convert_quote_to_order_job_aware.sql:57`, `supabase/migrations/20260702172500_layer2_convert_quote_to_order_job_aware.sql:89`, `supabase/migrations/20260702172500_layer2_convert_quote_to_order_job_aware.sql:99`, `supabase/migrations/20260702172500_layer2_convert_quote_to_order_job_aware.sql:246`.
- `create_delivery_with_items` is idempotent and locks/validates the order path: `supabase/migrations/20260518010000_create_delivery_with_items_validate_order_status_and_address.sql:31`, `supabase/migrations/20260518010000_create_delivery_with_items_validate_order_status_and_address.sql:75`, `supabase/migrations/20260518010000_create_delivery_with_items_validate_order_status_and_address.sql:95`, `supabase/migrations/20260518010000_create_delivery_with_items_validate_order_status_and_address.sql:211`.
- `complete_delivery` requires in-progress status, actor binding, row locks, and idempotency save: `supabase/migrations/20260716120104_gauntlet_access_boundaries.sql:38`, `supabase/migrations/20260716120104_gauntlet_access_boundaries.sql:54`, `supabase/migrations/20260716120104_gauntlet_access_boundaries.sql:58`, `supabase/migrations/20260716120104_gauntlet_access_boundaries.sql:70`, `supabase/migrations/20260716120104_gauntlet_access_boundaries.sql:254`, `supabase/migrations/20260716120104_gauntlet_access_boundaries.sql:509`. The later wrapper authorizes before replay: `supabase/migrations/20260716173342_authorize_delivery_before_replay.sql:35`, `supabase/migrations/20260716173342_authorize_delivery_before_replay.sql:60`, `supabase/migrations/20260716173342_authorize_delivery_before_replay.sql:68`.
- Manual delivery-invoice backfill locks the delivery and order and saves idempotency: `supabase/migrations/20260718175641_backfill_invoice_refuse_split_billing.sql:16`, `supabase/migrations/20260718175641_backfill_invoice_refuse_split_billing.sql:38`, `supabase/migrations/20260718175641_backfill_invoice_refuse_split_billing.sql:46`, `supabase/migrations/20260718175641_backfill_invoice_refuse_split_billing.sql:50`, `supabase/migrations/20260718175641_backfill_invoice_refuse_split_billing.sql:67`, `supabase/migrations/20260718175641_backfill_invoice_refuse_split_billing.sql:172`.
- Public money-lifecycle wrappers require idempotency keys for order invoice creation, delivery invoice creation, and invoice posting: `supabase/migrations/20260721145936_require_money_lifecycle_idempotency_keys.sql:105`, `supabase/migrations/20260721145936_require_money_lifecycle_idempotency_keys.sql:118`, `supabase/migrations/20260721145936_require_money_lifecycle_idempotency_keys.sql:127`, `supabase/migrations/20260721145936_require_money_lifecycle_idempotency_keys.sql:141`, `supabase/migrations/20260721145936_require_money_lifecycle_idempotency_keys.sql:155`, `supabase/migrations/20260721145936_require_money_lifecycle_idempotency_keys.sql:166`.
- `allocate_payment` has actor binding, idempotency claim flow, and invoice-row locking: `supabase/migrations/20260713060300_harden_allocate_payment_idempotency.sql:19`, `supabase/migrations/20260713060300_harden_allocate_payment_idempotency.sql:45`, `supabase/migrations/20260713060300_harden_allocate_payment_idempotency.sql:63`, `supabase/migrations/20260713060300_harden_allocate_payment_idempotency.sql:164`.

Live Supabase catalog evidence:

- Read-only `supabase db query --linked --output-format json` found exactly one live overload each for `convert_quote_to_order`, `create_direct_order`, `create_delivery_with_items`, `confirm_delivery`, `complete_delivery`, `create_invoice_from_order`, `create_invoice_for_unbilled_delivery`, `create_split_invoices_from_order`, `post_invoice`, `post_invoice_group`, `allocate_payment`, `apply_prepay_to_invoice`, and `create_quick_delivery`.
- The same live catalog query showed these target RPCs are `SECURITY DEFINER`, `search_path=public, pg_temp`, and executable by `authenticated`, `postgres`, and `service_role`; no target lifecycle RPC in this Section 4 set showed an `anon` execute grant.
- Live `create_invoice_from_order` requires a nonblank idempotency key and delegates to `_create_invoice_from_order_idem_impl_20260721`; the internal implementation locks the order row `FOR UPDATE`, rejects terminal/deleted orders, rejects existing active invoices, and counts non-cancelled/non-voided deliveries before creating an order-level invoice.
- Live `complete_delivery` delegates through the authorized wrapper, locks the delivery row, rejects any status other than `in_progress`, writes delivered quantities into a draft invoice linked by `delivery_id`, and saves the `complete_delivery` idempotency result.
- Live `post_invoice` requires a nonblank idempotency key, binds replay to invoice and actor, rejects deleted invoices, and preserves the deleted-delivery recovery path only when invoice/order/delivery lineage matches.
- Live latest migration versions included `20260723193312`, while disk migration high-water in this checkout is `20260722222743_product_families_return_policy_foundation.sql`.

## Confirmed Findings

None.

## Refuted Or Not Carried Forward

- Stale order-level invoice after a delivery is scheduled/in flight: refuted. UI hides/warns on pending/active deliveries, and live `_create_invoice_from_order_impl_20260718` locks the order and refuses any non-cancelled/non-voided delivery before creating a whole-order invoice.
- Skipping delivery confirm -> complete: refuted. Frontend completion calls `complete_delivery`, and live/disk function evidence rejects completion unless the delivery is `in_progress`.
- Split invoice half-posting: refuted. InvoiceDetail and OrderDetail route invoice groups through `post_invoice_group`; standalone `post_invoice` is used only outside groups.
- Payment modal writing to a different ledger than the payment allocation screen: refuted. InvoiceDetail and PaymentAllocation both use `allocate_payment`.
- Repeat-click/lost-response lifecycle duplication for the audited paths: refuted for the inspected code/catalog. The frontend passes idempotency keys, and live wrappers now require or bind idempotency on invoice creation/posting/payment/delivery completion.

## Scope Warning

This is not counted as a product finding: the audit checkout is detached and 27 commits behind local `origin/main`, while the live Supabase migration ledger is newer than disk. That means this report is useful for the current checked-out repo plus live catalog, but Section 4 should be refreshed again after the checkout is updated to current `origin/main` if Mason needs a merge/readiness decision.

Suggested prevention: add a gauntlet preflight line that records `git rev-list --left-right --count origin/main...HEAD`, disk migration high-water, and live migration high-water in every section report. For merge/readiness audits, fail closed when the checkout is behind.

## Next Section

Section 5 is queued next: Database drift: migrations on disk vs schema registry vs live database catalog, CHECK constraints, overloads, generated columns, search_path.
