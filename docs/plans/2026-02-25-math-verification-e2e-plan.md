# Math & Business Logic Verification E2E Tests — Implementation Plan

> **Created:** February 25, 2026
> **Status:** READY TO BUILD
> **Goal:** Playwright tests that verify real dollar amounts, inventory quantities, tier pricing, and calculations flow correctly through every workflow step — not just that buttons exist.

## Problem Statement

Current E2E tests verify UI interactions (pages load, buttons click, forms submit). They do NOT verify:
- Invoice line item math: `qty × rate = line_total`, line totals sum to invoice total
- Inventory quantities update correctly after deliveries/returns/cancellations
- Quote pricing calculations produce correct totals based on tier
- Payment allocations reduce balances by the right amount
- Commission splits calculate correctly from order totals
- Prepayment balances track accurately through application
- Finance charge math on overdue invoices

These are the bugs that actually matter in production. A button can "work" while silently producing wrong numbers.

## Architecture

### Approach: Extract-and-Verify

Each test will:
1. Navigate to a real page with real data
2. **Extract numbers** from the DOM (text content, input values)
3. **Parse** them into numeric values (strip `$`, `,`, handle cents)
4. **Recalculate** expected values independently
5. **Assert** the displayed values match the calculated values

### Shared Utility: `tests/e2e/utils/math-helpers.ts`

```typescript
// Parse "$1,234.56" → 123456 (cents)
export function parseDollars(text: string): number;

// Parse "1,234" → 1234
export function parseQuantity(text: string): number;

// Compare cents values with tolerance for rounding
export function assertCentsEqual(actual: number, expected: number, tolerance?: number): void;

// Sum an array of dollar strings
export function sumDollarStrings(texts: string[]): number;
```

### Key Source Files to Reference

| File | What to Extract |
|------|----------------|
| `src/pages/InvoiceDetail.tsx` | Line items table, totals section, balance display |
| `src/pages/QuoteBuilder.tsx` | Line items with tier pricing, subtotal, total |
| `src/pages/PaymentAllocation.tsx` | Payment amount, allocation grid, remaining balance |
| `src/pages/CustomerDetail.tsx` | Account balance, outstanding invoices tab |
| `src/pages/Products.tsx` | Tier 1/2/3 prices, inventory quantities |
| `src/pages/Deliveries.tsx` / `DeliveryDetail.tsx` | Delivery quantities, inventory impact |
| `src/pages/PurchaseOrderDetail.tsx` | PO line items, received quantities, costs |
| `src/pages/Inventory.tsx` | Available qty, allocated qty, total qty |
| `src/pages/CommissionPayments.tsx` | Commission amounts, split percentages |
| `src/pages/MonthEndClose.tsx` | Revenue totals, period summaries |

## Test Files (6 files, ~60 tests)

---

### File 1: `tests/e2e/math-invoice-verification.spec.ts` (~12 tests)

**Purpose:** Verify every invoice's internal math is correct.

| ID | Test | What It Verifies |
|----|------|-----------------|
| IV1 | Navigate to posted invoice, extract line items | qty × unit_price = line_amount for EACH line |
| IV2 | Sum all line amounts | Sum of line amounts = displayed subtotal |
| IV3 | Verify total amount | Subtotal (+ any adjustments) = total_amount displayed |
| IV4 | Verify balance calculation | balance = total - paid - prepay_applied - write_offs |
| IV5 | Check invoice with partial payment | Paid amount + remaining balance = total |
| IV6 | Check fully paid invoice | Balance = $0.00, paid = total |
| IV7 | Check voided invoice | All amounts zeroed |
| IV8 | Check chemical_sale invoice math | Same line-item math for CS- type |
| IV9 | Navigate invoice list, sum outstanding | Sum of individual balances = any displayed total |
| IV10 | Verify invoice PDF totals match page | Open print dialog, check total matches detail page |
| IV11 | Check credit memo math | CM amounts are negative, verify signs |
| IV12 | Multi-line invoice cross-check | 3+ line items all independently verified |

---

### File 2: `tests/e2e/math-quote-pricing.spec.ts` (~10 tests)

**Purpose:** Verify quote pricing math including tier-based pricing.

| ID | Test | What It Verifies |
|----|------|-----------------|
| QP1 | Open existing quote, extract line items | Each line: qty × price_per_unit = line_total |
| QP2 | Verify tier pricing applied | Product tier price matches what's in the quote line |
| QP3 | Sum line totals | Sum of all line totals = quote subtotal |
| QP4 | Verify quote total | Subtotal = displayed total (no tax in this system) |
| QP5 | Create new quote, add product, verify math | Add 1 product, check qty × tier_price = line total live |
| QP6 | Change quantity, verify recalculation | Modify qty, confirm new line total = new_qty × price |
| QP7 | Multiple products, verify grand total | Add 2+ products, verify sum |
| QP8 | Verify $/acre calculation | For field_application: rate × acres = total |
| QP9 | Grower share pricing | If grower has price_override, verify it's used |
| QP10 | Quote → Order → Invoice total consistency | Same dollar amount carries through all 3 stages |

---

### File 3: `tests/e2e/math-payment-allocation.spec.ts` (~10 tests)

**Purpose:** Verify payment allocation math and balance updates.

| ID | Test | What It Verifies |
|----|------|-----------------|
| PA1 | Open customer with outstanding invoices | Sum of invoice balances = displayed total outstanding |
| PA2 | Navigate to payment allocation page | Verify customer balance shown matches |
| PA3 | Enter payment amount, verify allocation grid | Allocation suggestions sum ≤ payment amount |
| PA4 | Auto-allocate (oldest first) | Oldest invoice gets allocated first, amounts correct |
| PA5 | Partial payment on one invoice | Invoice balance reduced by exact payment amount |
| PA6 | Overpayment creates prepay | Payment > total outstanding → difference goes to prepay balance |
| PA7 | After payment, verify invoice balances updated | Each invoice's new balance = old balance - allocated amount |
| PA8 | Multiple invoices allocated | Total allocated across all invoices = payment amount |
| PA9 | Prepay application reduces balance | Apply prepay to invoice, balance decreases by prepay amount |
| PA10 | Customer statement totals | Statement shows correct aging buckets summing to total |

---

### File 4: `tests/e2e/math-inventory-flow.spec.ts` (~10 tests)

**Purpose:** Verify inventory quantities track correctly through operations.

| ID | Test | What It Verifies |
|----|------|-----------------|
| INV1 | Read product inventory page | Available + allocated + on_order = total displayed |
| INV2 | Check inventory before delivery | Record starting quantity for a product |
| INV3 | Complete a delivery, verify deduction | Inventory decreased by exact delivery quantity |
| INV4 | Cancel a delivery, verify restoration | Inventory restored by exact cancelled quantity |
| INV5 | Process a return, verify restock | Inventory increased by exact return quantity |
| INV6 | PO receiving increases inventory | Receive PO items, inventory goes up by received qty |
| INV7 | Quote commit creates hold | Committing a quote increases "allocated" by ordered qty |
| INV8 | Manual inventory adjustment | Add X units manually, verify total increases by X |
| INV9 | Cycle count discrepancy | If count differs from system, verify adjustment amount |
| INV10 | Multiple operations net effect | Start qty + receives - deliveries + returns = end qty |

---

### File 5: `tests/e2e/math-commission-verification.spec.ts` (~8 tests)

**Purpose:** Verify commission calculations from orders.

| ID | Test | What It Verifies |
|----|------|-----------------|
| CM1 | Open commission payments page | Verify commissions exist and have dollar amounts |
| CM2 | Commission = order_total × split_percentage | For each commission, amount = order total × percentage |
| CM3 | Sum all splits = 100% | All commission splits on one order sum to 100% |
| CM4 | Dollar amounts match percentages | If 60/40 split on $1000 → $600 + $400 |
| CM5 | Multiple recipients correct | Each recipient gets their percentage of order total |
| CM6 | Unpaid vs paid totals | Sum of unpaid + sum of paid = total commissions |
| CM7 | Season filter totals | Filtered view total matches sum of visible rows |
| CM8 | Commission from quick delivery | Quick delivery commissions use same split logic |

---

### File 6: `tests/e2e/math-end-to-end-workflow.spec.ts` (~10 tests, serial)

**Purpose:** Follow $$ through the ENTIRE workflow and verify at every step.

This is the crown jewel — a single workflow that tracks exact dollar amounts from quote creation to final payment, verifying the math never goes wrong.

| ID | Test | What It Verifies |
|----|------|-----------------|
| E2E1 | Login, record starting state | Capture customer balance, product inventory, product tier price |
| E2E2 | Create quote with known product/qty | qty × tier_price = line_total = quote_total |
| E2E3 | Commit quote → verify order total | Order total = quote total (no drift) |
| E2E4 | Verify inventory hold created | Allocated qty increased by order qty |
| E2E5 | Post invoice from order | Invoice total = order total = quote total |
| E2E6 | Verify customer balance increased | Customer balance increased by exactly invoice total |
| E2E7 | Schedule and complete delivery | Delivery qty = order qty, inventory decreased by qty |
| E2E8 | Record payment for full amount | Payment amount = invoice total |
| E2E9 | Verify invoice balance = $0 | paid = total, balance = 0 |
| E2E10 | Verify customer balance returned to starting | Starting balance + 0 remaining = back to original |

---

## Implementation Notes

### Number Extraction Patterns

```typescript
// Get text from a table cell
const amount = await page.locator('td:nth-child(4)').textContent();
const cents = parseDollars(amount!); // "$1,234.56" → 123456

// Get value from an input
const qty = await page.locator('input[name="quantity"]').inputValue();
const qtyNum = parseInt(qty, 10);

// Get from a summary row
const total = await page.locator('[data-testid="invoice-total"]').textContent();
// OR more commonly:
const total = await page.locator('text=Total').locator('..').locator('text=$').textContent();
```

### Dealing with Real Data

Tests should work with whatever data exists in the system:
- **Don't hardcode expected values** — calculate them from what's on screen
- **Cross-verify** instead: "line items sum to subtotal" not "subtotal is $500"
- **For workflow tests (File 6):** Create fresh data via the UI, capture amounts at each step, verify consistency across steps
- **Use `test.skip()`** for data-dependent tests when preconditions aren't met (e.g., no overdue invoices for finance charge test)

### Money Format

This app uses bigint cents internally but displays as dollars:
- `total_amount_cents: 123456` → displayed as `$1,234.56`
- `balance_cents` is GENERATED: `total_amount_cents - paid_amount_cents - prepay_applied_cents - write_off_cents`
- Always compare in cents to avoid floating-point issues

### Tolerance

- Most comparisons should be exact (cents are integers)
- Rounding tolerance of ±1 cent for percentage-based calculations (commissions, finance charges)
- `assertCentsEqual(actual, expected, 1)` for those cases

## Priority Order

1. **File 6: End-to-end workflow** — Highest value, catches systemic drift
2. **File 1: Invoice math** — Most common user-facing numbers
3. **File 4: Inventory flow** — Hardest to debug when wrong
4. **File 3: Payment allocation** — Money moving between accounts
5. **File 2: Quote pricing** — Tier pricing correctness
6. **File 5: Commission verification** — Revenue sharing accuracy

## Run Command

```bash
# All math verification tests
npx playwright test math-

# Individual file
npx playwright test math-end-to-end-workflow
npx playwright test math-invoice-verification
```

## Success Criteria

- All ~60 tests pass with real production-like data
- Zero hardcoded expected values (all cross-verified from page content)
- Every test that passes means "the numbers on this page are mathematically consistent"
- End-to-end workflow proves dollars don't drift across the full lifecycle
