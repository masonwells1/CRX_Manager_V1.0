# Section 2 Refresh: Money, Invoices, Payments, AR, Statements, Credits, Write-offs, Finance Charges

Date: 2026-08-05
Mode: Clean current-repo code plus live Supabase catalog structure only
Project: `rhyzpcqhnizqbxphqdkr`
Checkout: `codex/section2-historical-reports-20260805` at `6a49add2d8b972b082375162bff97176ca883f73`

## Verdict

0 BLOCKER / 2 HIGH / 0 MED / 0 LOW.

At audit time, the two historical report controls were not safe to rely on for a past date: both reused mutable current balances, and Customer Balance Listing excluded live `overdue` rows while including `unposted`. Both HIGH findings were fixed live later the same day by ledger version `20260805151605`; exact-commit review then caught and live follow-up `20260805171334` closed a paid-invoice aggregate regression before publication. The proof is recorded below.

## Reproducible Checkout Evidence

Run-start evidence after `git fetch origin main --prune`:

```text
## codex/section2-historical-reports-20260805...origin/main
HEAD = origin/main = 6a49add2d8b972b082375162bff97176ca883f73
origin/main...HEAD = 0 0
working tree = clean
```

The original `C:\CRX_Manager` checkout was 45 commits behind and contained pre-existing audit/handoff changes. It was not modified. A clean linked worktree was created from current `origin/main` for this audit and remediation.

Graphify was refreshed from commit `6a49add2` (`graphify-out/GRAPH_REPORT.md`). Queries used: `graphify explain "get_ar_aging"`, `graphify explain "get_customer_balance_listing"`, and `graphify query "what connects the AR aging and customer balance listing report pages to their database functions and historical date inputs?" --budget 1200`. Graphify identified the pages and historical migration lineage; current source and live catalog evidence below are authoritative.

## Findings

### HIGH - AR Aging labels a selectable historical cutoff while calculating today's balances

Evidence:

- The page initializes a user-editable `asOfDate` and sends it to the RPC at `src/pages/ARaging.tsx:69` and `src/pages/ARaging.tsx:97-110`; the control is labeled `As of Date` at `src/pages/ARaging.tsx:852-858`.
- The current repo definition at `supabase/migrations/20260712210000_ar_credit_visibility.sql:113-146` uses `p_as_of_date` only to calculate bucket age. Its invoice subquery has no `invoice_date <= p_as_of_date` cutoff and filters today's `status` plus generated `balance_cents`. It also returns today's `customers.prepay_balance_cents` and today's credit-memo `balance_cents`.
- Fresh live `pg_proc` evidence captured 2026-08-05 shows exactly one `get_ar_aging(date)` overload, definition MD5 `e771c41fec37dbae8407a27b22727746`, with the same structure: `status IN ('posted','overdue')`, current `balance_cents`, no invoice/credit cutoff, current prepay, and current credit balance.
- Live catalog evidence confirms `invoices.balance_cents` is a stored generated expression over mutable paid, prepay, write-off, and credit-application levers. It is not a historical ledger snapshot.

Business risk:

An admin can choose a prior date and receive a report that includes invoices created later, omits invoices paid/voided/unposted later, and shows today's prepay and credit. Collections decisions and customer conversations can therefore be based on a false historical balance.

Suggested fix:

Re-emit the RPC using the already-live statement reconstruction contract: select invoices posted as of the cutoff, enforce invoice/credit date boundaries, replay immutable credit-memo applications, and fail closed when later payments, prepay, write-offs, generic voids, or unposts make reconstruction unknowable.

Prevention:

Add a rollback-only smoke spec with a past-dated posted invoice, a later invoice, a later payment, an overdue invoice, and a later credit application. The old function must either misstate the cutoff or omit overdue; the corrected function must return the exact cutoff or the documented historical-reconstruction error.

### HIGH - Customer Balance Listing omits overdue invoices and reports current state for its End Date

Evidence:

- `src/pages/Reports.tsx:274-279` sends the shared End Date to `get_customer_balance_listing`; the editable control is labeled `End Date` at `src/pages/Reports.tsx:793-804`.
- The UI presents the result as Invoiced, Paid, Balance, Credit Available, invoice count, and Oldest Unpaid at `src/pages/Reports.tsx:700-707`.
- The current repo definition at `supabase/migrations/20260712210000_ar_credit_visibility.sql:238-269` filters `i.status IN ('posted', 'unposted')`. Live `invoices_status_check` allows `draft`, `unposted`, `posted`, `paid`, `overdue`, `voided`, and `cancelled`, so the query includes non-posted work while excluding overdue receivables.
- Although it filters invoice and credit `invoice_date`, it sums today's `total_amount_cents`, `paid_amount_cents`, `prepay_applied_cents`, generated `balance_cents`, and today's credit-memo balance.
- Fresh live `pg_proc` evidence shows exactly one `get_customer_balance_listing(date)` overload, definition MD5 `2162c42c7571cdcf5c1074f8bc419ba9`, and matches the repo body.

Business risk:

The customer balance report can understate collections by dropping overdue invoices and can rewrite a prior End Date after later cash, prepay, write-off, credit, void, or unpost activity. Exported CSVs can therefore be internally inconsistent with AR Aging and customer statements.

Suggested fix:

Use the same posted-as-of and historical-reconstruction contract as statements and AR Aging. Preserve admin and sales-rep access with an internal active-role gate, revoke anonymous execution after converting the function to `SECURITY DEFINER`, and calculate open invoice balances and credits at the cutoff.

Prevention:

Register the same rollback-only historical report smoke plus a deterministic migration guard that asserts both report RPCs call the shared reconstruction helpers, enforce the cutoff, retain one overload, use fixed search paths, and deny anonymous execution.

## Verified Safe

- The three findings from the 2026-08-02 Section 2 pass are resolved live by migration ledger version `20260803221244`: overdue-only customers enter statement batches, finance charges are not added twice to per-invoice Net Due, and statements disclose gross invoice balance, open credit, and net account position separately.
- Live `get_ar_aging(date)` remains admin-gated, has `search_path=public, pg_temp`, denies `PUBLIC`/`anon`, and grants only `authenticated`/`service_role` beyond the owner.
- The statement reconstruction helpers each have one overload, fixed search paths, and owner-only execution. Their live definitions provide the reusable posted-as-of and later-balance-activity controls proposed above.
- No finding was added for current-date AR arithmetic. This audit proved the pre-migration historical cutoff contract was unsafe; it did not prove a current aggregate mismatch.

## Scope Limits

No Sentry, Vercel, GitHub PR, browser session, logs, runtime telemetry, or customer-row dump was inspected. The original audit used catalog/constraint/function-definition reads only. After Mason's explicit approval, the reviewed migration changed the two report RPCs, one private helper, grants, and the migration ledger; no persistent business data, frontend deployment, or runtime system was changed.

The canonical same-model gauntlet workflow runner is not callable from this Codex tool surface, so its deterministic settlement object was not produced. The audit itself ran from a clean exact-current checkout and every reported finding is independently supported by current source plus fresh live catalog evidence.

## Remediation and Live Proof

Both findings are fixed live by `supabase/migrations/20260805151605_fix_historical_ar_report_cutoffs.sql`, with paid-invoice aggregate follow-up `supabase/migrations/20260805171334_fix_customer_balance_paid_invoice_totals.sql`, after Mason's explicit approval.

- Before apply, the migration followed by `scripts/smoke/smoke-historical-ar-report-cutoffs.sql` executed against the current live catalog in one deliberately aborted transaction and terminated with `SMOKE_PASS_ROLLBACK`. A read-only postcheck confirmed the original function-body hashes were restored, the new helper count was zero, no smoke customers remained, and the candidate was absent from the live migration ledger at that pre-apply point.
- The smoke proves overdue inclusion, future-invoice exclusion, credit-application cutoff reconstruction, and fail-closed handling for unreconstructable later prepay activity. It is registered in `scripts/smoke/smoke-specs.json` and the billing test area.
- Exact changed-file SQL validation passed with 0 violations and 0 warnings. The full historical SQL scan exceeded its 15-minute bound without a verdict; it is not counted as green.
- Typecheck, lint, production build, documentation drift, the final focused static guard (6 tests), drift slice (234 passed / 78 skipped), and the full Vitest suite (4,268 passed / 123 skipped) passed.
- Fresh pre-apply Supabase `list_migrations` returned 934 rows with high-water `20260803221244`; the exact migration SHA-256 was `57326b0ac606abe0dd872412f57617364bbc043bcaec2e3fbd5edc9f1aca0509`. Both refreshed content-bound `gpt-5.6-sol` high-effort migration charters returned CLEAN immediately before apply.
- Post-apply, the ledger holds 935 rows at `20260805151605`; all three functions have one overload and fixed search paths, anon is revoked, the private helper is owner-only, and the expected cutoff/role markers are present. Admin current reports and sales-rep current listing executed read-only; sales-rep historical listing raised the expected admin-only error.
- The first exact-commit reviewer found that cumulative Invoiced, Paid, Prepay Applied, and invoice count were restricted to positive-balance invoices. Follow-up `20260805171334` restores fully paid invoices to those cumulative fields while keeping Outstanding Balance and Oldest Unpaid open-only.
- The expanded paid-plus-open smoke re-ran against the final applied function and returned `SMOKE_PASS_ROLLBACK`; zero fixture customers remained. The live schema registry was regenerated from all six introspection queries to high-water `20260805171334`.
- All 21 standing live database-invariant predicates were executed read-only after apply. Every financial identity predicate returned zero rows, and the remaining catalog hits exactly matched documented allowlist entries, for zero unallowlisted violations.
- The repository's complete agent-workflow regression suite also passed after the live reconciliation and documentation updates.
- Supabase advisors returned no target-related performance finding. Their two target security warnings are the expected generic authenticated-`SECURITY DEFINER` warnings for these deliberately exposed, internally role-gated reports.
