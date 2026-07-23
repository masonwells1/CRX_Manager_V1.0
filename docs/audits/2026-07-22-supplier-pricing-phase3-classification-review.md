# Supplier Pricing Phase 3 — Provisional All-Product Classification Review

**Status: PROPOSAL ONLY — all approvals remain pending Mason's explicit review.**

This is the required pre-Stage-A all-Product classification packet. It neither approves classifications nor authorizes a migration, Product update, feature activation, PR merge, or live-data change. Regenerate it from the Stage A schema only after the separately governed Stage A migration is applied.

## Fresh read-only snapshot

- Source project: `rhyzpcqhnizqbxphqdkr`.
- Capture: `2026-07-23T00:37:13.129364Z`, using one read-only aggregate `SELECT` over all `public.products` with active-return status prechecks.
- Migration high-water: `20260722202622`.
- Snapshot SHA-256: `60c2f27a3182a9d4e14232c579a6365ae94b51a5056cb30aa19cb9b47273b356`.
- Product population observed: **604 total** — **595 active**, **9 inactive**.
- Current active-return conflicts: **1** Product; it is retained as unresolved and receives no automated override.

The snapshot records each Product UUID, SKU, name, form, package and unit fields, active state, pricing version, update timestamp, and active-return statuses. The Phase 3 columns do not exist at this pre-Stage-A point, so the recorded current/default values are `product_family_id = null`, `return_policy = unknown`, `packaging_variant = null`, and `is_full_tote_only = false`.

## Proposed classification disposition

- Manifest SHA-256: `bf85cc649657735fa26ba8c7e753d653c76ba238ce63c7605ce723393ea322c4`.
- **604 unresolved**, **0 standalone**, **0 family assigned**.
- **21** Product names contain name-only `no return` candidate text. This is flag-only evidence, not policy truth; none were classified `no_return`.
- **56** Product names contain full-tote/tote text candidates. This is flag-only evidence; none were set to tote-only.
- Every row contains an immutable current Product copy plus source and row SHA-256 hashes. Each of the five decision fields — disposition, product family, return policy, packaging variant, and tote-only flag — is `pending_owner_review`.

## Durable artifacts and repeatable proof

- [Product snapshot](./2026-07-22-supplier-pricing-phase3-product-snapshot.json)
- [Proposed classification manifest](./2026-07-22-supplier-pricing-phase3-proposed-classification-manifest.json)
- `scripts/generate-supplier-pricing-phase3-classification-manifest.mjs`
- `scripts/verify-supplier-pricing-phase3-classification-manifest.mjs`

Run these from the repository root:

```powershell
node scripts/generate-supplier-pricing-phase3-classification-manifest.mjs --summary
node scripts/generate-supplier-pricing-phase3-classification-manifest.mjs --compare
node scripts/verify-supplier-pricing-phase3-classification-manifest.mjs
```

`--compare` proves deterministic regeneration matches the checked-in canonical LF UTF-8 JSON exactly. The independent verifier rejects byte/content/count/UUID-order/duplicate/row-hash/root-hash/current-Product/approval-state drift.

## Required owner gate

Mason must separately review and explicitly approve any classification decisions before a governed apply path can exist. Until then, the only allowed disposition is the conservative unresolved/unknown proposal represented here.
