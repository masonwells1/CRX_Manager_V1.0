# CRX Live Foundation Gauntlet Summary

Last updated: 2026-07-15

The July 14 all-section Codex-only run has a built, rollback-proven, Codex-adversarially clean remediation branch. Direct corrected-diff Claude verification is complete with no BLOCKER/HIGH finding. Mason approved the live cutover on July 15: all three migrations are live, `process-blend-ticket` is v25 ACTIVE/JWT-enabled, live-derived artifacts are refreshed, the rollback smoke passes, and all 17 invariant sweeps are clean. The remaining shipping gate is the exact-commit review plus PR/check/merge path; historical cleanup is separate.

## Ranked Fix Queue

| Rank | Severity | Area | Item | Current evidence | Recommended next action |
|---:|---|---|---|---|---|
| 1 | RESOLVED | Deployment order | Three reviewed migrations applied before frontend release | Applied live in order after zero-row preflights; live registry/types/RPC snapshot regenerated and queued exceptions removed. | Complete exact-commit review and PR/check/merge. |
| 2 | RESOLVED | Edge deployment | Hardened `process-blend-ticket` deployed | v23 → v25, ACTIVE, JWT enabled, shared CORS/auth/Sentry and local guards present; v25 is the formatting-normalized refresh of functional v24; recent Edge logs clean. | Verify the signed-in production flow after frontend merge. |
| 3 | HIGH | Commission historical data | Resolve eight empty unposted `SEED` batches ($1,500 header total) | New RPC/UI guards make them unpostable, but the rows remain. | Mason decides whether to void/quarantine them; do not mutate automatically. |
| 4 | MED | PO historical data | Correct PO-2026-0008 status and review overreceipts | Seven open lines are hidden by old aggregate receipt totals. New code uses linewise completion. | Owner-approved reconciliation after reviewing source documents/physical receipts. |
| 5 | MED | Historical test/legacy rows | Decide one E2E invoice, five empty completed deliveries, and PO-2026-0015 receipt gap | Row-level probes identify historical/test data, not a current code path failure. | Present a separate live-data checklist; preserve rows until approved. |
| 6 | MED | Inventory operations | Reconcile 18 negative inventory rows | Negative on-hand is intentional discrepancy evidence. | Use physical counts and `reconcile_negative_inventory`; never zero-clamp. |

## Current Queue Position

All 15 sections are complete. Restart at Section 1 after deployment and production verification.

## Visibility Notes

- Full ledger and evidence: [2026-07-14-full-gauntlet-codex-only-remediation.md](2026-07-14-full-gauntlet-codex-only-remediation.md).
- No Claude review was used during the Codex-only gauntlet or Codex remediation phase. Direct Claude verification was performed afterward as Mason requested and returned `SHIP-WITH-FOLLOWUPS` with no BLOCKER/HIGH; all code findings and operational preflights are closed. The exact-commit Claude proof remains part of the post-apply pre-push gate.
