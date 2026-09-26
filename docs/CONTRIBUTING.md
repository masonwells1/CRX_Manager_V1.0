# Contributing to CRX Manager

Quick reference for contributors and future-Mason. The short shared contract is
[`AGENTS.md`](../AGENTS.md); detailed engineering rules live in
[`SAFE_DEVELOPMENT_RULES.md`](workflows/SAFE_DEVELOPMENT_RULES.md). `CLAUDE.md`
contains Claude-only routing.

---

## E2E tests (Playwright)

E2E tests are staging-only. They sign in with a staging test account and
seed/teardown shared `[E2E]`-prefixed fixtures. Production is categorically
rejected; there is no override. No staging Supabase project exists yet
(creating one is an open owner action in `TODO.md`), so the suite cannot run
today.

### Required env vars

These must be set before any `playwright` command, including
`npm run test:e2e`. The test runner refuses to start without them — there is
no hardcoded credential fallback (PR-05).

| Var | Purpose |
| --- | --- |
| `E2E_TARGET_ENV` | Must be exactly `staging`. |
| `E2E_SUPABASE_URL` | Non-production staging Supabase URL. |
| `E2E_SUPABASE_ANON_KEY` | Staging anon key. |
| `E2E_TEST_EMAIL` | Staging E2E account email. |
| `E2E_TEST_PASSWORD` | Staging E2E account password. |

Set them via your shell, or put them in a `.env` file at the repo root that
`playwright.config.ts` auto-loads at startup:

```bash
E2E_TARGET_ENV=staging
E2E_SUPABASE_URL=https://your-staging-project.supabase.co
E2E_SUPABASE_ANON_KEY=...staging anon key...
E2E_TEST_EMAIL=e2e@example.com
E2E_TEST_PASSWORD=...your password here...
```

`.env` is git-ignored — never commit it.

### Production-Supabase guardrail

The safety guard in
[`tests/e2e/utils/safety-guards.ts`](../tests/e2e/utils/safety-guards.ts)
requires explicit staging configuration, rejects the production project, and
has no production escape hatch. Playwright also refuses to start while direct
production endpoint literals remain in E2E source. The suite remains disabled
in CI until PR-23 supplies staging and those literals/token-key assumptions are
migrated.

### Test data convention

ALL test-created entities MUST use the `[E2E]` prefix in their name. The
teardown step deletes every row matching `[E2E]%`. Entities without the
prefix won't get cleaned up and will pollute staging.

Use the shared fixtures from
[`tests/e2e/fixtures/e2e-constants.ts`](../tests/e2e/fixtures/e2e-constants.ts)
when possible. For unique entities (e.g. concurrency tests), use
`${E2E_PREFIX} Description-${runId()}`.

---

## Pre-commit checks

The git hooks live in the tracked `.husky/` folder; `npm install` points git at
it (`scripts/install-git-hooks.mjs`). They are deliberately fast, so the heavy
proof runs in CI.

The **pre-commit** hook runs:

1. `scripts/check-ledger-update.mjs` — a policy or guard change must stage its
   changelog, decision, or reference update.
2. `scripts/check-supplier-pricing-phase3-private-artifacts.mjs --pre-commit` —
   private-artifact containment (checks untracked and modified files too).
3. `scripts/validate-sql.sh` — on staged migrations; blocks SQL with wrong
   idempotency columns, `pg_get_functiondef()`, etc.
4. `scripts/validate-frontend.sh` — on staged frontend files; blocks direct
   `@sentry/react` imports and warns on a missing `checkMutationResult()` or
   `.toFixed(2)` on money.
5. `scripts/check-agent-workflows.mjs` — only when agent hooks, commands,
   skills, settings, `AGENTS.md`, or `CLAUDE.md` are staged.
6. `scripts/verify-deps.mjs` — only when `package.json`, `package-lock.json`,
   or `.nvmrc` is staged.

The **pre-push** hook runs private-artifact containment again (over every
outgoing commit), `npm run typecheck`, and `npm run build`, then refreshes the
optional local Graphify map.

Neither hook runs ESLint or the unit tests. **CI** (`lint-typecheck-test` in
`.github/workflows/ci.yml`) runs lint, typecheck, the Vitest suite with
coverage, the build, and the documentation check on every pull request that
changes code; run `npm run lint` and `npm test` yourself before pushing if you
want the answer early.

If a hook fails, fix the underlying issue. NEVER use `--no-verify`.

---

## Migrations

See [`SAFE_DEVELOPMENT_RULES.md`](workflows/SAFE_DEVELOPMENT_RULES.md) and
[`DATABASE_CHANGE_CHECKLIST.md`](workflows/DATABASE_CHANGE_CHECKLIST.md) for the
full migration safety protocol.

After ANY migration:

1. Run the `regen-schema-registry` workflow: collect its six live read-only Supabase query results, then run `node scripts/regenerate-schema-registry.mjs --from-introspection <queries.json>`. The no-argument command only updates the timestamp and is not a schema refresh.
2. `bash scripts/validate-sql-migrations.sh` — verify no new violations
3. Update the relevant entry in `docs/reference/migration-history.md`
