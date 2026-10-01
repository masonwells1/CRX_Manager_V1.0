## 2026-09-12 - Generic invoice registered-chain verification

The filed-season guard's disposable prover previously executed the registered
field-application split/post chain but not the separate registered `save_invoice`
edit chain, despite the new generic-creation refusal changing that public RPC.
Run both registered chains in the same network-isolated PostgreSQL proof and
require each chain's rollback-only success marker. Preserve the existing fee,
field cost, customer/type lock, share and split-override assertions unchanged.

Update the historical fixture to use public governed pricing preview/apply:
establish an explicit positive 1-cent basis before seeding historical invoice rows,
then establish the original $10 cost before every public edit. Supply explicit
active-admin below-cost reasons on the affected public edit payloads. Neither
missing cost nor direct pricing/below-cost context is fabricated, and no trigger
is disabled. Retain the actual setup refusals as evidence of these prerequisites.

The June chain also expected nonfield header cost to retain a stale 77777c
sentinel. Current live-pinned `_save_invoice_scoped_impl`, emitted by
`20260827041500_preserve_generated_invoice_lineage_and_finish_cutover.sql`,
deliberately reconciles every draft/unposted header to its item cost total.
Assert the exact 5000c result (5 units x refreshed 1000c) instead, retaining the
separate nonfield share-preservation assertion. Execute the registered chain
against the live-pinned baseline before the guard and again after the guard;
this compatibility claim must be observed, not inferred from a changed expectation.

This is verification coverage, not a business-logic change. No live smoke,
migration apply, merge or review-policy change is authorized or performed.
Observed runtime: the complete disposable prover exited 0 with
`PREVIEW_SEASON_PROOF_PASS`; the live-pinned generic baseline chain, post-guard
generic edit chain and field-application split/post chain all reached their
rollback-only success markers. Refusal, replay, drift, restoration and removed-
guard behavioral mutation checks passed in the same run. Fresh lint, typecheck,
build, documentation, correction-guard and agent-workflow checks passed.
Fresh exact-head independent review and corrected-head CI remain publication
and closeout gates, respectively; prior head reviews do not clear this commit.
