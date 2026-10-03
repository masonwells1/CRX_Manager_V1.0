# 2026-10-01 — Monthly integrity report (automated)

**Type:** ops / automated routine
**PR:** #861 `ops/integrity-report-2026-10-01`
**Author:** Automated session (Claude Code)

## What ran

Monthly pre-close integrity check against production (`rhyzpcqhnizqbxphqdkr`). All 10 checks from `src/lib/reconciliation.ts` executed via direct SQL against the live DB (read-only).

## Outcome

3 checks FAIL — month-end close is blocked until resolved:

| Check | Result | Discrepancies |
|---|---|---|
| 2 · Inventory Ledger | FAIL | 5 products with ledger/DB mismatch |
| 7 · Delivery-Invoice Qty | FAIL | 153 order+product pairs delivered but not billed |
| 8 · Pre-booked Inventory | FAIL | 1 product prebooked qty off by 211 units |

7 checks PASS (order totals, invoice payments, balance formula, commission splits, quote-hold, return-credit, customer AR).

Full detail tables in `docs/reports/integrity-report-monthly.md`.

## Bug found (not blocking)

`src/lib/reconciliation.ts` checks 3 and 4 filter `status = 'posted'` but no production invoice carries that status. The `/integrity-report` admin page silently checks 0 entities for invoice payments and balance formula. Needs a fix to use `status IN ('overdue','paid')` / `status != 'voided'` respectively.

## Files changed

- `docs/reports/integrity-report-monthly.md` — created (first monthly run)
