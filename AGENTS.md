# CRX Manager Codex Guide

This file is for Codex and other coding agents working in this repo. It condenses the project rules from `CLAUDE.md` and the Markdown docs, but `CLAUDE.md` remains the main source of truth.

## Project Snapshot

- App: CRX Manager V1.0 for Crop RX Solutions, an agricultural chemical distributor.
- Stack: React 18, TypeScript, Vite, Tailwind CSS, Supabase, Vercel.
- Production: https://croprxsolutions.app
- Supabase project: `rhyzpcqhnizqbxphqdkr`
- Owner: Mason Wells. Mason has 0 coding experience and may not know technical terms. Lead the process, explain in plain language, define any necessary jargon, and give clear next steps instead of assuming he knows what to do.
- Verified locally on 2026-05-01: 65 lazy-loaded pages, 266 migrations, 7 Edge Functions, 128 unit test files, 93 E2E spec files. (Counts can drift — recompute from the repo before citing.)

Some older docs contain stale counts. When counts matter, recompute from the repo instead of trusting old README-style numbers.

## Read First

At the start of a work session, read:

1. `CLAUDE.md`
2. `docs/workflows/SAFE_DEVELOPMENT_RULES.md`
3. The relevant workflow doc for the area being changed:
   - Database: `docs/workflows/DATABASE_CHANGE_CHECKLIST.md`
   - Quote/order/delivery/invoice pipeline: `docs/workflows/QUOTE_TO_DELIVERY.md`
   - Inventory: `docs/workflows/INVENTORY_RULES.md`
   - RLS/security: `docs/workflows/RLS_SECURITY_GUIDE.md`
   - UI: `docs/workflows/UI_PATTERNS.md`

Reference docs:

- Tables and RLS: `docs/reference/database-schema.md`
- RPCs: `docs/reference/rpc-functions.md`
- Migrations: `docs/reference/migration-history.md`
- Routes: `docs/reference/pages-routes.md`
- Code patterns: `docs/reference/code-patterns.md`
- QA/testing: `docs/reference/qa-testing.md`
- History: `docs/CHANGELOG.md`
- Agent memory: `docs/claude-memory/`

The `.claude/skills/` files are useful workflow checklists. Follow the matching skill when adding pages, migrations, RPCs, audits, deployment checks, or doc updates.

## Hard Rules

- Database changes only through new files in `supabase/migrations/`. Never edit old migrations.
- New tables must have RLS policies.
- Every mutating RPC should accept `p_idempotency_key text DEFAULT NULL`.
- Every `SECURITY DEFINER` function must include `SET search_path = public, pg_temp`.
- Check function overloads and existing CHECK constraints before writing SQL migrations.
- Use `src/lib/db.ts` as the only Supabase client.
- Use `assertRpcResult()` after RPC calls.
- Use `checkMutationResult()` after every Supabase `.update()` or `.delete()`.
- Use `ConfirmModal`, not `confirm()` or `window.confirm()`.
- Use toast UI, not `alert()` or `window.alert()`.
- Import Sentry only through `src/lib/sentry`.
- Store money as bigint cents. Do not use floating point for persisted money.
- Use Lucide React icons and Tailwind CSS only.
- Shared types belong in `src/types/index.ts`.
- Never commit `.env` files or expose service-role keys in frontend code.

## Business Rules To Preserve

- Season is October 1 through September 30.
- Delivery lifecycle is `scheduled -> in_progress -> completed`, with cancel/void paths.
- Delivery items are editable only while delivery status is `scheduled`.
- Invoices must link to an order or blend ticket.
- `post_invoice()` must respect `check_period_open()`.
- Admin-only areas include month-end, commissions, settings, and most financial controls.
- Inventory math belongs in PostgreSQL RPCs/triggers, not React.
- Net Free inventory is `quantity_available - planned holds - quantity_prebooked`.
- AR source of truth is invoice balances, especially `invoices.balance_cents`.

## Common Entry Points

- App routes/providers: `src/App.tsx`
- Auth: `src/contexts/AuthContext.tsx`
- Supabase helpers: `src/lib/db.ts`
- Activity logging: `src/lib/activityLogger.ts`
- Idempotency: `src/lib/idempotency.ts` and `src/hooks/useIdempotencyKey.ts`
- Shared types: `src/types/index.ts`
- Layout/sidebar: `src/components/layout/`
- Pages: `src/pages/`
- Domain components: `src/components/{domain}/`
- Edge Functions: `supabase/functions/`
- Migrations: `supabase/migrations/`
- E2E fixtures: `tests/e2e/fixtures/e2e-constants.ts`

## Change Workflow

Before editing:

1. Check `git status` and preserve unrelated user changes.
2. Read the files and docs for the specific area.
3. Search for existing patterns before adding new ones.
4. For database work, inspect actual schema/function constraints before writing SQL.

After editing:

1. Run the narrowest useful checks first.
2. For frontend changes, run `npm run typecheck` and usually `npm run build`.
3. For database or business logic changes, also run relevant tests.
4. Update docs when behavior, schema, routes, RPCs, or migration counts change.

Useful commands:

```bash
npm run dev
npm run typecheck
npm run lint
npm run build
npm run test
npm run test:e2e
```

## Testing Notes

- Unit tests live mostly beside source files as `*.test.ts` / `*.test.tsx`.
- E2E specs live in `tests/e2e/`.
- E2E-created data must use the `[E2E]` prefix and shared fixtures from `tests/e2e/fixtures/e2e-constants.ts`.
- Use `page.once('dialog')` in serial Playwright suites.
- Prefer waiting for meaningful UI/network states over fixed sleeps.

## Documentation Notes

- `CLAUDE.md` is dense but important. Keep it aligned after meaningful code changes.
- Update `docs/reference/migration-history.md` for new migrations.
- Update `docs/reference/pages-routes.md` for new routes/pages.
- Update `docs/reference/rpc-functions.md` for new or changed RPCs.
- Update `docs/reference/database-schema.md` for schema changes.
- Update `docs/CHANGELOG.md` after completed work sessions that change behavior.
