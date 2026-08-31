# Section 2 Historical Report Remediation

## WHERE

- Repository: `https://github.com/masonwells1/CRX_Manager_V1.0`
- Worktree: `C:\Users\mason\.codex\worktrees\section2-historical-reports-20260805\CRX_Manager`
- Branch: `codex/section2-historical-reports-20260805`
- Base: `origin/main` at `6a49add2d8b972b082375162bff97176ca883f73`
- Supabase project: `rhyzpcqhnizqbxphqdkr`

## GOAL

Make AR Aging and Customer Balance Listing truthful for their selected cutoff date. Done means both RPCs share the live statement reconstruction contract, regression proof covers later activity and overdue invoices, all money/migration gates pass, and the approved live apply is post-verified.

## PROVEN

- The clean checkout exactly matched freshly fetched `origin/main` with no dirty files or ahead/behind commits at audit start.
- Current source and fresh live `pg_proc` definitions independently confirm two HIGH defects documented in `docs/audits/gauntlet/2026-08-05-section-02-money-invoices-payments-ar-refresh.md`.
- Live statement helpers already provide ledger-backed posting-interval reconstruction and a fail-closed detector for later cash, prepay, and write-off activity.
- Graphify was rebuilt from `6a49add2`; scoped queries narrowed the work to `ARaging.tsx`, `Reports.tsx`, the two report RPCs, and the live statement helper contract.

## APPLIED AND PROVEN LIVE

- `supabase/migrations/20260805151605_fix_historical_ar_report_cutoffs.sql` re-emits both reports with posted-as-of eligibility, invoice/credit cutoffs, credit-application replay, fixed search paths, deliberate grants, and a private fail-closed reconstruction helper.
- Exact-commit review found that its Customer Balance Listing cumulative fields omitted fully paid invoices. Follow-up `supabase/migrations/20260805171334_fix_customer_balance_paid_invoice_totals.sql` is live and restores all cutoff-eligible invoices to Invoiced, Paid, Prepay Applied, and count while keeping balance/oldest-unpaid open-only.
- `scripts/smoke/smoke-historical-ar-report-cutoffs.sql` proves overdue inclusion, future-invoice exclusion, cutoff credit reconstruction, and rejection of unknowable later prepay history. It is registered in the smoke and billing-area registries.
- The exact migration plus smoke ran against live Supabase in one deliberately aborted transaction and returned `SMOKE_PASS_ROLLBACK`. Postchecks proved the original report functions remained byte-identical at the body level, no helper or fixture remained, and no ledger row was written.
- Exact changed-file SQL validation: 0 violations / 0 warnings. The all-history scan exceeded its 15-minute bound without a verdict and is not represented as passing.
- Typecheck, lint, production build, docs drift, final focused static tests (6), drift tests (234 passed / 78 skipped), and full Vitest (4,268 passed / 123 skipped) passed.
- Pre-apply ledger proof: 934 migrations at high-water `20260803221244`; exact SHA-256 `57326b0ac606abe0dd872412f57617364bbc043bcaec2e3fbd5edc9f1aca0509`. Post-apply: 935 migrations at assigned version `20260805151605`, submitted name `20260805124533_fix_historical_ar_report_cutoffs`.
- Both content-bound `gpt-5.6-sol` high-effort reviewer charters returned CLEAN. Proof query hash: `57326b0ac606abe0dd872412f57617364bbc043bcaec2e3fbd5edc9f1aca0509`.
- Post-apply catalog proof: exactly one overload each; fixed search paths; anon revoked; the helper is postgres-only; expected cutoff and role checks are present.
- Read-only role proof: admin current AR/listing and sales-rep current listing execute; sales-rep historical listing raises the expected admin-only error.
- Applied-function smoke returned `SMOKE_PASS_ROLLBACK` with zero customer-fixture residue. Supabase advisors show no target performance finding; their two target security warnings are expected for the deliberately exposed, internally role-gated `SECURITY DEFINER` report RPCs.
- The follow-up was submitted as `20260805170848_fix_customer_balance_paid_invoice_totals`, applied as ledger version `20260805171334`, and B7-renamed content-identically (SHA-256 `a187a68da5ca0f94781211d8ed1cfe40d313f85b6eb30d411ba66936f53258ab`). Both content-bound Sol/high charters were CLEAN; post-apply owner/search-path/ACL/body-marker checks passed.
- `.claude/schema-registry.json` was regenerated from all six live introspection queries to high-water `20260805171334`; enums, generated columns, and table shapes are unchanged.
- All 21 standing live database-invariant predicates passed read-only with zero unallowlisted violations; all financial identity predicates returned zero rows. The complete agent-workflow regression suite passed after reconciliation.

## NOT DONE

- No persistent business-data change or signed-in browser UI smoke occurred. Commit, push, PR, review, merge, and production verification are the active release steps.

## APPROVAL STATE

Mason explicitly approved the live migration applies on 2026-08-05; that authorization was used for ledger versions `20260805151605` and corrective follow-up `20260805171334`. Mason subsequently authorized the complete protected-PR release path in the same conversation. Persistent business-data changes, unrelated permission changes, and deletion remain out of scope.

## GATES AND BLOCKERS

- No migration or production blocker remains. The branch is ready for its exact-commit review and protected PR pipeline.
- The canonical gauntlet workflow runner is unavailable in this Codex tool surface; the clean audit is backed directly by current source, fresh live catalog evidence, full local verification, rollback smoke, and the two content-bound reviewer charters.

## FIRST ACTION

Create the release commit, bind the required Sol/high proof to its exact SHA, then publish through the protected PR pipeline and verify production plus live Supabase after merge.

Verify current state from Git, disk, and connected services before trusting this handoff; it may be stale when read.
