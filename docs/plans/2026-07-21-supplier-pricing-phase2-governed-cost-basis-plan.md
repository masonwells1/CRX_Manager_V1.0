# Supplier Pricing Phase 2 — Governed Cost Basis Build Plan

**Date:** 2026-07-21
**Status:** Mason approved and merged migration-first PR #196 on 2026-07-21 as main commit `c4b16d19aa69bbbda9f96206ad743f74397ef030`. Vercel production deployment completed successfully and `/supplier-pricing` returned HTTP 200. Live Supabase now records `20260722015019_supplier_cost_basis_phase2`; the feature flag remains disabled. Live postflight found 602 baseline rows and 602 active rows, zero change rows, one exact overload for each new RPC, and unchanged Wells Product cost/sell-price totals. A rollback-only live preview→apply chain returned `SMOKE_PASS_ROLLBACK`, and all 17 invariant sweeps returned zero unallowlisted findings. Before merge, the disposable PostgreSQL proof returned `SMOKE_PASS_ROLLBACK`; 98 focused tests and the full 3,791-test pipeline passed with 118 skipped. Both migration reviewers returned CLEAN with zero blocker/high/medium findings; Claude returned `SHIP-WITH-FOLLOWUPS` with no blocker/high findings; the required Codex push review returned CLEAN on its successful retry after one tooling timeout. All protected GitHub checks passed, including SQL validation, lint/typecheck/test/build, CodeQL, Vercel, and CodeRabbit; E2E was intentionally skipped by workflow policy. CodeRabbit reported no actionable comments. Two mechanically unresolved GitHub Codex threads were non-actionable on final code: the PO-snapshot claim was disproved by the migration trigger and smoke proof, and the supplier-lock deadlock was fixed by observation-first locking. The frontend remains separately parked behind live registry/generated-types refresh and the queued-RPC CI barrier; the feature must not be enabled until that release is complete and its live canary is approved.
**Parent roadmap:** `docs/plans/2026-07-16-supplier-pricing-and-variants-plan.md`

**Frontend verification follow-up:** Authenticated workbook review found that the original wrapper attempted cost-basis resolution for every manifest row, including a legitimate unchanged Product whose exported current cost was blank. Follow-up migration `20260722035521_allow_inert_null_cost_workbook_rows` is now live; it preserves full workbook manifest, identity, token, formula, and baseline validation, then omits only the exact unchanged/null-cost/no-selection row from the basis ledger. Changed Products and explicit selections remain fail-closed. Disposable PostgreSQL proof passed with one inert null-cost row and one changed row. The feature flag remains OFF.

## 1. Pilot gate and current evidence

Phase 2 is allowed to enter planning because the Wells Ag Supply Phase 1b operational pilot completed end to end:

- 10 confirmed supplier-product links, each with an approved `1` conversion into the CRX inventory unit.
- One invalid staging was rejected before approval and retained in the audit trail.
- One corrected import was approved with 10 observations dated 2026-07-21.
- The Supplier Comparison screen identifies Wells and its normalized replacement cost.
- The Product page charts the new Wells observation beside the selected cost basis and actual-paid history.
- `products.current_cost`, all three tier-price totals, and the 9 existing `cost_history` rows for the linked pilot Products remained at the pre-pilot baseline. Supplier evidence changed; sell pricing did not.

Phase 1b cleanup is complete: the reviewed Wells `legacy_vendor_resolution` now labels exact Wells historical purchase facts without rewriting purchase rows or Product pricing. That stewardship remains separate from Phase 2 provenance.

## 2. Outcome

Give an administrator one deliberate workflow to choose the cost CRX will use for pricing, preview every resulting margin and sell-price effect, and confirm the change through an idempotent database transaction.

Supplier imports remain evidence-only. Approving a quote must never select a cost basis or change a sell price.

## 3. Business rules

1. **Selection is explicit.** No supplier observation, purchase receipt, scheduled job, trigger, or client heuristic may automatically become the selected basis.
2. **Preview is mandatory.** The exact product version, proposed basis, pricing mode, resulting margins, and resulting tier prices are persisted before apply.
3. **Safe default:** selecting a basis keeps the current tier sell prices and recalculates margins. Repricing from retained margins is a separate explicit option in the confirmation flow.
4. **One active basis per product.** Historical selections remain queryable and attributable.
5. **Integer cents at the boundary.** New records use `bigint` cents. The governed pricing RPC remains the only cents-to-legacy-dollar conversion point.
6. **Fresh evidence only.** A supplier candidate must still exist, be approved, not be superseded, and be comparable when apply runs.
7. **Optimistic concurrency.** Apply fails if `products.pricing_version` or the preview fingerprint changed after preview.
8. **No client authority.** The browser sends the choice; PostgreSQL derives and enforces the financial result.
9. **Order behavior stays unchanged.** Existing quote and order snapshot semantics are not migrated in this phase.

## 4. Data model

Add `public.product_cost_basis` in a new migration:

| Field | Purpose |
|---|---|
| `id uuid` | Immutable history-row identity |
| `product_id uuid` | Product whose basis was selected |
| `basis_type text` | `selected_supplier_price`, `actual_purchase`, or `manual_override` |
| `cost_cents bigint` | Exact selected cost, positive integer cents |
| `supplier_price_observation_id uuid null` | Required only for a supplier-price selection |
| `purchase_order_item_id uuid null` | Required only for an actual-purchase selection |
| `effective_from timestamptz` | When this selection became active |
| `effective_to timestamptz null` | Set only when a later selection closes the row |
| `reason text` | Required owner-readable reason; mandatory and substantive for manual override |
| `pricing_change_set_id uuid` | Preview/apply record that produced the selected basis and pricing result |
| `selected_by uuid`, `selected_at timestamptz` | Actor and audit time |

Required constraints and guards:

- One active row per product with a partial unique index on `product_id WHERE effective_to IS NULL`.
- Check constraints tie each `basis_type` to the correct source foreign key and forbid unrelated source IDs.
- Supplier source must match the same product and remain a current, non-superseded observation.
- Actual-purchase source must reference a received purchase fact for the same product.
- Direct table writes are revoked from browser roles; selection and closure occur only inside the governed apply RPC.
- RLS is enabled in the migration, with admin-only read access and RPC-only writes.
- Historical fields are immutable. The only allowed update is the apply RPC closing the previously active row.

Bootstrap existing products with a `manual_override` basis equal to `products.current_cost`, reason `Phase 2 bootstrap from existing selected cost`. Do not infer a supplier or purchase source, and do not update `products` during bootstrap.

`products.current_cost` remains a compatibility cache of the active basis until all readers are deliberately migrated. It is not independently editable.

## 5. Database workflow

### Preview RPC

Add `preview_product_cost_basis_selection(...)` with a required idempotency key. Inputs identify the product, source evidence or manual amount, reason, expected `pricing_version`, and pricing behavior:

- `keep_sell_prices` — recommended default; preserve tier prices and recalculate margins.
- `keep_margins_and_reprice` — preserve entered margins and calculate new tier prices.

The RPC validates the actor, source provenance, cents, product/unit compatibility, and current version. It then creates or reuses the existing `pricing_change_sets` / row / preview-row structure and returns:

- old and proposed selected basis, type, source, and as-of date;
- current versus resulting cost, tier prices, net margins, and gross margins;
- per-tier dollar and percentage changes;
- a plain warning when any sell price changes;
- change-set ID, request fingerprint, expected product version, and a summary suitable for the confirmation modal.

No `product_cost_basis`, `products`, or `cost_history` row changes during preview.

### Apply RPC

Add `apply_product_cost_basis_selection(...)` with change-set ID, request fingerprint, actor, and required idempotency key.

In one transaction it must:

1. Re-authenticate the actor and require the admin role.
2. Lock the change set, product, source observation/purchase row, and current active basis in a deterministic order.
3. Revalidate the fingerprint, `pricing_version`, source status, product match, conversion/comparability, and selected pricing behavior.
4. Close the previous active basis and insert the new basis row.
5. Apply the already-previewed product cost/margin/tier result through the existing governed pricing invariants.
6. Let `trigger_write_product_pricing_history` capture the final product values exactly once.
7. Return the stored basis row, final product pricing, new `pricing_version`, and an owner-readable audit summary.

Any failure rolls back both basis selection and product pricing. Replaying the same idempotency key returns the durable prior result; reusing it with different input fails.

### Hard database invariants

- Keep `trigger_y_require_governed_product_pricing`, `trigger_z_guard_version_product_pricing`, and `trigger_write_product_pricing_history` effective.
- Do not create a second product-pricing writer.
- Do not let the cost-basis table become a way around the existing change-set fingerprint or version checks.
- Ensure an observation correction does not silently alter a basis already selected from the superseded observation. It remains historical until an administrator selects a replacement.

## 6. Application changes

Expected files/surfaces:

- `src/lib/productPricing.ts` — typed cost-basis preview/apply wrappers using `assertRpcResult()`.
- `src/lib/supplierPricing.ts` — candidate/source types shared with history and comparison.
- `src/components/products/ProductPriceHistory.tsx` — add `Select as cost basis` actions only where the evidence is eligible.
- `src/pages/ProductDetail.tsx` — candidate selection, pricing-behavior choice, preview panel, and `ConfirmModal` apply.
- `src/pages/Products.tsx` — no first-release bulk basis apply; link to the single-product governed flow only.
- `src/types/index.ts` and generated Supabase types — shared types for basis rows and RPC results.

Product-page flow:

1. Administrator sees replacement cost, selected basis, last paid, and recent-PO average side by side.
2. Administrator chooses an eligible source or manual override and enters a reason.
3. UI defaults to **keep current sell prices**.
4. Preview shows the exact before/after cost, margins, and tier prices. Any sell-price change is visually prominent.
5. Apply uses a fresh idempotency key and the preview fingerprint.
6. The page reloads from the server and shows the new basis point in Supplier Price History and the matching product pricing values.

Do not add a direct `Update current cost` escape hatch. Existing Product-page pricing edits continue through the Phase 1a preview/apply path.

## 7. Proof package

### SQL and RPC tests

- Migration shape, RLS, grants, foreign keys, check constraints, unique active-row index, and immutable-history guard.
- Bootstrap preserves every `products` and `cost_history` value.
- Supplier, actual-purchase, and manual-override source-shape tests.
- Cross-product source forgery, superseded observation, unresolved/incomparable link, non-received purchase, zero/negative/overflow cents, and blank reason rejection.
- Preview is read-only.
- Default mode changes cost and margins but leaves all three tier prices byte-for-byte unchanged.
- Reprice mode changes only the values shown in preview.
- Stale product version and stale/falsified fingerprint rejection.
- Same-key replay, conflicting-key reuse, unauthorized actor, forged actor, concurrent selection, and full rollback tests.
- Exactly one cost-history entry for an applied change; none for preview or failed apply.
- Supplier import approval still creates observations only.

### Frontend tests

- Candidate eligibility and cannot-compare messaging.
- Default `keep_sell_prices` selection.
- Before/after preview rendering and explicit sell-price warning.
- Confirmation modal, busy-state double-click protection, retry/replay behavior, and sanitized errors.
- Product history refresh shows the new selected-basis point and correct supplier filter.

### Required verification before merge

- Focused SQL smoke in a rollback-only disposable database.
- `npm run typecheck`, `npm run lint`, `npm run test`, and `npm run build`.
- Real browser proof on a non-production environment.
- Codex cross-model review for the migration, RLS, money arithmetic, and RPCs.
- Protected-branch PR, required checks, CodeRabbit review disposition, and Vercel preview verification.

## 8. Rollout and production gate

1. **Read-only release:** ship the table, bootstrap, RPC preview, and UI preview behind an admin-only feature flag. Compare preview results against the existing Phase 1a pricing RPC.
2. **Wells canary:** enable apply only for the 10 pilot products. Start with one `keep_sell_prices` selection and prove tier prices remain unchanged; then separately test a deliberately approved reprice on a non-customer-impacting test product if Mason authorizes it.
3. **Canary observation period:** confirm active-basis uniqueness, history rendering, idempotent replay, cost-history count, product pricing versions, quotes, and order snapshots.
4. **Broader admin rollout:** remove the product allowlist only after the canary evidence packet is clean.

Applying the live migration and enabling Phase 2 apply remain separate explicit production approvals. A failure or ambiguous preview/apply result triggers PARK-AND-REPORT; it is not worked around with direct SQL.

## 9. Acceptance criteria

Phase 2 is complete only when:

- every active product can have exactly one attributable selected basis;
- selecting evidence never happens automatically;
- preview and apply are server-authoritative, idempotent, version-checked, and cent-exact;
- default selection changes zero tier sell prices;
- any intentional repricing exactly matches the confirmed preview;
- history shows supplier evidence, selected basis, and actual paid as distinct streams;
- imports remain observation-only;
- legacy `products.current_cost` matches the active basis without becoming an alternate write path;
- a real Wells canary is proven in the UI and live database with a rollback/closeout record.

## 10. Architecture evidence used for this plan

- Graphify refreshed at commit `3eb8a93d` (7,600 nodes, 15,816 edges).
- Query: `graphify query "what connects supplier price observations to governed product cost basis selection and sell price protection?" --budget 1600`.
- Material connections were confirmed in current source: Supplier Pricing uses append-only observations; Product Price History already renders the three evidence streams; Product Detail and Products call the Phase 1a preview/apply wrappers; live PostgreSQL has the two governed pricing RPCs and three product-pricing triggers; `product_cost_basis` does not yet exist.
