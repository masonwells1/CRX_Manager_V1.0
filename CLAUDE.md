<!--
MAINTAINER NOTE (block-level HTML comments are stripped before this file enters Claude's context — they cost no tokens).
This file is kept deliberately lean. Guidance followed (Anthropic "Best practices for Claude Code" + "How Claude
remembers your project"): target a short, every-session-facts-only file; push sometimes-relevant detail out to docs +
skills; prune by asking "would removing this line cause Claude to make a mistake?". Heavy reference content was moved to
docs/reference/sql-canonical-patterns.md and docs/reference/agent-guardrails.md; the running history to docs/CHANGELOG.md
+ memory/. The "Working Principles" block adapts Karpathy's ACTUAL committed guidance
(github.com/karpathy/autoresearch/program.md); the viral "Karpathy CLAUDE.md" is a third-party derivative
(github.com/multica-ai/andrej-karpathy-skills), NOT his own file. AGENTS.md is generated separately by
scripts/regenerate-agents-md.mjs and does not parse this file.
-->
# CLAUDE.md - CRX Manager V1.0

## Project
- **Repo:** https://github.com/masonwells1/CRX_Manager_V1.0
- **Live:** https://croprxsolutions.app
- **Stack:** React 18, TypeScript, Vite, Tailwind CSS, Supabase, Vercel
- **Supabase ID:** rhyzpcqhnizqbxphqdkr
- **Owner:** masonwells1 (beginner — explain things simply)

## Snapshot (2026-06-15)

**Live counts — verify with `node scripts/check-doc-drift.mjs`, don't trust them blind:** 68 pages · 96 tables (+2 views) · 226 callable RPCs (+47 trigger fns) · **458** migration files on disk (reference docs track ~455) · 7 Edge Functions · ~2,005 unit tests + 70 skipped / 94 E2E specs.

- **`main` = production** (croprxsolutions.app). NEVER push, deploy, apply a live migration, delete data, or commit unrelated files without Mason's explicit OK *in the current chat*.
- **Where history lives now** (so this file stays lean): sprint log → [`docs/CHANGELOG.md`](docs/CHANGELOG.md); detailed per-topic narrative → the `memory/` files (auto-loaded each session); the old multi-month "Current State" block → [`docs/archive/2026-spring/claude-md-session-log-pre-2026-06-15.md`](docs/archive/2026-spring/claude-md-session-log-pre-2026-06-15.md).
- **Open owner items (need Mason, not code):** Stripe pay-now keys (A1) · 10 real vendor bills for the AP-AI accuracy gate (D1) · physical counts to re-base 17 negative-inventory products (H1) · seed-admin `ENVIRONMENT=production` confirm (M4) · Supabase leaked-password protection toggle (L4) · grower-portal label CSV (0/604 products have REI/PHI/signal_word).
- **Money/AR audits are still "vacuously clean"** (≈0 posted invoices/payments live) → re-run `/foundation-ultra-review` after the first real billing cycle.

## Working Principles

Kept short on purpose: this whole file loads on **every turn**, so bloat makes Claude follow it *less* (Anthropic: "Bloated CLAUDE.md files cause Claude to ignore your actual instructions"). General coding discipline = the **Karpathy-derived guidelines appended at the end of this file** (think-before-coding · simplicity-first · surgical changes · goal-driven execution). On top of those, the CRX-specific rules that always apply:

- **Verify, don't assume.** Read the live schema / existing code before writing; if a fact is load-bearing, confirm it (a quick query, `get_advisors`, the actual file) rather than trusting memory or a handoff.
- **The Hard Red Lines beat everything — including the appended "NEVER STOP."** Drive a task to completion without stalling on trivial questions, BUT never push, deploy, apply a live migration, delete data, or commit unrelated files without Mason's explicit OK in the current chat. CRX runs a live business; "NEVER STOP" governs task *momentum*, never production actions.
- **Lead for Mason.** He has ~0 coding experience: explain in plain English, define jargon, and **recommend a clear next step** instead of listing options.

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

## Auto-Triggered Skills & Commands (MANDATORY)

Claude MUST automatically invoke the matching skill/command when the task matches — do NOT wait for the user to type the slash command. These exist in `.claude/skills/` and `.claude/commands/` and travel with the repo.

### Skills (multi-step guided workflows)
| When the task involves... | Auto-invoke |
|---------------------------|-------------|
| **Any substantive coding job done to completion** — "add/build/implement/fix/create X", a new feature, page, RPC, fix, or migration. **Mason will NOT type the command — default to this** and tell him in one line that you're running it through `/ship` (it wraps the scaffold skills below as its implement step, then runs the review gate + auto-fix + auto-apply, stopping only for Codex when worthy and the prod-push approval). Skip for trivial one-line tweaks or questions. | `/ship` |
| Adding a new page/screen to the app | `/new-page` |
| Creating a new RPC / database function / stored procedure | `/new-rpc` |
| Creating a new migration / table / column / index / RLS policy | `/create-migration` |
| Running a full health check, audit, or "is everything okay?" | `/audit` |
| Deploying, or "is this ready to ship?" | `/deploy-check` |
| Checking docs for drift or staleness | `/update-docs` |
| Deploying a Supabase Edge Function (live deploy of `send-email`, `create-user`, etc.) | `/deploy-edge-function` |
| Setting up a Codex cross-review for a finding, fix, or proposed change | `/codex-cross-review` |
| Translating a SQL migration into plain English before approving `apply_migration` | `/explain-migration` |
| Quick live production health check (Sentry + Supabase + Vercel + Edge Functions) | `/spot-check-prod` |
| Regenerating `.claude/schema-registry.json` after a status enum / generated column / table change | `/regen-schema-registry` |
| Checking whether the app drifted from the workflow map — "is everything still wired right?", "did anything drift?", "find missing/broken page↔RPC↔lifecycle connections" | `/map-drift-audit` |
| Stress-testing the architecture for FRAGILITY — "where are the weak spots?", "single points of failure?", "is this double-submit/race safe?", "what connections are missing for resilience?" | `/architecture-weakness-audit` |
| "How does X work?", "what's the architecture of Y?", "trace this flow" — codebase exploration | `feature-dev:code-explorer` |
| "I want to add X feature" — needs architecture design before coding | `feature-dev:code-architect` |
| "A customer reported X", "a customer can't Y", "something looks weird for user Z" | `posthog:investigating-replay` (pulls their actual session replay) |
| "Why is this failing in prod?", "I see an error" — production debugging | `engineering:debug` |
| "We had an incident" / "production is down" / "rollback X" | `engineering:incident-response` |
| "Are we ready to deploy?", "deploy checklist" | `engineering:deploy-checklist` |
| "Where are we slowing down?", "tech debt review" | `engineering:tech-debt` |
| Any new feature with non-trivial complexity (before writing code) | `superpowers:brainstorming` (MUST — required by my system) |

### Commands (quick one-shot checks)
| When the user says... | Auto-invoke |
|-----------------------|-------------|
| "commit this", "ready to commit", or before any git commit | `/preflight` |
| "what's the status", "where are we", "show me the state" | `/status` |
| "something's broken", "check for errors", "what's wrong" | `/quick-fix` |

**Rule:** If the user's request matches ANY row above, invoke the skill/command FIRST, then follow its steps. Do not freelance the workflow — the skill exists to prevent mistakes. Skills only guide the process — they still require user approval before any destructive or irreversible action (deploys, migrations, commits).

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
- NEVER allow editing delivery items once delivery is in_progress or beyond — items are only editable while status = 'scheduled'
- NEVER create invoices without an order OR blend ticket — must have order_id or blend_ticket_id. (Enforced by **RPC convention, NOT a DB CHECK** — `invoices` has zero CHECK constraints. **Credit memos are exempt:** `issue_return_credit` inserts a `credit_memo` whose `order_id` may be NULL with no `blend_ticket_id`. Don't add a literal `order_id OR blend_ticket_id` CHECK without excluding `invoice_type='credit_memo'`, or credit memos break.)
- NEVER bypass `check_period_open()` — closed periods block backdated transactions
- NEVER allow non-admin access to month-end, commissions, or settings
- `/payments` (PaymentAllocation) is **sales+admin** — both roles can record check entries and allocate to invoices. Confirmed at `App.tsx:198`: `allowedRoles={['admin', 'sales_rep']}`. Do NOT lock this page to admin-only without a deliberate policy change. (Audit Q6, 2026-05-06.)
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

### Quote: `draft → sent ⇄ revised`; from sent/revised → `accepted` / `declined` / `expired`; `cancelled` from draft/sent/revised
- **Branching, not linear** — the old single-arrow chain was misleading: `declined`/`expired`/`cancelled` are **terminal**, and `accepted` can revert to `sent`. See the quote SVG in `docs/app-workflow-map.html` for the exact enforcer-allowed transitions.
- `is_planned` reserves inventory via holds (linked via `source_id`)
- Accepted quotes convert via `convert_quote_to_order()` — holds released
- **Partial draw-down (since `20260610145253`):** a `sent`/`revised` quote is an open booking — `draw_down_quote()` pulls any per-product portion into a new confirmed order at the quote's locked price, repeatedly; balances live in `quote_product_draws`; active holds decrement FIFO per draw (hold → prebooked, Net Free invariant); the final draw sets `accepted`. Whole-conversion on a partially-drawn quote is blocked (`BOOKING_PARTIALLY_DRAWN`)
- Declined/expired auto-release holds AND restore `quantity_available`

### Order: `confirmed → partially_fulfilled → fulfilled → cancelled → voided`
- AR derived from linked invoices (use `invoices.balance_cents` — `orders.total_paid`/`balance_due` columns were dropped)
- Commission records created per order per recipient

### Delivery: `scheduled → in_progress → completed → cancelled → voided`
- Two-step: `confirm_delivery()` then `complete_delivery()`
- Items editable while scheduled (add/remove/adjust qty); locked once in_progress or beyond
- Quick Delivery: `create_quick_delivery()` = atomic order + delivery + draft invoice

### Invoice: `draft → unposted → posted → paid → overdue → voided → cancelled`
- `post_invoice()` calls `check_period_open()` — rejects if period closed
- `balance_cents` = single source of truth for AR (GENERATED ALWAYS column)
- All changes logged to `financial_audit_log`

### Job: `scheduled → in_progress → completed → cancelled → invoiced`
### PO: `draft → submitted → partially_received → fully_received → cancelled`
### Return: `requested → {approved, rejected, cancelled}`; `approved → {received, cancelled}`; `received → credited` (credited/rejected/cancelled are terminal — branches, not a chain)
### Commission Payment: `unposted → posted → voided`

### Blend Ticket: 4 orthogonal status axes (not a single lifecycle)
- `status` (OCR pipeline): `pending → processing → completed → failed | needs_review` — set by `process-blend-ticket` Edge Function + `save_blend_ticket`
- `review_status`: `unreviewed → approved | rejected` — `batch_approve_blend_tickets` / `batch_reject_blend_tickets` / `reverse_blend_ticket_approval` (require `status='completed'` first)
- `payment_status`: `unbilled → billed | prepaid | no_charge` — `create_invoice_from_blend_ticket` / `sync_blend_ticket_payment_status`; the `trg_sync_blend_ticket_payment` trigger auto-resets `billed → unbilled` when the linked invoice is voided/cancelled
- `order_link_status`: `unlinked → linked` — `link_blend_ticket_to_order` / `create_order_from_blend_ticket` / `unlink_blend_ticket_from_order`

### Tier Pricing
- Customers: tier 1, 2, or 3. Products: tier1/2/3_price. Quotes inherit tier.

### Inventory
- **Net Free** = available − planned holds − prebooked
- **On Order** = sum(ordered − received) from open POs
- **Transaction types (12):** received, booked, delivered, returned, adjusted, transferred, job_applied, cancelled_delivery_reversal, void_delivery_reversal, prebooked, released, prebook_reconciliation (2026-06-10 — prebooked-only corrections; historical prebooked corrections were `adjusted` rows flagged in notes — see INVENTORY_RULES.md caveats)

### Commissions
- `commission_split` JSONB: `{ splits: [{ recipient, percentage }] }`
- `save_customer()` validates splits sum to 100%
- Per-order commission record status: `pending → paid → cancelled`

### Commission Payment (batch): `unposted → posted → voided`
- `commission_payments` table — a payout batch grouping multiple commission records for one recipient
- Created with `status = 'unposted'`; finalized to `posted`; reversible via `void_commission_payment()` → `voided`
- CHECK constraint: `status IN ('unposted', 'posted', 'voided')` (see `20260331120000_void_commission_payment.sql`)
- Distinct from the per-order `commissions.status` above

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

## Edge Functions (7 in `supabase/functions/`, + `_shared/` lib dir)
- **create-user** — Admin-only user creation
- **process-blend-ticket** — OCR via Google Vision AI
- **process-document** — Document processing
- **reset-user-password** — Admin-only password reset
- **seed-admin** — One-time admin setup
- **send-email** — Resend API, JWT auth, idempotency, PDF attachments
- **setup-blend-tickets-storage** — Storage bucket config

All require `ALLOWED_ORIGIN` env var for CORS.

---

## Codebase Knowledge Graph & Architecture Map
- **Page graph:** `graphify-out/graph.json` (gitignored, local). Rebuild via Bash (not PowerShell): `python -m graphify src/pages`. Ask Claude to "trace the invoice flow" and it reads the JSON.
- **Workflow map:** `docs/app-workflow-map.html` — regenerate with `npm run generate-map` (auto-runs in the pre-commit hook).

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
- `profile_public_view` uses `security_invoker = off` (SECURITY DEFINER semantics) **by design** — exposes only non-PII profile columns (id, full_name, role, is_active) so non-admin UIs can display user names without leaking email/phone. Supabase security advisor flags this as ERROR; it is an accepted finding. Do NOT switch to `security_invoker = on` without auditing every UI that reads through this view. (Migration: `20260510070000_tighten_customer_profile_rls.sql`)
- The **53 anon-executable SECURITY DEFINER functions** (live count as of 2026-06-15) the Supabase advisor flags (`Public Can Execute SECURITY DEFINER Function`) are **accepted/inert grant-debt, NOT a hole**: each self-gates on `auth.uid()`/`require_admin()` as its first executable statement (runtime-proven 2026-06-08 the `anon` role is rejected — e.g. `admin_update_profile`→"requires admin role", `get_ar_aging`→"Admin access required"), and the trigger functions in the set error on a direct call. Migration `20260529214355` revoked anon EXECUTE on the **37 report/dashboard** RPCs that were leaking PII; the remaining 53 are a *different* set whose real gate is the in-body check, not the EXECUTE grant. Revoking them is optional defense-in-depth (migration gate + `get_advisors` re-check). (2026-06-08 workflow review LOW #6.)
- `commissions.commission_amount` is `numeric` dollars (NOT `_cents bigint`)
- `returns`: `requested_by` (not `created_by`), status `'requested'` (not `'pending'`)
- `return_items`: references `order_item_id` only (not `delivery_item_id`)
- `invoice_items.extended_cents` (not `line_total_cents`)
- `create_direct_order` returns `{ order_id }` not `{ id }`
- `complete_delivery` requires `p_signed_by text`
- `orders.total_paid` / `orders.balance_due` — DROPPED (use `invoices.balance_cents`)

### Tables WITHOUT `updated_at` (DO NOT SET updated_at on these!)
These tables have NO `updated_at` column. Setting it in an UPDATE will crash the RPC:
`payments`, `write_offs`, `delivery_items`, `finance_charges`, `prepay_applications`,
`cycle_counts`, `cycle_count_items`, `financial_audit_log`,
`idempotency_keys`, `receiving_records`, `commission_payment_items`

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
| `docs/reference/database-schema.md` | 96 tables (+2 views) + RLS matrix |
| `docs/reference/rpc-functions.md` | 226 callable RPCs + 47 trigger functions |
| `docs/reference/migration-history.md` | 455 migrations |
| `docs/reference/pages-routes.md` | 68 pages with routes |
| `docs/reference/code-patterns.md` | Number formats, UI patterns, build notes |
| `docs/reference/qa-testing.md` | Role matrix, workflow tests, edge cases |
| `docs/CHANGELOG.md` | Sprint-by-sprint history |
| `TODO.md` | Current TODO/Done/Deferred status |

## Workflow Docs
- `SAFE_DEVELOPMENT_RULES.md` — **READ EVERY SESSION** — mandatory safety rules
- `DATABASE_CHANGE_CHECKLIST.md` — Step-by-step for schema changes
- `QUOTE_TO_DELIVERY.md` — Full business pipeline reference
- `INVENTORY_RULES.md` — Inventory calculations and transaction rules
- `RLS_SECURITY_GUIDE.md` — Row Level Security patterns
- `UI_PATTERNS.md` — Frontend patterns and conventions

---

## Keeping Docs In Sync (MANDATORY)
After any change that alters counts, schema, routes, RPCs, or lifecycles, update the matching doc(s) and re-run the generators. The `/update-docs` skill automates this; `node scripts/check-doc-drift.mjs` verifies it.
- **Every session:** add an entry to `docs/CHANGELOG.md` and refresh the counts in the Snapshot above.
- **Schema / RPC / route / migration change:** update the relevant `docs/reference/*.md`, then run `node scripts/regenerate-agents-md.mjs` (rebuilds AGENTS.md counts) and, for schema changes, `node scripts/regenerate-schema-registry.mjs` (the PreToolUse hooks read this).
- **Lifecycle / enum change:** also update the Business Logic Lifecycles section above.

## Code Drift Prevention Rules (MANDATORY)

These rules exist because code drift caused 40+ bugs. Follow them to keep the codebase consistent.

### Canonical code patterns → [`docs/reference/sql-canonical-patterns.md`](docs/reference/sql-canonical-patterns.md)
**Read that file before writing a migration, RPC, or mutation.** It holds the full copy-paste templates (operation-scoped idempotency lookup, the `check_idempotency`/`save_idempotency` helpers, the strict-actor block, the SECURITY DEFINER header, machine-readable error tokens, RPC return shapes, and the frontend `checkMutationResult`/`logActivity`/`ConfirmModal`/Sentry rules). The non-negotiable few, inline so they're never forgotten:
- `idempotency_keys` columns are **`idempotency_key` / `operation` / `result`** (jsonb) — never `key`/`entity_type`/`entity_id`; the lookup MUST filter `AND operation = '<this_rpc_name>'` (an unscoped lookup returns another op's cached row — the `restore_quote_version` bug class).
- Every SECURITY DEFINER fn: `SET search_path = public, pg_temp`. Every mutating RPC: `p_idempotency_key text DEFAULT NULL` **and actually use it** in the body.
- Money is `bigint` cents (never float). After `.update()/.delete()` → `checkMutationResult()`. After an RPC → `assertRpcResult()`. Strict-actor: bind `auth.uid()` and reject a mismatched `p_performed_by` with `ACTOR_MISMATCH`.

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
- **Activity logging** — call `logActivity(performedBy=profile.id)` for user-visible actions
- **Error handling** — use toast notifications, never `window.alert()` or `window.confirm()` (use `ConfirmModal`)
- **Sentry** — import `{ Sentry }` from `lib/sentry`, never directly from `@sentry/react`

### Automated Enforcement (Pre-Commit Hook)
The pre-commit hook runs these checks automatically — code that violates them CANNOT be committed:

1. **`scripts/validate-sql.sh`** — Blocks SQL with wrong idempotency columns, pg_get_functiondef, updated_at on wrong tables
2. **`scripts/validate-frontend.sh`** — Blocks frontend code with direct @sentry/react imports, warns on missing checkMutationResult
3. **ESLint rules** — `no-restricted-globals` blocks `confirm()` and `alert()`, `no-restricted-properties` blocks `window.confirm()` and `window.alert()`, `no-restricted-imports` blocks `@sentry/react`
4. **Build + test** — TypeScript check, production build, all unit tests

### Automated guardrails (hooks + subagents) → [`docs/reference/agent-guardrails.md`](docs/reference/agent-guardrails.md)
You don't have to remember the rules above by hand — **deterministic PreToolUse hooks BLOCK the bad write**: wrong idempotency columns, `updated_at` on a table that lacks it, a status not in the live CHECK constraint, UPDATE on a GENERATED column (e.g. `invoices.balance_cents`), `.env`/`service_role` leaks, a new table with no RLS, `parseFloat` on a `*_cents` value — and `apply_migration` is gated behind a recent reviewer proof-file. Before any migration is applied, five review subagents run in parallel: `rls-security-reviewer`, `migration-drift-reviewer`, `typescript-types-drift-reviewer`, `pdf-output-reviewer`, `compliance-reviewer`. The full table of every hook + subagent and the exact bug each prevents is in [`docs/reference/agent-guardrails.md`](docs/reference/agent-guardrails.md).

### Before Every Commit
1. `npm run lint` — 0 errors (ESLint now blocks confirm/alert/wrong-imports)
2. `npm run build` — clean build
3. `npm run test` — all tests pass
4. Doc counts match reality (see Keeping Docs In Sync above)
5. SQL + frontend validation passes (automatic via pre-commit hook)

---

## Appendix — Karpathy-derived coding guidelines (verbatim)

> Mason asked to include the popular "Karpathy CLAUDE.md" here. Below is the 100k+ star file by **Forrest Chang**
> (`github.com/multica-ai/andrej-karpathy-skills`), distilled from Andrej Karpathy's LLM-coding observations and
> reproduced **verbatim** (including its own `# CLAUDE.md` heading). Provenance: this is a community *derivative* —
> Karpathy did not author it. Where these differ from the CRX-specific "Working Principles" near the top of this
> file, the CRX rules win.

# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

---

### Karpathy's own "NEVER STOP" (verbatim — `github.com/karpathy/autoresearch`, `program.md`)

> This is Andrej Karpathy's *actual* text (Mason asked for it specifically), written as an instruction for an
> autonomous ML-experiment loop — not a coding-agent rule he publishes for general use. **CRX precedence:** it
> governs *task momentum* (don't pause to ask "should I keep going?" mid-task), but it does NOT override the Hard
> Red Lines — pushing, deploying, applying a live migration, deleting data, or committing always require Mason's
> explicit OK in the current chat.

**NEVER STOP**: Once the experiment loop has begun (after the initial setup), do NOT pause to ask the human if you should continue. Do NOT ask "should I keep going?" or "is this a good stopping point?". The human might be asleep, or gone from a computer and expects you to continue working *indefinitely* until you are manually stopped. You are autonomous. If you run out of ideas, think harder — read papers referenced in the code, re-read the in-scope files for new angles, try combining previous near-misses, try more radical architectural changes. The loop runs until the human interrupts you, period.
