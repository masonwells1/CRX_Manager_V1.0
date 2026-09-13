## 2026-09-12 - Native review cleanup and retry guidance

PR #647 follow-up findings 3997061258 and 3997061260 identified a provider
request racing unspent cleanup and active runbooks still describing legacy
paid retries. Cleanup rechecks provider-label absence after removing a receipt
and after clearing state labels. A raced or unknown cleanup restores the
requested marker and preserves the original receipt details as evidence.
This evidence is not a replacement dispatch receipt: its new server timestamp
cannot establish review attribution or authorize another paid request.

The gotchas and deploy-check instructions now preserve pending native requests
and reconcile late formal reviews through the ready label. They distinguish
verified unspent cleanup from retained or ambiguous attempts. The generated
Codex deploy-check adapter is synchronized from its canonical Claude source.

Verification: all 201 local transport tests passed, including provider writes
racing receipt deletion and marker removal; lint and agent-workflow checks
passed. Protected delivery still requires fresh independent exact-head/base
proof, final CI and an actual formal provider review. No live migration or
business-data mutation is included.
