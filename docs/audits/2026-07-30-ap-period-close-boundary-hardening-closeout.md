# AP Period-Close Boundary Hardening — Live Closeout

Date: 2026-07-30 America/Chicago
Production project: `rhyzpcqhnizqbxphqdkr`
Verdict: COMPLETE for the bounded AP slice

## Scope

This release extends the existing accounting-month advisory-lock protocol to:

- `record_vendor_payment` using the payment date;
- `void_vendor_payment` using the original payment date;
- `void_vendor_bill` using the original bill date.

It also removes every direct `accounting_periods` table capability from
`PUBLIC`, `anon`, and `authenticated`, then restores authenticated SELECT only.
Active admins continue to close and reopen periods through the governed RPCs.

This is not a global accounting-close protocol. Live closeout still found 26
other `check_period_open` callers without `_lock_accounting_months`; those
remain a separate high-risk review lane.

## Migration Identity

- Authored/submitted name:
  `20260730233835_ap_period_close_boundary_hardening`
- Server-assigned ledger version and B7 disk filename:
  `20260731001654_ap_period_close_boundary_hardening`
- Applied SQL SHA-256:
  `4c28c8c2e89e1ba68198f58089eed6ebc42aceae1d7c2b6b9853ee6c768d7de4`
- Live ledger: exactly one matching row; 932 total rows; high-water
  `20260731001654`

## Review

- Sol-high design verdict: ACCEPT. Preserve existing AP business-row locks,
  then take the shared month lock, check the period, and mutate. Do not add a
  later month lock to `reopen_accounting_period`; that would invert close's
  month-first order and can deadlock.
- Sanctioned content-bound migration review:
  `rls-security-reviewer` CLEAN and `migration-drift-reviewer` CLEAN using
  GPT-5.6 Sol.
- Independent exact-file Sol-high adversarial review: CLEAN with zero
  BLOCKER/HIGH/MED/LOW findings.
- The drift review found and fixed one downstream E2E cleanup that directly
  patched `accounting_periods`; it now uses `reopen_accounting_period`.
- No Claude review was used.

## Pre-Apply Proof

- Focused source contract: 9/9 passed.
- Full Vitest: 4,128 passed, 123 skipped.
- Drift suite: 234 passed, 78 skipped.
- Typecheck, lint, build, documentation drift, changed-migration SQL audit,
  JSON parse, `node --check`, and `git diff --check`: passed.
- Network-isolated PostgreSQL 17 full replay applied 18 post-baseline
  migrations, including the Quote/Customer migration immediately before this
  AP migration.
- Six real concurrency schedules passed:
  writer-first and close-first for record payment, void payment, and void bill.
- The proof observed real advisory locks, bounded waits, fail-closed wakeups,
  and no AP/audit/activity/idempotency leakage.
- Terminal marker:
  `VENDOR_BILL_PERIOD_CLOSE_CONCURRENCY_PASS`.

The full historical SQL audit exceeded ten minutes in Git Bash, so the intended
changed-only audit was used and returned zero violations and zero warnings.

## Live Proof

The apply completed successfully and its in-migration postflight passed.
Read-only production catalog verification then confirmed:

- one overload per target function;
- `postgres` owner, SECURITY DEFINER, and
  `search_path=public, pg_temp`;
- shared month lock before period check before mutation in all three AP bodies;
- no PUBLIC or anon EXECUTE; authenticated and service-role EXECUTE retained;
- `accounting_periods` RLS enabled;
- only `accounting_periods_select_admin` remains;
- authenticated has SELECT only, anon has no table privilege, and deliberate
  service/metabase access remains.

The registered Section 9 production smoke ended with the expected terminal
`ERROR P0001: SMOKE_PASS_ROLLBACK`. Follow-up counts were all zero for smoke
vendors, purchase orders, vendor bills, idempotency keys, and closed accounting
periods. No business data was retained.

The schema registry was regenerated from six fresh live-introspection queries
after both same-evening migrations. It now records high-water
`20260731001654`, both applied migration names, and the Quote/Customer
`row_version` columns; generated-column/status/no-`updated_at` counts remained
stable. No stale registry flag remained.

## Remaining Boundary

The other 26 live `check_period_open` callers are not covered by this release.
Any global protocol must re-evaluate each writer's business-row lock order,
date semantics, close completeness scan, concurrency proof, and deadlock graph.
