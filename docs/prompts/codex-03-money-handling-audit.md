# Codex Audit #3: Money Handling Audit

## CRITICAL INSTRUCTION — READ-ONLY AUDIT, NO CODE CHANGES

**DO NOT write, edit, or modify any files. DO NOT create branches, commits, or PRs. DO NOT run any commands that change state.**

Your job is REVIEW ONLY. Produce a detailed findings report. The developer will hand this to Claude for verification before any changes are made.

---

## Context

CRX Manager V1.0 is an agricultural input dealership ERP. Money handling is critical — incorrect calculations directly affect invoices, payments, and AR balances sent to real customers.

### The Rule

**All money is stored as bigint cents in the database. Display code divides by 100. NEVER use floating point for money.**

- Database columns: `*_cents` suffix (e.g., `balance_cents`, `credit_limit_cents`, `prepay_balance_cents`, `amount_cents`)
- Some legacy columns use dollar amounts WITHOUT the `_cents` suffix (e.g., `orders.total_price`, `orders.total_profit`) — these store dollars as numeric, which is acceptable but must never be mixed with cents columns
- Frontend display: divide cents by 100, format with `Intl.NumberFormat`
- Calculations: always in cents (integer math), convert to dollars only for display
- RPC returns: may return cents or dollars depending on the function — each must be verified

### Common Bugs to Find

1. **Cents/dollars confusion** — adding a cents value to a dollar value, or displaying cents without dividing by 100
2. **Floating point math on money** — `0.1 + 0.2 !== 0.3` in JavaScript
3. **Missing `/100` conversion** — displaying raw cents as if they were dollars
4. **Double conversion** — dividing by 100 when the value is already in dollars
5. **`toFixed()` on money** — can cause rounding errors; should use `Intl.NumberFormat`
6. **String-to-number without coercion** — Supabase returns bigint as string
7. **Multiplication/division order** — `price * quantity / 100` vs `(price * quantity) / 100` can differ due to integer truncation

## Your Task

### Step 1: Find Every Money Column
Search `supabase/migrations/` for columns containing: `price`, `cost`, `amount`, `balance`, `total`, `profit`, `margin`, `commission`, `credit_limit`, `prepay`, `payment`, `charge`, `fee`, `revenue`. For each, note whether it stores cents (bigint) or dollars (numeric).

### Step 2: Find Every Money Display
Search `src/` for:
- `Intl.NumberFormat` with `currency: 'USD'`
- Any function named `fmt`, `format`, `formatCurrency`, `fmtDecimal`, etc.
- Direct `.toFixed(2)` calls
- Template literals with `$` signs
- `.toLocaleString()` with currency options

### Step 3: Find Every Money Calculation
Search `src/` and `supabase/migrations/` for:
- Arithmetic on money fields (`+`, `-`, `*`, `/`)
- `SUM()`, `AVG()` on money columns
- Comparisons between money values (especially cross-column: cents vs dollars)
- `/ 100` and `* 100` conversions

### Step 4: Verify Each Instance
For each money operation found:

```
### Instance [N]
- **File:** [path]:[line]
- **Column/Variable:** [name]
- **Storage format:** cents | dollars | unknown
- **Operation:** display | calculation | comparison | transfer
- **Current code:** [snippet]
- **Issue:** [what's wrong, or "OK" if correct]
- **Proposed fix:** [if needed — DO NOT apply]
```

## Expected Output

### Part 1: Money Column Inventory

| Column | Table | Type | Format | Notes |
|--------|-------|------|--------|-------|
| balance_cents | invoices | bigint | cents | |
| total_price | orders | numeric | dollars | legacy |
| ... | ... | ... | ... | ... |

### Part 2: Findings by Severity

Group findings into:
- **Critical** — wrong amounts displayed to users or stored in DB
- **High** — potential for wrong calculations under certain conditions
- **Medium** — inconsistent formatting, missing coercion
- **Low** — style issues, unnecessary conversions that happen to be correct

### Part 3: Proposed Fix Plan
Ordered list of changes with dependencies noted.

---

## IMPORTANT

- **DO NOT WRITE CODE. DO NOT EDIT FILES. REPORT ONLY.**
- A cents/dollars confusion bug could mean a customer sees $50,000 instead of $500. This is real money.
- Pay special attention to RPCs that do `/ 100.0` — verify the source column is actually in cents
- Your output will be reviewed by Claude before any changes are made
