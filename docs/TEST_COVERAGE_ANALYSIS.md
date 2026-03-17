# Test Coverage Analysis — CRX Manager V1.0

**Date:** 2026-03-17
**Current State:** 104 unit test files (1,629 tests) + 82 E2E spec files, CI green

---

## Overall Scorecard

| Category | Score | Notes |
|----------|-------|-------|
| Business logic unit tests | **A** | Excellent edge case coverage |
| UI component unit tests | **B** | Good for `ui/`, new layout + page tests added |
| E2E workflow coverage | **A-** | Strong golden-path and lifecycle coverage |
| Coverage enforcement | **C** | Thresholds now configured (50/40/50/50) |
| Page component tests | **C** | 5 critical pages now tested |
| Accessibility testing | **C** | Partial, no automated axe-core scanning |

---

## What Was Added (March 15, 2026)

### New Unit Tests
- `src/lib/emailService.test.ts` — 8 tests covering pdfToBase64, buildEmailHtml, sendEmail (auth, errors, attachments)
- `src/hooks/useFormDraft.test.ts` — 10 tests covering localStorage persistence, expiry, debounce, visibility flush, corruption
- `src/pages/QuoteBuilder.test.tsx` — 7 tests for the quote builder page rendering and error states
- `src/pages/InvoiceDetail.test.tsx` — 3 tests for invoice detail loading, not-found, and data render
- `src/pages/OrderDetail.test.tsx` — 3 tests for order detail loading, not-found, and data render
- `src/pages/PaymentAllocation.test.tsx` — 3 page tests + 6 autoAllocate unit tests
- `src/pages/MonthEndClose.test.tsx` — 4 tests for month-end page rendering
- `src/components/ui/ConfirmModal.test.tsx` — 9 tests for all variants and interactions
- `src/components/ui/Combobox.test.tsx` — 12 tests for filtering, keyboard nav, ARIA, disabled state
- `src/components/ui/OfflineBanner.test.tsx` — 3 tests for online/offline states
- `src/components/layout/AppLayout.test.tsx` — 6 tests for layout structure and accessibility
- `src/components/layout/Sidebar.test.tsx` — 8 tests for role-based navigation visibility

### Coverage Thresholds
- Added to `vite.config.ts`: lines 50%, branches 40%, functions 50%, statements 50%
- Conservative initial thresholds — ratchet up as coverage improves

---

## Remaining Gaps (prioritized)

| Priority | Gap | Recommendation |
|----------|-----|----------------|
| **P1** | Firefox/WebKit E2E | Add cross-browser projects when CI has browser support |
| **P1** | Mobile viewport E2E | Add iPad Mini project for field-user testing |
| **P2** | Integration tests (local Supabase) | For payment, inventory, commission flows |
| **P2** | `@axe-core/playwright` | Automated accessibility scanning |
| **P2** | Remaining 50 untested pages | Prioritize by complexity and change frequency |
| **P3** | Visual regression for PDFs | Playwright visual snapshots for invoice/statement/quote PDFs |
| **P3** | E2E parallelization | Move from workers:1 to workers:4+ with test isolation |
| **P3** | Edge function unit tests | Reduce reliance on E2E for backend logic |

---

## Strengths

1. **Business logic tests are thorough** — commissionSplit, paymentAllocation, deliveryLifecycle, quoteCalc, financeChargeCalc, reconciliation all cover edge cases
2. **E2E workflow coverage is strong** — mega-workflow (95 steps), golden-path, dedicated workflow specs
3. **Contract tests are excellent** — rpcContracts, rlsContracts, schemaIntegrity validate backend contracts
4. **Role-based E2E tests exist** — role-security, role-sales-rep, role-applicator verify access control
5. **Coverage enforcement now active** — thresholds prevent silent regression
