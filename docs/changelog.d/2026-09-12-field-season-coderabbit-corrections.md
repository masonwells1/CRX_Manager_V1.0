## 2026-09-12 - Resolve filed-season guard review gaps

CodeRabbit reviewed PR #652's `15742bd` candidate and requested five changes.
The cancellation actor-sweep exception now also pins both active-user role helpers,
`public.is_admin()` and `public.is_sales_rep()`, using their verified live composite
definition/owner/ACL/effective-EXECUTE contracts. The mandatory-pin regression failed
before correction; per-pin removal and mutation checks cover both helpers.

The disposable actor-forgery proof now specifically requires the original harmless
`p_signed_by` row to stay unallowlisted after public-body drift, so a different actor
parameter cannot accidentally satisfy that assertion. Captured-result adjudication sets
an exit code without abruptly terminating output, and its exclusive execution branch
prevents linked-live/print-only fallthrough. A large piped JSON regression verifies the
complete output and refusal status; its previous Windows run passed and is not claimed
as a reproduced truncation bug.

The season prover now checks that both preview and cross-season guard migrations are
in its selected inventory and that the guard follows preview. The rendered invoice test
opens the real block-mode admin override while the date is valid, changes the date into
another season, confirms the override, and observes the season refusal with no save RPC
or override activity write. Its first run failed on a fixture label mismatch, then all
31 invoice tests passed after that correction.

Observed focused proof: 483 matcher/actual-CLI assertions and 31 disposable PostgreSQL
checks passed. Independent security re-review returned CLEAN and verified all five
cancellation dependency contracts against live read-only state. The existing 29-result
same-session capture also passed corrected CLI adjudication; that CLI execution is
captured-results-only, not a new live sweep.

The corrected full suite passed 373 files and 5,246 tests, with 123 skipped and exit 0.
Lint, typecheck, build, workflow parity, dependency audit and documentation checks passed.
The strengthened season prover completed its real registered public split/save/retry/post
chain with `SMOKE_PASS_ROLLBACK` and terminal `PREVIEW_SEASON_PROOF_PASS`, exit 0.

The authoritative season migration, predicate SQL and live grants were not changed.
Fresh whole-branch exact-commit review, broader checks and final corrected-head
CodeRabbit review remain delivery gates. No merge, live apply or production mutation
is authorized or performed here. The abandoned posting-date due-date proposal stays
out of scope; this guard follows the invoice-date season work, not that proposal.
