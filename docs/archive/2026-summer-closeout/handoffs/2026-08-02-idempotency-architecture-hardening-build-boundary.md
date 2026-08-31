# Idempotency architecture hardening — verified build boundary

## WHERE

- Repository: `masonwells1/CRX_Manager_V1.0`
- Checkout: `C:\Users\mason\.codex\worktrees\idempotency-architecture-hardening-20260802\CRX_Manager`
- Branch: `codex/idempotency-architecture-hardening-20260802`
- Base: `origin/main` at `ea794571bd189a1dab25fabf0cb1175925e17cb8`
- Production: `https://croprxsolutions.app`
- Supabase project: `rhyzpcqhnizqbxphqdkr`

## GOAL

Bind retry identity to the exact mutation intent and reconcile ambiguous
responses so Invoice Save and Quick Delivery cannot duplicate work, replay one
entity's result into another, or discard corrected financial input.

Done means behavioral proof for unchanged retry, changed payload, abandoned
modal, validation rejection, lost response, and invoice route changes; full
repository gates; exact-SHA Sol/high CLEAN; protected PR delivery.

## PROVEN

- The parked research branch `codex/idempotency-reset-order-hardening-20260802`
  reached commit `9049efc80e3e9cf8956b32061fab0688487a8758` locally and was not pushed.
- Its full test/typecheck/lint/build/workflow/doc pipeline passed.
- Five exact-SHA adversarial reviews withheld CLEAN and proved that reset-order
  changes alone are insufficient.
- Confirmed failure classes: invoice create lost-response duplication; invoice
  A/B route replay; validation-error payload pinning; newer-edit loss; Quick
  Delivery abandoned-form replay.
- Production remained unchanged and returned HTTP 200 during closeout.
- Fresh Graphify map at base `ea794571`: 8,975 nodes and 18,785 edges. Query:
  `How do InvoiceDetail save_invoice and QuickDeliveryModal create_quick_delivery generate, reset, and replay idempotency keys across errors, form edits, modal close, and route changes?`

## HISTORICAL BUILD BOUNDARY

This document captured the pre-implementation boundary. The implementation now
lives in PR #299. Canonical fingerprints, server mismatch rejection, client
reconciliation, focused behavioral tests, SQL structure tests, migration review,
and exact-SHA review are complete. The migration was subsequently applied live
as ledger version `20260803010917`; current release state is recorded in
`docs/manual/CURRENT_STATE.md`.

## APPROVAL STATE

Mason approved continuing with the recommended dedicated architecture task on
2026-08-02. Ordinary reversible local research, code, tests, and migration
drafting are authorized. Live migration apply, live-data mutation, permissions,
secrets, destructive operations, and nonstandard production deployment remain
outside this approval. A normal reviewed merge may proceed only after every
repository and exact-SHA gate is green under current project policy.

## GATES AND BLOCKERS

- `idempotency_keys` is globally unique by key and existing replay is not bound
  to request payload.
- The final function bodies and live grants must be verified from current source
  and read-only Supabase evidence before design is accepted.
- Any SQL change requires migration review plus fresh exact-SHA Sol/high proof.
- The prior parked branch is evidence, not a merge base.

## FIRST ACTION

Read the final on-disk and live definitions for shared idempotency helpers,
`save_invoice`, and `create_quick_delivery`; then choose the smallest
payload-binding design that rejects key reuse with different canonical input.

Verify current state from Git, disk, and connected services before trusting this handoff; it may be stale when read.
