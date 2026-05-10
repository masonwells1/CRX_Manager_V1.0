# Contributing to CRX Manager

Quick reference for contributors and future-Mason. The full project conventions
live in [`CLAUDE.md`](../CLAUDE.md) at the repo root.

---

## E2E tests (Playwright)

E2E tests run against the live Supabase project. They sign in with a real
user account and seed/teardown shared `[E2E]`-prefixed fixtures.

### Required env vars

These must be set before any `playwright` command, including
`npm run test:e2e`. The test runner refuses to start without them — there is
no hardcoded credential fallback (PR-05).

| Var                  | Purpose                                                | Example                              |
| -------------------- | ------------------------------------------------------ | ------------------------------------ |
| `E2E_TEST_EMAIL`     | The login email of the E2E test account.               | `mason@croprxsolutions.com`          |
| `E2E_TEST_PASSWORD`  | That account's password.                               | (your password — never commit this)  |

Set them via your shell, or put them in a `.env` file at the repo root that
`playwright.config.ts` auto-loads at startup:

```bash
E2E_TEST_EMAIL=mason@croprxsolutions.com
E2E_TEST_PASSWORD=...your password here...
```

`.env` is git-ignored — never commit it.

### Production-Supabase guardrail

Today the SUPABASE_URL is hardcoded in
`tests/e2e/fixtures/setup-fixtures.ts` to the production project
(`rhyzpcqhnizqbxphqdkr`). This means E2E tests CURRENTLY run against live data.
That's an accepted-but-uncomfortable state — PR-23 will introduce a separate
staging Supabase project to remove this risk entirely.

In the meantime, the safety guard in
[`tests/e2e/utils/safety-guards.ts`](../tests/e2e/utils/safety-guards.ts)
(`assertNotProductionWithoutOverride`) refuses to run if `VITE_SUPABASE_URL`
is set to the production project ref WITHOUT `E2E_ALLOW_PROD=true`. This
catches the future case where the hardcoded URL becomes env-driven.

If you intentionally want to run E2E against production:

```bash
E2E_ALLOW_PROD=true npm run test:e2e
```

### Test data convention

ALL test-created entities MUST use the `[E2E]` prefix in their name. The
teardown step deletes every row matching `[E2E]%`. Entities without the
prefix won't get cleaned up and will pollute production.

Use the shared fixtures from
[`tests/e2e/fixtures/e2e-constants.ts`](../tests/e2e/fixtures/e2e-constants.ts)
when possible. For unique entities (e.g. concurrency tests), use
`${E2E_PREFIX} Description-${runId()}`.

---

## Pre-commit checks

The pre-commit hook runs:

1. `scripts/validate-sql.sh` — blocks SQL with wrong idempotency columns,
   `pg_get_functiondef()`, etc.
2. `scripts/validate-frontend.sh` — blocks direct `@sentry/react` imports.
3. `npm run lint` — ESLint, must have 0 errors.
4. `npm run build` — TypeScript + Vite production build.
5. `npm run test` — full vitest suite.

If a hook fails, fix the underlying issue. NEVER use `--no-verify`.

---

## Migrations

See [`SAFE_DEVELOPMENT_RULES.md`](../SAFE_DEVELOPMENT_RULES.md) and
[`DATABASE_CHANGE_CHECKLIST.md`](../DATABASE_CHANGE_CHECKLIST.md) for the
full migration safety protocol.

After ANY migration:

1. `node scripts/regenerate-schema-registry.mjs`
2. `bash scripts/validate-sql-migrations.sh` — verify no new violations
3. Update the relevant entry in `docs/reference/migration-history.md`
