<!--
MAINTAINER NOTE (block-level HTML comments are stripped before this file enters Claude's context — they cost no tokens).
This file is kept deliberately lean. Guidance followed (Anthropic "Best practices for Claude Code" + "How Claude
remembers your project" + "Effective context engineering"): target a short, every-session-facts-only file; push
sometimes-relevant detail out to docs + skills; prune by asking "would removing this line cause Claude to make a
mistake?"; and DON'T duplicate what a hook/linter already enforces (the deterministic layer is the real boundary —
prose on top of it is advisory noise). Heavy reference content lives in docs/reference/ (sql-canonical-patterns.md,
agent-guardrails.md, coding-guidelines.md); running history in docs/CHANGELOG.md + memory/. AGENTS.md is generated
separately by scripts/regenerate-agents-md.mjs and does not parse this file.
-->
# CLAUDE.md - CRX Manager V1.0

## Project
- **Repo:** https://github.com/masonwells1/CRX_Manager_V1.0
- **Live:** https://croprxsolutions.app
- **Stack:** React 18, TypeScript, Vite, Tailwind CSS, Supabase, Vercel
- **Supabase ID:** rhyzpcqhnizqbxphqdkr
- **Owner:** masonwells1 (beginner — explain things simply)

## Snapshot (2026-06-21)

**Live counts — verify with `node scripts/check-doc-drift.mjs`, don't trust them blind:** 70 pages · 97 tables (+2 views) · 225 callable RPCs (+51 trigger fns) · **501 migrations** on disk · 6 Edge Functions · ~2,005 unit tests + 70 skipped / 94 E2E specs.

- **`main` = production** (croprxsolutions.app). **Auto-push is authorized** (Mason, 2026-06-16): push regular code to `main` once the `/ship` pipeline is green (review clean + tests + the pre-push hook's typecheck/build) — no approval click; Vercel rollback is one click if needed. STILL get Mason's explicit OK before **applying a live migration, deploying an edge function, or deleting data**, and never commit unrelated files.
- **Where history lives now** (so this file stays lean): sprint log → [`docs/CHANGELOG.md`](docs/CHANGELOG.md); detailed per-topic narrative → the `memory/` files (auto-loaded each session); the old multi-month "Current State" block → [`docs/archive/2026-spring/claude-md-session-log-pre-2026-06-15.md`](docs/archive/2026-spring/claude-md-session-log-pre-2026-06-15.md).
- **Open owner items (need Mason, not code):** Stripe pay-now keys (A1) · 10 real vendor bills for the AP-AI accuracy gate (D1) · physical counts to re-base 17 negative-inventory products (H1) · Supabase leaked-password protection toggle (L4) · grower-portal label CSV (0/604 products have REI/PHI/signal_word).
- **Money/AR audits are still "vacuously clean"** (≈0 posted invoices/payments live) → re-run `/foundation-ultra-review` after the first real billing cycle.

## Working Principles

Kept short on purpose: this whole file loads on **every turn**, so bloat makes Claude follow it *less* (Anthropic: "Bloated CLAUDE.md files cause Claude to ignore your actual instructions"). General coding discipline, distilled: **think before coding** (state assumptions; if multiple readings exist, surface them; if a simpler way exists, say so) · **simplicity first** (the minimum code that solves it; nothing speculative) · **surgical changes** (touch only what the task needs; match existing style) · **goal-driven** (turn the task into a check you can run — write/curate the test, then make it pass). Fuller version: [`docs/reference/coding-guidelines.md`](docs/reference/coding-guidelines.md). On top of those, the CRX-specific rules that always apply:

- **Verify, don't assume.** Read the live schema / existing code before writing; if a fact is load-bearing, confirm it (a quick query, `get_advisors`, the actual file) rather than trusting memory or a handoff.
- **Drive to completion; auto-ship code, but gate the rare dangerous actions.** Don't stall on trivial questions or pause to ask "should I keep going?" — keep momentum, and **push regular code to `main` automatically once the pipeline is green** (Mason authorized auto-push 2026-06-16; `/ship`'s review gate + the pre-push hook's typecheck/build must pass first; Vercel rollback is one click). BUT still get Mason's explicit OK before **applying a live migration, deploying an edge function, or deleting data**, and never commit unrelated files — those three can corrupt data or down the live app, so they keep a human stop. **Harness-enforced** (`.claude/settings.json` permissions): reversible work + `git push` are auto-allowed; edge-function deploy `ask`s; force-push / hard-reset / recursive-delete / `.env` writes / `deploy_to_vercel` are hard-denied; live migrations stay gated by `migration-apply-guard`. Don't route around the remaining gates.
- **Lead for Mason.** He has ~0 coding experience: explain in plain English, define jargon, and **recommend a clear next step** instead of listing options.

## How to size the work (effort · verification · hygiene)
- **Match the workflow to the risk.** A trivial single-file change (no SQL, money, RLS, or lifecycle) just needs lint + build + test — do NOT run the full `/ship` multi-agent review on it (that pipeline costs ~15× the tokens; reserve it for changes touching SQL / money / RLS / a lifecycle, or multiple files). Anthropic: most coding is single-agent work.
- **"Done" = ran and proven, not "tests pass."** For DB work, exercise the change against the live schema (a rolled-back smoke run / `plpgsql_check`) before calling it done — a unit suite you wrote yourself can rubber-stamp the same misunderstanding as the bug. For UI, open the page and look.
- **Plan first on real changes.** For multi-file or migration work, write a short plain-English plan (assumptions + the 2–4 files you'll touch) so Mason can catch a wrong direction before code exists.
- **Model & session hygiene.** Opus + high effort for migration / RLS / money / architecture; a faster model is fine for known-pattern pages and fixes (switching models needs `/clear`). `/clear` between unrelated tasks; `/compact` when one task's session gets long; let subagents do the heavy reading so exploration doesn't fill the main context.

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

## Auto-Triggered Skills & Commands

Invoke the matching skill/command automatically when the task fits — don't wait for Mason to type it (he won't). **The big one: route any substantive coding job through `/ship`** (it scaffolds → reviews → fixes → gates) and tell him in one line you're doing so; skip it for trivial one-line tweaks or questions (see "How to size the work"). Mason triggers this in plain English — "build me X", "ship it", "push this", "make it live", "do it" — and the `ship-intent-reminder` UserPromptSubmit hook reinforces the routing, so he never types the command. **"Push" runs the full pipeline but still STOPS for his explicit one-click OK before any prod deploy** — it is never an auto-deploy. Other routing:

**Building** — new page → `/new-page` · new RPC → `/new-rpc` · new migration/table/column/RLS → `/create-migration` (all run *inside* `/ship`).

**Reviews — Mason only needs two phrases; Claude picks the right tool:**
- **"Is everything okay?" / "check it"** (light, fast) → before a commit: `/preflight` · project health (lint/build/test/doc-drift): `/audit` · live production right now: `/spot-check-prod`.
- **"Do a deep review" / "is the foundation solid?"** (thorough, read-only — pick the lens by what's in question; Mason won't name it, choose for him): money / AR / security / financial foundation → `/foundation-ultra-review` · fragility / races / single-points-of-failure → `/architecture-weakness-audit` · "did anything drift / is it still wired right?" → `/map-drift-audit` · workflow logic / page↔RPC / lifecycle wiring → `/review-workflow` · broad everything-at-once → `/whole-codebase-audit`.
- **Independent second opinion** (the Codex gate — migrations / RLS / money / edge-fns) → `/codex-review`.

**Other utilities** — docs drift → `/update-docs` · regen schema registry after an enum/generated-col/table change → `/regen-schema-registry` · plain-English a migration before `apply_migration` → `/explain-migration` · "ready to ship?" → `/deploy-check` · deploy an Edge Function → `/deploy-edge-function` · "where are we" → `/status` · "something's broken in prod" → `/quick-fix`.

**Internal — Mason never types these** (Claude↔Codex collaboration plumbing, invoked by the flows above, kept because they're tested infrastructure): `/codex-gauntlet`, `/codex-cross-review`, `/claude-review`, `/agent-pair-review`, `/agent-health`, `/agent-pr-comment`, `/codex-to-claude-handoff`.

These guide the process to prevent mistakes — they still require Mason's approval before any deploy, migration, or commit.

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
- NEVER create invoices without an order OR blend ticket — must have order_id or blend_ticket_id. (Enforced by **RPC convention, NOT a DB CHECK** — there is no `order_id`-OR-`blend_ticket_id` CHECK on `invoices` (it *does* carry status/type/non-negativity CHECKs — 5 total). **Credit memos are exempt:** `issue_return_credit` inserts a `credit_memo` whose `order_id` may be NULL with no `blend_ticket_id`. Don't add a literal `order_id OR blend_ticket_id` CHECK without excluding `invoice_type='credit_memo'`, or credit memos break.)
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
- **Smoke it against live before calling it done:** run the change through a rolled-back transaction / `plpgsql_check` (see `scripts/smoke/` + `scripts/db-invariant-sweeps/`) — a clean diff and green unit tests do NOT prove an RPC runs. ("Done = ran and proven.")
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

## Edge Functions (6 in `supabase/functions/`, + `_shared/` lib dir)
- **create-user** — Admin-only user creation
- **process-blend-ticket** — OCR via Google Vision AI
- **process-document** — Document processing
- **reset-user-password** — Admin-only password reset
- **send-email** — Resend API, JWT auth, idempotency, PDF attachments
- **setup-blend-tickets-storage** — Storage bucket config

> `seed-admin` (one-time admin seeder) was DELETED from the live project 2026-06-16 — it was the only function deployed with `verify_jwt=false` (a latent unauthenticated admin-mint; nightly-debug PARKED-07). The one-time seed is done (3 active admins exist). Do NOT re-add it.

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
| `docs/reference/rpc-functions.md` | 226 callable RPCs + 51 trigger functions |
| `docs/reference/migration-history.md` | 458 migrations |
| `docs/reference/pages-routes.md` | 68 pages with routes |
| `docs/reference/code-patterns.md` | Number formats, UI patterns, build notes |
| `docs/reference/qa-testing.md` | Role matrix, workflow tests, edge cases |
| `docs/reference/sql-canonical-patterns.md` | Copy-paste templates for migrations/RPCs/mutations |
| `docs/reference/agent-guardrails.md` | Every hook + review subagent and the bug each prevents |
| `docs/reference/coding-guidelines.md` | Fuller general coding discipline (moved out of this file) |
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

---

## Code Drift Prevention

Drift caused 40+ bugs; most rules below are now **enforced automatically** so you don't have to hold them in your head — the deterministic layer is the real boundary.

### Canonical code patterns → [`docs/reference/sql-canonical-patterns.md`](docs/reference/sql-canonical-patterns.md)
**Read that file before writing a migration, RPC, or mutation.** The non-negotiable few, inline so they're never forgotten:
- `idempotency_keys` columns are **`idempotency_key` / `operation` / `result`** (jsonb) — never `key`/`entity_type`/`entity_id`; the lookup MUST filter `AND operation = '<this_rpc_name>'` (an unscoped lookup returns another op's cached row — the `restore_quote_version` bug class).
- Every SECURITY DEFINER fn: `SET search_path = public, pg_temp`. Every mutating RPC: `p_idempotency_key text DEFAULT NULL` **and actually use it** in the body.
- Money is `bigint` cents (never float). After `.update()/.delete()` → `checkMutationResult()`. After an RPC → `assertRpcResult()`. Strict-actor: bind `auth.uid()` and reject a mismatched `p_performed_by` with `ACTOR_MISMATCH`.

### Enforced for you — don't re-memorize → [`docs/reference/agent-guardrails.md`](docs/reference/agent-guardrails.md)
Deterministic PreToolUse hooks **BLOCK the bad write**: wrong idempotency columns, `updated_at` on a table that lacks it, a status outside the live CHECK constraint, an UPDATE on a GENERATED column (e.g. `invoices.balance_cents`), `.env`/`service_role` leaks, a new table with no RLS, `parseFloat` on a `*_cents` value. `apply_migration` is gated behind a recent reviewer proof-file, and five review subagents run before any migration applies (`rls-security-reviewer`, `migration-drift-reviewer`, `typescript-types-drift-reviewer`, `pdf-output-reviewer`, `compliance-reviewer`). ESLint blocks `confirm()`/`alert()`/`window.confirm`/`window.alert`, direct `@sentry/react` imports, and enforces `assertRpcResult`. **The few judgment calls the hooks can't make for you:** before changing a status enum, read the live CHECK so your new list is a superset; read the real table before referencing columns; check for function overloads before `CREATE OR REPLACE`; update `src/types/index.ts` when you add a column.

### Before Every Commit
1. `npm run lint` — 0 errors · 2. `npm run build` — clean · 3. `npm run test` — all pass · 4. Doc counts match reality (see Keeping Docs In Sync) · 5. SQL + frontend validation passes (automatic via pre-commit hook)
