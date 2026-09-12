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
