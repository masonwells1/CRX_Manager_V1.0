## 2026-08-26 — Return-credit delivery invoices remain billable

Added `20260827041200_exclude_return_credits_from_delivery_invoice_gate.sql`, a forward migration
that excludes credit memos from both delivery invoice coverage checks. A posted order-level return
credit therefore cannot suppress the ordinary draft invoice for a later delivery or block the admin
recovery path for an already-completed unbilled delivery. Both private function bodies are pinned to
their exact prior and replacement hashes and retain their existing ownership, security, search-path,
signature, volatility, and private-execute posture.

Added `20260827041300_align_return_credit_delivery_surfaces.sql` after Claude's exact-commit
adversarial review found three remaining server-side mismatches. The main dashboard now continues to
surface a completed unbilled delivery when the order has only a return credit; void and cancel no
longer describe a posted credit memo as a sales invoice needing review; and automatic delivery billing
ignores soft-deleted invoices. The migration preserves the public RPC grants and the private helper's
no-application-execute posture with exact preflight and postflight checks. Delivery completion also
excludes credit-memo lines from tote-number copying, preserving the return's original traceability.
Delivery voiding leaves draft/manual and soft-deleted credit memos untouched, and posted credits do
not create a false cancelled-order billing warning.
The cancelled-order review queue also ignores soft-deleted posted invoices, so deleted billing
history no longer creates a false active-invoice warning.

The delivery detail page, integrity cleanup panel, and office exception dashboard now share the same
active, non-deleted sales-invoice coverage predicate, so a return credit or deleted invoice cannot hide
the recovery action or produce a false all-clear in the user interface.

The invoice-list Batch Print path now uses the same return-credit grouping as single-invoice Print,
so one credit memo cannot produce a simple customer line in one PDF and cost-lot fragments in another.

Fresh read-only production schema was restored into disposable PostgreSQL and eight replay entries were
applied there: the six PR #361 candidates plus two required compatibility/guard predecessors. The
rollback-only harness passed 56 load-bearing predicates, including
separate mutants for the dashboard credit filter and both automatic-invoice filters; direct execution
of the dashboard, void, cancel, and ordinary hard-delete paths; draft-credit preservation; and proof
that both invoice paths still create the expected $25 revenue and $5 historical-cost draft. The full
application suite passed 4,814 tests with 123 skipped; typecheck, lint, documentation check, and the
production build are green.
No migration was applied to the live database in this change.
