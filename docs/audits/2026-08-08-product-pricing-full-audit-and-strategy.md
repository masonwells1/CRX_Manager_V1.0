# Product Pricing — Full Audit and Strategy (2026-08-08)

Read-only audit of everything that touches product pricing: cost capture, margin math, vendor/price history, and how to keep a several-hundred-SKU list current. Evidence = current source, migrations, and live read-only queries on 2026-08-08. No data was changed. Exact commercial counts and margin figures are intentionally omitted from this public repository.

## Verdict

**PARTIAL — the pricing machinery is strong; the pricing *practice* is behind the machinery.** The governed pricing engine (preview → approve → apply, with history) built in the July phases is live and hardened, but it is barely being used: the multi-vendor pipeline covers only a pilot subset, cost freshness is untrackable for the vast majority of the catalog, and no written pricing strategy (target margins, tier formula, refresh cadence) exists anywhere. Plus a short list of real defects that corrupt margin numbers.

## 1. What exists today (and works)

- **Catalog**: several hundred products and roughly a dozen vendors. Only a handful of products are missing a cost or tier-1 price.
- **Three price tiers per product** (`tier1/2/3_price`), derived from `current_cost × (1 + markup)` by a DB trigger; customers get a tier via `customers.assigned_tier`. Sell-price resolution at sale time: manual override → quoted price → tier price.
- **Governed price-change engine** (Phase 1a/2, live): Product-page edits, Products-list inline edits, and a monthly Excel workbook round-trip all flow through the same `preview_product_cost_basis_changes` → `apply_product_cost_basis_change_set` RPCs, with old→new diffs, optimistic concurrency (`pricing_version`, row tokens), expiring change sets, and a single database history writer. Direct pricing writes from app roles are denied (`20260718190000`). This is the hardened path — use it.
- **Bulk update capability already exists**: `generateProductPricingWorkbook` / `parseProductPricingWorkbook` (`src/lib/productPricingWorkbook.ts`) export a styled .xlsx of the whole catalog, accept edited costs, margins, or prices back (margin-driven or price-driven per row), detect formulas and stale rows, and apply atomically. **The full-catalog reprice tool Mason is asking for is already built** — it needs adoption, not construction.
- **Multi-vendor price evidence pipeline** (Phase 1b/3, live but gated): `vendors` → `product_supplier_links` (with SKU + unit-of-measure conversion) → `supplier_price_imports` → `supplier_price_observations` (bigint cents, effective-dated, supersession) → `product_cost_basis` (one active, provenance-checked cost basis per product). Supplier quote-sheet .xlsx export/re-import with staging + approval lives at `src/pages/SupplierPricing.tsx`.
- **Cost snapshots at transaction time**: `order_items.cost_at_time_cents`, `invoice_items.cost_cents`, PO items with `cost_provenance` + `cost_snapshot_at`, locked after receipt.
- **Margin reporting**: `FieldProfitability` and `FinancialDashboard` are server-computed; commission math is a locked canonical helper minting from chemical-line profit.

## 2. Live-data findings

| Metric (live, 2026-08-08) | Value | Meaning |
|---|---|---|
| Products with supplier links / price observations | Pilot subset only | Multi-vendor pipeline has very low adoption |
| Cost basis rows still `manual_override / migration_baseline` | Nearly all active rows | Real vendor evidence backs only a negligible share of product costs |
| `cost_updated_date` NULL | Vast majority | Cost freshness is untrackable for most SKUs |
| `cost_history` rows | Sparse | Pre-July price changes are unrecorded (settled: no backfill without source documents) |
| `supplier_cost_basis_enabled` | false (Wells canary only) | The governed cost-basis engine is dark for the catalog |
| Average tier gross margins | Internal-only | Lower and upper tiers differ materially |
| Tier-1 SKUs under the review threshold | Material tail | Thin-margin products are worth a deliberate review |
| Invoice lines missing cost snapshot | Non-zero minority | Margin data has a small but material completeness gap |
| Pricing workbook adoption | No completed production cycle observed | The bulk tool has not yet become an operating routine |

## 3. Defects and design risks (ranked)

1. **Margin/markup column naming is misleading — but NOT a live bug (resolved on investigation, 2026-08-08).** `tierN_margin` holds margin-on-price and `tierN_gross_margin` holds markup-on-cost; the trigger comments in `20260206191700` describe a formula that was deliberately corrected 26 minutes later by `20260206192224_fix_margin_terminology.sql`, and every engine since (currently `20260718190000_supplier_pricing_phase1a_cutover.sql:95`) plus all UI consumers use the live semantics consistently, with definitions shown on-screen. Fix is documentation-only: record the canonical semantics in `docs/reference/gotchas.md` so future audits don't re-flag it. No rename, no data fix.
2. **Returns reverse revenue but never COGS** (`issue_return_credit`) — known open defect; every return overstates cost and understates margin. This corrupts the exact margin numbers this audit is about. (The sibling partial-delivery cost defect from the June hunt report is already fixed: `20260620220000_complete_delivery_audit_and_partial_cost.sql` recomputes `invoices.total_cost_cents` from delivered lines, preserved in `20260716120104`.)
3. **Reports disagree on cost source.** Dashboard/report RPCs (`20260308200000`) read mutable `order_items.cost_per_unit`, not the immutable `cost_at_time_cents` snapshot; `Reports.tsx` computes margin in React from raw selects (`SalesReports.tsx` already consumes the server RPCs — its fix is in the RPC bodies, not the page). Report surfaces can show different margins for the same period.
4. **Quote costs re-sync live on every save** (`20260730235031:419`): a stored quote's margin silently changes when admin updates product cost. Price overrides are preserved; cost is not.
5. **No active automated cost-update path.** PO receiving stopped writing `current_cost` in March (deliberate — cost is a pricing basis, not a purchase echo), and the governed replacement is feature-flagged off. Cost updates are 100% manual admin action, with `cost_updated_date` effectively writer-less.
6. **No inventory costing method.** On-hand value = quantity × live `current_cost`; no FIFO/average layer, so inventory valuation and COGS drift from actual paid cost.
7. **`products` money is `numeric` dollars, not bigint cents** — everything newer is cents; ~15 `round(x*100)` conversion boundaries exist. Contained by the cent-scale trigger guard, but `InvoiceDetail.tsx:645-647`'s float `Math.round(price*100)` and `NewPurchaseOrder.tsx`'s `parseFloat` path are the weak boundaries.
8. **Sale-time margin guardrails were cosmetic; the UI half is now closed.** As originally audited, a rep could save a below-cost line freely with text color as the only signal (`NewOrder.tsx:955`). **Update (this branch):** a below-cost confirmation with a required reason now ships on the manual order, order-edit, invoice, quote, and bulk-import paths, and the reason is recorded on the entity. Two gaps remain and are tracked separately: the confirmation is a UI gate, so a **direct RPC caller still bypasses it** until server-side enforcement lands (settled 2026-08-09 — see `docs/manual/DECISION_LOG.md`), and **below-*floor* selling is still unguarded entirely** — only below-*cost* is checked. The catalog remains better protected than the transaction.
9. **`products.vendor` is free text**, parallel to the real `vendors`/`product_supplier_links` truth — a second, unvalidated vendor source that has already needed typo-merge migrations.

## 4. Recommended plan

**Phase A — turn on what's built (biggest payoff, mostly process not code):**
1. Run the first real **pricing workbook cycle**: export the full catalog, review the material thin-margin tail, and clean up the handful of products missing a cost or a tier-1 price. Apply through the governed preview. This also seeds `cost_history` and `cost_updated_date` going forward.
2. **Scale the supplier-pricing pipeline past the Wells canary**: pick the top 2–3 vendors by spend, run the quote-sheet export → vendor fills → import → approve loop, and expand the `product_cost_basis` rollout gate vendor-by-vendor until `supplier_cost_basis_enabled` can flip on. Target: every A-mover SKU has ≥1 current supplier observation before spring season.
3. **Write the pricing strategy doc** (one page, Mason decides): target gross margin by category/tier, floor margin, tier formula, and a refresh cadence (e.g., monthly workbook cycle + event-driven vendor sheet imports). Today the catalog contains a wide variety of tier-1 markups with no stated policy.

**Phase B — fix the margin-corrupting defects (small, high value):**
4. Returns-COGS fix (already recommended "yes, soon" in the inventory-costing plan).
5. ~~Resolve the margin/markup column swap~~ Investigated 2026-08-08: not a bug (see finding 1); document the semantics in `docs/reference/gotchas.md`.
6. Point margin report RPCs at `cost_at_time_cents` and move `Reports.tsx`'s client-side margin math server-side so all four report surfaces agree (`SalesReports.tsx` inherits the fix through the RPCs it already calls).

**Phase C — guardrails and depth (after A/B):**
7. Below-cost / below-floor sale confirmation (a `ConfirmModal` + reason, or office approval) instead of a color hint. **Status: below-cost confirmation shipped on this branch across the order, order-edit, invoice, quote, and bulk-import paths. Below-floor is not implemented, and server-side enforcement is deferred to the follow-up recorded in the decision log.**
8. Snapshot quote cost at quote time (like invoices already do) so accepted-quote margins are stable.
9. Longer-term: inventory cost layers (average or FIFO) for true COGS, `vendor_id` FK on products (or retire the text column in favor of links), and price-position analytics (margin by vendor, cost-trend per SKU from observations).

## 5. Ideas surfaced for brainstorm (not commitments)

- **Vendor sheet ingestion at scale**: the OCR path was deliberately retired; the durable version is the structured quote-sheet .xlsx per vendor (already built). A per-vendor "standing sheet" emailed quarterly + a staleness dashboard ("SKUs with no observation < 90 days") makes 600 SKUs maintainable by one person in an afternoon per month.
- **Cost-staleness alerting**: a simple report/RPC listing products whose active cost basis or observation is older than N days, ranked by sales velocity — refresh effort goes where the money moves.
- **Margin-floor by category** instead of one global number (commodity glyphosate vs. specialty biologicals earn very different margins).
- **Multi-vendor cost comparison view**: once observations exist for 2+ vendors per SKU, a "best current cost vs. selected basis" screen turns the pipeline into a negotiating tool.
- **What-if repricing** (already a VISION item G12): workbook preview already computes old→new margins; a percent-uplift or target-margin batch fill on top of the existing export is a small step.

## Proof observed

- Live queries: product/vendor counts, cost/price null and staleness counts, cost-basis and observation adoption, margin distribution recomputed from price/cost, invoice-line snapshot coverage, margin-column swap sample.
- Source: pricing trigger chain, guard trigger, receive-path history, workbook/change-set RPC surface, sale-time snapshot paths, report cost sources (file:line citations throughout).

**Recommended next step:** run one real pricing-workbook cycle on the live catalog (Phase A step 1) — it exercises the built machinery end-to-end, fixes the stragglers, and starts the history clock **for every cost you change** (unchanged rows keep their null freshness date — the apply engine only stamps rows whose values actually move), all with zero new code.
