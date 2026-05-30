# CLAUDE.md - CRX Manager V1.0

## Project
- **Repo:** https://github.com/masonwells1/CRX_Manager_V1.0
- **Live:** https://croprxsolutions.app
- **Stack:** React 18, TypeScript, Vite, Tailwind CSS, Supabase, Vercel
- **Supabase ID:** rhyzpcqhnizqbxphqdkr
- **Owner:** masonwells1 (beginner — explain things simply)

## Current State (2026-05-30)
- 66 pages, **95** tables (+2 views; incl. `rebate_claim_counters`), **218** RPCs, **369 migrations**, 7 Edge Functions (+ `_shared` lib dir)
- **2026-05-30 (review P2 sprint — branch `fix/review-2026-05-30-p2p3`):** P2-H — `20260530194520_save_blend_ticket_canonical_return` aligned `save_blend_ticket`'s return from `{status:'saved'}` to the canonical `{success:true, ticket_id, ticket_number}`. Migration-only (sole caller `BlendTicketDetail.tsx` uses `assertRpcResult` generically — no field read). Body verbatim from live (md5-confirmed); both reviewers clean; live-verified (overload=1).
- **2026-05-30 (review P2 sprint — branch `fix/review-2026-05-30-p2p3`):** P2-3 — `20260530191823_batch_rpc_idempotency` added canonical check-at-top/save-at-end idempotency (via `check_idempotency`/`save_idempotency`) to `batch_apply_all_prepayments` + `batch_void_invoices` (the last two `IDEMPOTENCY_BODY_EXEMPT` `'gap'`s — now removed from the test). **Bundled bugfix (Mason-approved):** `batch_apply_all_prepayments` was silently broken in prod — it inserted `entity_id = NULL` into `financial_audit_log` (NOT NULL) so the "Apply all prepayments" button failed on every click (0 audit rows ever). Fixed to `entity_type='batch'`, `entity_id=v_actor`. A post-apply smoke test caught that an initial `entity_type='system'` violated the `financial_audit_log_entity_type_check`; re-applied with `'batch'` (live-only correction stamp `20260530192441`). Both reviewers clean; live-verified (overloads=1, idempotency wired, rolled-back insert confirms the audit row now succeeds). Deferred follow-up: both batch RPCs still use the permissive `COALESCE(p_performed_by, auth.uid())` actor (attribution-only, gated by `require_admin_or_sales_rep`) — candidate for a strict-actor pass.
- **2026-05-30 (review P2 sprint — branch `fix/review-2026-05-30-p2p3`):** P2-E — `20260530183926_returns_rpc_role_actor_guard` added the canonical auth + strict-actor (`AUTH_REQUIRED`/`ACTOR_MISMATCH`) + `role IN ('admin','sales_rep')` `is_active` gate (copied from `issue_return_credit`) to `approve_return` and `receive_return`, placed BEFORE the idempotency check so cached results never leak to unauthorized callers. Both were SECDEF-but-ungated (relied only on RLS; forgeable `p_approved_by`/`p_received_by`). Bodies reproduced verbatim from live (md5-confirmed body-minus-guard == live). Both reviewers clean; live-verified (overloads=1 each, guard present, service-role call → `AUTH_REQUIRED`).
- **2026-05-30 (review P2 sprint, applied live):** P2-D — `20260530121534_delivery_items_parent_lock_trigger` added a BEFORE INS/UPD/DEL trigger (`enforce_delivery_items_parent_lock`) on `delivery_items` rejecting writes when the parent `deliveries.status IN ('in_progress','completed')`, honoring the canonical `app.admin_override` hatch (`_is_admin_override()`). Closes the direct-PostgREST tamper path on locked-delivery items (UI was already safe via `edit_delivery`). Guard uses `IN ('in_progress','completed')` not literal `<> 'scheduled'` so `update_order_items`' legit DELETE of cancelled/voided delivery_items keeps working; only `complete_delivery` needed the hatch (reproduced verbatim from live — md5-confirmed — with one added `SET LOCAL app.admin_override` line). Both reviewers clean; live-verified (overload=1, trigger attached, rolled-back smoke test: completed write blocked, scheduled write allowed).
- **2026-05-30 (review fix-branch P1 sprint, applied live):** 3 P1 fixes applied via MCP from branch `fix/review-2026-05-29` (cherry-picked to main). (1) `20260530020412_reverse_write_off_strict_actor` — replaced forgeable `COALESCE(p_performed_by, auth.uid())` with the canonical strict-actor block (`AUTH_REQUIRED`/`ACTOR_MISMATCH` + `is_active` admin check); the one mutating-financial RPC missed by the 2026-05-26 sweep (verified forgeable live pre-apply, strict post-apply). (2) `20260530020452_save_job_idempotency` — `save_job` declared `p_idempotency_key` but never used it, so a double-click created two jobs; added canonical check-at-top/save-at-end idempotency. (3) `20260530020514_release_holds_on_quote_cancel` — cancelling a planned quote left its `inventory_holds` active forever; added `'cancelled'` to the release trigger's status sets. Both reviewers clean; all live-verified post-apply (overload counts=1, forgeable→fixed, body uses `idempotency_keys`, trigger includes cancelled). Non-DB in same sprint: unified 10 PDF modules' company address to single-source `src/lib/companyInfo.ts` (**West York, IL**; remit-to PO box left flagged for Mason to confirm — not guessed), hardened `rpcContracts.test.ts` to verify idempotency *body* usage (not just the param), `npm audit fix` cleared 3 prod CVEs (dompurify/ws/protocol-buffers-schema). See `docs/audits/2026-05-29-fix-branch-handoff.md`.
- **2026-05-29 (workflow review + Codex remediation, applied live):** 3 BLOCKER fixes applied via MCP. (1) `20260529214355_revoke_anon_execute_on_report_dashboard_secdef` — REVOKE EXECUTE FROM anon,PUBLIC on **37** SECDEF report/dashboard/geo/financial RPCs that were leaking customer PII/financials to the unauthenticated `anon` key (proven exploitable); re-GRANT to authenticated/service_role. anon-executable SECDEF dropped **89→52** (remaining 52 verified safe). (2) `20260529214538_fix_void_order_void_invoice_status_transitions` — `void_order` was crashing on every call (fulfilled→voided blocked by trigger, no `admin_override`); fixed with the override bracket + draft invoices→cancelled; `void_invoice` draft/unposted→cancelled. (3) `20260529214423_fix_get_customer_transaction_review_running_balance_cast` — fixed SQLSTATE 42804 (numeric→bigint window-sum cast). Both reviewers clean. Codex's 4th "BLOCKER" (`batch_void_invoices` actor-spoof) was **refuted on live** (vulnerable body is disk-only; deployed fn gates on `auth.uid()`). Deferred (documented in `docs/audits/2026-05-29-codex-disposition.md`): defense-in-depth internal role guards on the 37, `batch_void_invoices` disk-drift hardening, restore-RPC fix-or-drop, migration rebuild-fidelity shadow-DB diff.
- Edge Function live versions (verified 2026-05-29 via MCP `list_edge_functions`): `create-user` v20, `send-email` v13, `setup-blend-tickets-storage` v15, `process-blend-ticket` v19, `reset-user-password` v12, `process-document` v13, `seed-admin` v15.
- 1,918 unit tests (130 files, 70 skipped) + 94 E2E spec files, all passing
- Supabase performance advisor: 0 WARN findings (was 97). 72 FK indexes added, 23 permissive-policy overlap groups consolidated, 55 RLS policies rewrote `auth.uid()` as `(SELECT auth.uid())` for once-per-query evaluation.
- 0 ESLint errors, 0 TypeScript errors, CI green
- Pre-commit hook: lint + build + vitest
- All RPC data usage wrapped with `assertRpcResult()` — enforced by ESLint + safety-net test
- All destructive actions use `ConfirmModal` (no bare `confirm()` calls)
- 15+ RPC calls wired with `useIdempotencyKey` for double-submit prevention
- Schema-aware PreToolUse hooks block status-enum mismatches, GENERATED-column writes, missing RLS on new tables, and idempotency-key declarations that never get used
- `inventory_transactions` is fully immutable (UPDATE+DELETE blocked); `prepay_applications` blocks UPDATE only (DELETE allowed for `void_invoice` reversal). Bypass: `SET LOCAL app.bypass_ledger_immutability = 'true'`.
- `payments.order_id` is `ON DELETE RESTRICT` — orders with payments cannot be deleted (payments must be voided first; orders are cancelled/voided via state transitions anyway, never DELETEd).
- `parseDollarsToCents` is positive-only by default (strips sign). Use `parseDollarsToCentsSigned` for vendor-bill adjustment fields that legitimately accept negatives (3 callsites only).
- Audit fix sprint 2026-05-09 complete on `fix/audit-2026-05-09`. All Phase 1/2/3 + Decision-B + audit items closed. See `docs/audits/2026-05-13-pr59-codex-review-summary.md` for full disposition.
- **2026-05-13 codex review of PR #59 — all P1s closed, 11/13 P2s closed.** 10 follow-up migrations + 1 frontend refactor + 1 strict-actor hotfix landed; all applied live via Supabase MCP. The 4 changed Edge Functions (`create-user`, `reset-user-password`, `seed-admin`, `setup-blend-tickets-storage`) deployed to live via MCP with the `_shared/sentry.ts` audit #28 hardening.
- **2026-05-16:** `send-email` Edge Function deployed to v11 (PR-03 `farm_name` fix + WAL-pattern durable idempotency from ultra-review P2 #5); `setup-blend-tickets-storage` deployed to v14 (CORS hardening, ultra-review P3 #7). 3 new migrations: #335 (transfer_job_to_invoice canonical idempotency), #336 (notification RPCs idempotency), #337 (email_log.status += 'pending'). Ultra-review (`docs/reports/2026-05-16-ultra-code-review-findings.md`) — all 8 findings disposed: 7 fixed live, 1 (P2 #6 process-blend-ticket error checks) code committed but deploy pending. P1 #2 verified false positive. All 20 PR #59 codex threads now resolved. PR #60 advisory comment + follow-up posted: live state confirmed safe (drops were no-op or affected only Storage API list/download, not public-URL rendering).
- **2026-05-16 (PM):** All Edge Functions now deployed live — `process-blend-ticket` v17 deployed via MCP (47KB inline worked fine after using node-via-bash to JSON-encode the file content + reading it back through Read). All 10 ultra-review P2 #6 error checks verified in deployed bundle.
- **2026-05-26:** Full-codebase ultra review execution migration added (`20260526090000`): revokes anon/public write-oriented SECURITY DEFINER RPC execution, hardens `apply_write_off`/`issue_return_credit`/`void_order` actor checks, restores server-side commission split validation + reconciled rounding, consolidates `next_invoice_number`, adds idempotency to duplicate quote/follow-up delivery/finance charge generation, allows voiding unposted commission payments, and adds a DB signature guard for completed deliveries. Frontend/Edge fixes cover CSV formula injection, CustomerDetail RPC assertions, commission-payment void UI, offline complete-delivery idempotency reset, `reset-user-password` fail-loud CORS, and `create-user` phone-update error capture. **Applied live and verified 2026-05-29** via live SQL (apply_write_off has strict-actor guard, anon EXECUTE revoked on financial RPCs).
- **2026-05-27 (dummy-proofing wave 2):** Added 3 more hooks + activated 3 existing-but-unused plugins. New hooks: `migration-apply-guard.mjs` PreToolUse refuses Supabase `apply_migration` calls without a `.claude/session-state/migration-review-<name>.json` proof file from a recent (<30 min) subagent review; `session-staleness.mjs` SessionStart warns on stale schema-registry / CLAUDE.md count drift / uncommitted files from prior session; `stop-wrap.mjs` Stop hook blocks session end with loose-ends list (uncommitted files, unapplied migrations, undeployed Edge Functions, learning-capture prompt). `bash-safety.mjs` extended with 7 more patterns (`supabase db reset`, `dropdb`/`createdb`, force-delete main/master, `git push --mirror`, `git filter-branch`, broad `rm -rf /`, suspicious `npm run reset`). `/preflight` now also dispatches `pr-review-toolkit:code-reviewer` + `silent-failure-hunter` on TS changes and `type-design-analyzer` on new types in `src/types/index.ts`. CLAUDE.md skill table now wires PostHog session replay to "customer reported X" phrasing, `engineering:debug`/`incident-response`/`deploy-checklist`/`tech-debt` to natural triggers, and `feature-dev:code-explorer`/`code-architect` to architecture questions. **Updated totals: 8 PreToolUse hooks targeting code edits, 1 PreToolUse hook on MCP tools, 1 PreToolUse hook on Bash, 2 PostToolUse hooks, 1 UserPromptSubmit hook, 2 SessionStart hooks, 2 Stop hooks, 11 project skills, 4 project subagents + ~10 plugin agents now wired into preflight.**
- **2026-05-27 (dummy-proofing wave 1):** Claude Code automation expansion — added 4 subagents (`rls-security-reviewer`, `migration-drift-reviewer`, `typescript-types-drift-reviewer`, `pdf-output-reviewer`), 5 skills (`/deploy-edge-function`, `/codex-cross-review`, `/explain-migration`, `/spot-check-prod`, `/regen-schema-registry`), and 3 hooks (`env-guard.mjs` PreToolUse blocks `.env` edits + service_role literals in `src/`; `eslint-autofix.mjs` PostToolUse runs `eslint --fix` on TS edits; `dangerous-phrase-warning.mjs` UserPromptSubmit injects safety context on risky phrasing). Vercel plugin enabled. `/preflight` rewritten to auto-dispatch the 4 reviewer subagents based on what changed; `posttooluse-migration.mjs` extended to force subagent dispatch before suggesting `apply_migration`. The four subagents + UserPromptSubmit hook directly target the B7/B8/B9 + March-2026-40-bug + service_role-leak + customer-facing-PDF failure classes.
- **2026-05-26 (post-Codex audit, applied live):** Codex performed a post-apply review of commits `fce0629` + `a824952` and surfaced three blockers (B7/B8/B9) the parallel session missed. **B7** — Supabase MCP `apply_migration` stamped the live version `20260526151856` rather than the disk filename `20260526090000`; disk file renamed to match live to prevent future re-apply attempts (and the new B9 migration similarly renamed from `20260526170000` to its MCP-assigned `20260526201319`). **B8** — frontend Set-Password UI (`SettingsPage.tsx:393`) routes through `create-user?action=reset_password`, not `reset-user-password`, so the EDGE-2 `entity_recipient` block was dead code. Added the same guard to `create-user`'s reset branch, redeployed as **v20 ACTIVE**. **B9** — 6 SECURITY DEFINER DML helpers (`check_idempotency`, `check_rate_limit`, `check_remainder_reminders`, `cleanup_rate_limits`, `log_failed_notification`, `notify_damaged_receiving`) were still anon-EXECUTE-able. New migration `20260526201319_revoke_anon_on_secdef_dml_helpers.sql` revokes from `anon`/`authenticated`/`PUBLIC` and keeps `service_role`; legitimate SECDEF wrappers + pg_cron still call them as `postgres` owner. See `docs/audits/2026-05-26-claude-disposition-of-codex-execution.md §11`.
- **2026-05-26 (parallel audit additions to migration `20260526151856`):** Three new blockers folded into the same migration after parallel-session reconciliation (`docs/audits/2026-05-26-claude-disposition-of-codex-execution.md §10`): **B4** explicit `REVOKE EXECUTE … FROM anon` on `execute_sql_readonly(text)` (SECURITY DEFINER + arbitrary SELECT was an anon RLS-bypass; regex prefix `execute_` missed); **B5** same on `unapply_credit_memo(uuid,text,uuid,text)` (RLS-1 actor-forgery anti-pattern; regex prefix `unapply_` missed); **B6** `CREATE SEQUENCE IF NOT EXISTS public.cm_invoice_number_seq` (the historical migration creating it on disk was never applied live; verified via MCP `list_migrations`). Without B6, `next_invoice_number('credit_memo')` would have crashed on first credit-memo issuance. **C1** also folded — REVOKE regex extended with `auto|retry|revert` prefixes to sweep `auto_expire_quotes`, `retry_failed_notifications`, `revert_quote_status`. Verification `DO $$` block gained 3 assertions (sequence exists, B4/B5 anon revoke). **Applied live and verified 2026-05-29** (89 anon-executable SECDEF functions remain, all read-only — zero anon-callable mutators; cm_invoice_number_seq exists).
- **Pending Mason:** Phase 4 backup verification (Supabase dashboard — not exposed via MCP); Phase 4 restore drill (half-day operational exercise). _(#38 abandoned-package swap closed 2026-05-16: shapefile@0.6.6 → shpjs@6.2.0 + @mapbox/togeojson → @tmcw/togeojson@7.1.2 — see `src/lib/fieldImportParser.ts:1-17`.)_
- **Deferred (follow-up sprint):**
  - Customer RLS upper bound (P2 #3) — intentionally left as lower-bound-only; farm logistics require future visibility for route/job planning.
  - Entity commission recipients — **RESOLVED 2026-05-16** (Option 1, migration `20260516090000`): non-loginable service profile rows with role `entity_recipient` created for CMCTW LLC + Crop Rx Solutions. 18 CMCTW commissions ($72,174.90) now payable; verified live 2026-05-25 (2 entity profiles, 18 linked commissions, only 1 NULL recipient which is a cancelled $0 row).

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

## Auto-Triggered Skills & Commands (MANDATORY)

Claude MUST automatically invoke the matching skill/command when the task matches — do NOT wait for the user to type the slash command. These exist in `.claude/skills/` and `.claude/commands/` and travel with the repo.

### Skills (multi-step guided workflows)
| When the task involves... | Auto-invoke |
|---------------------------|-------------|
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
- NEVER create invoices without an order OR blend ticket — must have order_id or blend_ticket_id
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

### Quote: `draft → sent → revised → accepted → declined → expired → cancelled`
- `is_planned` reserves inventory via holds (linked via `source_id`)
- Accepted quotes convert via `convert_quote_to_order()` — holds released
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
### Return: `requested → approved → received → credited → rejected → cancelled`
### Commission Payment: `unposted → posted → voided`

### Tier Pricing
- Customers: tier 1, 2, or 3. Products: tier1/2/3_price. Quotes inherit tier.

### Inventory
- **Net Free** = available − planned holds − prebooked
- **On Order** = sum(ordered − received) from open POs
- **Transaction types:** received, booked, delivered, returned, adjusted, transferred, job_applied, cancelled_delivery_reversal, void_delivery_reversal, prebooked, released

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
| `docs/reference/database-schema.md` | 95 tables + RLS matrix |
| `docs/reference/rpc-functions.md` | 218 RPCs + triggers |
| `docs/reference/migration-history.md` | 365 migrations |
| `docs/reference/pages-routes.md` | 66 pages with routes |
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

### ⚠️ COPY-PASTE CHECKLIST — Read Before Writing ANY Code ⚠️

**Before writing a SQL function that touches `idempotency_keys`:**
```sql
-- CORRECT pattern — copy this exactly:
IF p_idempotency_key IS NOT NULL THEN
  SELECT result INTO v_existing
    FROM idempotency_keys
    WHERE idempotency_key = p_idempotency_key;   -- NOT "key"
  IF v_existing IS NOT NULL THEN RETURN v_existing::uuid; END IF;
END IF;

-- At end of function:
INSERT INTO idempotency_keys (idempotency_key, operation, result)  -- NOT key/entity_type/entity_id
VALUES (p_idempotency_key, 'operation_name', v_id::text);
```

**Before writing a SECURITY DEFINER function:**
```sql
SECURITY DEFINER
SET search_path = public, pg_temp   -- ALWAYS include pg_temp
```

**Before writing a supabase `.update()` or `.delete()`:**
```typescript
const result = await supabase.from('table').update({ col: val }).eq('id', id).select();
checkMutationResult(result, 'Context description');  // ALWAYS — import from lib/db
```

**Before writing a confirmation dialog:**
```typescript
// NEVER: confirm(), window.confirm(), alert(), window.alert()
// ALWAYS: ConfirmModal component — see existing usage in any page
```

**Before writing `logActivity()`:**
```typescript
// Uses object parameter — NOT positional args
// performedBy is ALWAYS profile.id — never a string like 'delivery'
await logActivity({ event: 'event_type', description: 'Description', performedBy: profile.id, entityType: 'entity_type', entityId: entityId });
```

**Before importing Sentry:**
```typescript
// NEVER: import * as Sentry from '@sentry/react'
// ALWAYS: import { Sentry } from '../lib/sentry'
```

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

### Canonical Patterns for New RPCs (MANDATORY going forward)

These patterns avoid the drift the 2026-05-07 final-wave-review surfaced (3 coexisting error-shape conventions, 2 idempotency patterns, fragile substring-matching of error tokens).

**Error tokens (machine-readable):**
- SQL raises `'TOKEN'` or `'TOKEN: human readable suffix'` — short SCREAMING_SNAKE codes, never freeform English-only messages.
- Register every new token in the `RpcErrorCodes` const in [src/lib/db.ts](src/lib/db.ts). The `as const` + `RpcErrorCode` indexed-access type makes typos at callsites a compile error.
- TS callers detect with `hasRpcCode(err, RpcErrorCodes.X)` — NEVER `message.includes('TOKEN')` (substring matching false-positives if the token text appears in a user-supplied note).

**Idempotency (helper-function pattern preferred):**
```sql
-- At top of body, BEFORE any mutation:
IF p_idempotency_key IS NOT NULL THEN
  v_existing := check_idempotency(p_idempotency_key, 'my_rpc_name');
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
END IF;

-- ... do the mutation ...

-- At end:
IF p_idempotency_key IS NOT NULL THEN
  PERFORM save_idempotency(p_idempotency_key, 'my_rpc_name', v_result);
END IF;
```
The `check_idempotency` / `save_idempotency` helpers (defined in `20260210000000_tier3_idempotency_and_triggers.sql`, both have `search_path = public, pg_temp`) are the canonical pattern. Inline raw-SQL idempotency lookups still exist in some 2026-05-07 migrations (`create_inventory_hold`, `mark_inventory_row_verified`) — those are NOT precedent for new code. When using helpers, add the file-level marker comment `-- idempotency-body-check: exempt` at the top so the schema-aware hook doesn't trip on the indirection.

**Strict-actor pattern (until shared helper exists):**
```sql
v_actor := auth.uid();
IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
  RAISE EXCEPTION 'ACTOR_MISMATCH';
END IF;
```
Use `IS DISTINCT FROM` (handles NULL safely) and the machine-readable codes above. Two spellings of this block currently coexist in the codebase; this one is the canonical going-forward shape.

**Return shape (mutating RPCs):**
- Mutating RPCs SHOULD return `jsonb_build_object('success', true, ...payload)`.
- Idempotent no-op RPCs (e.g. "already verified") return `'success', true, 'no_op', true, 'reason', 'why'` so the UI can differentiate "did the work" from "didn't need to."
- TS callers MUST wrap result data with `assertRpcResult<T>(data, 'rpc_name')` (enforced by `local-rules/require-assert-rpc-result` ESLint rule).

### Automated Enforcement (Pre-Commit Hook)
The pre-commit hook runs these checks automatically — code that violates them CANNOT be committed:

1. **`scripts/validate-sql.sh`** — Blocks SQL with wrong idempotency columns, pg_get_functiondef, updated_at on wrong tables
2. **`scripts/validate-frontend.sh`** — Blocks frontend code with direct @sentry/react imports, warns on missing checkMutationResult
3. **ESLint rules** — `no-restricted-globals` blocks `confirm()` and `alert()`, `no-restricted-properties` blocks `window.confirm()` and `window.alert()`, `no-restricted-imports` blocks `@sentry/react`
4. **Build + test** — TypeScript check, production build, all unit tests

### Schema-Aware PreToolUse Hooks (`.claude/hooks/`)
These run when Claude Code tries to Write or Edit a file — they refuse the write if it violates a known bug pattern. They read `.claude/schema-registry.json` (regenerate via `node scripts/regenerate-schema-registry.mjs`).

| Hook | What it blocks | Bug it prevents |
|------|----------------|-----------------|
| `sql-safety.mjs` | `pg_get_functiondef`, wrong idempotency columns, `updated_at` on tables that lack it | March 2026 40-bug incident |
| `money-safety.mjs` | `parseFloat()` on `*_cents` variables | Float rounding in money math |
| `idempotency-body-check.mjs` | RPC declares `p_idempotency_key` but body doesn't read/write `idempotency_keys` | `9b36cd2` — `issue_return_credit` regression |
| `rls-on-new-tables.mjs` | New table without `ENABLE ROW LEVEL SECURITY` + `CREATE POLICY` | Prevents future RLS regressions |
| `status-enum-check.mjs` | Writing a status string that isn't in the DB CHECK constraint | `4a25aea` — `'void'` vs `'voided'` |
| `generated-column-check.mjs` | UPDATE on a GENERATED column (e.g. `invoices.balance_cents`) | `a419da8` — `reverse_write_off` |
| `env-guard.mjs` | Any write/edit of `.env*` files; hard-coded JWT-shaped literals or `service_role` references in `src/` | Service-role-key leakage into frontend / transcripts |
| `migration-apply-guard.mjs` | Supabase MCP `apply_migration` calls — refused unless `.claude/session-state/migration-review-<name>.json` proof exists from a recent (<30 min) `rls-security-reviewer` + `migration-drift-reviewer` run | B7/B8/B9 class — applying migrations without parallel-session review |

### UserPromptSubmit Hooks (`.claude/hooks/`)
These run when Mason submits a prompt, BEFORE Claude reads it. They inject extra context via `additionalContext` — they don't block — so Mason's intent is preserved while Claude is forced to slow down on risky wording.

| Hook | What it warns on | Why |
|------|------------------|-----|
| `dangerous-phrase-warning.mjs` | "drop/delete migration", "drop/truncate table", "force push", "no-verify", "service_role in frontend", "disable RLS", "rebase published", "auto-commit/push/deploy", "bypass check_period_open", "edit financial_audit_log" | Forces Claude to explain consequences + offer safer alternative + get explicit confirmation before acting on phrasing that has caused incidents |

### SessionStart Hooks (`.claude/hooks/`)
Run when a new session begins. Inject `additionalContext` so Claude sees state-drift warnings up front.

| Hook | What it surfaces |
|------|------------------|
| `session-snapshot.mjs` | Git porcelain snapshot (so Stop hook can tell session-scoped changes from prior WIP) |
| `session-staleness.mjs` | Schema registry >7 days old, CLAUDE.md count drift vs reality, uncommitted files from a prior session |

### Stop Hooks (`.claude/hooks/`)
Run when a session ends. Block until Claude addresses loose ends.

| Hook | What it surfaces |
|------|------------------|
| `stop-verify.mjs` | Code files changed this session — forces `npm run build` + `npm run test` before declaring done |
| `stop-wrap.mjs` | Uncommitted files, written-but-unapplied migrations, edited-but-undeployed Edge Functions, learning-capture prompt on substantive sessions |

### PostToolUse Hooks (`.claude/hooks/`)
These run AFTER a successful Write/Edit. They can't block (file is already written) but they surface issues back to Claude immediately.

| Hook | What it does | Why |
|------|--------------|-----|
| `posttooluse-migration.mjs` | Reminds Claude to update migration-history.md + regenerate schema registry after a migration edit | Prevents doc drift |
| `eslint-autofix.mjs` | Runs `npx eslint --fix` on edited `.ts`/`.tsx` files in `src/` (skips tests, migrations, edge functions) | Catches import-order/local-rules/lint issues at edit time instead of at pre-commit |

### Subagents (`.claude/agents/`)
Specialized reviewers invoked via the `Agent` tool. They run in their own context window and return only a summary — perfect for parallel review without polluting the main session.

| Agent | When to invoke | Bug class it prevents |
|-------|----------------|-----------------------|
| `rls-security-reviewer` | After writing any migration, BEFORE `apply_migration` | B7/B8/B9 (2026-05-26) — anon-EXECUTE-able SECDEF DML, missing `search_path`, missing RLS on new tables, actor-forgery anti-pattern |
| `migration-drift-reviewer` | After writing any migration that touches an existing table/function | March 2026 (40-bug incident) — CHECK-constraint regression, function-overload collision, column-name drift |
| `typescript-types-drift-reviewer` | After applying any migration that adds/changes columns; or sprint-cadence health check | Silent type drift between `src/types/index.ts` and live DB schema (code "works" until a real query hits a missing field) |
| `pdf-output-reviewer` | After editing any file under `src/` that imports `jspdf` / `jspdf-autotable` | Off-brand colors, page overflow, missing image assets, undivided cents in customer-facing PDFs (tank labels, invoices, statements) |

**Rule:** Dispatch both subagents in parallel via a single message with two `Agent` tool calls. They are independent — running them sequentially is wasted time.

To exempt a specific file from a PreToolUse hook, add the marker comment named in the hook's error message.

**Full audit (manual):** `scripts/validate-sql-migrations.sh` — scans ALL migration files. Run with `--idempotency-only` for focused check.

**Refresh schema registry after schema changes:** `node scripts/regenerate-schema-registry.mjs` (or ask Claude Code to do it via Supabase MCP).

**Refresh AGENTS.md after CLAUDE.md changes:** `node scripts/regenerate-agents-md.mjs`.

**Refresh architecture map:** `npm run generate-map` (or `node scripts/generate-workflow-map.mjs`). Auto-runs in pre-commit hook and stages `docs/app-workflow-map.html` automatically.

### Before Every Commit
1. `npm run lint` — 0 errors (ESLint now blocks confirm/alert/wrong-imports)
2. `npm run build` — clean build
3. `npm run test` — all tests pass
4. Doc counts match reality (see Documentation Maintenance above)
5. SQL + frontend validation passes (automatic via pre-commit hook)
