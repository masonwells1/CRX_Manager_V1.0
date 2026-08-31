## 2026-08-31 — Retire the unusable production migration approval gate

Deleted the production-migration automation added by PR #514, ~1,900 lines that could never run.

Removed: `.github/workflows/production-migration.yml`, `.github/workflows/production-approval-canary.yml`,
`scripts/build-reviewed-migration-batch.mjs` and its test, `scripts/verify-production-migration-review.mjs`,
`scripts/production-migration-review-lib.mjs`, `scripts/assert-production-environment-protection.mjs`,
and `scripts/production-main-freeze.mjs`. Also removed the unconditional
`Production migration batch guard` step from `ci.yml`, which invoked the deleted test on every run and
would otherwise have failed the required `Lint, Type Check, Test, Build` check on every future pull
request. `docs/reference/production-migration-approval-gate.md` is retained with a RETIRED banner as a
record of the design, not as a runbook.

Why: the gate was never usable. Its required `production-database` GitHub environment was never created
(the repository has only `Preview` and `Production`), both workflows recorded zero runs, its mandatory
pre-use boundary canary was never performed, and `auditedDdlAdmission()` admitted only `COMMENT ON`
statements — so no schema, RLS, money, or function migration could pass it. It also required a
ledger-order trigger that is not installed live.

Deliberately kept: PR #514's general migration-apply content binding and SQL parser hardening
(`migration-apply-lib.mjs`, `live-testdata-lib.mjs`, `migration-wrappability-lib.mjs`), which have
consumers outside the deleted automation.

Also rejected in the same change (Mason's decision, 2026-08-31): the global ledger-order trigger.
`20260827223000_enforce_global_migration_ledger_order.sql` was never applied and moved to
`scripts/.staging-migrations/…​.sql.REJECTED`, out of `supabase/migrations/`; its standalone prover
`scripts/smoke/prove-global-migration-ledger-order-guard.mjs` was deleted, and
`docs/reference/migration-history.md` row 900 records the rejection. The trigger is `ENABLE ALWAYS` on
every `BEFORE INSERT`, and 89 live ledger rows have an effective stamp at or below the running maximum
of earlier-versioned rows, so a `COPY`-based disaster-recovery restore would abort. It also lacks the
intentional-replay escape hatch the client-side ordering preflight honours and would reject all 626
legacy slug-only ledger names. No database change was made; the trigger was never installed.

Live migrations are unaffected and continue through the existing reviewed manual apply path. No
production behavior, database state, money, inventory, RLS, or customer-visible surface changed.

Verified before deletion: every reference to the removed files resolved to the removed files themselves
or to the single `ci.yml` line, and no `protect-main` required check names these workflows or jobs.
Reviewed by `gpt-5.6-sol` at high reasoning effort — verdict PROCEED WITH CHANGES; the CI-line removal
and the deletion of `production-main-freeze.mjs` are that review's required adjustments.
