# CLAUDE.md - CRX Manager V1.0

## Project
- **Repo:** https://github.com/masonwells1/CRX_Manager_V1.0
- **Live:** https://croprxsolutions.app
- **Stack:** React 18, TypeScript, Vite, Tailwind CSS, Supabase, Vercel
- **Supabase ID:** rhyzpcqhnizqbxphqdkr
- **Owner:** masonwells1 (beginner — explain things simply)

## Current State (2026-03-18)
- 56 pages, 88+ tables, ~144 RPCs, 205 migrations, 6 Edge Functions
- 1,633 unit tests (107 files) + 82 E2E spec files, all passing
- 0 ESLint errors, 0 TypeScript errors, CI green
- Pre-commit hook: lint + build + vitest
- All RPC data usage wrapped with `assertRpcResult()` — enforced by ESLint + safety-net test
- All destructive actions use `ConfirmModal` (no bare `confirm()` calls)
- 15+ RPC calls wired with `useIdempotencyKey` for double-submit prevention

---

## Architecture Rules
1. **Database changes = migrations only** — files in `supabase/migrations/`, never modify tables directly
2. **All tables MUST have RLS policies** — no exceptions
3. **Use `checkMutationResult()`** after every `.update()` or `.delete()`
4. **Lazy-load all pages** — `lazy()` + `Suspense` in `App.tsx`
5. **Lucide React icons only** — no other icon packages
6. **Tailwind CSS only** — brand color `crx-green` (#28A26A)
7. **Types in `src/types/index.ts`** — all shared interfaces
8. **Single Supabase client** — `src/lib/db.ts` only
9. **Activity logging** — `logActivity({ event, description, performedBy, ... })` from `src/lib/activityLogger.ts` (typed object param, NOT positional)
10. **Idempotency** — `useIdempotencyKey()` hook for critical writes
11. **Local ESLint rules** — `eslint-local-rules/` enforces `assertRpcResult` usage and blocks direct `@sentry/react` imports

---

## Hard Red Lines — NEVER Break

### Data Safety
- NEVER delete/modify existing migration files — only add new ones
- NEVER remove RLS policies — every table must have RLS
- NEVER expose `service_role` key in frontend — anon key only
- NEVER modify `financial_audit_log` records — append-only
- NEVER store money as floating point — use `bigint` cents, display ÷ 100

### Business Logic
- NEVER skip delivery confirm→complete flow (scheduled → in_progress → completed)
- NEVER allow editing delivery item quantities — locked to original order
- NEVER create invoices without an order — always linked via order_id
- NEVER bypass `check_period_open()` — closed periods block backdated transactions
- NEVER allow non-admin access to month-end, commissions, or settings
- Season = October 1 to September 30

### Code Quality
- NEVER remove pre-commit hook or commit with `--no-verify`
- NEVER add `@ts-ignore` or `any` (one exception: `reportPdf.ts` columnStyles)
- NEVER install other CSS/icon frameworks
- NEVER commit `.env` files

---

## Migration Safety Rules (CRITICAL — Prevents Code Drift)

These rules exist because **migration drift caused 40+ bugs** in March 2026.

### Before Writing ANY Migration
1. **CHECK constraints** — `SELECT conname, consrc FROM pg_constraint WHERE conrelid = 'table'::regclass AND contype = 'c';` — read existing values BEFORE rewriting
2. **Function overloads** — `SELECT proname, pg_get_function_identity_arguments(oid) FROM pg_proc WHERE proname = 'func_name';` — ensure only ONE overload exists
3. **Trigger functions** — Read the LATEST version in migrations before rewriting
4. **Status columns** — Check existing CHECK constraint values; your new list MUST include ALL old values plus any new ones

### When Writing Migrations
- NEVER use `pg_get_functiondef()` + regex to clone functions dynamically
- NEVER rewrite a CHECK constraint without including ALL existing allowed values
- NEVER `CREATE OR REPLACE FUNCTION` without checking for overloads first
- NEVER `DROP FUNCTION` without verifying the replacement exists
- Every `SECURITY DEFINER` function MUST have `SET search_path = public, pg_temp`
- Every RPC that mutates data MUST accept `p_idempotency_key text DEFAULT NULL`
- NEVER reference `idempotency_keys` columns as `key`, `entity_type`, `entity_id`, or `result_id` — correct columns are `idempotency_key`, `operation`, `result`

### After Writing Migrations
- Verify: `SELECT proname, count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace GROUP BY proname HAVING count(*) > 1;` — should return ZERO rows
- Run `npm run build` + `npm run test` before committing

---

## Business Logic Lifecycles

### Quote: `draft → sent → revised → accepted → declined → expired`
- `is_planned` reserves inventory via holds (linked via `source_id`)
- Accepted quotes convert via `convert_quote_to_order()` — holds released
- Declined/expired auto-release holds AND restore `quantity_available`

### Order: `confirmed → partially_fulfilled → fulfilled → cancelled`
- AR derived from linked invoices (`orders.total_paid`/`balance_due` are DEPRECATED)
- Commission records created per order per recipient

### Delivery: `scheduled → in_progress → completed → cancelled → voided`
- Two-step: `confirm_delivery()` then `complete_delivery()`
- Items locked to order quantities — only logistics editable
- Quick Delivery: `create_quick_delivery()` = atomic order + delivery + draft invoice

### Invoice: `draft → posted → paid → overdue → voided`
- `post_invoice()` calls `check_period_open()` — rejects if period closed
- `balance_cents` = single source of truth for AR (GENERATED ALWAYS column)
- All changes logged to `financial_audit_log`

### Job: `scheduled → in_progress → completed → cancelled → invoiced`
### PO: `draft → submitted → partially_received → fully_received → cancelled`
### Return: `requested → approved → received → credited → rejected → cancelled`

### Tier Pricing
- Customers: tier 1, 2, or 3. Products: tier1/2/3_price. Quotes inherit tier.

### Inventory
- **Net Free** = available − planned holds − prebooked
- **On Order** = sum(ordered − received) from open POs
- **Transaction types:** received, booked, delivered, returned, adjusted, transferred, job_applied, cancelled_delivery_reversal, void_delivery_reversal, prebooked, released

### Commissions
- `commission_split` JSONB: `{ splits: [{ recipient, percentage }] }`
- `save_customer()` validates splits sum to 100%
- Status: `pending → paid → cancelled`

---

## Common Patterns

### Adding a page
1. Component in `src/pages/` → lazy import in `App.tsx` → Route → nav link in `AppLayout.tsx`

### Database column change
1. Migration in `supabase/migrations/` → update `src/types/index.ts` → update components → `npm run typecheck && npm run build`

### Supabase queries
```typescript
import { supabase, checkMutationResult } from '../lib/db';
const result = await supabase.from('table').update({ col: val }).eq('id', id).select();
checkMutationResult(result, 'Update context');
```

---

## Edge Functions (6 in `supabase/functions/`)
- **create-user** — Admin-only user creation
- **process-blend-ticket** — OCR via Google Vision AI
- **process-document** — Document processing
- **seed-admin** — One-time admin setup
- **send-email** — Resend API, JWT auth, idempotency, PDF attachments
- **setup-blend-tickets-storage** — Storage bucket config

All require `ALLOWED_ORIGIN` env var for CORS.

---

## Key Entry Points
- `src/App.tsx` — Routes, auth provider, navigation tracking
- `src/contexts/AuthContext.tsx` — Auth state, Sentry user context
- `src/lib/db.ts` — Supabase client + `checkMutationResult()`
- `src/types/index.ts` — All TypeScript interfaces
- `src/lib/emailService.ts` — Email service (Resend via Edge Function)
- `supabase/migrations/` — Database migrations
- `supabase/functions/` — Edge Functions

---

## Schema Gotchas
- `commissions.commission_amount` is `numeric` dollars (NOT `_cents bigint`)
- `returns`: `requested_by` (not `created_by`), status `'requested'` (not `'pending'`)
- `return_items`: references `order_item_id` only (not `delivery_item_id`)
- `invoice_items.extended_cents` (not `line_total_cents`)
- `create_direct_order` returns `{ order_id }` not `{ id }`
- `complete_delivery` requires `p_signed_by text`
- `orders.total_paid` / `orders.balance_due` — DEPRECATED, use `invoices.balance_cents`

### Tables WITHOUT `updated_at` (DO NOT SET updated_at on these!)
These tables have NO `updated_at` column. Setting it in an UPDATE will crash the RPC:
`commissions`, `purchase_order_items`, `payments`, `write_offs`, `delivery_items`,
`order_items`, `quote_items`, `return_items`, `finance_charges`, `prepay_applications`,
`cycle_counts`, `cycle_count_items`, `activity_feed`, `financial_audit_log`,
`idempotency_keys`, `receiving_records`, `inventory_transactions`,
`invoice_line_allocations`, `commission_payment_items`

**Rule:** ALWAYS check `information_schema.columns` before referencing `updated_at` in any UPDATE statement.

---

## E2E Testing
- Mega-workflow: `tests/e2e/mega-workflow.spec.ts` (95 serial steps)
- Use `page.once('dialog')` in serial suites (not `page.on`)
- Use `waitForLoadState('networkidle')` over `waitForTimeout()`

### E2E Test Data Protocol (MANDATORY)
- **ALL test-created entities MUST use `[E2E]` prefix** in their name — no exceptions
- **Reuse shared fixtures** from `tests/e2e/fixtures/e2e-constants.ts`:
  - Customers: `[E2E] Farm Alpha` (tier 1), `[E2E] Farm Beta` (tier 3)
  - Products: `[E2E] Herbicide Alpha`, `[E2E] Adjuvant Beta`, `[E2E] Fertilizer Gamma`
  - Vendor: `[E2E] Test Vendor`
- **If a test needs unique entities** (e.g., concurrency), use `${E2E_PREFIX} Desc-${runId()}`
- **NEVER create test entities without the `[E2E]` prefix** — they won't get cleaned up
- `globalSetup` creates shared fixtures before the suite, `globalTeardown` deletes ALL `[E2E]` data after
- Import from `tests/e2e/fixtures/e2e-constants.ts` — never hardcode test entity names

---

## Reference Docs (read when needed)

| Doc | Contents |
|-----|----------|
| `docs/reference/database-schema.md` | 83+ tables + RLS matrix |
| `docs/reference/rpc-functions.md` | ~138 RPCs + triggers |
| `docs/reference/migration-history.md` | 196 migration entries |
| `docs/reference/pages-routes.md` | 56 pages with routes |
| `docs/reference/code-patterns.md` | Number formats, UI patterns, build notes |
| `docs/reference/qa-testing.md` | Role matrix, workflow tests, edge cases |
| `docs/CHANGELOG.md` | Sprint-by-sprint history |

## Workflow Docs
- `SAFE_DEVELOPMENT_RULES.md` — **READ EVERY SESSION** — mandatory safety rules
- `DATABASE_CHANGE_CHECKLIST.md` — Step-by-step for schema changes
- `QUOTE_TO_DELIVERY.md` — Full business pipeline reference
- `INVENTORY_RULES.md` — Inventory calculations and transaction rules
- `RLS_SECURITY_GUIDE.md` — Row Level Security patterns
- `UI_PATTERNS.md` — Frontend patterns and conventions

---

## Documentation Maintenance Rules (MANDATORY)

Docs drift caused confusion and wasted time repeatedly. These rules prevent it.

### After EVERY Code Change Session
1. **Update `CLAUDE.md` Current State counts** — page count, migration count, RPC count, test counts
2. **Update `docs/reference/migration-history.md`** — add row for every new migration file created
3. **Update `docs/reference/pages-routes.md`** — add entry for every new page/route added
4. **Update `docs/reference/rpc-functions.md`** — add entry for every new RPC created or dropped
5. **Update `docs/reference/database-schema.md`** — add entry for every new table or significant column change
6. **Update `docs/CHANGELOG.md`** — add entry summarizing the work done in this session
7. **Update `docs/reference/qa-testing.md`** — if new E2E tests were added or test patterns changed

### When Writing Migrations
- Add the new migration to `docs/reference/migration-history.md` immediately
- If the migration creates a table → update `database-schema.md`
- If the migration creates/drops a function → update `rpc-functions.md`
- If the migration changes status enums or lifecycles → update `CLAUDE.md` Business Logic section

### When Adding Pages
- Add lazy import to `App.tsx` → update `pages-routes.md` → update page count in `CLAUDE.md`

### When Adding/Changing Business Logic
- Update the relevant lifecycle in `CLAUDE.md` Business Logic Lifecycles section
- Update `docs/workflows/QUOTE_TO_DELIVERY.md` if the quote→order→delivery→invoice pipeline changes
- Update `docs/workflows/INVENTORY_RULES.md` if inventory calculations change

### Verification
Before claiming work is done, verify:
```bash
# Quick doc-drift check
grep -c "lazy(" src/App.tsx                    # should match CLAUDE.md page count
ls supabase/migrations/*.sql | wc -l          # should match CLAUDE.md migration count
```

---

## Code Drift Prevention Rules (MANDATORY)

These rules exist because code drift caused 40+ bugs. Follow them to keep the codebase consistent.

### Naming & Convention Rules
- **Status enums** — ALWAYS check existing CHECK constraints before adding/modifying statuses. Your new list MUST be a superset of the old values.
- **Column names** — ALWAYS read the actual table schema before referencing columns in RPCs. Never assume column names from memory.
- **RPC signatures** — ALWAYS check for existing overloads before CREATE OR REPLACE. Run: `SELECT proname, pg_get_function_identity_arguments(oid) FROM pg_proc WHERE proname = 'func_name';`
- **Type definitions** — When adding new DB columns, ALWAYS update `src/types/index.ts` to match
- **idempotency_keys columns** — The table uses `idempotency_key` (NOT `key`), `operation` (NOT `entity_type`), `result` (NOT `result_id` or `entity_id`). Pre-commit hook validates this.

### Pattern Consistency Rules
- **New pages** MUST follow the existing pattern: lazy import → Route → nav link → page component with standard layout
- **New RPCs** MUST accept `p_idempotency_key text DEFAULT NULL` if they mutate data
- **New tables** MUST have RLS policies — no exceptions
- **New mutations** MUST use `checkMutationResult()` after `.update()` or `.delete()`
- **Money values** MUST use `bigint` cents — NEVER floating point
- **Activity logging** — call `logActivity()` for user-visible actions
- **Error handling** — use toast notifications, never `window.alert()` or `window.confirm()` (use `ConfirmModal`)

### SQL Validation Scripts
- **Pre-commit (automatic):** `scripts/validate-sql.sh` — validates staged .sql files for idempotency column bugs, missing search_path, etc.
- **Full audit (manual):** `scripts/validate-sql-migrations.sh` — scans ALL migration files. Run with `--idempotency-only` for focused check.

### Before Every Commit
1. `npm run lint` — 0 errors
2. `npm run build` — clean build
3. `npm run test` — all tests pass
4. Doc counts match reality (see Documentation Maintenance above)
5. SQL migration validation passes (automatic via pre-commit hook — validates idempotency column names)
