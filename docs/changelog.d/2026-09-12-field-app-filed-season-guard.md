## 2026-09-12 - Keep field-application date edits inside the filed season

PR #599 merged on September 11 with invoice-date-based season stamping and preview parity,
but without the later cross-season edit guard. This separate follow-up preserves that merged
work and adds the guard; it does not revive the closed due-date PR #591.

An existing field-application invoice keeps its filed season. Preview and save must reject
date edits across October 1, and all database writers must reject changing its filed season.
The screen explains the allowed date range. Within-season edits remain allowed. New invoices
still derive their season from the invoice date. No money calculation is rewritten.

The new migration is NOT APPLIED. Read-only live evidence on September 12 confirms the
previous preview implementation remains installed and the new helper/trigger are absent.
Live apply and production landing remain separately gated; this candidate is not deployed.

The disposable PostgreSQL proof covers real preview/save calls, unchanged headers after
refusal, valid within-season edits, a two-step generic-save bypass mutation, clean replay,
ACL/overload drift refusal, trigger-enabled-state rollback, and a disabled-assertion mutation.
The September 12 run passed those guard/restoration behaviors and their targeted mutations.
The corrected registered public preview/split/save/post/idempotency chain also reached
`SMOKE_PASS_ROLLBACK` and terminal `PREVIEW_SEASON_PROOF_PASS`, exit 0. Its fixture establishes
a positive cost through the real governed public pricing workflow and checks the current public
posting wrapper plus its private locking delegate; no cost, locking, or actor guard is disabled.
This is not a live-database smoke or an apply claim. Fresh exact-commit adversarial proof
and final release checks remain required before this follow-up is delivered.

Refreshed the schema registry through all six live read-only introspection queries and the
sanctioned generator. Only metadata and three already-applied names changed; all eight schema
sections were unchanged. Corrected the older #535 candidate wording to match its live ledger name.

PR #652's first CI run refused the non-numbered migration-history table. The new migration was
untracked during the earlier local index-scoped check, so that pass did not cover it. Registered
the exact unapplied basename as numbered LOCAL CANDIDATE row 927 and rerun the staged-index
cross-reference; no guard or test assertion is relaxed. Fresh exact-commit proof/CI are required
after this correction. Updated the top live-boundary note from a real September 12 ledger query;
the September 6 apply-time guidance remains only as explicitly superseded history.

GitHub Codex's first-head P1 identified an unsafe future suppression path in the newly added
actor-sweep exceptions. The correction binds each actor exception to its exact suspect parameter
and reviewed public/auth/delegate definition, owner, canonical direct and effective Data API
EXECUTE contracts. Detector and contract metadata are read in one PostgreSQL statement. Missing
or changed metadata leaves the finding visible; identity-only actor matching is refused. Bound
the legacy cancel_delivery exception too and removed the stale unused transfer exemption.
The same matcher runs in linked-psql mode and captured-MCP adjudication, with canonical preflight
instructions updated. No detector SQL or protected predicate fingerprint was changed, and no
capped scanner rule was reopened. Executable prevention is registered in Linux/Windows correction
guards: 473 focused/real-CLI assertions passed. A networkless PostgreSQL proof passed 31 checks,
observing actual actor forgery under removed-public-guard and helper-only mutants and requiring
both to remain unallowlisted; direct/inherited permission, owner and identity-source drift also
failed closed. Fresh live sweep adjudication, independent exact-commit review and CI remain gates.

The corrected wrapped live sweep ran all 29 predicates read-only and the actual captured-result
CLI found zero unallowlisted findings with required contracts matched. Broad validation then
caught pending commission recorders disappearing from the test inventory below an unrelated
registry apply-time high-water. Actual live ledger inspection confirms their repair candidates
are unapplied, so removing the two exemptions would hide missing coverage. Contract inventory
now reuses canonical local-candidate parsing and applied-identity normalization, retaining pending
sources regardless of date and failing unknown/missing evidence closed. Focused RPC contracts
passed 96 tests, including below-high-water, renumbered/bare applied-name, one-row/unapplied-twin
and ambiguous-pair regressions. Independent drift review caught the first yes/no slug lookup
as HIGH; it now delegates to the canonical pending guard's exact-stamp spending and per-slug
counts, with clean re-review and no separate attribution implementation. The failed broad run
is not counted as passing. The final rerun passed all 373 files and 5,245 tests, with
123 skipped (5,368 total); lint, typecheck and production build also passed. Fresh
exact-commit proof and corrected-head CI remain gates.
