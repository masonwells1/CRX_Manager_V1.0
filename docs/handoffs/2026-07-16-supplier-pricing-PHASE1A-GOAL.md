# Supplier Pricing Phase 1a — Codex Goal Contract

**Owner:** Mason Wells
**Approved:** 2026-07-16
**Execution branch:** `feat/supplier-pricing-phase1a`
**End state:** a proof-backed **Draft PR** is open; it is not merged.

This document is the controlling execution prompt for Phase 1a. Read it with:

1. `AGENTS.md`
2. `docs/handoffs/2026-07-16-supplier-pricing-BUILD-HANDOFF.md`
3. `docs/plans/2026-07-16-supplier-pricing-and-variants-plan.md`
4. `docs/workflows/SAFE_DEVELOPMENT_RULES.md`
5. `docs/reference/gotchas.md`

Where the embedded rev-5 plan still says `PROPOSED` or where its full-future worksheet contract conflicts with this Phase 1a-only contract, this document controls. Mason approved Phase 1a. Phase 1b is a separate future PR after 1a merges. Phases 2 and 3 are not authorized.

## Mission

Build the Phase 1a pricing safety foundation end-to-end:

- retire every supplier-price OCR path and the unsafe legacy batch-pricing writer;
- add the pricing-only `.xlsx` export/edit/upload/preview/confirm/apply workflow;
- preserve fast single-product pricing edits on ProductDetail, but route them through the same governed server pricing engine;
- replace frontend `cost_history` inserts with one authoritative database history writer;
- prove the complete behavior on a local or disposable non-production database and in the UI;
- open a Draft PR containing the proof and stop without merging.

There is **no AI, OCR, or automated supplier-PDF price extraction**, now or as a suggested replacement.

## Orchestration

The primary orchestrator is Codex `gpt-5.6-sol` at Extra High reasoning. It owns architecture, integration, owner-facing decisions, and the final verdict.

Delegate independent, bounded work when it materially improves quality:

- **Luna:** read-only inventories, repetitive searches, log/test-output summaries, and structured contract checks.
- **Terra:** bounded implementation analysis, focused tests, and ordinary frontend/library work.
- **Sol:** PostgreSQL/RLS/RPC/money design, security review, concurrency/idempotency review, and final adversarial review.

Use only one writer in the shared worktree at a time. Parallel subagents are read-only unless the orchestrator gives one agent an isolated, non-overlapping write assignment. The orchestrator verifies all returned claims in current source or executed evidence before acting on them.

After every coherent risk unit and again before delivery, run a separate read-only adversarial review. Verify every finding as `VERIFIED`, `REFUTED`, `UNVERIFIED`, or `BLOCKED`. Fix confirmed BLOCKER/HIGH findings, add a regression-prevention action, and repeat the same review scope until no BLOCKER/HIGH remains.

## Scope and required behavior

### 1. Exactly two authorized pricing workflows

CRX must retain both of these owner workflows:

1. **In-app manual editing:** Mason can open one ProductDetail page and quickly edit its existing cost/margin/tier pricing controls without using a spreadsheet. Saving opens a compact confirmation showing old and new cost, margins, and every trigger-produced tier price. Confirming applies that one product through the governed server pricing engine. Preserve the existing Products-list inline pricing editor too, but route its changed pricing rows through the same governed preview/confirm engine instead of direct table updates. Non-pricing inline edits may retain their current safe path.
2. **Monthly worksheet batch edit:** Mason exports one `.xlsx`, edits many products, uploads it, reviews a complete change preview, and approves one atomic batch apply.

Every pricing screen must use the same server-side validation and pricing-calculation source. ProductDetail and the Products-list inline editor must not call `.update()` directly for cost, margins, or tier prices. The database must reject price-field writes that bypass the governed pricing path.

The two sources are recorded distinctly in history, for example `product_page` and `pricing_worksheet`, along with actor and optional reason/note.

### 2. Retire the unsafe legacy path completely

- Remove `BulkPricingImport`'s PDF/OCR price-list mode.
- Remove its direct cost/tier writes and frontend history inserts.
- Do not preserve a second file-import pricing workflow; the `.xlsx` worksheet becomes the only file-based batch-pricing workflow.
- Preserve Bulk Product Import only as a CSV product-identity/details creator. Remove all pricing columns from that importer, and create new products without cost, margins, or tier prices; pricing is set afterward through one of the two governed pricing workflows.
- Remove or hard-disable both price-bearing document-processing capabilities in `process-document`: `price_list` and the current `product_list` parser (which requires dollar amounts and extracts cost/tier pricing). Remove their callers/tests/docs while preserving unrelated invoice, purchase-order, customer, and quote document processing.
- Prove that the old UI and backend routes can no longer alter product prices or OCR supplier price lists.

### 3. Phase 1a worksheet contract — pricing only

The exported workbook contains:

- **Protected identity:** export/session identity, `product_id`, SKU, product name, category, pack/unit, and `row_version`.
- **Read-only current pricing:** current cost, tier margins, and tier prices.
- **Editable pricing:** `pricing_mode`, new cost, the fields allowed by that mode, and an optional reason/note.

Phase 1a does **not** make market evidence, purchase evidence, supplier observations, product-info fields, or `rate_unit` editable. Those belong to later phases.

Each row uses exactly one mode:

- **margin-driven:** new cost plus margins; the server calculates tier prices;
- **price-driven:** new cost plus explicit tier prices; the server reconciles margins.

The server—not the browser or spreadsheet—is the only cents/dollars conversion boundary and the authoritative calculator. Preview and apply must use the same calculation logic, and executed proof must show that previewed tier prices equal the actual stored results exactly.

Workbook protection is not treated as security. The server must retain an export manifest or equivalent tamper-evident row identity so it can reject changed identity fields, unknown rows, duplicate IDs, formulas, blank required cells, invalid numeric formats, invalid pricing-mode combinations, and locale-ambiguous money.

Use a dedicated server-controlled version token for pricing concurrency (exported as `row_version`). If current schema has no suitable monotonic token, add a dedicated pricing row version that increments whenever governed pricing inputs change. A stale version creates a loud conflict and no product update.

### 4. Preview, confirmation, and atomic apply

- Preview performs all validation and returns every proposed effect without changing `products`.
- Worksheet preview persists an approved change-set with its actor, exact input/snapshot fingerprint, expected versions, status, and expiry/validity rules.
- Apply validates authorization, approval ownership, fingerprint, status, and every expected version again under database locks.
- Worksheet apply is all-or-nothing across the approved rows.
- Product-page confirmation uses the same engine for a single row and returns the actual post-write values.
- Both mutating RPC paths accept and enforce `p_idempotency_key text DEFAULT NULL`.
- A retry with the same operation and idempotency key safely returns the original result.
- A later apply attempt for an already-applied change-set using a different key is rejected as already applied.

The worksheet UI is admin-only. Product-page pricing retains the current authorized admin workflow; do not broaden pricing permissions. Every privileged function verifies `auth.uid()`, checks the live application role source, uses deliberate grants, and follows the repo's `SECURITY DEFINER`/`search_path` rules when elevated execution is genuinely required.

### 5. Single history writer

An `AFTER UPDATE` database trigger writes `cost_history` whenever governed cost/margin/tier pricing changes. It records old and final new values, actor, source, reason/note, and timestamp.

- Remove frontend `cost_history` inserts from ProductDetail and BulkPricingImport in the same release.
- Do not write history for no-op saves or version-only bookkeeping.
- Do not double-log trigger-produced tier changes.
- Prove one and only one correct history record per changed product.

## Database and migration safety

- Keep all new SQL under `scripts/.staging-migrations/` using the DRAFT/APPLY protocol until its specific APPLY gate opens.
- **Owner sequencing clarification (Mason, 2026-07-16):** use an expand-then-contract rollout. First promote only the backward-compatible additive bootstrap after its plain-English explanation, clean migration review, fresh apply-guard proof, and Mason's separate explicit apply approval. Restore/publish the RPC frontend only after those functions are verified live. Keep the enforcement cutover parked until that frontend is deployed and its rollback window is closed.
- Mason's sequencing approval is not live-apply approval. Never copy or apply either draft merely because this Goal exists; each promotion remains a separate gated decision.
- Never change production business rows outside the reviewed migration's necessary schema backfill/default work.
- New public tables enable RLS and receive least-privilege policies in the same SQL draft.
- Use bigint cents for new money storage; preserve the legacy numeric-dollar columns only at the governed conversion boundary.
- Run migration/RLS/drift/security review and exact rollback/disposable-database smoke proof. A printed SQL sweep is not executed proof.

For functional proof, the draft may be applied only to a clearly verified local or disposable non-production Supabase/Postgres database. The test harness must fail closed if its URL or project identity could be production. If no safe target is available, stop and ask Mason; do not substitute production and do not call the Goal complete.

## Required proof

Exercise the real flow, not only unit mocks:

1. Export the real Phase 1a `.xlsx` from the running development UI.
2. Edit at least three disposable test products, covering margin-driven and price-driven modes.
3. Create one deliberate stale-row conflict after export and show preview catches it.
4. Show formulas, duplicate/changed identity, and invalid mode combinations are rejected.
5. Show previewed tier prices exactly match the values stored after apply.
6. Show the Product-page quick edit previews and applies one minor cost change without a spreadsheet.
7. Show correct single `cost_history` rows with old/new values, actor, source, and note.
8. Show same-key network retry is safe and a new-key second apply is rejected.
9. Show direct client/table price writes are rejected.
10. Show BulkPricingImport, Bulk Product Import, and the backend `price_list`/price-bearing `product_list` OCR routes can no longer update or extract prices.

Also run the risk-proportionate repository gates: focused tests, typecheck, lint, full tests, build, SQL/RPC contract checks, agent-workflow checks when relevant, browser verification, and the final adversarial review. Record exact commands, observed results, screenshots/artifacts where useful, and any genuinely blocked layer.

## Delivery gate

- Commit only feature-related work on `feat/supplier-pricing-phase1a`; never use `--no-verify`.
- Push only this feature branch after all required local and review gates are green.
- Open a **Draft PR** with the proof, known limitations, parked migration path, later APPLY-session requirements, and explicit statement that production was not changed.
- Do not mark the PR ready, merge it, deploy it, change secrets/permissions, or delete data. A live SQL action is allowed only for the separately authorized additive-bootstrap APPLY gate described above; the enforcement cutover remains out of scope until after frontend deployment.
- Stop and report when the proof-backed Draft PR is open.

If an owner-facing behavior remains ambiguous, stop and ask Mason in plain English. Do not silently weaken a hard rule to keep moving.
