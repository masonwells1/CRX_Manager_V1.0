# Codex Audit #1: AR Deprecation Sweep

## CRITICAL INSTRUCTION — READ-ONLY AUDIT, NO CODE CHANGES

**DO NOT write, edit, or modify any files. DO NOT create branches, commits, or PRs. DO NOT run any commands that change state.**

Your job is REVIEW ONLY. Produce a detailed findings report and a proposed fix plan. The developer will hand this plan to Claude for verification before any changes are made.

---

## Context

In CRX Manager V1.0, **AR (Accounts Receivable) is derived from invoices, NOT orders.** The fields `orders.total_paid` and `orders.balance_due` are **DEPRECATED** and should not be used for AR calculations anywhere.

The correct source of AR data is:
- `invoices.balance_cents` (bigint, stored in cents) where `invoices.status = 'posted'`
- All money is stored as **bigint cents** — display code divides by 100

This deprecation was established during the Feb 2026 hardening sprint, but old references may still exist throughout the codebase.

## Your Task

Scan the ENTIRE codebase for any reference to the deprecated AR fields and report every occurrence.

### What to Search For

**In SQL migrations (`supabase/migrations/*.sql`):**
1. `orders.balance_due` — deprecated, should use `invoices.balance_cents`
2. `orders.total_paid` — deprecated, should use invoice payment records
3. Any CTE or subquery that computes AR from the `orders` table instead of `invoices`
4. Any RPC that returns `open_ar_balance` computed from orders
5. Any credit limit check that uses `orders.balance_due * 100` instead of invoice data

**In TypeScript/React (`src/**/*.ts`, `src/**/*.tsx`):**
1. Any reference to `balance_due` from an orders query
2. Any reference to `total_paid` from an orders query
3. Any component displaying AR data — verify where the number comes from
4. Any type/interface that includes `balance_due` or `total_paid` from orders

**In tests (`tests/**/*`):**
1. Any test fixture or mock that uses `orders.balance_due`
2. Any assertion that validates AR from orders instead of invoices

### What to Report for Each Occurrence

```
### Occurrence [N]
- **File:** [path]:[line number(s)]
- **Context:** [is this a read, write, calculation, display, or type definition?]
- **Current code:** [exact code snippet]
- **Impact:** [is this actively returning wrong data, or is it dead code?]
- **Proposed fix:** [exact replacement code — but DO NOT apply it]
- **Risk:** Safe | Moderate | High
- **Requires new migration:** Yes | No
```

### Special Attention Areas

These RPCs are known to use the deprecated field — verify and propose fixes:
- `dashboard_summary()` — CTE "ar" uses `SUM(orders.balance_due)`
- `financial_dashboard_summary()` — CTE "ar" uses `SUM(orders.balance_due)`
- `check_customer_credit_limit()` — uses `SUM(orders.balance_due) * 100`
- `dashboard_summary()` migration 4 — "over_credit" CTE uses `orders.balance_due`

For each RPC fix, the replacement should use:
```sql
-- WRONG (deprecated):
SELECT COALESCE(SUM(GREATEST(balance_due, 0)), 0) AS balance FROM orders

-- CORRECT:
SELECT COALESCE(SUM(GREATEST(balance_cents, 0)), 0) / 100.0 AS balance
FROM invoices WHERE status = 'posted'
```

## Expected Output

### Part 1: Complete Occurrence List
Every single reference to `orders.balance_due` or `orders.total_paid` in the codebase.

### Part 2: Impact Assessment
- How many occurrences are actively returning wrong data in production?
- How many are dead code or type-only references?
- Are any pages displaying incorrect AR numbers to users right now?

### Part 3: Migration Plan
- List every new migration needed (remember: append-only, never edit existing)
- Specify the execution order
- Note which RPCs will have their return values change (could break frontend expectations)

### Part 4: Frontend Changes Needed
- List every component that needs to be updated to consume the corrected data
- Note if any TypeScript interfaces need updating

### Part 5: Test Changes Needed
- List every test that references the deprecated fields
- Note if any test assertions will need to change because the corrected data will differ

---

## IMPORTANT

- **DO NOT WRITE CODE. DO NOT EDIT FILES. REPORT ONLY.**
- This is potentially the highest-severity issue in the codebase — wrong financial data in production
- Be exhaustive. Missing even one occurrence defeats the purpose
- Your output will be reviewed by Claude before any changes are made
