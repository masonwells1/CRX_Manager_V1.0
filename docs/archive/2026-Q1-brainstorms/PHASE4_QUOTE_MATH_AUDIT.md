# Phase 4 — Quote Math Forensics

## Plain-English summary (for Mason)

I moved directly to the next phase.

### Business translation
Your quote math should be like a certified scale at the grain elevator: one trusted number source, same result every time.

Right now, the quote calculator mostly runs in the browser (`QuoteBuilder`) and then writes those totals into the database. That means your “scale” is in the truck cab, not at the elevator office.

If two reps use slightly different client behavior (or a bad network/offline sequence), margin and totals can drift.

---

## QUOTE MATH AUDIT

### 1) Where calculations happen

## Frontend (primary quote calculator)
`src/pages/QuoteBuilder.tsx` computes:
- tier unit price selection (`getTierPrice`),
- unit conversion math,
- `total_units_needed`,
- line `total_price`, `profit`, `net_margin`,
- quote-level totals (`totalPrice`, `totalCost`, `totalProfit`, `totalMarginPct`).

## Backend (order conversion + commissions)
`convert_quote_to_order` RPC in migrations:
- copies quote totals into order,
- builds order items from quote items,
- prebooks inventory,
- computes commission amounts from quote profit and split percentages.

### Key forensic observation
- Backend conversion **trusts persisted quote totals** rather than recomputing full quote pricing from authoritative product/rate/tier inputs at conversion time.

---

### 2) Single source of truth?

**NO (Critical).**

- Quote dollar math is produced in React first.
- Database conversion logic mostly carries through those values.
- This violates the “database is source of truth for financial calculations” rule for high-liability operations.

---

### 3) Test cases (expected vs actual)

> Method note: Browser execution is environment-limited, so these are deterministic forensic calculations using the same formula behavior documented in `QuoteBuilder` logic.

#### Case 1 — Simple quote (1 product, 1 quantity-equivalent)
- Inputs: price/unit `$100`, cost/unit `$80`, rate `1 oz/ac`, acres `128`, inventory unit `gal (128 oz)`.
- Expected total units: `1.00`
- Expected total price: `$100.00`
- Expected profit: `$20.00`
- Expected margin: `20.00%`
- Actual (formula trace): matches expected.

#### Case 2 — Multi-line quote (3 lines)
- Combined expected total price: `$15,187.50`
- Combined expected total profit: `$5,846.88`
- Actual (formula trace): matches expected from frontend formula.

#### Case 3 — Tier pricing break triggered
- Same usage, tier price before break `$150`, after break `$140`.
- Expected line total change: `$150.00` -> `$140.00`
- Actual (formula trace): matches expected.

#### Case 4 — Tier edge threshold exact value
- Edge behavior is driven by selected tier price on quote/customer context (not robust quantity-break table logic).
- Result: no dedicated server-side tier-threshold engine found in quote math path.
- Status: **architecture gap** (tier threshold policy not centrally enforced in DB quote calculator).

#### Case 5 — Commission split (2 reps)
- Profit basis `$5,000`, split 60/40.
- Expected: `$3,000` / `$2,000`.
- Actual: conversion RPC multiplies `v_quote.total_profit * percentage/100`, matching expected arithmetic.

#### Case 6 — Discount + tax order-of-operations
- Required test could not be executed because quote schema/path does not expose first-class quote tax/discount/fee fields in current core quote math model.
- Result: **missing functional domain fields/workflow in quote calculator path**.

---

### 4) Rounding behavior

Detected rounding pattern in frontend quote math:
- line-level quantities/prices/profit rounded to 2 decimals,
- `net_margin` rounded to 4 decimals,
- quote-level totals rounded to 2 decimals after summing.

Risk:
- Line-rounding then summing can diverge from high-precision sum then final rounding, especially at scale.

---

### 5) Edge cases that can produce wrong results

1. **Client-side-only source for quote totals**
   - Any UI/client drift can lock incorrect totals into persisted quote.
2. **No explicit tax/discount/fee canonical engine in quote path**
   - Missing domain fields/order-of-operations means invoices may need ad hoc adjustments.
3. **Tier threshold governance is not represented as a normalized server-side pricing rule table in quote math path**
   - Hard to guarantee consistent break behavior across contexts.
4. **Commission uses quote profit snapshot**
   - If quote profit was wrong upstream, commission payouts inherit the error.

---

### 6) Recommended fix (authoritative location)

Move all quote math to **Supabase RPC + constrained schema model**:

1. Add canonical quote-pricing RPC (`calculate_quote_totals`) that accepts quote item inputs and returns normalized line + header totals.
2. Persist only RPC-computed totals (frontend displays result, does not author it).
3. Add explicit quote fields/tables for discounts, taxes, fees and codify operation order in RPC.
4. Require convert-to-order RPC to recompute/validate totals server-side before order insert.
5. Add deterministic rounding policy in DB function (single rounding strategy everywhere).

---

## Phase progression

Proceeding next into **Phase 5: Inventory Integrity Forensics**.
