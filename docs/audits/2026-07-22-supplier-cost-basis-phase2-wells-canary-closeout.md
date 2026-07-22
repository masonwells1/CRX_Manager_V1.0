# Supplier Cost Basis Phase 2 — Wells Canary Closeout

**Date:** 2026-07-22
**Scope:** Ten Wells Ag Supply pilot Products; one approved `keep_sell_prices` selection
**Status:** Canary evidence clean. This is the final Phase 2 Wells canary closeout packet; broader rollout remains a separate gate.

## Owner verdict

The first live Phase 2 cost-basis selection completed through the authenticated Product Detail workflow. N-Serve moved from its prior $47.05 manual basis to the reviewed $47.26 Wells supplier observation. Tier sell prices remained exactly $52.77, $56.46, and $62.46. The global rollout flag remains `false`; only the private ten-Product Wells allowlist is enabled.

No evidence of sell-price drift, duplicate active bases, duplicate history, unauthorized table mutation access, or browser errors was found.

## Release chain

- Foundation migration: `20260722015019_supplier_cost_basis_phase2`.
- Wells rollout gate: submitted as `20260722060644_wells_cost_basis_rollout_gate`, live ledger version `20260722064814`, reconciled disk file `20260722064814_wells_cost_basis_rollout_gate.sql`.
- Received-PO reassignment repair: submitted as `20260722075500_lock_received_po_cost_snapshot_across_product_reassignment`, live ledger version and disk file `20260722080226`.
- Frontend and migration integration: PR #206, merge commit `5a3f49fa8a4c3bd2debb9ffbbf175242d16a0291`, final head `a4569dc8ac74025144412f7cee3efe6a6a470197`.
- PR #206 required checks passed: SQL Migration Validation, lint/typecheck/test/build, CodeQL, and Vercel. The advisory CodeRabbit review was read and resolved; the workflow-policy E2E job was skipped.
- Workbook-v2 and inner-RPC permission follow-up: PR #207, protected merge `b78535af583a366ee7ccafa65aaef15e9a639b4f`, final head `7ecdaceaef7b5e8afbac92fe89b9eba3cb1e01b7`.
- PR #207 passed exact-head Codex CLEAN, Claude SHIP-WITH-FOLLOWUPS with no blocker/high findings, SQL Migration Validation, lint/typecheck/test/build, CodeQL, Vercel, and CodeRabbit. Its two final CodeRabbit findings were addressed before merge.
- PR #207 production deployment `dpl_2u9A1U8RdeNjTtqzbmQL92WjdvsH` reached Ready and held the `croprxsolutions.app` alias; `/` and `/supplier-pricing` both returned HTTP 200.
- Permission hardening migration `20260722100456_revoke_inner_pricing_rpc_access` is live and reconciled on disk. Browser roles retain the governed cost-basis wrappers but cannot execute the legacy inner pricing engines directly.

## Live canary record

Applied change set: `3708874a-aceb-4130-9023-12d140b5a9b0`

| Fact | Observed value |
|---|---|
| Product | N-Serve - Bulk (`d1961efe-6133-4ab4-bf84-ac7bf7da903a`) |
| Apply time | 2026-07-22 07:37:06 UTC |
| Change-set source | `product_page` |
| Basis selection source | `product_detail` |
| Basis type | `selected_supplier_price` |
| Evidence | Wells supplier observation `52f1cbff-5cb9-4067-adc5-dd0422816861` |
| Reason | `Wells Ag Supply quote dated 2026-07-21; approved N-Serve pilot canary.` |
| Pricing behavior | `keep_sell_prices` (stored preview mode `price_driven`) |
| Cost | $47.05 → $47.26 |
| Tier 1 | $52.77 → $52.77 |
| Tier 2 | $56.46 → $56.46 |
| Tier 3 | $62.46 → $62.46 |
| Pricing version | 1 → 2 |
| Cost-history rows for this change set | Exactly 1 |

The cost increase is the intended selected-basis change. It raised the ten-Product Wells cost total by $0.21, from the pre-canary $882.03 baseline to $882.24. Sell-price totals remained at the pre-canary baselines: Tier 1 $995.67, Tier 2 $1,097.73, and Tier 3 $1,220.51.

## Observation proof

Read-only live postflight at 2026-07-22 10:46:53 UTC, more than three hours after apply, returned:

- `supplier_cost_basis_enabled = false`.
- exactly 10 rollout rows and 10 matching Products;
- exactly 10 active basis rows across those Products;
- exactly one applied supplier-backed Product Detail canary;
- exactly one `_supplier_cost_basis_enabled_for_product(uuid)` overload;
- zero before/after tier-price differences in the applied canary row;
- current Wells totals of cost $882.24 / Tier 1 $995.67 / Tier 2 $1,097.73 / Tier 3 $1,220.51.

Live privileges also showed `authenticated` can SELECT `purchase_order_items` but cannot INSERT, UPDATE, or DELETE it. The governed `save_purchase_order` and `receive_po_items` RPCs remain executable. This disproves the mechanically open PR comment that an authenticated admin could manufacture received purchase evidence through direct table DML; the RLS policy alone is not sufficient without the table privilege.

The CodeRabbit suggestion to replace PO fixture `unit_cost = 47.26` with `4726` is also non-actionable. `purchase_order_items.unit_cost` is the legacy exact-dollar numeric column; the generated `unit_cost_cents` column is the bigint-cents representation.

## Replay and quote/order snapshot proof

A final live verification closed the original rollout-plan checks:

- the canary change set remains `applied`, retains its exact `apply_result`, and has exactly one matching `apply_product_cost_basis_change_set` idempotency receipt with a non-null saved result;
- the public wrapper contains the cache-replay return, and the private serialized helper contains the durable applied-change-set return used after cache expiry;
- exact word-boundary inspection covered the public cost-basis wrapper, private serialized helper, inner `apply_product_pricing_change_set` engine, the `product_cost_basis` history trigger, and every live Product-update trigger function. None references `quote_items` or `order_items`, so the complete observed apply/trigger chain has no quote/order snapshot writer;
- N-Serve has no existing `quote_items` rows, so there was no quote snapshot to change;
- N-Serve's one existing `order_items` row still holds `cost_per_unit = $47.05` and `cost_at_time_cents = 4705` while the Product basis is now $47.26, directly confirming the historical order snapshot did not follow the Product update.

Timing disclosure: one exact cached idempotent replay call completed before the coordinator's STOP instruction arrived. It returned the stored apply response. Immediate read-only postflight proved zero durable change: the global flag remained `false`; rollout count remained 10; Product cost, tier prices, and pricing version remained $47.26 / $52.77 / $56.46 / $62.46 / version 2; the N-Serve basis row, this change set's cost-history row, and its matching idempotency receipt each remained at 1; basis selection and change-set apply timestamps were unchanged; and the existing order snapshot remained $47.05 / 4,705 cents. No further live RPC, write, or apply was performed.

## Authenticated browser proof

Production Product Detail was opened while signed in as an administrator. The page showed:

- current selected basis `selected supplier price` at $47.26;
- the approved canary reason;
- pricing behavior `Keep current sell prices; recalculate margins`;
- Wells supplier observation $47.26 dated 2026-07-21;
- prior received-PO cost $47.05 dated 2026-03-16;
- selected-basis history points for $47.05 and $47.26;
- current cost $47.26 and tier prices $52.77 / $56.46 / $62.46;
- zero captured console warnings or errors.

No additional preview or apply was submitted during closeout verification.

## Architecture evidence

Graphify was refreshed again from post-PR-#207 `main` at `b78535af` with 7,919 nodes and 16,242 edges. The scoped query used during the canary review was:

```text
graphify query "what connects product_cost_basis_rollout to get_product_cost_basis_workspace preview_product_cost_basis_changes and apply_product_cost_basis_change_set?" --budget 1400
```

Graphify identified the workspace and preview migration communities. Current SQL and live read-only catalog/data checks—not the graph alone—confirmed the allowlist helper, workspace behavior, apply record, grants, and monetary result.

## Closed scope and remaining release boundary

- Keep the global flag `false`.
- Keep rollout limited to the exact ten Wells Products.
- Do not run the optional `keep_margins_and_reprice` experiment without a separate explicit approval on a non-customer-impacting test Product.
- Treat broader admin rollout, allowlist removal, or any additional live Product basis selection as a new production gate rather than part of this completed canary.
