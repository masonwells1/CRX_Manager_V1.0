# Supplier Pricing Phase 3 — Provisional All-Product Classification Review

**Status: PROPOSAL ONLY — all approvals remain pending Mason's explicit review.**

This is the required pre-Stage-A all-Product classification packet. It neither
approves classifications nor authorizes a migration, Product update, feature
activation, PR merge, or live-data change. After the separately governed Stage A
migration is applied, a future Stage-A-aware generator must capture the new live
read-only schema; this pre-Stage-A generator cannot consume it. Any later
classification apply must call the lock-taking `set_product_phase3_metadata`
RPC for each Product rather than update the governed columns directly.

## Fresh read-only snapshot

- Source project: `rhyzpcqhnizqbxphqdkr`.
- Capture: `2026-07-23T00:37:13.129364Z`, using one read-only aggregate `SELECT` over all `public.products` with active-return status prechecks.
- Migration high-water: `20260722202622`.
- Snapshot SHA-256: `60c2f27a3182a9d4e14232c579a6365ae94b51a5056cb30aa19cb9b47273b356`.
- Product population observed: **604 total** — **595 active**, **9 inactive**.
- Current active-return conflicts: **1** Product; it is retained as unresolved and receives no automated override.

The snapshot records each Product UUID, SKU, name, form, package and unit fields, active state, pricing version, update timestamp, and active-return statuses. The Phase 3 columns do not exist at this pre-Stage-A point, so the recorded current/default values are `product_family_id = null`, `return_policy = unknown`, `packaging_variant = null`, and `is_full_tote_only = false`.

## Proposed classification disposition

- Manifest SHA-256: `57da3f92d2e02253f4be7fa88a8626a3191bdbbc13ab140a57f33af6e84f7b91`.
- **604 unresolved**, **0 standalone**, **0 family assigned**.
- **21** Product names contain name-only `no return` candidate text. This is flag-only evidence, not policy truth; none were classified `no_return`.
- **56** Product names contain full-tote/tote text candidates. This is flag-only evidence; none were set to tote-only.
- Every row contains an immutable current Product copy plus source and row SHA-256 hashes. Each of the five decision fields — disposition, product family, return policy, packaging variant, and tote-only flag — is `pending_owner_review`.

## Private artifacts and repeatable proof

The complete Product snapshot and proposed manifest are commercially sensitive
and are deliberately excluded from this public repository. Store both files in
an approved private directory and point the verification scripts to it with
`CRX_PHASE3_PRIVATE_ARTIFACT_DIR`.

- Snapshot file SHA-256: `2edbb16698fb6e957aaec21fd79c531dbb81a1b620b84f494b149caaa49cb90a`.
- Manifest file SHA-256: `fe62e53a16266078c50417b02c7063f0165cbb883d4f0c2e89386791a08ee3b7`.
- `scripts/generate-supplier-pricing-phase3-classification-manifest.mjs`
- `scripts/verify-supplier-pricing-phase3-classification-manifest.mjs`

Run these from the repository root:

```powershell
$env:CRX_PHASE3_PRIVATE_ARTIFACT_DIR = '<approved-private-directory>'
node scripts/generate-supplier-pricing-phase3-classification-manifest.mjs --summary
node scripts/generate-supplier-pricing-phase3-classification-manifest.mjs --compare
node scripts/verify-supplier-pricing-phase3-classification-manifest.mjs
```

`--compare` proves deterministic regeneration matches the private canonical LF
UTF-8 JSON exactly. The independent verifier rejects
byte/content/count/UUID-order/duplicate/row-hash/root-hash/current-Product/approval-state
drift. The public file checksums above make replacement or disclosure-free
private storage drift visible without publishing the catalog.

## Required owner gate

Mason must separately review and explicitly approve any classification decisions before a governed apply path can exist. Until then, the only allowed disposition is the conservative unresolved/unknown proposal represented here.
