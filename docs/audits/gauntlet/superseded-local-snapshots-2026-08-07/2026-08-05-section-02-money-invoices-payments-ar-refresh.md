# Section 2 Refresh: Money, Invoices, Payments, AR, Statements, Credits, Write-offs, Finance Charges

Date: 2026-08-05
Mode: Read-only current remote-main code object plus live Supabase structure/catalog
Project: `rhyzpcqhnizqbxphqdkr`
Code audited: `b5796b082d50f3ff5a58daaa6b2bbb1c617afbb1` (`origin/main`; read-only `git ls-remote` returned the same SHA)

## Verdict

**PARTIAL — 0 BLOCKER / 2 HIGH / 0 MED / 0 LOW confirmed.**

The prior 2026-08-02 statement findings are fixed in the current code object and live database structure. The current audit instead found two HIGH reporting defects: AR Aging accepts a historical "As of Date" but calculates from today's mutable invoice, prepay, and credit balances, while the Customer Balance report both omits `overdue` invoices and includes `unposted` invoices. Both can materially misstate customer receivables.

The deterministic section gate is **not settled**. The active checkout started 30 commits behind `origin/main` and dirty. The stricter audit write boundary prohibited fetching, checking out, or creating a clean worktree, so the audit read the exact current remote-main Git object without modifying refs or source. The current remote-main SHA was verified directly, but the canonical runner requires its reviewers to read a clean checkout at that SHA.

## Existing Checkout State

Run-start `git status --short --branch`:

```text
## main...origin/main [behind 30]
 M docs/audits/gauntlet/live-foundation-gauntlet-index.md
 M docs/audits/gauntlet/live-foundation-gauntlet-summary.md
?? docs/audits/2026-07-27-claude-session-handoff-opus5.md
?? docs/audits/gauntlet/2026-08-02-section-02-money-invoices-payments-ar-refresh.md
?? docs/handoffs/2026-07-29-inventory-net-position-backlog-closeout.md
?? docs/handoffs/2026-07-29-quote-customer-lost-update-overnight-fresh-session.md
?? docs/handoffs/2026-07-29-supplier-pricing-operational-completion-fresh-session.md
?? docs/handoffs/2026-07-29-vendor-bill-period-close-race-overnight-fresh-session.md
```

Run-start `HEAD` was `ea794571bd189a1dab25fabf0cb1175925e17cb8`. Local `origin/main` was `b5796b082d50f3ff5a58daaa6b2bbb1c617afbb1`, ahead/behind `30/0` relative to `HEAD`; read-only `git ls-remote origin refs/heads/main` returned that same current remote SHA. All listed files pre-dated this run and were left untouched except the two gauntlet trackers this automation is required to update.

## Method and Live Evidence Packet

- Read the required repo guidance: `CLAUDE.md`, `AGENTS.md`, `docs/workflows/SAFE_DEVELOPMENT_RULES.md`, `docs/reference/gotchas.md`, `docs/workflows/CODEX_REVIEW_GAUNTLET.md`, and `.claude/commands/gauntlet-section.md`.
- Used the existing Graphify index only for navigation with `graphify explain "generate_batch_statements"`. Its report was built from stale checkout commit `ea794571`, and the query returned only the historical 2026-02 definition, so no Graphify-only edge is used as proof.
- Read current source through `git show origin/main:<path>` and `git grep origin/main`; no checkout, ref, or source file was changed.
- Collected fresh live evidence only from `pg_catalog`, `information_schema`, and `supabase_migrations.schema_migrations`. No customer/business rows, aggregates, logs, telemetry, browser sessions, Edge Function runtime, Sentry, Vercel, or GitHub PR data were inspected.
- Live migration high-water is `20260803221244`, recorded with submitted name `20260803131507_fix_statement_balance_disclosure`.
- Live `invoices.balance_cents` is a stored generated `bigint` expression over total, paid, prepay, write-off, and type-aware credit levers. Live CHECK constraints validate invoice status/type, nonnegative ordinary balances, nonpositive credit-memo balances, positive write-offs, positive credit applications, and `posted_at` for financial statuses.

## Findings

### HIGH — AR Aging's selectable historical date still reports today's mutable balances

**Evidence**

- The page exposes an editable `As of Date` at `src/pages/ARaging.tsx:69`, sends it to `get_ar_aging` at `src/pages/ARaging.tsx:97-110`, and renders the date control at `src/pages/ARaging.tsx:845-858`.
- Current source for `get_ar_aging(date)` calculates bucket age from `p_as_of_date`, but reads current `i.balance_cents`, current invoice status, current `customers.prepay_balance_cents`, and current credit-memo balances at `supabase/migrations/20260712210000_ar_credit_visibility.sql:113-146`.
- The same function has no `i.invoice_date <= p_as_of_date` filter, so an invoice dated after the selected cutoff can enter the historical report as "current." Its open-credit subquery also has no credit-invoice cutoff.
- Fresh live `pg_get_functiondef('public.get_ar_aging(date)'::regprocedure)` matches that structure. A catalog-only predicate probe returned: `reads_current_generated_balance=true`, `returns_current_prepay_balance=true`, `filters_invoice_date_at_cutoff=false`, and `filters_credit_date_at_cutoff=false`.

**Business risk**

An admin selecting a prior date can see a balance changed by later payments, credit applications, invoice postings/unpostings, or prepay activity. Future-dated invoices can also appear in that past snapshot. Collections, credit-limit, month-end, or finance-charge decisions made from that screen can therefore use a materially wrong receivable amount.

**Suggested fix**

Make the contract explicit and fail closed. Either remove/disable historical dates and rename the report as current-only, or rebuild `get_ar_aging` on the same cutoff-replay/fail-closed foundation now used by detailed statements. At minimum, exclude invoices and credits created after the cutoff and refuse a historical result when later mutable balance activity cannot be reconstructed safely.

**Prevention**

Add a rollback-only database smoke with a posted invoice, then later payment, credit application/reversal, prepay change, and future-dated invoice. A prior cutoff must either reproduce the original snapshot exactly or raise the approved historical-reconstruction error; it must never silently return current balances.

### HIGH — Customer Balance hides overdue debt, counts unposted invoices, and is not a true as-of report

**Evidence**

- The Financial > Customer Balance tab passes the selected End Date to `get_customer_balance_listing` at `src/pages/Reports.tsx:274-279`; the shared date controls explicitly expose Start Date and End Date at `src/pages/Reports.tsx:793-804`, and the table labels the output `Balance` / `Oldest Unpaid` at `src/pages/Reports.tsx:704-707`.
- Current source filters invoice status with `i.status IN ('posted', 'unposted')`, omitting `overdue`, at `supabase/migrations/20260712210000_ar_credit_visibility.sql:238-269`.
- That function uses current `SUM(i.balance_cents)`, `SUM(i.paid_amount_cents)`, current prepay-applied totals, and current credit-memo balances. `p_as_of_date` only filters invoice dates; it does not replay payments, credit applications/reversals, unposts, voids, or other later balance changes.
- Fresh live `pg_get_functiondef('public.get_customer_balance_listing(date)'::regprocedure)` matches the cited source. A catalog-only predicate probe returned: `status_filter_has_posted=true`, `status_filter_has_unposted=true`, `status_filter_has_overdue=false`, `reads_current_generated_balance=true`, and `reads_current_paid_component=true`.
- Live `invoices_status_check` separately proves `unposted` and `overdue` are distinct valid states. Elsewhere the canonical open-AR scope is `posted` plus `overdue`, including live `get_ar_aging` and the remediated detailed-statement functions.

**Business risk**

The report can hide the most delinquent invoices while counting invoices that were deliberately unposted and are not current AR. A historical End Date can also change retroactively after later money activity. The CSV and on-screen Customer Balance may therefore understate or overstate what each customer owed.

**Suggested fix**

Change the open-invoice scope to the canonical `status IN ('posted', 'overdue')` and exclude `unposted`. Then make the date contract truthful: reuse the detailed-statement cutoff engine/fail-closed checks, or remove the historical End Date behavior and present a clearly current-only report.

**Prevention**

Add a rollback-only report smoke containing one `posted`, one `overdue`, one `unposted`, and one later-paid invoice. Assert that current AR includes posted+overdue only, and that a past cutoff is stable after later payment/credit activity or fails closed. Add a source invariant forbidding the `('posted','unposted')` status set in customer-balance producers.

## Verified Safe

- **Prior 2026-08-02 HIGH resolved:** live `generate_batch_statements(date,uuid,text,text)` now uses the historical posting helper and passes every selected customer to `get_detailed_statement_data`; current source is `supabase/migrations/20260803221244_fix_statement_balance_disclosure.sql:560-675`. Month End passes actor and idempotency values and asserts the RPC result at `src/pages/MonthEndClose.tsx:338-364`.
- **Prior 2026-08-02 HIGH resolved:** live `get_detailed_statement_data` emits `net_due_cents = v_inv.statement_balance_cents`; current source is `supabase/migrations/20260803221244_fix_statement_balance_disclosure.sql:446-470`. `src/lib/statementPdf.test.ts:173-185` asserts a finance charge is not doubled.
- **Prior 2026-08-02 MED resolved:** live detail output returns `open_credit_cents` and `net_account_position_cents` at `supabase/migrations/20260803221244_fix_statement_balance_disclosure.sql:535-556`. The shared frontend guard fails closed on an old payload at `src/lib/statementBalance.ts:7-21`; PDF/email tests assert separate gross, credit, and net labels.
- Live statement helpers are `SECURITY DEFINER`, fixed to `public, pg_temp`, and executable only by `postgres`; neither `anon`, `authenticated`, nor `service_role` can call them directly. The two public statement RPCs deny anon execution and require admin access.
- Live payment, prepay, write-off, credit-application, invoice-post/void, and finance-charge paths retain actor/role checks, period gates where money moves, row/advisory locks, idempotency binding, and audit-log writes. `record_invoice_payment` is postgres-only and hard-disabled in favor of reversible `allocate_payment`.
- The catalog scan found no current public money RPC that directly updates generated `invoices.balance_cents`; mutations use its component columns.

## Scope Limits and Gate

- The canonical workflow runner was not invoked because its checkout self-attestation would correctly reject the active behind checkout before review. No deterministic gate result was overridden.
- No tests, build, runtime flow, or business-row probe was run; the automation is restricted to current repo code and live database structure only.
- No app/source code, migration, database row, grant, deployment, commit, branch, ref, or tracked file outside `docs/audits/gauntlet/` was changed.

## Next Action

Keep Section 2 queued. Re-run from a clean checkout at current `origin/main` so the deterministic gate can adjudicate these two HIGH findings. If confirmed there, fix both report contracts together around one shared historical-as-of rule; do not patch only the status literal and leave retroactive balances in place.
