# Section 2 Refresh: Money, Invoices, Payments, AR, Statements, Credits, Write-offs, Finance Charges

Date: 2026-07-20  
Mode: Read-only current repo code plus live Supabase catalog/data invariants  
Project: `rhyzpcqhnizqbxphqdkr`

## Verdict

0 BLOCKER / 1 HIGH / 1 MED / 0 LOW.

Core live money identities are currently clean. The remaining production risk is the transaction-style customer statement: its displayed ending balance excludes all activity before the selected start date, and same-day transactions of the same type do not have a deterministic running-balance order.

## Existing Worktree State

Run-start `git status --short --branch`:

```text
## HEAD (no branch)
MM docs/app-workflow-map.html
 M docs/audits/gauntlet/live-foundation-gauntlet-index.md
 M docs/audits/gauntlet/live-foundation-gauntlet-summary.md
?? docs/audits/gauntlet/2026-07-19-section-01-security-roles-rls-secdef-refresh.md
```

These files pre-dated this Section 2 refresh and were not modified except for the gauntlet index and summary as explicitly allowed. Graphify refresh was not run because it writes generated artifacts outside `docs/audits/gauntlet/`.

## Findings

### HIGH - Date-range statements label period activity as the customer's ending balance without an opening balance

Evidence:

- Live catalog: `public._get_customer_statement_scoped_impl(uuid,date,date)` filters invoice, legacy-payment, allocation-payment, prepay, and write-off rows to `p_start_date..p_end_date`, then computes `SUM(t.amt) OVER (...)`. It has no branch or variable for activity before `p_start_date` and no opening-balance row.
- Repo source shows the same period-only construction: `supabase/migrations/20260611131549_customer_statement_blind_spots.sql:148-214` filters every transaction source to the selected dates, and line 222 computes the running sum only from those rows.
- The AR page passes the selected date range to this RPC at `src/pages/ARaging.tsx:146-150`, then labels the last returned running sum as `Ending Balance` at `src/pages/ARaging.tsx:1047-1050`.

Business risk:

A customer with an unpaid invoice or unapplied account activity before the selected statement start date can receive a statement whose displayed ending balance is lower than the actual amount owed. This is a customer-facing AR error even though today's live data has no open invoice older than 90 days.

Suggested fix:

Create a new migration that carries the net account balance before `p_start_date` into the statement as an explicit opening-balance row (or adds it to the running-balance window), using the same invoice/payment/prepay/write-off sources and reversal rules as the statement body. Keep the displayed ending balance tied to the full as-of account balance.

Prevention:

Add a rolled-back statement smoke case with an unpaid invoice before the period and an in-period payment. Assert the first row carries the opening balance and the final running balance equals the customer's as-of AR balance. Change `fin-ar-statement-balance.sql` so it tests bounded date ranges, not only the all-time transcription.

### MED - Same-day transactions of the same type have no deterministic running-balance sequence

Evidence:

- Live catalog: `public._get_customer_statement_scoped_impl(uuid,date,date)` calculates `SUM(t.amt) OVER (ORDER BY t.txn_date, t.txn_type)` and returns rows ordered by only those same two non-unique fields.
- Repo source has the same window and output ordering at `supabase/migrations/20260611131549_customer_statement_blind_spots.sql:216-224`.
- The UI renders each returned `running_balance` directly at `src/pages/ARaging.tsx:337-339` and exports it at `src/pages/ARaging.tsx:1075-1082`.

Business risk:

Two invoices, payments, or write-offs with the same transaction date and type are peers in the window order. PostgreSQL can show the same post-peer balance on multiple lines and can reorder those lines between executions, making the statement's line-by-line balance confusing and non-auditable even though the final total remains correct.

Suggested fix:

Carry a stable transaction identifier and source rank through the union, then order both the window and final result by date, source rank, stable identifier. Use an explicit `ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` frame.

Prevention:

Extend the statement smoke with two same-day invoices and two same-day payments. Assert a stable row order and a distinct, arithmetically correct running balance after every line.

## Verified Safe

Live read-only invariant counts on 2026-07-20:

- 12 active invoices; 1 posted/overdue invoice with a positive balance.
- 0 negative non-credit invoice balances.
- 0 negative payment/prepay/write-off/credit levers.
- 0 non-credit invoices whose settlement levers exceed the invoice total.
- 0 active allocation sets over their payment total; 0 negative allocation sets.
- 0 prepay balances below zero or above original value.
- 0 invoice/write-off ledger mismatches.
- 0 target/source credit-memo application mismatches.
- 0 finance-charge rows without an invoice.
- 0 current customers affected by a write-off statement mismatch or an open invoice older than 90 days.

Additional structure verified:

- `invoices.balance_cents` is live as a generated bigint-cents expression using paid, prepay, write-off, and credit levers.
- `allocate_payment`, `void_payment`, credit apply/reverse, write-off apply/reverse, invoice post/unpost/void, and finance-charge generation expose one current overload each and retain idempotency parameters.
- Live `generate_finance_charges` uses an as-of-date advisory transaction lock and skips an existing customer/period charge.
- The newer live scoped statement implementation includes unreversed write-offs; the older repo comment describing write-offs as invisible is no longer true of live behavior and was not reported as a finding.

## Scope Limits

No Sentry, Vercel, GitHub PR, browser-session, or runtime telemetry was inspected. No tests that mutate live data were run. No app/source code, migrations, database rows, grants, deployments, commits, or branches were changed.
