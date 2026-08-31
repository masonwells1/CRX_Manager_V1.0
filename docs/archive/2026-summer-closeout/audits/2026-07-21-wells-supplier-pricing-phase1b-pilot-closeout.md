# Wells Ag Supply Supplier-Pricing Phase 1b Pilot Closeout

**Date:** 2026-07-21
**Owner approval:** Mason approved the revised Wells pilot, confirmed CRX's existing Wells vendor fields, and approved the Phase 1b closeout plus exact Wells legacy resolution.
**Current status:** Operational pilot and one authenticated Phase 2 Product canary are complete. Phase 2 migration `20260722015019` is applied live with its global feature flag off. The Wells resolution is applied live as ledger version `20260722025808`, with disk migration `20260722025808_resolve_wells_legacy_vendor_history.sql`. Workbook hardening and all closeout proofs are green.

## Scope and non-negotiable rules

- Wells Ag Supply replaced Van Diest Supply as the pilot vendor because it supplies most CRX chemical volume.
- Staff, not software, transcribed supplier prices into the protected CRX `.xlsx` quote workbook.
- Supplier PDFs are audit attachments only. No PDF was read by AI or OCR.
- Approving supplier evidence must create observations only. It must never change selected Product cost or any tier sell price.

## Live pilot result

The production workflow completed end to end:

1. Ten representative CRX products received confirmed Wells supplier-product links and conversions.
2. CRX generated and downloaded the Wells quote workbook.
3. Mason/staff manually entered the supplier prices.
4. The first upload was rejected and retained for audit because `.39` did not meet the strict dollar-string contract.
5. The corrected workbook previewed successfully and was explicitly approved.
6. Ten append-only Wells observations populated Supplier Comparison and Product Price History.

Fresh live evidence after the pilot and after the rollback-only resolution proof:

| Invariant | Verified value |
|---|---:|
| Wells supplier-product links | 10 |
| Wells supplier observations | 10 |
| Approved imports represented by observations | 1 |
| Existing cost-history rows for the 10 linked products | 9 |
| Selected Product cost total | $882.03 |
| Tier 1 sell-price total | $995.67 |
| Tier 2 sell-price total | $1,097.73 |
| Tier 3 sell-price total | $1,220.51 |

Supplier evidence changed. Every recorded Product cost and tier-price total above remained unchanged.

## Authenticated Wells Phase 2 canary

One controlled Product-money canary was previewed and explicitly applied through the governed Phase 2 wrapper by an authenticated CRX admin on 2026-07-22. The durable database audit rows retain the exact actor identifier; this repository document intentionally does not duplicate it. No second canary is required.

| Canary evidence | Verified value |
|---|---|
| Product | `N-Serve - Bulk` (`d1961efe-6133-4ab4-bf84-ac7bf7da903a`) |
| Selected evidence | Wells quote observation `52f1cbff-5cb9-4067-adc5-dd0422816861`, $47.26/Gal, exact 1:1 Gal conversion |
| Before selected cost | $47.05 manual baseline |
| After selected cost | $47.26 Wells supplier quote (+$0.21) |
| Tier 1 sell price | $52.77 before and after; no change |
| Tier 2 sell price | $56.46 before and after; no change |
| Tier 3 sell price | $62.46 before and after; no change |
| Derived margins | 10.84% / 16.67% / 24.67% before; 10.441539% / 16.294722% / 24.335575% after |
| Governed preview/apply | Change set `3708874a-aceb-4130-9023-12d140b5a9b0`, one submitted row, one applied row, expected pricing version 1, resulting version 2 |
| Audit result | Cost-history row `f1f85bfa-639a-442c-a087-331a1dda0b43`, active basis row `db39fd19-e22a-4f9c-aa2c-5034092f1d63`, and activity row `3e8a60e2-2b87-468a-b963-0b1341e2ff0e` all agree |
| Scope guard | Wells allowlist remains exactly 10; global `supplier_cost_basis_enabled` remains `false` |

The canary changed only the selected cost and its mathematically derived margins. It did not change any tier sell price, did not select a purchase-order row, and did not widen the rollout beyond the exact Wells allowlist.

## Workbook hardening

`src/lib/supplierPricingWorkbook.ts` now normalizes only unambiguous sub-dollar shorthand at the workbook boundary:

- `.39` becomes `0.39`.
- `.5` becomes `0.5`.
- Ambiguous or invalid forms such as `.123`, `-.39`, and scientific notation remain unchanged and are rejected by the governed server validator.
- The authoritative PostgreSQL money parser remains strict.

Verification completed:

- `npm run typecheck` — PASS.
- Supplier-pricing focused suite — 41 tests PASS after the migration contract test was added.
- The focused workbook tests cover valid normalization, invalid-input preservation, formulas, protected identity fields, duplicates, and unsafe archive envelopes.
- Full repository suite — 3,781 tests PASS and 118 skipped across 276 files.
- `npm run lint` — PASS with three pre-existing warnings outside supplier pricing.
- `npm run build` — PASS.
- `npm run check:docs` — rerun after the final Wells restamp and migration-history entry; the branch now owns entry 798 above applied Phase 2 entry 797.

## Wells legacy purchase-history resolution

Fresh read-only production inspection found the exact historical text `Wells Ag Supply` on 17 purchase orders: 8 fully received plus 3 partially received orders contain 66 received lines; 4 cancelled plus 2 submitted orders contain none. The reviewed `legacy_vendor_resolution` now labels those actual-purchase points without rewriting any purchase fact.

Prepared staging migration:

- `supabase/migrations/20260722025808_resolve_wells_legacy_vendor_history.sql`
- Maps only the exact normalized text `Wells Ag Supply` to the existing active CRX vendor `Wells Ag Supply` (`c5d1c6b1-645c-475d-a6d3-d03ec2960337`).
- Inserts one reviewed resolution row; it does not add a redundant alias for the already-canonical spelling.
- Refuses a missing/duplicate canonical vendor, missing source purchases, or a conflicting prior resolution.
- Self-checks the ten linked products' selected-cost and tier-price totals before and after the insert.
- Contains no Product, purchase-order, observation, or vendor update.

Independent content-bound reviewers returned CLEAN:

- RLS/security: 0 blocker, 0 high, 0 medium.
- Migration drift: 0 blocker, 0 high; documentation entry remains intentionally pending ordered integration with Phase 2.

The exact migration bytes were exercised inside a live transaction. The terminal pass signal was:

The final-timestamp rerun intentionally failed first because the earlier pilot count covered only the 11 received/partially received POs, while the exact legacy text is also present on 4 cancelled and 2 submitted POs. Current truth is 17 total POs, 11 with receipts, and 66 received lines. The corrected terminal signal is:

`SMOKE_PASS_ROLLBACK: Wells resolution=1, total_POs=17, received_POs=11, received_lines=66, products=10, costs_and_sell_prices_unchanged`

The real admin-only `get_product_price_history` RPC was then exercised in a second rollback-only transaction for Anthem Maxx. Both historical actual-purchase points changed from `supplier unknown` to `Wells Ag Supply` inside the transaction while its existing Wells supplier observation remained distinct. The terminal pass signal was:

`SMOKE_PASS_ROLLBACK: Anthem Maxx history relabeled 2 actual-purchase points as Wells Ag Supply; no sell prices changed`

Both pre-apply proof exceptions rolled their transactions back. Final pre-apply postflight confirmed zero Wells resolution rows persisted, Anthem Maxx returned to two `supplier unknown` actual-purchase points plus its one Wells observation, and every count and dollar total remained at baseline. After permanent apply, one approved Wells resolution persists and both actual-purchase points now show `Wells Ag Supply`; the supplier observation remains distinct and every Product dollar total remains at baseline.

## Ordered release gate

Phase 2 applied live as exact ledger version/name `20260722015019_supplier_cost_basis_phase2`. A fresh read-only high-water check confirmed that version before the UTC command produced Wells submitted timestamp `20260722025020`. Both fresh content-bound reviewers returned CLEAN, the corrected exact-file rollback chain passed, and Supabase applied the migration as ledger version `20260722025808`. The disk file was B7-renamed to `supabase/migrations/20260722025808_resolve_wells_legacy_vendor_history.sql` so future migration runs cannot replay it.

Closeout rules:

- Wells is complete; do not add another resolution or rewrite historical purchase rows.
- The Phase 2 frontend/types release and one authenticated Wells live canary are complete. Keep the global flag off; any broader rollout still requires separate approval.
- The migration order is reconciled on disk and live; keep the applied `20260722025808` filename unchanged.
- Independent pre-push review found that active vendor names were only unique by exact text, not by supplier normalization. Live read-only evidence showed one normalized Wells vendor and zero active normalized collisions. The CLEAN, rollback-proven follow-up was applied as ledger version `20260722033450` and B7-renamed on disk to `20260722033450_enforce_active_vendor_normalized_uniqueness.sql`.
- Phase 2 frontend verification later exposed a separate database-wrapper issue for unchanged Products with no current cost. The isolated follow-up is live as `20260722035521_allow_inert_null_cost_workbook_rows` and remains outside the Wells data cleanup: it preserves complete workbook validation, skips only an exact inert null-cost basis row, and leaves the Phase 2 flag OFF. Its full PostgreSQL rollback chain passed before apply.
- The OFF flag hides the Phase 2 frontend rollout; it does not revoke the admin-only governed RPC capability. An authenticated admin can call those preview/apply RPCs directly, so real Product-money changes still require the normal explicit approval and admin-account protections.
- Final exact-branch Codex review found the live null-cost replacement lacked its own fail-closed overload assertion. Forward-only assertion migration `20260722042515_assert_supplier_cost_basis_followup_overloads` is now live; postflight showed one exact preview, apply, and private-helper signature with the flag still OFF. A concurrency overlap replayed the identical assertion as ledger version `20260722043537`; both entries are retained on disk and neither execution rewrote a function, grant, data, Product pricing, or the feature flag.
- Continue to treat every supplier import as observation-only with zero sell-price changes.
