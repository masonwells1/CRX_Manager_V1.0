# CLAUDE.md - CRX Manager V1.0

## Project
- **Repo:** https://github.com/masonwells1/CRX_Manager_V1.0
- **Live:** https://croprxsolutions.app
- **Stack:** React 18, TypeScript, Vite, Tailwind CSS, Supabase, Vercel
- **Supabase ID:** rhyzpcqhnizqbxphqdkr
- **Owner:** masonwells1 (beginner — explain things simply)

## Current State (2026-05-13, end of day)
- 66 pages, 93 tables (incl. `rebate_claim_counters`), ~184 RPCs, **333 migrations**, 7 Edge Functions
- 1,913 unit tests (130 files, 70 skipped) + 94 E2E spec files, all passing
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
- Audit fix sprint 2026-05-09 complete on `fix/audit-2026-05-09`. All Phase 1/2/3 + Decision-B + audit items closed. See `docs/audits/2026-05-13-execution-summary.md` for full disposition.
- **2026-05-13 codex review of PR #59 — all P1s closed, 11/13 P2s closed.** 10 follow-up migrations + 1 frontend refactor + 1 strict-actor hotfix landed; all applied live via Supabase MCP. The 4 changed Edge Functions (`create-user`, `reset-user-password`, `seed-admin`, `setup-blend-tickets-storage`) deployed to live via MCP with the `_shared/sentry.ts` audit #28 hardening.
- **Pending Mason:** Phase 4 backup verification (dashboard check + future restore drill); #38 abandoned-package swap (needs `.shp`/`.dbf`/`.prj`/`.kml` test fixtures from Mason); resolve the ~17 already-fixed Codex threads in the GitHub PR UI (Codex doesn't auto-resolve).
- **Deferred (follow-up sprint):**
  - 3 known `(*_cents * qty)::bigint` instances in `transfer_job_to_invoice`, `create_invoice_from_blend_ticket`, `save_field_app_invoice` — single-instance each, smaller blast radius — to be wrapped with `safe_cents_qty()`.
  - Customer RLS upper bound (P2 #3) — intentionally left as lower-bound-only; farm logistics require future visibility for route/job planning.
  - Entity commission recipients (CMCTW LLC, Crop Rx Solutions) — `recipient_user_id` stays NULL because no profile row exists. Need design call on entity-recipient payment flow.

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

For the full source (Auto-Triggered Skills, Hard Red Lines, Migration Safety Rules,
Business Logic Lifecycles, Schema Gotchas, Code Drift Prevention, etc.), the rest of
this file is unchanged from prior version. Only the **Current State** section above
was updated to reflect end-of-day 2026-05-13 reality. See git history for prior versions
if the legacy sections need consultation.

*This abbreviated version was pushed via GitHub MCP due to git proxy issues; the full
445-line CLAUDE.md is preserved in local commit f796bee and will land when proxy clears.*
