# Supplier Pricing Phase 3 — Corrected Implementation Plan

**Date:** 2026-07-22
**Verdict:** PARKED — final exact review, protected PR acceptance, and Mason
approval are required before any Stage C design.
**Approved scope:** product families, structured policy/packaging metadata, exact-SKU picker clarity, and return/credit enforcement
**Execution contract:** `docs/handoffs/2026-07-22-supplier-pricing-PHASE3-GOAL.md`
**Current status:** Stage A/B1/B2 are landed. The remaining Stage C path is the regenerated-and-verified 604-row aggregate-only post-Stage-A packet, fresh exact review, protected PR acceptance, Mason's row/field/checksum approval, a separate guarded migration PR, and a separate live-apply gate.

## Outcome in Plain English

Every existing Product row remains the same sellable and inventory SKU. Phase 3 adds a family layer so related SKUs can be displayed together, shows staff the package and return policy before they choose a Product, and makes PostgreSQL refuse a return or return-linked credit for an explicitly `no_return` Product.

The safe default is `unknown`: an unclassified Product behaves as it does today. A row is blocked only after Mason approves an explicit `no_return` classification.

The current packet covers 604 Product rows and is regenerated and
verified. Do not refresh or regenerate it merely because #213 has since landed;
recapture is allowed only after an explicit invalidation condition. The older
estimate of 163 variants is context, not an acceptance count. The verified
classification packet reconciles every current row.

## Smallest Complete Architecture

### Product family and policy schema

Add `product_families` with a stable UUID, canonical name, active ingredient, formulation, active/audit fields, RLS, and deliberate grants. Add display-only grouping metadata only when a demonstrated UI need cannot be derived from those fields.

Add to `products`:

- nullable `product_family_id` with a restrictive foreign key;
- non-null `return_policy` constrained to `returnable`, `no_return`, `not_applicable`, or `unknown`, defaulting to `unknown`;
- nullable `packaging_variant`; and
- non-null `is_full_tote_only`, default false.

Reuse existing structured Product columns (`container_size`, `unit_size`, `inventory_unit`, `container_unit`, `container_type`, and `product_form`). Add another pack/volume column only if the refreshed source/live audit proves a concrete semantic gap. Do not create a second variants or inventory subsystem.

The schema/enforcement migration contains no Product classifications and must remain compatible with the pre-Phase-3 UI.

### One database return-policy guard

Implement one reusable PostgreSQL guard. Every explicit `no_return` refusal must use the exact stable error code `RETURN_POLICY_NO_RETURN`.

Enforce it at:

- `create_return` before a return item can be created;
- direct `return_items` insert or Product-changing update through a trigger backstop;
- `approve_return` before status advancement;
- `receive_return` before restocking or inventory side effects; and
- `issue_return_credit` before invoice/credit side effects.

Family, policy, packaging, and tote fields get no ordinary application write path. Govern their changes through a dedicated RPC or approved data-migration context; a database trigger rejects ad hoc direct updates outside that context and still validates active-return conflicts.

Use one proven concurrency protocol on both sides of the race: acquire transaction-level advisory locks for distinct Product UUIDs in sorted order before either a governed metadata change or a return lifecycle mutation, then re-read and revalidate return items and Product policies after the locks are held. Do not rely on a row-lock sequence that a Product `UPDATE` trigger cannot obey after the Product row is already locked. Preserve existing idempotency, role checks, search paths, grants, inventory math, audit events, and money-in-cents behavior.

The guard must not break rejection, cancellation, an authorized reversal/unapply, or an unrelated credit memo. A failure discovered late in a transaction must roll back inventory, invoice, credit, audit, and status side effects together.

### Supplier comparison boundary

Families are for grouping and display. Existing supplier ranking stays partitioned by exact `product_id`. Do not rank or select a supplier across sibling Product rows. Existing confirmed-link conversion, package/UOM, formulation, and policy evidence remains the comparability boundary; anything ambiguous stays `cannot compare` or pending review.

No cost-basis selection logic changes. The global cost-basis flag remains false.

## All-Product Classification Packet

The following was the construction contract for the post-Stage-A packet. That
packet has since been regenerated and verified at 604 aggregate-only rows. Only
an explicitly invalidated replacement packet must be generated from a fresh
read-only Product snapshot, with one row for every current Product and:

- immutable Product UUID and SKU;
- current name, form, package/unit fields, active state, and current family/policy fields;
- proposed disposition: `family_assigned`, `standalone`, or `unresolved`;
- proposed canonical family UUID/name, package label, tote-only value, and return policy;
- evidence/source, confidence, reviewer note, and owner-approval status;
- expected old values, snapshot timestamp/version, and a deterministic row checksum; and
- a manifest checksum and exact expected row count.

An agent may propose but may not approve. Uncertain rows remain `unresolved` and `unknown`. The 21 names previously observed with text resembling “NO RETURN” are candidates for owner review, not automatic truth.

Mason's decision packet must require an approve/reject decision for every row's `family_assigned`, `standalone`, or `unresolved` disposition; every proposed family membership; every proposed packaging/tote-field change; every non-`unknown` policy; and explicit acknowledgment of every unresolved row. Approval is field-specific: an approved family assignment does not silently approve a package or policy change.

The pre-Stage-A packet was provisional. After Stage A became live, it was
superseded by the current regenerated-and-verified 604-row aggregate-only
packet. Do not recapture or regenerate it unless an explicit invalidation
condition occurs.

After Mason approves that exact verified packet, generate a separate one-to-one
data migration containing only individually approved fields and rows. The
migration must bind to the exact owner-approval checksum and verify the manifest
checksum, expected old values, and expected affected-row count before changing
anything; any mismatch aborts the entire migration. Never merge Product rows or
rewrite historical references.

## Historical Product Selector Matrix — completed Stage B context

This is completed Stage B source context, retained for auditability only. It is
not an instruction to reopen Stage B selectors or rerun the post-#213 scan in
this PARKED Stage C lane.

Every included surface used one shared Product-option model/presentation:
Product name and SKU, canonical family, package/unit, return-policy badge, and
tote-only signal. Imports refused ambiguous sibling matches instead of silently
choosing one.

The matrix was a point-in-time Graphify/source inventory. The post-#213 scan
was completed for its historical Stage B work; do not rerun it from this plan.
Any future separately approved UI scope must establish and approve its own
current source inventory.

To keep its PRs reviewable, historical Stage B was split as follows:

- **Stage B1 core sales/returns/supplier:** QuoteBuilder, NewOrder, OrderDetail, QuickDeliveryModal, DeliveryDetail, Returns, SupplierPricing comparison/linking, InvoiceDetail, and FieldAppSplitInvoiceEditor. These own quote/order/delivery/return/invoice or supplier-link Product-ID writes.
- **Stage B2 operational/procurement hardening:** ManualTicketCreate, BlendTicketDetail, FieldAppChemicalEntry, JobDetail, NewPurchaseOrder, PurchaseOrderDetail, QuickReceivePanel, the three bulk import/correction flows, both InventoryPage flows, and Rebates. These own inventory, production, applied-chemical, procurement, import-resolution, reservation, rebate-program, or rebate-claim Product-ID writes.

Neither historical PR alone represented the complete Phase 3 picker rollout.

| Surface | Decision | Required Phase 3 behavior | Source evidence |
|---|---|---|---|
| QuoteBuilder | INCLUDE | Distinguish the exact SKU before writing `quote_items.product_id`. | `src/pages/QuoteBuilder.tsx:536`, `:894`, `:3560` |
| NewOrder | INCLUDE | Show family/package/policy before sales-order selection. | `src/pages/NewOrder.tsx:174`, `:408`, `:1011` |
| OrderDetail Add Product | INCLUDE | Apply the same contract to order amendments. | `src/pages/OrderDetail.tsx:294`, `:438`, `:2035` |
| QuickDeliveryModal | INCLUDE | Distinguish direct delivery/invoice Product rows. | `src/components/deliveries/QuickDeliveryModal.tsx:95`, `:276`, `:656` |
| DeliveryDetail Add item | INCLUDE | Show Product context on the order-item selector that changes a delivery. | `src/pages/DeliveryDetail.tsx:476`, `:513`, `:1940` |
| Returns | INCLUDE + HARD BLOCK | Show policy, disable/explain `no_return`, and rely on the database guard as authority. | `src/pages/Returns.tsx:175`, `:295`, `:799` |
| SupplierPricing comparison | INCLUDE | Show family/package/policy without cross-SKU ranking. | `src/pages/SupplierPricing.tsx:123`, `:764` |
| SupplierPricing supplier link | INCLUDE | Refuse incompatible or ambiguous Product-link reuse. | `src/pages/SupplierPricing.tsx:890` |
| InvoiceDetail add Product | INCLUDE | Product search writes `invoice_items.product_id` through `save_invoice`; distinguish the exact SKU first. | `src/pages/InvoiceDetail.tsx:576`, `:605`, `:731`, `:1917` |
| FieldAppSplitInvoiceEditor line | INCLUDE | Chemical-line selection persists an invoice-item Product ID. | `src/pages/FieldAppSplitInvoiceEditor.tsx:257`, `:493`, `:1038` |
| ManualTicketCreate | INCLUDE | Identify the exact ingredient SKU used for inventory/production. | `src/components/blendtickets/ManualTicketCreate.tsx:267`, `:691` |
| BlendTicketDetail correction | INCLUDE | Show exact-SKU context before a correction changes Product identity. | `src/pages/BlendTicketDetail.tsx:200`, `:1393` |
| FieldAppChemicalEntry | INCLUDE | Distinguish the applied Product before writing its ID. | `src/components/field-app/FieldAppChemicalEntry.tsx:155`, `:294`, `:410` |
| JobDetail chemical row | INCLUDE | Apply the same contract to the separate job chemical picker. | `src/pages/JobDetail.tsx:1429`, `:3576` |
| NewPurchaseOrder | INCLUDE | Prevent procurement of the wrong package/tote sibling. | `src/pages/NewPurchaseOrder.tsx:81`, `:135`, `:501` |
| PurchaseOrderDetail | INCLUDE | Preserve the exact Product ID while an unreceived procurement line is corrected; show exact SKU/package/policy context before saving the PO line. | `src/pages/PurchaseOrderDetail.tsx:446`, `:454`, `:473`, `:1128` |
| QuickReceivePanel | INCLUDE | Show exact SKU where receipt creates inventory/PO allocations. | `src/components/receiving/QuickReceivePanel.tsx:94`, `:141`, `:923` |
| BulkQuoteImport | INCLUDE | Ambiguous family-member input becomes a review error. | `src/components/quotes/BulkQuoteImport.tsx:281`, `:385` |
| BulkOrderImport | INCLUDE | Ambiguous name lookup becomes a row error. | `src/components/orders/BulkOrderImport.tsx:345` |
| BulkPOImport correction | INCLUDE | Human correction shows family/package/policy; no new OCR work. | `src/components/purchase-orders/BulkPOImport.tsx:331`, `:815` |
| InventoryPage create hold | INCLUDE | Show exact Product context before creating a reservation. | `src/pages/InventoryPage.tsx:350`, `:1375` |
| InventoryPage manual add | INCLUDE | Show exact Product context before creating inventory. | `src/pages/InventoryPage.tsx:465`, `:1465` |
| Rebates program and claim | INCLUDE | Program edits and claim RPC input persist Product IDs that affect financial eligibility/claims. | `src/pages/Rebates.tsx:234`, `:304`, `:713`, `:882` |

Explicit exclusions:

| Surface | Decision and reason |
|---|---|
| BlendRecipes | EXCLUDE: configuration template, not a transactional Product write. |
| CropPrograms | EXCLUDE: quote-prefill template; QuoteBuilder owns the transaction boundary. |
| BrandVsGeneric | EXCLUDE: separate catalog/generic mapping, not supplier equivalence. |
| Reports and SalesReports Product filters | EXCLUDE: read-only filters. |
| NewDelivery | EXCLUDE: consumes existing order items and has no direct Product picker. |
| BulkTicketUpload | EXCLUDE: selects images, not Products. |
| FieldApplicationInvoice wrapper | EXCLUDE: the owning picker is FieldAppChemicalEntry. |
| ProductDetail policy editor | EXCLUDE: policy decisions come through the governed manifest, not ad hoc editing. |

## Expected Files and Systems

The following Stage A/B file expectations are historical completed context and
must not be rerun from this PARKED Stage C plan. Stage A was expected to touch
only:

- one new `supabase/migrations/<fresh_timestamp>_product_families_return_policy_foundation.sql`;
- one new rollback-only proof such as `scripts/smoke/smoke-supplier-pricing-phase3-return-policy.sql`;
- one proposed all-Product manifest under `docs/audits/` plus a short owner-readable review summary;
- generated schema/type/reference artifacts only after #213 is reconciled and only when the migration workflow requires them; and
- focused RPC/contract tests if the current test architecture requires a companion TypeScript test.

Do not touch `src/lib/db.ts`, `ProductDetail`, or `docs/reference/rpc-functions.md` unless refreshed source proves a concrete need and Fable approves the scope change.

Historical Stages B1/B2 were expected to add one small shared Product-option
formatter/presentation component under `src/components/products/` or `src/lib/`
and adopt it in every included selector and focused test. The exact helper
filename was chosen after the completed post-#213 source refresh; there was one
contract, not independently formatted variants.

Stage C adds only the owner-approved classification migration and its checksum/proof artifacts.

## Release Sequence and Gates

Steps 1–5 are historical completed context retained for the audit trail; they
must not be rerun from this document. The current gate begins at step 6 and
remains PARKED.

1. **Historical — #213 reconciliation.** The exact Goal-contract gate was satisfied before the completed Stage A work.
2. **Historical — Stage A PR: schema/enforcement.** The disposable proof, review, protected-PR, and review-resolution sequence was completed for that stage.
3. **Historical — explicit live schema gate.** Mason's separate authorization and the stage's guarded live apply/verification occurred in its authorized context.
4. **Historical — Stage B1 PR: core UI.** The applied-schema refresh, selector inventory, implementation, proof, review, and protected-PR sequence are completed context.
5. **Historical — Stage B2 PR: operational/procurement UI.** The B1-refresh, remaining Product-ID writer implementation, proof, review, and protected-PR sequence are completed context.
6. **Current owner classification gate.** The post-Stage-A packet is already
   regenerated and verified at 604 aggregate-only rows; do not regenerate it
   unless an explicit invalidation condition occurs. After a fresh `origin/main`
   refetch, fresh exact review, and protected-PR acceptance with required
   checks including Ubuntu PR CI, Mason approves/rejects every row disposition
   and every changed field, explicitly acknowledges unresolved rows, and
   approves the exact packet checksum. All 604 decisions remain `PENDING` until
   that approval is complete.
7. **Stage C PR: classification migration.** Generate one-to-one guarded SQL from only the approved fields/rows, prove it in a disposable database, review it, and stop before live apply.
8. **Postflight.** After separate authorization and applies, verify repo/deploy/live ledger/schema/browser/data/flag state and write closeout evidence.

A single combined PR is forbidden unless the UI is proven compatible both before and after the schema migration and Fable plus Sol explicitly approve collapsing the stages.

## Proof Required

### Database and concurrency

- migration validation and linked dry-run with no drift;
- disposable-clone forward apply and rollback-only smoke;
- RLS, grants, constraints, search-path, and idempotency checks;
- returnable and `unknown` Products preserve current create/approve/receive/credit behavior;
- `no_return` fails at create, direct insert/update, approve, receive, and issue-credit with `RETURN_POLICY_NO_RETURN`;
- concurrent return creation/policy change cannot bypass enforcement or deadlock;
- policy changes are blocked for requested/approved/received returns;
- rejection, cancellation, reversal, and `unapply_credit_memo` still work;
- forced failure inside each RPC proves that RPC commits no partial status, inventory, invoice, credit, or audit effects; an earlier committed receive is not incorrectly expected to roll back when a later credit RPC fails; and
- supplier ranking remains exact `product_id` and the global flag remains false.

### UI and imports

- focused tests for all included selectors, reusing existing suites and adding missing ones;
- ambiguous BulkQuoteImport/BulkOrderImport/BulkPOImport rows stop for review;
- Returns clearly explains why `no_return` is unavailable and surfaces the stable server refusal;
- authenticated browser proof at desktop and phone width for core sales, delivery, return, supplier-pricing, procurement, blend, field-app, and inventory lanes;
- no horizontal overflow, console errors, silent sibling selection, or changed sell price; and
- pre-schema compatibility proof for Stage A plus post-schema proof for Stage B.

### Full pipeline and reviews

- focused tests, `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build`, workflow tests, migration validation, and applicable strict DB sweeps;
- Fable adversarial review before the first edit and after final proof;
- independent Sol review on the exact candidate SHA after all tests pass;
- rerun both reviews after any code change; and
- protected branch push, PR checks, Vercel, and CodeRabbit review before any later merge decision.

## Stop Conditions

Park immediately on migration drift, stale generated artifacts, changed-file overlap, ambiguous Product classification, non-exact supplier comparison, unexplained Product-count changes, flag drift, a failed disposable proof, review disagreement, or any need for live mutation not explicitly approved.

The implementation is not complete merely because code and tests exist. Completion requires separately authorized staged merges/applies plus live, browser, ledger, and closeout proof.
