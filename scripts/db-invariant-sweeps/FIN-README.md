# FIN predicates — C9 financial identity suite

Standing SQL predicates asserting the numeric identities of CRX Manager's money
subsystem (AR, payments, prepay, write-offs, commissions, quote pricing).
Built per `docs/audits/2026-06-10-error-prevention-review.md` §4 C9: the
money-logic errors Codex caught in review (B2 statement double-count, P1A
discarded price overrides) were each a violated numeric identity that a
standing query can assert against the live database.

Scope of this README: the `predicates/fin-*.sql` files only. The runner, the
security predicates, and the allowlist are owned separately (same directory).

## Predicate contract (matches the runner)

- Plain SQL, one statement per file.
- **Rows returned = violations.** A healthy database returns zero rows.
- **First column is a stable identity key** (e.g. `customer:<uuid>`,
  `invoice:<uuid>:paid`, `allocation_set:<uuid>`) so runs diff cleanly.
- Header comment documents: the identity, which historical finding(s) it would
  have caught, expected-zero semantics, and known false-positive modes.
- Read-only. Never DDL/DML.

## Files

| File | Identity | Would have caught |
|---|---|---|
| `fin-ar-statement-balance.sql` | Per customer: all-time net of `get_customer_statement`'s line-source union (transcribed) == SUM(`invoices.balance_cents`) over posted/overdue/paid; plus credit-memo-counted-exactly-once (claimed by at most one credited return, credit conserved across `returns.total_credit_cents` / `return_items` / credit-memo total) | B2 (return credits double-counted on statements) |
| `fin-allocations-bounded.sql` | Per payment allocation set: SUM(`invoice_line_allocations.amount_cents`) <= `total_payment_cents`; cached `total_allocated_cents` == SUM; no NULL-invoice rows under payment sets | C9 "Σ allocations ≤ payment" invariant; partial-write cache drift |
| `fin-prepay-balance.sql` | `customers.prepay_balance_cents` == SUM(`prepay_credits.balance_cents`); per credit: `balance_cents` == `original_amount_cents` − SUM(applications) | Silently-divergent-cache class (P1A shape); will catch the live void_payment reversal bug the first time it fires (see Findings) |
| `fin-commission-split-sum.sql` | Every non-empty `commission_split` on orders/quotes/customers passes the `validate_commission_split_json` rules: sum within 0.01 of 100, non-empty unique recipients, each pct in (0,100] | Pre-validator split rows driving silent commission mis-payment |
| `fin-quote-override-survival.sql` | Per quote (aggregates only): every persisted `quote_items.price_override` survives as `price_per_unit` (save_quote recalc sets ppu = COALESCE(override, tier price)) | P1A (overrides silently rewritten back to tier pricing) — rewrite-after-persist variant |
| `fin-invoice-balance-identity.sql` | Per invoice: `write_off_cents` == SUM(unreversed write_offs); `prepay_applied_cents` == SUM(prepay_applications); `paid_amount_cents` == SUM(active payment-set allocations) + SUM(audited `payment_recorded` legacy payments). (`balance_cents` itself is GENERATED and cannot drift.) | Cached-component drift between ledger insert and invoice UPDATE; one-sided voids |

## Live validation — 2026-06-10, project rhyzpcqhnizqbxphqdkr (read-only)

| Predicate | Violations |
|---|---|
| fin-ar-statement-balance | **0** |
| fin-allocations-bounded | **0** |
| fin-prepay-balance | **0** |
| fin-commission-split-sum | **3** (baseline below) |
| fin-quote-override-survival | **0** |
| fin-invoice-balance-identity | **0** |

Data-volume caveat: the AR subsystem is essentially pre-launch (0 payments,
0 allocation_sets, 0 prepay_credits/applications, 0 write_offs, 2 draft
invoices, 1 `requested` return, 0 quote_items with overrides). The zero counts
above prove the predicates compile and reference real columns (the 42703 class
this suite exists to kill), but only fin-commission-split-sum was exercised by
real violating data. Re-read these counts skeptically after AR goes live.

## Baseline — accepted/known violations (do NOT silently drop)

### fin-commission-split-sum: 3 rows (empty recipient, pre-validator data)

All three are `customers.default_commission_split` rows written before
`validate_commission_split_json` existed; the validator now rejects this exact
shape (`recipient is required`) so the write path cannot reproduce them.
Percentages sum to 100, so commission TOTALS are right, but the recipient is
unattributable — any commission calculated from these defaults pays "nobody".

| identity_key | farm | raw |
|---|---|---|
| `customer:0c703cb9-7bdf-4900-87f7-4952ef1df2d1` | Test Farm Alpha | `{"splits":[{"recipient":"","percentage":100}]}` |
| `customer:144763fa-bb50-489e-bc26-29c09c2c8356` | Yeley Farms | `{"splits":[{"recipient":"","percentage":100}]}` |
| `customer:679200b6-a56d-4fb0-8c20-8a72f2a2366f` | Tim Jondle | `{"splits":[{"recipient":"","percentage":100}]}` |

Disposition: fix the data (set a real recipient or clear the split to
`{"splits":[]}`) via the normal save_customer path, then remove this baseline
section. Until then these 3 rows are the expected result set for this file.

## Findings from the build investigation (code-level, not yet data-visible)

These were found while transcribing live function bodies. The relevant
predicates will fire the first time the code paths run in production; filing
them here so they're fixed before that, not after.

1. **`void_payment` can never reverse overpayment prepay credits.**
   `allocate_payment` creates the credit with
   `source_reference = 'From payment ' || COALESCE(reference_number, check_number, set_id::text)`,
   but `void_payment` searches `source_reference = p_allocation_set_id::text`.
   The prefix guarantees the lookup never matches: voiding an overpaying
   payment reverses the invoice allocations but strands the prepay credit AND
   `customers.prepay_balance_cents`. First production occurrence will surface
   in `fin-prepay-balance` (and the `[VOIDED:` notes-marker exclusion that
   predicate documents will never match anything until this is fixed).

2. **`get_customer_statement` blind spots** (pre-encoded as diagnostics in
   `fin-ar-statement-balance`'s `statement_balance_drift` detail column):
   - Payments recorded via `allocate_payment` are invisible — it writes
     `allocation_sets`, never `payments`, and the statement's payment branch
     reads `payments INNER JOIN orders` only.
   - The invoice branch filters `status = 'posted'` only: a fully-`paid`
     invoice drops its charge line while its payment lines remain (statement
     net goes negative); `overdue` invoices vanish from the statement
     entirely.
   - No `payments.deleted_at` filter — soft-deleted payments still count.
   - Payments with NULL `order_id` are excluded by the INNER JOIN.
     `record_invoice_payment` copies `order_id` from the invoice, and
     `transfer_job_to_invoice` creates invoices with no order — payments on
     job-sourced invoices will be statement-invisible.

## Schema facts verified live (pg_catalog/information_schema, 2026-06-10)

- `invoices.balance_cents` is GENERATED ALWAYS AS
  `(total_amount_cents - paid_amount_cents - prepay_applied_cents - write_off_cents)`.
  Status CHECK: draft, unposted, posted, paid, overdue, voided, cancelled.
  Type CHECK: chemical_sale, field_application, misc_charge, credit_memo.
  Credit memos are stored with **negative** `total_amount_cents`
  (`issue_return_credit` inserts `-v_total`; CHECK constraints exempt
  credit_memo from non-negativity).
- `payments.amount` is **dollars** (numeric); the statement multiplies by 100.
  Payments are keyed by `order_id` — there is no payment→invoice link except
  `financial_audit_log` rows (`operation_type='payment_recorded'`,
  `new_values->>'invoice_id'`, `new_values->>'amount_cents'`).
- Two payment-application paths: legacy `record_invoice_payment`
  (payments row + paid_amount_cents bump + audit row) and
  `allocate_payment` (allocation_sets `entity_type='payment'` +
  `invoice_line_allocations` rows + paid_amount_cents bump; remainder becomes
  an `overpayment` prepay credit). `void_payment` reverses by flipping
  `allocation_sets.is_active` (allocation rows are kept).
- `allocation_sets.entity_type` CHECK: order, invoice, payment. Order/invoice
  sets are bill-to splits (different contract; excluded from fin predicates).
- `prepay_credits.balance_cents` is trigger-maintained from applications
  (`_recompute_prepay_credit_balance`); `prepay_applications` is immutable
  after insert (`_guard_prepay_applications_immutable`) except under
  `app.bypass_ledger_immutability` (void_invoice restore path).
- `write_offs` has `reversed_at` (unreversed rows are the ledger).
- Commission splits: `{"splits":[{"recipient":text,"percentage":numeric}]}` on
  `orders.commission_split`, `quotes.commission_split`,
  `customers.default_commission_split`; rule enforced at write time by
  `validate_commission_split_json` (sum tolerance 0.01, recipients non-empty
  and case-insensitively unique, pct in (0,100], empty array allowed).
- Quote pricing: `save_quote`'s server recalc sets
  `price_per_unit = COALESCE(price_override, tier price)` where tier price is
  `tier1_price` / `COALESCE(tier2_price, tier1_price)` /
  `COALESCE(tier3_price, tier1_price)` off `quotes.tier`
  (NOT `customers.assigned_tier` — `create_quick_delivery` uses assigned_tier,
  quotes do not).

## Running

Each file is a single read-only statement; execute against the live DB (e.g.
via the Supabase MCP `execute_sql` or the suite runner). Any returned row is a
violation; diff the identity keys against the baseline section above. New rows
are findings — report them, never prune them from the predicate.
