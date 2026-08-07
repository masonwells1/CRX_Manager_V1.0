# Section 2 Refresh: Money, Invoices, Payments, AR, Statements, Credits, Write-offs, Finance Charges

Date: 2026-08-02
Mode: Read-only current repo code plus live Supabase structure/catalog
Project: `rhyzpcqhnizqbxphqdkr`
Checkout: `ea794571bd189a1dab25fabf0cb1175925e17cb8` (`origin/main` identical at capture time)

## Verdict

**PARTIAL — 0 BLOCKER / 2 HIGH / 1 MED / 0 LOW confirmed.**

The three findings below survived current-source review, live-catalog confirmation, a completeness pass, and two adversarial skeptics. The deterministic section gate is nevertheless **not settled** because the checkout started with five pre-existing untracked files; the canonical gauntlet treats a dirty tree as non-reproducible even when the files do not overlap the audited source.

Production risk is customer-facing: Month End can omit the most delinquent customers from its statement batch, a detailed statement can double a finance-charge invoice on its per-invoice `Net Due` line, and gross AR statements do not disclose unapplied credits while labeling the gross figure `Balance Due`.

## Existing Checkout State

Run-start `git status --short --branch`:

```text
## main...origin/main
?? docs/audits/2026-07-27-claude-session-handoff-opus5.md
?? docs/handoffs/2026-07-29-inventory-net-position-backlog-closeout.md
?? docs/handoffs/2026-07-29-quote-customer-lost-update-overnight-fresh-session.md
?? docs/handoffs/2026-07-29-supplier-pricing-operational-completion-fresh-session.md
?? docs/handoffs/2026-07-29-vendor-bill-period-close-race-overnight-fresh-session.md
```

`git fetch origin main` completed at 2026-08-02T02:02:15-05:00. `HEAD` and `origin/main` were both `ea794571bd189a1dab25fabf0cb1175925e17cb8`; ahead/behind was `0/0`. The five files above pre-dated the run and were not modified.

## Method and Live Evidence Packet

- Required guidance read: `CLAUDE.md`, `AGENTS.md`, `docs/workflows/SAFE_DEVELOPMENT_RULES.md`, `docs/reference/gotchas.md`, `docs/workflows/CODEX_REVIEW_GAUNTLET.md`, and the canonical gauntlet-section command.
- Graph navigation query used: `graphify query "what connects ARaging customer statements invoices payments prepayments write-offs finance charges" --budget 1200`. The pre-existing graph used for navigation was built from `e83aed90`, so every material edge was rechecked in current source and live catalog.
- Fresh live evidence came only from `pg_catalog` metadata/function definitions and constraints. The packet inspected `pg_proc`, `pg_attribute`, `pg_attrdef`, `pg_constraint`, and `pg_trigger`; no business rows are used as evidence in this report.
- Live `invoices.balance_cents` is a stored generated `bigint` expression over total, paid, prepay, write-off, and type-aware credit levers. The live invoice status CHECK includes `posted` and `overdue`.
- Compact live `pg_proc` probe returned:
  - `generate_batch_statements(date,uuid,text,text)`, source md5 `bd7544b6df565a7f24c909f6c45bdd94`: `status = 'posted'` present, posted+overdue literal absent, positive-balance filter present.
  - `get_detailed_statement_data(uuid,date,text)`, source md5 `fbb023d78bc3ba89732eda9081c0d72f`: posted+overdue and positive-balance filters present, no credit-memo branch, `finance_charge_cents` present, and `v_inv.balance_cents + v_finance_cents` present.
  - `_generate_finance_charges_idem_impl_20260721(date,uuid,uuid[],text)`, source md5 `49496e51d0d3ee07e57f3afdc7c033ff`: creates a charge invoice, inserts a `finance_charges` row, and links that row to the same invoice id.

## Findings

### HIGH — Month End batch statements omit customers whose only open invoices are overdue

**Evidence**

- Live catalog: `public.generate_batch_statements(date,uuid,text,text)` seeds its customer loop from positive invoice balances with `i.status = 'posted'`. Its nested `get_detailed_statement_data(uuid,date,text)` correctly accepts `status IN ('posted','overdue')`, and the live `invoices_status_check` permits both states.
- Repo source preserves the posted-only selector at `supabase/migrations/20260219210000_invoice_statement_rpcs.sql:483-496`.
- The reachable Month End action calls this RPC and sends its returned array directly to batch PDF generation at `src/pages/MonthEndClose.tsx:338-364`.
- The project already documents the same posted-only failure class for overdue receivables at `supabase/migrations/20260701200000_ar_reminder_include_overdue.sql:2`.

**Business risk**

A customer whose unpaid invoices have all aged from `posted` to `overdue` is absent from the Month End statement batch. The most delinquent account can therefore receive no generated statement while less-delinquent accounts do.

**Suggested fix**

Create a new migration that makes the batch customer selector use the same posted-like scope as the detailed statement (`status IN ('posted','overdue')`), while retaining positive balance, deletion, customer-active, and as-of-date checks.

**Prevention**

Add a rolled-back RPC smoke fixture with an active customer whose only positive invoice is `overdue`; assert `generate_batch_statements` returns exactly one statement. Add a source guard that requires the batch selector and detailed selector to share the same posted-like status set.

### HIGH — Detailed statements double a finance-charge invoice on the per-invoice Net Due line

**Evidence**

- Live catalog: `_generate_finance_charges_idem_impl_20260721(date,uuid,uuid[],text)` creates a `misc_charge` invoice for `v_charge_amount`, then inserts a `finance_charges` row for the same `v_charge_amount` with `invoice_id = v_invoice_id`.
- Current repo source shows that same linkage at `supabase/migrations/20260721125937_ignore_voided_finance_charge_month_dedup.sql:178-214`.
- Live `get_detailed_statement_data(uuid,date,text)` sums `finance_charges.amount_cents` for the current invoice and emits `net_due_cents = v_inv.balance_cents + v_finance_cents`; current source is `supabase/migrations/20260702161000_a8_aging_basis_unification.sql:188-212`.
- Live `invoices.balance_cents` already begins with `total_amount_cents`, so the generated finance-charge invoice's balance already contains the charge.
- The detailed PDF prints the invoice balance, then `Finance Charges`, then the inflated `Net Due` at `src/lib/statementPdf.ts:321-340` and `src/lib/statementPdf.ts:430-447`.

**Business risk**

Once a generated finance-charge invoice is posted, a detailed customer statement can show its charge twice on that invoice's `Net Due` line. The statement header total remains correct, but the contradictory line can cause a customer or staff member to believe twice the finance charge is owed.

**Suggested fix**

Treat the `finance_charges` row as metadata for the standalone misc-charge invoice: keep the informational charge line if desired, but set that invoice's `net_due_cents` to its generated `balance_cents`. If legacy linkage shapes exist, branch explicitly by linkage rather than adding every linked charge blindly.

**Prevention**

Add a rolled-back statement fixture that generates and posts one finance-charge invoice, calls `get_detailed_statement_data(..., 'detailed')`, and asserts the transaction's `net_due_cents` equals one invoice balance. Strengthen `src/lib/statementPdf.test.ts:171-175` to assert the exact rendered charge and Net Due amounts instead of only asserting that rendering succeeds.

### MED — Gross-AR statements label the gross figure Balance Due without disclosing unapplied credit memos

**Evidence**

- The gross-aging convention is intentional and documented at `src/pages/ARaging.tsx:7-12`; this finding does **not** claim the AR aging arithmetic should automatically net credits.
- Live `get_detailed_statement_data(uuid,date,text)` includes only `status IN ('posted','overdue') AND balance_cents > 0`, has no credit-memo branch or open-credit field, and returns the positive-only sum as `outstanding_balance_cents`. Current source matches at `supabase/migrations/20260702161000_a8_aging_basis_unification.sql:110-118` and `supabase/migrations/20260702161000_a8_aging_basis_unification.sql:230-255`.
- The customer email calls that gross figure `current balance` and `Balance Due` at `src/pages/ARaging.tsx:689-713`.
- The PDF labels the same figure `BALANCE DUE` / `Total Outstanding` at `src/lib/statementPdf.ts:153-158`, `src/lib/statementPdf.ts:282-285`, and `src/lib/statementPdf.ts:468-473`.
- The live `get_ar_aging(date)` contract separately exposes `open_credit_cents`, proving the system already distinguishes gross receivables from unapplied credit; the detailed statement contract exposes no equivalent disclosure.

**Business risk**

A customer can receive a statement demanding the full gross receivable without any indication that an unapplied credit memo exists. Even if gross AR remains the chosen accounting view, the document's wording can overstate what the customer reasonably believes is payable.

**Suggested fix**

Preserve the intentional gross-AR calculation, but add explicit `open_credit_cents` disclosure and label the figures unambiguously (for example, `Gross Open Invoices`, `Unapplied Credits`, and an owner-approved payable/net presentation). Do not silently change the accounting convention without Mason's decision.

**Prevention**

Add a statement/email fixture with one positive posted invoice and one negative posted credit memo. Assert that the output either shows the credit and approved gross/net labels or follows another explicitly approved policy; never allow a bare gross value to be labeled simply `Balance Due`.

## Verified Safe

- The prior Section 2 HIGH and MED are fixed live: `_get_customer_statement_scoped_impl(uuid,date,date)` emits an opening-balance row and orders its running window by date, source rank, and stable id with an explicit `ROWS` frame.
- Live money levers remain integer cents, and `invoices.balance_cents` is generated rather than directly writable.
- The audited payment, prepay, write-off, credit-application, invoice-lifecycle, and finance-charge entry points have one current public overload each, fixed `search_path`, no anon EXECUTE, and no direct update of generated `invoices.balance_cents` in the catalog scan.
- Live finance-charge generation retains active-actor/admin checks, required idempotency, period gating in its private implementation, a month-keyed advisory lock, and month-level duplicate detection.
- Live catalog triggers retain allocation-over-payment enforcement, immutable financial-audit logging, immutable credit-memo applications, prepay-balance recomputation, and invoice status-transition enforcement.

## Process Deviations and Scope Limits

- One read-only reviewer mistakenly ran `npm run graph:refresh`, which rewrote gitignored local artifacts under `graphify-out/` outside the permitted audit folder. No tracked or application/source file changed. The artifacts were left in place because deletion was not authorized.
- One completeness reviewer mistakenly ran aggregate live business-row count probes despite the structure-only boundary. Those results were discarded and are not cited or relied upon anywhere in this report. No live data was mutated.
- No Sentry, Vercel, GitHub PR, browser-session, production runtime telemetry, Edge Function logs, or customer row contents were used.
- No app/source code, migration, database row, grant, deployment, commit, branch, or tracked file outside `docs/audits/gauntlet/` was changed.

## Gate and Next Action

The evidence-backed findings are verified, but the section gate is **not settled** because the starting checkout was dirty and the run had the two process deviations above. The next queued run should repeat Section 2 from a clean current `origin/main` checkout, using catalog-only evidence, before advancing to Section 4.
