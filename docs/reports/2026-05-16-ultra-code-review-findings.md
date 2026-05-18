# Ultra Code Review Findings - 2026-05-16

Review scope: local source review of CRX Manager V1.0 focused on high-risk production defects, database safety rules, RPC/idempotency contracts, Edge Functions, offline workflows, and documentation drift.

No code changes were made during this review.

## Executive Summary

Automated TypeScript, lint, build, and unit test checks passed. The highest-risk issues found are not compile errors. They are production safety and contract gaps around idempotency, SECURITY DEFINER search paths, offline sync validation, notification RPC signatures, email audit/idempotency durability, and ignored Edge Function write errors.

Recommended fix order:

1. Fix `transfer_job_to_invoice` idempotency before the new migration ships.
2. Patch active `SECURITY DEFINER` functions to use `SET search_path = public, pg_temp`.
3. Fix notification RPC signatures/calls.
4. Harden offline sync result validation.
5. Make `send-email` idempotency durable before sending.
6. Add error checks in `process-blend-ticket`.
7. Clean up the CORS fallback and RPC docs drift.

## Checks Run

- `npm run typecheck`: passed.
- `npm run lint`: passed on rerun.
- `npm run build`: passed with warnings only.
- `npm run test`: passed, 1913 passed, 70 skipped.
- SQL migration audit: scanned 334 files, exited with 61 violations and 57 warnings.

The SQL audit script notes that many old migration violations are expected historical debt. Recent migrations still need attention where called out below.

## Findings

### P1 High - New transfer_job_to_invoice migration bypasses idempotency

Files:

- `supabase/migrations/20260516000000_safe_cents_transfer_job_to_invoice.sql:1`
- `supabase/migrations/20260516000000_safe_cents_transfer_job_to_invoice.sql:42`
- `supabase/migrations/20260516000000_safe_cents_transfer_job_to_invoice.sql:79`

The migration starts with `-- idempotency-body-check: exempt`. The function signature accepts `p_idempotency_key text DEFAULT NULL`, but the body intentionally does not use it. On retry after a network timeout, a successful invoice creation can come back as `Job already invoiced` instead of replaying the original successful result.

Impact: a real invoice may be created, but the user can see a failure on retry and may not know the invoice exists. This also weakens the project rule that every mutating RPC accepts and uses idempotency.

Recommended fix: wire canonical `check_idempotency()` before mutation and `save_idempotency()` after the returned JSON is built. Remove the exemption. Add a verification that repeated calls with the same key return the same invoice result.

### P1 High - Active SECURITY DEFINER functions have incomplete search_path

Files:

- `supabase/migrations/20260228210000_failed_notifications_table.sql:54`
- `supabase/migrations/20260228210000_failed_notifications_table.sql:83`
- `supabase/migrations/20260302200000_business_logic_enhancements.sql:1515`
- `supabase/migrations/20260302200000_business_logic_enhancements.sql:1547`
- `supabase/migrations/20260307200000_pre_launch_hardening.sql:1040`

Several active `SECURITY DEFINER` functions still use `SET search_path = public` instead of `SET search_path = public, pg_temp`.

Confirmed examples:

- `log_failed_notification(...)`
- `retry_failed_notifications()`
- `release_expired_quote_holds()`
- `notify_damaged_receiving(...)`
- `check_remainder_reminders()`

Impact: this violates the repo hard rule and leaves security-definer functions with weaker object-resolution safety.

Recommended fix: create a new migration that redefines each active function with the same body and `SET search_path = public, pg_temp`. Add or expand test coverage so this rule catches all active security-definer functions, not only selected mutating RPCs.

### P1 High - Offline sync can drop failed mutating RPC work

File:

- `src/lib/offlineSync.ts:150`

`executeOfflineAction()` maps queued offline operations to RPC names, calls `supabase.rpc(rpcName, params)`, and only checks `error`.

Impact: if Supabase returns `{ data: null, error: null }` for a mutating RPC contract failure, permission issue, or unexpected silent result, the pending action can be removed as synced. This affects high-risk operations such as delivery completion, payment allocation, receiving, order updates, cancellation, and confirmation.

Recommended fix: capture `{ data, error }`, throw on `error`, and validate returned RPC payloads with `assertRpcResult()` for RPCs that should return data. For true void RPCs, document them in a per-operation metadata map and use `.throwOnError()`. Add a unit test where `{ data: null, error: null }` does not remove the queued action.

### P1 High - Notification RPC calls pass arguments the SQL functions do not accept

Files:

- `src/lib/notificationTriggers.ts:37`
- `src/lib/notificationTriggers.ts:43`
- `src/lib/notificationTriggers.ts:278`
- `src/lib/notificationTriggers.ts:282`
- `supabase/migrations/20260228210000_failed_notifications_table.sql:54`
- `supabase/migrations/20260302200000_business_logic_enhancements.sql:1547`

The frontend calls `log_failed_notification` and `notify_damaged_receiving` with `p_idempotency_key`, but the SQL function signatures do not accept that argument.

Impact: `notifyDamagedReceiving()` is likely to fail at runtime due to a function signature mismatch. Its fallback logging can also fail because `log_failed_notification` receives the same unsupported parameter. That means damaged receiving alerts may not send and may not be recorded in the failure queue.

Recommended fix: preferred fix is a new migration that adds `p_idempotency_key text DEFAULT NULL` to both mutating RPCs and wires canonical idempotency. Alternative fix is removing the extra frontend argument, but that does not satisfy the project rule for mutating RPCs.

### P2 Medium - send-email can send without durable idempotency/audit logging

Files:

- `supabase/functions/send-email/index.ts:268`
- `supabase/functions/send-email/index.ts:324`
- `supabase/functions/send-email/index.ts:343`
- `supabase/functions/send-email/index.ts:366`

The function checks idempotency through `email_log`, sends through Resend, then inserts into `email_log`. If the insert fails, it logs a warning but still returns success.

Impact: a customer email can be sent with no audit record and no saved idempotency key. A retry can send a duplicate email because replay detection depends on `email_log`.

Recommended fix: insert a pending `email_log` row with a unique idempotency key before calling Resend, then update it to sent or failed after the provider call. If the pre-send log insert fails, do not send. Add tests for log insert failure.

### P2 Medium - process-blend-ticket ignores critical write errors

Files:

- `supabase/functions/process-blend-ticket/index.ts:864`
- `supabase/functions/process-blend-ticket/index.ts:874`
- `supabase/functions/process-blend-ticket/index.ts:974`
- `supabase/functions/process-blend-ticket/index.ts:987`
- `supabase/functions/process-blend-ticket/index.ts:1004`
- `supabase/functions/process-blend-ticket/index.ts:1020`
- `supabase/functions/process-blend-ticket/index.ts:1070`
- `supabase/functions/process-blend-ticket/index.ts:1081`
- `supabase/functions/process-blend-ticket/index.ts:1086`
- `supabase/functions/process-blend-ticket/index.ts:1096`

The function performs many service-role updates and inserts without checking returned errors.

Impact: OCR processing can report success even if queue status updates, blend ticket updates, parsed product inserts, or notification inserts failed. This can leave tickets partially processed or queues stuck in the wrong state.

Recommended fix: destructure and check `{ error }` for every critical update/insert. Throw for core ticket and queue writes. Treat notification insert failures as non-critical only if they are explicitly logged to Sentry.

### P3 Low - setup-blend-tickets-storage falls back to production origin

File:

- `supabase/functions/setup-blend-tickets-storage/index.ts:12`

The function returns `https://croprxsolutions.app` when `ALLOWED_ORIGIN` is missing.

Impact: this violates the project rule that production Edge Functions should require `ALLOWED_ORIGIN` and fail loudly when it is missing. It can hide deployment misconfiguration.

Recommended fix: use the same pattern as the hardened Edge Functions: allow localhost only for local Supabase, otherwise throw when `ALLOWED_ORIGIN` is absent. If this function is dead code, remove it and update docs.

### P3 Low - void_vendor_bill docs disagree with current SQL and frontend

Files:

- `docs/reference/rpc-functions.md:169`
- `supabase/migrations/20260510030000_ap_structural_fixes.sql:422`
- `src/pages/VendorBillDetail.tsx:268`

Docs say `void_vendor_bill(...) -> jsonb`, but the latest SQL returns `void` and the frontend correctly uses `.throwOnError()`.

Impact: the app path appears consistent, but the docs can mislead future fixes, tests, or agents into expecting a JSON payload.

Recommended fix: update `docs/reference/rpc-functions.md` to say `void_vendor_bill(...) -> void`, unless the business decision is to change SQL back to returning JSON.

## Notes And Scope Limits

- I did not run the full Playwright E2E suite.
- I did not connect to the live Supabase project or inspect production data.
- Existing uncommitted and untracked files were present before this review and were not changed.

