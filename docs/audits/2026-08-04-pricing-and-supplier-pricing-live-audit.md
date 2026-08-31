# Pricing and Supplier Pricing Live Audit

**Date:** 2026-08-04  
**Audit baseline:** `origin/main` at `172ff0c317e7a916c3f9dde8f3e68d1a22120226`  
**Production database:** `rhyzpcqhnizqbxphqdkr`  
**Scope:** Product pricing, monthly workbook pricing, supplier evidence, selected cost basis, price history, and customer-tier quote pricing. No migration, deployment, permanent test record, or feature-flag change was made.

## Verdict

**READY FOR APPROVAL — the live pricing paths tested correctly; the stale live-proof fixture is repaired, and the Product page now distinguishes a current governed basis from a missing legacy price-change event.**

There was no reproduced calculation, authorization, mutation, or supplier-evidence integrity defect in the exercised paths. All controlled test writes ran in a single production transaction and rolled back; post-test checks found zero `[AUDIT]` Products, price-history rows, or cost-basis rows.

## Live functional proof

| Path | Result | Evidence |
| --- | --- | --- |
| Supplier quote/evidence | PASS | Current Phase 1B rolled-back chain passed: link confirmation, quote staging, approval, idempotent replay, supplier-history reads, correction/supersession, and zero sell-price mutation. |
| Product-page pricing | PASS | Synthetic Product: preview and explicit apply changed cost and all three tier prices, incremented pricing version, wrote one legacy `cost_history` record and one `manual_override`/`product_page` cost-basis record, then rolled back. |
| Monthly workbook pricing | PASS | Synthetic Product: export (`crx-product-pricing-phase2-v2`) -> identity-preserving row -> preview -> apply succeeded; export became consumed, price/history/basis records were correct, then rolled back. |
| Supplier/product history UI | PASS | Authenticated Product page showed current cost, tier prices, price-per-acre values, supplier observation, selected cost-basis entries, received-PO costs, weighted recent PO average, and legacy Cost History. |
| Customer quote tier | PASS | In an unsaved quote for a Tier 1 customer, selecting the checked Product populated its exact Tier 1 price of `$15.06` per gallon. No quote was saved. |

## Current integrity snapshot

- `supplier_cost_basis_enabled` remains `false`; the observed Product is in the controlled rollout and its gated selection controls were available as expected.
- 595 active Products; 602 current cost-basis records; the one active Product without a current basis also has no cost.
- 10 supplier observations and 10 confirmed reusable Product-supplier links.
- Zero approved import rows missing an observation; zero observation/import-row mismatches; zero observations on unconfirmed links; zero malformed comparable links; zero orphan cost-basis rows.
- All 32 legacy `cost_history` rows have a source and timestamp; no non-incrementing pricing-version row or negative historical cost was found.

## Findings

### Resolved — legacy Cost History no longer implies that current pricing provenance is absent

571 active Products have a positive current cost but no row in legacy `cost_history`. The newer `product_cost_basis` baseline covers their current provenance, but it does not reconstruct earlier price-change history. The Product page formerly showed only “No cost changes recorded,” which could misleadingly suggest the current price had no governed provenance.

**Repair completed locally 2026-08-04:** when legacy history is empty, the Product page now says “No legacy cost changes recorded” and, where present, shows the current governed basis amount, type, and selection date. A `migration_baseline` is explicitly labeled as a baseline copied from the existing Product cost, not independently verified supplier evidence. It also states that this is current cost provenance, not a backfilled historical price-change event. Load failures render an error state rather than an absence claim; regression tests cover both states.

The missing older source records remain intentionally unreconstructed: creating dated supplier or price events without original source material would falsify history. If a complete pre-governed timeline is required later, it needs a separate approved import from canonical vendor invoices or price sheets.

### Resolved — the Phase 2 cost-basis live smoke was stale against production

`scripts/smoke/smoke-supplier-cost-basis-phase2.sql` assumes exactly 14 current fixture bases. Production now has 602, so it fails immediately with `SMOKE_FAIL: base and Wells fixture costs were not baselined exactly once`, before testing its intended business assertions. The current workbook wrapper proof also requires a generated `/tmp/phase2-workbook-payload.json`, so it is not a direct live one-command proof.

**Repair completed and committed locally 2026-08-04:** commit `e1613354cef3788a7cd7db6544adec214dbcffa2` added `scripts/smoke/smoke-supplier-cost-basis-phase2-live.sql` and registered it as `supplier_cost_basis_phase2_live`. The new chain creates two UUID-backed synthetic Products inside one transaction, uses `create_pricing_workbook_export` to obtain the signed workbook identity row, and validates Product-page plus workbook preview/apply/history/basis/export behavior before the standard `SMOKE_PASS_ROLLBACK` terminal exception. It has no fixture IDs, production row-count assumptions, or `/tmp` payload dependency.

The new live chain passed against production and follow-up checks found zero synthetic Products, cost-history rows, cost-basis rows, or idempotency records. `npm run check:pricing-phase2-live-smoke`, `npm run test:pricing` (214), typecheck, lint, and the existing disposable `npm run proof:pricing-phase2` all passed.

**Review hardening completed locally 2026-08-04:** the live chain now checks all four direct ledger privileges (SELECT/INSERT/UPDATE/DELETE), rejects unauthenticated, non-admin, and forged-actor calls for both governed preview and apply wrappers, replays each idempotency key, and requires exactly one total cost-basis row per synthetic Product/change set. The Product History panel also renders successfully loaded legacy history independently while governed cost-basis details are still loading. The focused UI suite now has 20 passing tests; the rollback auth/ACL probe passed against production.

## Verification gates

- Source baseline was fetched from `origin/main`; Graphify was used to map the supplier evidence, Product pricing, cost-basis, and quote-tier paths before source and live verification.
- Focused source tests passed: `npm run test:pricing` (214 tests), plus the direct supplier-pricing/product-pricing/product-cost-basis slice (39 tests).
- `npm run typecheck`, `npm run lint`, `npm run build`, `npm run test:contracts` (100 tests), `npm run test:drift` (234 passed; 78 intentionally skipped), correction guards, schema baseline, documentation checks, agent-health, agent-workflow checks, dependency-lock verification, and `scripts/validate-frontend.sh` all passed.
- `npm run test:schema-live` completed with 74 passing and 78 skipped checks. The production-only checks that need a direct database connection were not enabled by that runner.
- The final production read-only coverage check found 571 active, costed Products without legacy `cost_history`; all 571 have an effective current `product_cost_basis`, and none lack that current governed basis.
- The strict live invariant-sweep command could not run because this checkout has neither `SUPABASE_DB_URL` nor `psql`. The shell SQL-migration validator also timed out without diagnostic output under Git Bash. These are coverage limitations, not passed gates.
- Supabase's live security advisor returned 320 existing warnings, including generic SECURITY DEFINER execution notices for the pricing RPCs. This audit exercised their authorization behavior through the approved wrappers; it did not treat generic linter warnings as a reproduced pricing authorization defect.
- `npm ci` reported 6 high-severity dependency advisories. They are outside this pricing-specific audit and were not changed.

## Out of scope / intentionally not changed

- The global supplier-cost-basis flag stayed off.
- No Product-family or return-policy classification was performed.
- No permanent fake Product, customer, vendor, quote, supplier observation, or price change remains in production.
- No migration, push, PR, deployment, or live-data cleanup was performed.
