# Test Coverage Analysis — 2026-08-04

Measured on branch `claude/test-coverage-analysis-3thnt5`, commit base `main`.
Command: `npx vitest run --coverage`. Full run: **314 files, 4157 passed, 123 skipped, 284s**.

## Measured baseline

| Metric | Current | vite.config gate | Headroom |
|---|---|---|---|
| Lines | **47.11%** (17427/36988) | 36 | +11.1 |
| Statements | **44.71%** (18813/42076) | 34 | +10.7 |
| Branches | **37.85%** (13460/35561) | 27 | +10.9 |
| Functions | **34.07%** (3391/9953) | 24 | +10.1 |

Coverage is materially higher than the last recorded baseline (2026-07-13:
37.77 / 28.77 / 25.49 / 35.93). The ratchet floor has not been raised to match.

### Where the uncovered code is

| Area | Lines % | Functions % | Uncovered lines |
|---|---|---|---|
| `src/pages` | 33.6% | 20.6% | **13,361** |
| `src/components` | 48.2% | 41.9% | 4,481 |
| `src/lib` | 79.9% | 82.8% | 1,564 |
| `src/hooks` | 81.3% | 85.9% | 47 |

`src/lib` and `src/hooks` are in good shape. **76% of all uncovered lines are in
`src/pages`** — the layer that composes RPC calls, mutation sequencing, and money
display. Test effort has gone to pure helpers; the orchestration layer is largely
unexercised.

---

## Finding 1 — ~30 test files assert against frozen artifacts and cannot fail

A family of tests (`moneyInventoryGauntletFixes`, `gauntletRemediationGuards`,
`section9PoApRemediation`, `productCostBasis*Migration`, `vendorBillPeriodCloseLock`,
and ~25 others) `readFileSync` a specific historical migration and assert
`expect(sqlText).toContain('...')`.

Example — `src/lib/moneyInventoryGauntletFixes.test.ts:309`:

```ts
expect(poInitialStatus).toContain(statusGuard);
expect(poInitialStatus).toContain('INVALID_INITIAL_PO_STATUS');
```

`poInitialStatus` is the text of `20260716144353_lock_purchase_order_initial_status.sql`.
Per the CRX hard rule, applied migrations are **never edited**. So these assertions
can only fail if the file is deleted or renamed — never because the guard they
describe stopped being true.

They do not detect the thing they exist to prevent. Cross-referencing every
migration pinned by a test against later redefinitions of the same function:

**33 pinned migrations → 20 pinned-function/later-redefinition pairs.**

| Function | Pinned in | Redefined since |
|---|---|---|
| `save_purchase_order` | `20260716120104_gauntlet_access_boundaries` | **10×**, latest `20260717085512_canonicalize_bu…` |
| `generate_finance_charges` | `20260716120112_gauntlet_money_workflows` | 2×, latest `20260721125937_ignore_voided_f…` |
| `preview_finance_charges` | `20260716120112_gauntlet_money_workflows` | 2× |
| `save_invoice` | `20260716120112_gauntlet_money_workflows` | 2× |
| `create_vendor_bill` | `20260717010000_close_final_…` | 2×, latest `20260730114102_vendor_bill_per…` |
| `enforce_delivery_accounting_period` | `20260716152906_guard_delivery_closed_periods` | 2× |

`save_purchase_order` has been redefined ten times since the migration whose text
these tests assert on. The suite is green regardless of what the *current* function
body does. `complete_delivery` is redefined 21× across the migration history and
`void_payment` 13× — this is a live drift surface, not a hypothetical one.

**Proposal.** Replace text-pinning with assertions against the *effective* schema:
introspect `pg_get_functiondef()` for the current definition of each guarded
function, or snapshot the resolved final-state SQL. Keep the intent of every
existing assertion; change what it reads from.

---

## Finding 2 — the entire SQL layer has no executable tests

413 `CREATE OR REPLACE FUNCTION public.*` definitions across 848 migrations;
253 distinct RPCs called from the frontend. There are **zero pgTAP or SQL-level
tests** in the repo.

This is the highest-value gap because `AGENTS.md` deliberately puts the invariants
there: *"Inventory and financial invariants belong in PostgreSQL RPCs/triggers, not
only in React."* The money and inventory correctness rules live almost entirely in
SQL, and nothing executes that SQL in a test.

The compensating controls are all weaker than they look:
- Text-pinning tests — Finding 1, can't fail.
- `schemaIntegrityLive.test.ts` — 13 `describe.skipIf(!isLiveDB)` blocks covering RLS
  enablement, idempotency bodies, `SECURITY DEFINER` search paths, CHECK constraints.
  **CI never sets `CRX_LIVE_SCHEMA_TESTS`** (confirmed: no reference in `.github/`), so
  every one of these is skipped on every PR.
- `rpcFixtureLiveDiff.test.ts` — a hand-pasted `LIVE_PG_PROC_NAMES_CSV` snapshot with a
  manual regeneration note. Stale by construction between refreshes.

**Proposal.** Stand up an ephemeral Postgres (Supabase branch or `supabase start`),
apply migrations, and run pgTAP against the money/inventory RPCs. Start with the six
most-redefined and highest-risk: `complete_delivery` (21 redefinitions),
`save_purchase_order` (15), `create_quick_delivery` (14), `void_payment` (13),
`generate_finance_charges` (13), `record_invoice_payment` (10). Assert the invariants
the text tests currently describe — idempotency replay, closed-period rejection,
cents integrality, status transitions.

---

## Finding 3 — 99.4% of the E2E suite never runs in CI

94 spec files, **1,075 `test()` blocks**. CI runs `npm run test:e2e:smoke`, which greps
`@smoke` — present in **6 tests across 6 files**.

Never gated on: `math-invoice-verification`, `math-commission-verification`,
`math-payment-allocation`, `math-inventory-flow`, `golden-path-quote-to-payment`, and
all nine `golive/stream*` suites. The behavioral money coverage that would catch a
cents/allocation regression exists and is not enforced.

> **Correction, 2026-08-31.** The sentence above is wrong in a way that *understates* this
> finding. CI does not run `npm run test:e2e:smoke`: the `e2e-smoke` job in `ci.yml` has been
> pinned `if: false` since `0474fa47` (2026-05-18, "disable E2E smoke job until staging Supabase
> exists"), which is two and a half months *before* this audit was written. The claim was
> therefore false when made, not merely overtaken by events. The real figure is not 99.4% — it is
> **100%**, including the 6 `@smoke` tests this finding treats as covered. CI provides no browser
> coverage at all. Original text left intact; see
> `docs/changelog.d/2026-08-31-ci-claims-no-browser-coverage.md`.

The cause is structural, not neglect: `playwright.config.ts` points at
`http://localhost:5173` backed by `VITE_SUPABASE_URL` — the **production** Supabase
project. Running 1,075 mutating tests against production is not an option, so the suite
was correctly left out of CI.

**Proposal.** This blocks on the same infrastructure as Finding 2. Once an ephemeral
seeded database exists, promote the `math-*` and `golive/stream4-financials` +
`stream5-payments-prepay` suites into a required check. Until then, the accurate
statement is that the E2E suite is a manual tool, not a regression gate — worth saying
plainly in `docs/` so it isn't mistaken for CI coverage.

---

## Finding 4 — mirror tests: green tests over duplicated logic, 0% real coverage

Six files carry a test file yet execute under 15% of their lines:

| File | Coverage | Uncovered |
|---|---|---|
| `src/pages/NewDelivery.tsx` | **0.0%** | 236 |
| `src/pages/FieldStop.tsx` | **0.0%** | 221 |
| `src/pages/LabelReview.tsx` | **0.0%** | 213 |
| `src/components/customers/BulkCustomerImport.tsx` | 10.1% | 151 |
| `src/lib/loaderWorksheetPdf.ts` | 4.8% | 120 |
| `src/components/receiving/ReceivingHubPanel.tsx` | 4.0% | 97 |

The reason is explicit in the tests. `NewDelivery.driver-guardrail.test.tsx` builds a
`DriverGuardrailHarness` component and comments:

> `// Mirror of the effect block in src/pages/NewDelivery.tsx (lines 214-220).`
> `// Keep deps array IDENTICAL to the page's.`

The test asserts on a copy. If someone edits the real deps array, the test still
passes — it is pinned to a line range that has already drifted. `DispatchBoard.idempotency.test.ts`
uses the same approach ("independent of the heavily-mocked full-component render"),
as does `FieldStop.idempotency.test.ts` (hook-level, "no heavy FieldStop render").

At least 11 test files self-describe as mirroring or re-implementing source logic.

The instinct was reasonable — these pages are hard to render. But a mirror test buys
confidence it cannot deliver. **Proposal:** extract the mirrored logic out of the page
into a `src/lib` helper the page imports, then test the helper. One change kills the
duplication and produces real coverage; `src/lib` is already at 79.9%, so the pattern
demonstrably works here.

---

## Finding 5 — money-critical UI at 0%, and weak branch coverage where lines look fine

Worst-covered money/inventory files:

| File | Lines | Branches |
|---|---|---|
| `src/components/prepay/PrepaymentManagerPanel.tsx` | **0.0%** | 0% |
| `src/components/prepay/PrepayWorkspacePanel.tsx` | **0.0%** | 0% |
| `src/components/field-invoices/CustomerInvoiceSummaryPanel.tsx` | **0.0%** | 0% |
| `src/pages/PaymentHistory.tsx` | **0.0%** | 0% |
| `src/lib/invoiceSummaryPdf.ts` | **0.0%** | 0% |
| `src/pages/FieldAppSplitInvoiceEditor.tsx` | 29.5% | 15% |
| `src/pages/Invoices.tsx` | 32.0% | 10% |
| `src/pages/PaymentAllocation.tsx` | 33.1% | 16% |
| `src/pages/CommissionPayments.tsx` | 35.0% | 26% |
| `src/pages/InventoryPage.tsx` | 44.1% | 29% |

Prepay is customer money held on account and is entirely unexercised at the UI layer.

Separately, note the line-vs-branch spread in files that *look* covered:
`src/lib/statementPdf.ts` is 88.1% lines but **54% branches**; `src/lib/invoicePdf.ts`
83.9% / **61%**. The happy path is tested; the conditionals — zero balance, credit
memo, multi-page, missing customer — are not. Branch coverage is the more honest
metric for this codebase and is the one worth ratcheting.

---

## Finding 6 — `src/lib/money.ts` is untested, and its own documented rule is violated everywhere

`money.ts` is the canonical formatter for a codebase where money is bigint cents. It
has **no test file**. Its header warns:

> ⚠️ Do NOT re-alias these to a local `fmt` … A single name `fmt` is exactly the
> cents-vs-dollars ambiguity this module was created to remove.

Roughly 30 call sites do exactly that — `formatCents as fmt`, `formatUSD as fmt` —
so both semantics again appear under one name. The header notes a lint rule "is
possible future hardening — deliberately not added yet."

I checked every `formatUSD` call site that passes a `*_cents` value. **All are correct**
— each divides by 100 explicitly (`fmt(inv.balance_cents / 100)` in `OrderDetail.tsx`,
`CustomerDetail.tsx`, `Quotes.tsx`). No live bug. But correctness rests entirely on a
manual `/100` that nothing checks; omitting it renders a 100× amount silently.

**Proposal.** Add `money.test.ts` (cheap, ~20 lines: rounding, negatives, zero, the
cents/dollars distinction). Then either enable the lint rule the file already
contemplates, or introduce a branded `Cents` type so the compiler rejects the mixup
instead of relying on a comment.

---

## Other untested modules worth noting

No test file, ordered by size: `masterMixSummaryPdf.ts` (363), `invoiceSummaryPdf.ts`
(298), `projectedUseReportPdf.ts` (255), `xlsxArchiveSafety.ts` (223),
`chemicalSummaryReportPdf.ts` (214), `loaderWorksheetFetch.ts` (185),
`masterMixSummaryFetch.ts` (167), `deliveryCompletionEmail.ts` (123), plus
`statementBalance.ts`, `splitBillingSetting.ts`, `jobChemicalPayload.ts`.

`statementBalance.ts` and `jobChemicalPayload.ts` are small, pure, money/payload-shaping
and trivially testable — good first PRs.

Largest untested pages: `JobDetail.tsx` (4,464 lines, **0% coverage**, 13 RPC calls,
10 `.update()`, 2 `.delete()`), `TeamBoard.tsx`, `Reports.tsx`, `SettingsPage.tsx`,
`NewOrder.tsx`, `FieldView.tsx` — all at 0%.

---

## Recommended order

Ranked by risk-reduction per unit of effort.

1. **Raise the coverage ratchet** to just under measured (lines 45, statements 43,
   branches 36, functions 32). Ten minutes; stops the current gains from eroding.
   The floor is ~11 points stale.
2. **`money.test.ts` + the small pure modules** (`statementBalance`, `jobChemicalPayload`,
   `splitBillingSetting`). Hours, not days.
3. **Convert the ~30 text-pinning tests to effective-schema assertions** (Finding 1).
   This is the one that converts guaranteed-pass tests into real ones. `save_purchase_order`
   first — ten redefinitions of drift behind it.
4. **Ephemeral seeded database.** Unblocks both Finding 2 (pgTAP on the six
   most-redefined RPCs) and Finding 3 (promote the `math-*` E2E suites to a required
   check). Largest effort, largest payoff — and it also lets CI stop skipping the 13
   live-schema `describe` blocks.
5. **Prepay + payment-allocation UI tests** (Finding 5) — money-handling components at 0%.
6. **Refactor mirror tests into importable helpers** (Finding 4). Do this opportunistically
   whenever one of those pages is touched, rather than as a dedicated sweep.

## Verification note

Coverage numbers are from a full local `vitest run --coverage` on this branch and were
observed directly. Findings 1 and 4 were verified by reading the test sources and by
cross-referencing pinned migrations against later redefinitions programmatically.
Finding 3's counts are from grepping `tests/e2e`. No live database was queried and
nothing was mutated; the live-schema suites remained skipped, as they are in CI.
