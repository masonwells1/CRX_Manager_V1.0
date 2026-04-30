# Production Operations Audit Findings

Date: 2026-04-30

Scope: deployment configuration, CI checks, Edge Functions, scheduled operations, monitoring hooks, recovery/runbook coverage, and privileged production controls.

This was a repo-based audit. I did not query live Supabase, Vercel, Sentry, or production logs in this pass.

## Executive Summary

The app has several good production controls already: Vercel security headers, CI with lint/typecheck/unit/build/smoke tests, Sentry client setup, request correlation IDs, local pre-commit safety hooks, and a production-disabled `seed-admin` function.

The biggest operations risks are:

1. `send-email` is a generic privileged mail sender that accepts arbitrary recipients, subjects, HTML, and attachments from broad roles.
2. `process-blend-ticket` uses a service-role client and only checks broad role, not whether the caller is allowed to process that exact ticket.
3. Some recurring operations run only when the Dashboard page is opened, not from a reliable production scheduler.
4. Reconciliation checks exist, but there is no production runner, report, or alert path wired to them.
5. SQL safety validators exist locally, but the GitHub CI workflow does not run them.
6. I found no repo runbook for backups, restore drills, incident response, or month-end production operations.

## Positive Controls Found

- `vercel.json` defines security headers including CSP, frame denial, HSTS, nosniff, referrer policy, and permissions policy in `vercel.json:1-19`.
- GitHub CI runs dependency audit, lint, TypeScript, unit tests, and build in `.github/workflows/ci.yml:39-59`.
- GitHub CI runs E2E smoke tests on push to main in `.github/workflows/ci.yml:61-103`.
- Local pre-commit runs SQL validation, frontend validation, lint, build, and unit tests in `.husky/pre-commit:3-58`.
- Local pre-push runs typecheck and build in `.husky/pre-push:4-28`.
- `seed-admin` blocks production use and requires a secret header in `supabase/functions/seed-admin/index.ts:26-44`.
- Sentry initializes only when a DSN is configured and production mode is enabled in `src/lib/sentry.ts:4-16`.
- The app sets Sentry user/role breadcrumbs and has request IDs for Supabase calls in `src/lib/db.ts:27-45`.
- The browser Supabase client uses only `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in `src/lib/db.ts:5-14`; a repo search found no service-role key use in `src/`.

## Findings

### P1-1: `send-email` is a broad privileged mail sender

Business risk: any authenticated admin, sales rep, or driver can call the function with arbitrary `to`, `subject`, `html`, `email_type`, and attachments. That creates risk of customer mis-sends, spam, spoofed operational messages, attachment abuse, and accidental exposure of sensitive account information.

Evidence:

- The function validates JWT, then allows `admin`, `sales_rep`, or `driver` in `supabase/functions/send-email/index.ts:33-61`.
- It accepts caller-provided `to`, `subject`, `html`, `email_type`, `customer_id`, `idempotency_key`, and `attachments` in `supabase/functions/send-email/index.ts:63-76`.
- It sends the caller-provided `html` and `subject` to Resend in `supabase/functions/send-email/index.ts:104-128`.
- It stores full `html_body` in `email_log` in `supabase/functions/send-email/index.ts:135-150`.

Recommended fix:

- Replace arbitrary HTML sending with server-side templates keyed by `email_type`.
- Require per-resource authorization: for example, a driver can send a delivery receipt only for a delivery assigned to that driver.
- Add attachment count/size/type limits.
- Consider storing a rendered summary/template data instead of full HTML body, or add retention rules.
- Add rate limits by user, customer, email type, and day.

### P1-2: `process-blend-ticket` uses service-role access with only broad role authorization

Business risk: a user with the `applicator` role can trigger OCR processing for any blend ticket id if they know or obtain the id. Because the function uses a service-role client after the role check, normal row-level access rules are bypassed.

Evidence:

- The function authenticates the caller in `supabase/functions/process-blend-ticket/index.ts:776-788`.
- It allows `admin`, `sales_rep`, or `applicator` by role only in `supabase/functions/process-blend-ticket/index.ts:790-802`.
- It parses only `blend_ticket_id` from the request body in `supabase/functions/process-blend-ticket/index.ts:804-811`.
- It then uses the service-role client to update the blend ticket and read ticket images in `supabase/functions/process-blend-ticket/index.ts:837-847`.

Recommended fix:

- Before using the service-role client for the ticket, verify the caller is allowed to process that exact ticket.
- For applicators, require assignment through the linked job/application record or another explicit permission path.
- Add idempotency/rate limiting per ticket and caller.
- Add audit log entries for who triggered processing and from what role.

### P2-1: Some recurring operations depend on Dashboard page visits

Business risk: holds, reminders, and escalations may not run if nobody opens the Dashboard. Operational work should not depend on a human loading a page.

Evidence:

- `Dashboard.tsx` calls `check_remainder_reminders()` and `release_expired_quote_holds()` as side effects after dashboard data loads in `src/pages/Dashboard.tsx:344-367`.
- `check_remainder_reminders()` is designed to find 7-day reminders and 14-day escalations in `supabase/migrations/20260307200000_pre_launch_hardening.sql:1040-1129`.
- `release_expired_quote_holds()` is explicitly described as something to call periodically in `supabase/migrations/20260302200000_business_logic_enhancements.sql:1510-1537`.
- Overdue invoice marking does have a real pg_cron schedule in `supabase/migrations/20260316121800_drop_stale_confirm_delivery_and_setup_cron.sql:17-22`, but I found no equivalent schedule for the Dashboard-triggered jobs.

Recommended fix:

- Move recurring operations to a real scheduler: Supabase cron, Vercel cron, or a small protected Edge Function called by a scheduler.
- Keep the Dashboard call only as a manual/fallback button or status display.
- Log each scheduled run with result counts and errors.

### P2-2: Reconciliation checks exist but are not wired into production operations

Business risk: order total drift, inventory ledger drift, and invoice balance drift can exist until a person notices a report looks wrong. The code has a useful reconciliation engine, but it does not appear to run on a schedule or alert anyone.

Evidence:

- `runReconciliationChecks()` is documented as running all checks against the live database in `src/lib/reconciliation.ts:609-614`.
- It checks order totals against line items in `src/lib/reconciliation.ts:617-641`.
- It checks inventory quantities against transaction history in `src/lib/reconciliation.ts:652-681`.
- It checks invoice payments and invoice balance formulas in `src/lib/reconciliation.ts:692-728`.
- A repo search found no production call to `runReconciliationChecks()` outside the function definition and tests.

Recommended fix:

- Add an admin-only "Integrity Report" page or scheduled report that runs reconciliation and stores results.
- Alert admins in-app and in Sentry when discrepancies are found.
- Add a daily or weekly scheduled run after business hours.

### P2-3: SQL migration validators exist but are not enforced in GitHub CI

Business risk: migration safety rules are enforced locally by hooks, but CI does not run the SQL validators. If hooks are bypassed, not installed, or run on a different machine, dangerous migration patterns can still reach a pull request.

Evidence:

- `scripts/validate-sql-migrations.sh` is a full migration audit and scans every migration file in `scripts/validate-sql-migrations.sh:1-14` and `scripts/validate-sql-migrations.sh:63-80`.
- `scripts/validate-sql.sh` checks staged migrations for known production bug patterns in `scripts/validate-sql.sh:1-13` and `scripts/validate-sql.sh:54-80`.
- `.husky/pre-commit` runs the SQL and frontend validators locally in `.husky/pre-commit:3-23`.
- GitHub CI runs dependency audit, lint, typecheck, tests, and build, but does not call the SQL validator scripts in `.github/workflows/ci.yml:39-59`.

Recommended fix:

- Add `bash scripts/validate-sql-migrations.sh` to CI.
- Add `bash scripts/validate-frontend.sh` to CI if it is stable enough for all files or provide a CI mode.
- Keep hooks as a convenience, but treat CI as the final gate.

### P2-4: Finance charges are manual-only and need an operations control

Business risk: finance charges are important money events. They probably should not run automatically without review, but they do need a documented monthly process so they are not forgotten or run inconsistently.

Evidence:

- `generate_finance_charges()` checks the accounting period and creates charge invoices in `supabase/migrations/20260333900000_mega_audit_phase1_fixes.sql:587-723`.
- The UI modal previews and lets a user generate selected/all finance charges in `src/components/invoices/FinanceChargePreviewModal.tsx:1-8` and `src/components/invoices/FinanceChargePreviewModal.tsx:99-142`.
- I found a cron schedule for overdue invoice marking, but no schedule or runbook reference for finance-charge review/generation.

Recommended fix:

- Keep final finance-charge generation human-approved.
- Add a month-end checklist item and an admin dashboard reminder when finance charges are eligible but not generated.
- Record "previewed by", "generated by", and selected customer count in an operations/audit table.

### P2-5: No backup/restore or incident runbook was found in the repo

Business risk: for a production billing and inventory app, backup/restore and incident-response steps need to be written down. If the database is corrupted, a migration fails, or a bad invoice batch posts, the team needs a repeatable recovery path.

Evidence:

- The `scripts/` folder contains validation/sync helpers, but no backup or restore script.
- A repo search for backup/restore/disaster/runbook/incident file names did not find an operations runbook.
- The project has business-critical tables and recurring financial/inventory operations, so recovery documentation is part of production readiness rather than a nice-to-have.

Recommended fix:

- Add `docs/operations/production-runbook.md`.
- Include backup policy, restore drill cadence, emergency contacts, deploy rollback, Supabase migration rollback strategy, Sentry/Vercel/Supabase log locations, and month-end close steps.
- Run and document at least one restore drill using a non-production project.

### P3-1: Edge Functions rely mostly on platform logs, not app-level alerting

Business risk: failures in OCR, email, or privileged user/admin operations may be visible only if someone checks Supabase logs. For production operations, the app should surface important function failures to admins or Sentry.

Evidence:

- `send-email` catches errors and returns JSON, but does not report to Sentry or an operations table in `supabase/functions/send-email/index.ts:171-175`.
- `process-document` logs processing errors with `console.warn` and returns an error response in `supabase/functions/process-document/index.ts:878-884`.
- Client Sentry is configured in `src/lib/sentry.ts:4-16`, but Edge Functions do not share that reporting path.

Recommended fix:

- Add a lightweight Edge Function error logger table or Sentry reporting for high-impact functions.
- Alert on repeated email failures, OCR failures, and unauthorized/forbidden attempts.
- Include request IDs and caller profile ids in logs.

## Recommended Operations Phase Order

1. Lock down `send-email` templates, role/resource checks, attachments, and rate limits.
2. Add per-ticket authorization and audit logging to `process-blend-ticket`.
3. Move Dashboard-triggered recurring jobs to a scheduler.
4. Wire reconciliation checks into a scheduled/admin-visible report.
5. Add SQL validators to GitHub CI.
6. Create `docs/operations/production-runbook.md`.
7. Add Edge Function alerting/logging for high-impact failures.

## Follow-Up Checks That Need Live Access

These should be done with live Supabase/Vercel/Sentry access:

- Confirm pg_cron is actually enabled and the `mark-overdue-invoices` job exists in production.
- Check recent `mark_overdue_invoices()` runs and failures.
- Check Supabase Security Advisor and Performance Advisor.
- Confirm Point-in-Time Recovery/backups are enabled for the Supabase project tier.
- Verify Vercel production environment variables and deployment protection settings.
- Review Sentry issue volume for `send-email`, OCR, delivery completion, invoice posting, and inventory RPCs.
