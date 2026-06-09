# GitHub Branch Ultra Review - 2026-05-12

## Scope

Reviewed the GitHub-visible recent branches after `git fetch --all --prune`:

- `main` at `ccd356f`, merged PR #61.
- `fix/audit-2026-05-09` at `70d60ad`, open PR #59.
- `claude/app-review-audit-yseuL` at `32e4a5d`, draft PR #60.
- `perf/advisor-sweep-2026-05-11` at `0f85545`, merged PR #61.

Local note: the checkout is on `fix/audit-2026-05-09` and is 4 commits ahead of GitHub. This review focuses on GitHub branches, so those local-only commits were not treated as reviewed branch history.

CodeRabbit note: the local `coderabbit` CLI is not installed in this environment. This is a direct GitHub/git review, not a CodeRabbit-generated report.

## Executive Decision

Do not merge PR #60 as-is. It is stale against PR #59 and its migration drops `profile_public_view`, while PR #59 now depends on that view in many frontend and notification paths. PR #59 is the main branch to continue reviewing and hardening. PR #61 is already merged and looks like performance-only database work, not data deletion.

## Findings

### P0 - PR #60 drops a view that PR #59 now depends on

Business impact: merging PR #60 together with PR #59 can break driver/user-name dropdowns, activity names, notification fan-out, and other screens that now read safe profile fields through `profile_public_view`.

Evidence:

- PR #59 creates `profile_public_view` and grants authenticated users read access in `supabase/migrations/20260510070000_tighten_customer_profile_rls.sql:90-107`.
- PR #59 uses the view in live frontend paths, for example `src/components/deliveries/QuickDeliveryModal.tsx:80-84`.
- PR #59 uses the same view for admin notification fan-out in `src/lib/activityLogger.ts:78-86`.
- PR #60 drops the view in `supabase/migrations/20260511120000_security_audit_2026_05_11.sql:20-23`.
- PR #60 documents the stale assumption that there were zero callsites in `docs/CHANGELOG.md:15`.

Why this matters: PR #60 was true only for its older branch snapshot. PR #59 later migrated many profile reads to the view. If both migrations exist, the migration order is: create view, tighten profile RLS, then drop view. The app code would still call the dropped view.

Recommended fix:

- Close PR #60 or rebuild it on top of PR #59.
- Do not drop `profile_public_view` unless all PR #59 callers are moved first.
- Better long-term fix: replace the security-definer view with an explicit `SECURITY DEFINER` RPC that returns only `id`, `full_name`, `role`, and `is_active`, then migrate frontend callers to that RPC. That keeps the safe display-name behavior without leaving the Supabase advisor `security_definer_view` warning unresolved.

### P1 - Several new RPC callsites are not retry-safe even though the RPCs are idempotent

Business impact: if the database succeeds but the browser times out, a user clicking again can send a brand-new idempotency key. That defeats replay protection. For prepay checks, this can duplicate customer credit dollars. For blend recipes, it can duplicate recipes. For bulk order import, the order-number uniqueness may stop duplicate rows, but the retry returns an error instead of a clean replay.

Evidence:

- `generateIdempotencyKey()` explicitly creates a new key on every call and says React components should persist the key across retries in `src/lib/idempotency.ts:13-17`.
- `BulkOrderImport` creates a fresh key inside the import RPC call at `src/components/orders/BulkOrderImport.tsx:374-377`.
- `BlendRecipes` creates a fresh key inside the save action at `src/pages/BlendRecipes.tsx:210-213`.
- `PrepaymentManager` sends `crypto.randomUUID()` directly for `create_prepay_check_splits` at `src/pages/PrepaymentManager.tsx:300-305`.
- `PrepaymentManager` also sends `crypto.randomUUID()` directly for `edit_prepay_credit` at `src/pages/PrepaymentManager.tsx:194` and `delete_prepay_credit` at `src/pages/PrepaymentManager.tsx:230`. Both RPCs implement canonical replay handling in `supabase/migrations/20260333400000_fix_reverse_receiving_and_idempotency_bugs.sql:442-444,545-547`, so the frontend is the only piece defeating retry-safety.
- The restored prepay RPC does have canonical replay handling in `supabase/migrations/20260511020000_create_prepay_check_splits.sql:87-93`, but the frontend is not reusing the same key on retry.
- The prepay reference index is not unique in `supabase/migrations/20260301200000_prepay_bucket_system.sql:18-21`, so duplicate check references are not automatically blocked.

Recommended fix:

- Use `useIdempotencyKey()` for `BlendRecipes` and reset only after confirmed success.
- In `BulkOrderImport`, create a stable key per parsed order attempt and reuse it if the same import row is retried.
- In `PrepaymentManager`, add dedicated key hooks for split-check creation, credit edit, and credit delete; reset each only after the RPC's `assertRpcResult` returns successfully.

### P1 - PR #59 contains Edge Function fixes that are not live until deploy

Business impact: merging the code does not automatically update Supabase Edge Functions. Until deployment happens, production may still have the old `send-email` customer-column bug and may not have the new Sentry capture/logging behavior.

Evidence:

- `send-email` now selects `farm_name` instead of nonexistent `name` at `supabase/functions/send-email/index.ts:158-162`.
- Shared Sentry helper changes are in `supabase/functions/_shared/sentry.ts:60-86`.
- PR #59 touches `_shared/sentry.ts`, `send-email`, `create-user`, `reset-user-password`, `seed-admin`, and `setup-blend-tickets-storage`.
- PR #59's own body lists Edge Function deploy as a pending Mason step.

Recommended fix:

- After PR #59 is accepted, deploy the changed functions intentionally.
- Confirm required secrets exist first: `ALLOWED_ORIGIN` and `SENTRY_DSN`.
- Spot-check `send-email` after deploy with a real customer-backed email request.

### P1 - All recent PRs skipped E2E smoke checks

Business impact: CI is green, but the browser-level workflow checks did not run. The risky branch, PR #59, changes money, inventory, prepay, vendor bills, deliveries, profile reads, permissions, and Edge Functions.

Evidence from GitHub checks:

- PR #59: lint/typecheck/test/build passed, SQL migration validation passed, Vercel passed, but `E2E Smoke Tests` were skipped.
- PR #60: same pattern, E2E skipped.
- PR #61: same pattern, E2E skipped.

Recommended fix before merging PR #59:

- Run a targeted human/browser check for: order import, new delivery, delivery detail, invoice payment, prepay split check, vendor bill create/edit/pay/void, activity feed names, and driver/sales name dropdowns.
- When staging Supabase exists, make the E2E smoke path mandatory for this class of PR.

### P2 - Known money-rounding risk remains deferred in PR #59

Business impact: PR #59 fixed the highest-traffic quick-delivery cent rounding issue, but three fee-acre paths still have the old truncation risk. This is not a hidden bug because the branch documents it, but it remains a business-money follow-up.

Evidence:

- PR #59 documents the deferred functions in `docs/audits/2026-05-13-execution-summary.md:48-53`.
- The new helper migration also documents the deferred functions in `supabase/migrations/20260513030000_safe_cents_multiply_helper.sql:18-30`.

Recommended fix:

- Follow up with one focused migration that wraps the three deferred calculations with `safe_cents_qty()`.
- Treat this as a money-integrity cleanup, not a general refactor.

## Branch Notes

### PR #59 - `fix/audit-2026-05-09`

Status: open, large, mergeable according to GitHub, CI green except E2E skipped.

High value:

- Brings frontend code into sync with database changes already applied live.
- Closes several real business risks: AP structure, idempotency replay, profile PII exposure, atomic multi-table writes, commission math, prepay split RPC restoration, and invoice balance guardrails.

Merge blockers:

- Fix the retry-safe idempotency issue above.
- Decide what to do with PR #60 before merging both.
- Plan Edge Function deployment.

### PR #60 - `claude/app-review-audit-yseuL`

Status: draft, stale relative to PR #59.

High value:

- The write-side RLS tightening for `blend_ticket_fields` and `field_crop_history` is conceptually useful.
- The storage policy cleanup is directionally reasonable if public URL rendering truly does not need storage SELECT.

Blocker:

- It drops `profile_public_view` based on a stale zero-callsites assumption. Do not merge as-is.

### PR #61 - `perf/advisor-sweep-2026-05-11`

Status: merged into `main`.

Assessment:

- Looks like performance-only database work.
- No `DROP TABLE`, `DROP COLUMN`, `DELETE FROM`, or `TRUNCATE` was found in the PR #61 migration set.
- The scary `DROP POLICY` statements are paired with replacement policies.
- The `DROP INDEX` is a duplicate-index cleanup; the migration explicitly keeps `idx_payments_order_id` in `supabase/migrations/20260511080000_perf_drop_duplicate_index.sql:11-22`.

Remaining risk:

- PR #61 manual spot checks for role-based screens were not proven by E2E because E2E was skipped.

## Recommended Merge Order

1. Pause PR #60. Rebase/rebuild it after PR #59 or close it and port only the useful RLS/storage changes.
2. Fix PR #59's frontend idempotency key reuse.
3. Re-run CI on PR #59 and manually spot-check the high-risk business flows.
4. Merge PR #59 only after the deploy plan for Edge Functions is clear.
5. Then create a smaller follow-up PR for the advisor-safe replacement of `profile_public_view` and the three deferred money-rounding paths.
