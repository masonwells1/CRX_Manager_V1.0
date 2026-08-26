## 2026-08-26 — Return-credit delivery invoices remain billable

Added `20260826215500_exclude_return_credits_from_delivery_invoice_gate.sql`, a forward migration
that excludes credit memos from both delivery invoice coverage checks. A posted order-level return
credit therefore cannot suppress the ordinary draft invoice for a later delivery or block the admin
recovery path for an already-completed unbilled delivery. Both private function bodies are pinned to
their exact prior and replacement hashes and retain their existing ownership, security, search-path,
signature, volatility, and private-execute posture.

The delivery detail page, integrity cleanup panel, and office exception dashboard now share the same
active, non-deleted sales-invoice coverage predicate, so a return credit or deleted invoice cannot hide
the recovery action or produce a false all-clear in the user interface.

Fresh read-only production schema was restored into disposable PostgreSQL and all five candidate
migrations were applied there. The rollback-only harness passed 33 load-bearing predicates, including
separate mutants for removing each new credit-memo filter and direct proofs that both invoice paths
still create the expected $25 revenue and $5 historical-cost draft. The full application suite,
typecheck, lint, documentation checks, and production build also passed. No migration was applied to
the live database in this change.
