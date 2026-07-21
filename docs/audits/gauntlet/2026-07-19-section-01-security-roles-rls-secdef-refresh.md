# CRX Live Foundation Gauntlet - Section 1 Refresh

Section: Security, roles, route gating, RLS, SECURITY DEFINER RPC access  
Run time: 2026-07-19 02:07 CDT  
Mode: Read-only audit of current repo code plus live Supabase database structure only

## Verdict

SOLID-WITH-FOLLOWUPS. I found no production-wide security blocker in this Section 1 refresh. Live RLS coverage and SECURITY DEFINER search paths are clean, route gating still fails closed, and the prior blend-ticket actor-forgery HIGH is fixed in the current repo/live catalog. Two MED follow-ups remain: anonymous execution is still allowed on six SECURITY DEFINER number-generator RPCs, and `save_field` can spoof activity-feed attribution for field edits.

Counts: BLOCKER 0, HIGH 0, MED 2, LOW 0.

## Repo State

Started from `C:\CRX_Manager` at detached HEAD.

Existing uncommitted files, not modified:

- `docs/app-workflow-map.html` was staged and modified at run start (`MM docs/app-workflow-map.html`).

Allowed writes performed by this run:

- `docs/audits/gauntlet/2026-07-19-section-01-security-roles-rls-secdef-refresh.md`
- `docs/audits/gauntlet/live-foundation-gauntlet-index.md`
- `docs/audits/gauntlet/live-foundation-gauntlet-summary.md`

Notes:

- The Supabase CLI linked query path was blocked by local config: `failed to read profile: Unsupported Config Type ""`. Live catalog checks used the connected Supabase SQL tool against project `rhyzpcqhnizqbxphqdkr`.
- Graphify refresh was intentionally skipped because this automation only permits writes under `docs/audits/gauntlet/`; `npm run graph:refresh` writes generated graph artifacts outside that folder.
- No Sentry, Vercel, GitHub PRs, browser sessions, production runtime telemetry, migrations, data mutations, commits, pushes, deploys, or deletes were performed.

## Findings

### MED 1 - Anonymous callers can execute six SECURITY DEFINER number generators

Evidence:

- Live catalog query, 2026-07-19: `next_application_record_number`, `next_commission_payment_number`, `next_cycle_count_number`, `next_delivery_number`, `next_job_number`, and `next_po_number` all had `anon_exec = true`, `authenticated_exec = true`, `mentions_auth_uid = false`, `mentions_is_active = false`, and `raises_exception = false`.
- Live `information_schema.routine_privileges`, 2026-07-19: each of those six routines has `EXECUTE` granted to `PUBLIC`, `anon`, `authenticated`, `postgres`, and `service_role`.
- Source definitions show these functions are `SECURITY DEFINER` and read current sequence-like values from operational tables: `next_delivery_number()` reads `deliveries` in [supabase/migrations/20260211260000_number_generation_sequences.sql](C:/CRX_Manager/supabase/migrations/20260211260000_number_generation_sequences.sql:13), `next_po_number()` reads `purchase_orders` in [supabase/migrations/20260211260000_number_generation_sequences.sql](C:/CRX_Manager/supabase/migrations/20260211260000_number_generation_sequences.sql:54), `next_application_record_number()` reads `application_records` in [supabase/migrations/20260214220000_application_records_table.sql](C:/CRX_Manager/supabase/migrations/20260214220000_application_records_table.sql:97), `next_job_number()` reads `jobs` in [supabase/migrations/20260215200000_job_scheduling_tables.sql](C:/CRX_Manager/supabase/migrations/20260215200000_job_scheduling_tables.sql:220), `next_cycle_count_number()` reads `cycle_counts` in [supabase/migrations/20260223200000_pre_launch_bug_fixes.sql](C:/CRX_Manager/supabase/migrations/20260223200000_pre_launch_bug_fixes.sql:82), and `next_commission_payment_number()` reads `commission_payments` in [supabase/migrations/20260217210000_commission_payments.sql](C:/CRX_Manager/supabase/migrations/20260217210000_commission_payments.sql:73).
- Normal frontend callers are authenticated office/admin workflows, for example `next_cycle_count_number` in [src/pages/CycleCounts.tsx](C:/CRX_Manager/src/pages/CycleCounts.tsx:155), `next_job_number` in [src/pages/JobDetail.tsx](C:/CRX_Manager/src/pages/JobDetail.tsx:1681), and `next_po_number` in [src/pages/NewPurchaseOrder.tsx](C:/CRX_Manager/src/pages/NewPurchaseOrder.tsx:180).

Plain-English business risk:

This does not let an anonymous visitor create orders, POs, jobs, cycle counts, application records, or commission payments. It does let anonymous API callers ask the database for the next operational numbers, which leaks rough business volume and keeps unnecessary SECURITY DEFINER entrypoints exposed to the public internet.

Suggested fix:

Create a new migration that revokes these six functions from `PUBLIC` and `anon`, grants only the roles that actually need them, and adds an explicit active-role gate inside each function or routes number generation through the mutating RPC that creates the record.

Prevention action:

Add a live SQL sweep that fails when a public-schema SECURITY DEFINER function is executable by `anon` unless it is on a short, documented allowlist and has an explicit `auth.uid()` / active-role gate.

### MED 2 - `save_field` can spoof field-save activity attribution

Evidence:

- Live catalog query, 2026-07-19: `save_field(p_field_id uuid, p_field_payload jsonb, p_billing_defaults jsonb, p_performed_by uuid, p_idempotency_key text)` is `SECURITY DEFINER`, executable by `authenticated`, mentions `p_performed_by`, and lacks an `auth.uid()` actor binding or `ACTOR_MISMATCH` / equivalent mismatch guard.
- Source defines the function with `p_performed_by` and only a role gate via `require_admin_or_sales_rep()` in [supabase/migrations/20260320100000_add_idempotency_to_remaining_rpcs.sql](C:/CRX_Manager/supabase/migrations/20260320100000_add_idempotency_to_remaining_rpcs.sql:13) and [supabase/migrations/20260320100000_add_idempotency_to_remaining_rpcs.sql](C:/CRX_Manager/supabase/migrations/20260320100000_add_idempotency_to_remaining_rpcs.sql:30).
- Source writes the supplied `p_performed_by` directly into `activity_feed.performed_by` in [supabase/migrations/20260320100000_add_idempotency_to_remaining_rpcs.sql](C:/CRX_Manager/supabase/migrations/20260320100000_add_idempotency_to_remaining_rpcs.sql:110).
- Normal UI callers pass the signed-in profile id, for example [src/pages/FieldSetup.tsx](C:/CRX_Manager/src/pages/FieldSetup.tsx:561) and [src/components/fields/BulkFieldImport.tsx](C:/CRX_Manager/src/components/fields/BulkFieldImport.tsx:438), but direct RPC callers can submit another active user's UUID.

Plain-English business risk:

An active admin or sales rep can save a field but make the activity timeline say another employee did it. This does not bypass the admin/sales role gate or expose extra rows by itself, but it weakens operational accountability for field and billing-default edits.

Suggested fix:

Rewrite `save_field` with the same strict-actor pattern used by newer RPCs: set `v_actor := auth.uid()`, reject unauthenticated calls, reject `p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor`, and write `v_actor` to `activity_feed.performed_by`.

Prevention action:

Extend the strict-actor SQL sweep to flag every authenticated SECURITY DEFINER mutator that both accepts `p_performed_by` and writes `performed_by`, `created_by`, `actor_user_id`, or similar audit columns without an `auth.uid()` mismatch guard.

## Verified Clean Areas

- RLS coverage: live catalog reports 144 public tables, 144 RLS-enabled tables, 0 RLS-disabled tables, and 0 RLS-enabled tables without policies.
- SECURITY DEFINER search paths: live catalog reports 374 public SECURITY DEFINER functions and 0 missing the required `public` plus `pg_temp` search path components.
- Prior Section 1 HIGH fixed: current source for `link_blend_ticket_to_order` rejects mismatched `p_performed_by` in [supabase/migrations/20260714230200_blend_ticket_order_lifecycle.sql](C:/CRX_Manager/supabase/migrations/20260714230200_blend_ticket_order_lifecycle.sql:27), and `unlink_blend_ticket_from_order` rejects mismatched `p_performed_by` in [supabase/migrations/20260714230200_blend_ticket_order_lifecycle.sql](C:/CRX_Manager/supabase/migrations/20260714230200_blend_ticket_order_lifecycle.sql:988). Live actor sweep no longer reports either function as missing an actor mismatch guard.
- Route gating: [src/components/auth/ProtectedRoute.tsx](C:/CRX_Manager/src/components/auth/ProtectedRoute.tsx:24) redirects without a session, [src/components/auth/ProtectedRoute.tsx](C:/CRX_Manager/src/components/auth/ProtectedRoute.tsx:29) redirects without a profile, [src/components/auth/ProtectedRoute.tsx](C:/CRX_Manager/src/components/auth/ProtectedRoute.tsx:34) blocks inactive users, [src/components/auth/ProtectedRoute.tsx](C:/CRX_Manager/src/components/auth/ProtectedRoute.tsx:38) enforces route roles, and [src/components/auth/ProtectedRoute.tsx](C:/CRX_Manager/src/components/auth/ProtectedRoute.tsx:48) fails closed on unknown protected routes.
- Page-permission prevention remains in source: [src/lib/pagePermissions.test.ts](C:/CRX_Manager/src/lib/pagePermissions.test.ts:228) asserts every protected `App.tsx` route has a `PAGE_PERMISSIONS` entry or explicit exemption.
- Edge Function active-profile helper remains fail-closed in source: [supabase/functions/_shared/auth.ts](C:/CRX_Manager/supabase/functions/_shared/auth.ts:61) checks profile lookup, active state, and allowed roles before returning success.
- Statement batch lead was cut: live `generate_batch_statements` lacks its own top-level role gate, but it calls `get_detailed_statement_data`, whose live body starts with `PERFORM require_admin()` before reading customer statement details. A non-admin caller does not get statement data through this path.

## Next Section

Section 2 is queued next: Money, invoices, payments, AR aging, statements, credits, write-offs, finance charges.
