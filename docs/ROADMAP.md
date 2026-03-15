# CRX Manager — Roadmap

> **Last updated:** 2026-03-15 | **Owner:** Mason Wells

---

## Priority 1: Team Board Enhancements (NEXT UP)

Detailed brainstorm: `docs/plans/2026-03-01-team-board-brainstorm.md`

| # | Feature | Effort | Notes |
|---|---------|--------|-------|
| F1 | Entity Linking (notes → deliveries/orders/customers) | Medium | Foundation for everything else |
| F2 | "Create Task From Here" buttons on operational pages | Medium | Remove friction between ops and board |
| F3 | Delivery Communication Thread | Medium | Biggest operational blind spot |
| F4 | Daily Briefing / Morning Digest | Medium | Immediate value for every role |
| F5 | Escalation Engine (stale task alerts) | Medium | Prevents things going silent |
| F6 | Quick Status Updates (driver mobile) | Medium | 5-second field communication |
| F7 | Workload Visibility | Medium | Better assignment decisions |
| F8 | Recurring Tasks / Checklists | Medium | Automate repeatable ops tasks |
| F9 | Customer Context Cards on linked notes | Low | Faster decision-making |
| F10 | Handoff Notes (end-of-day) | Low | Institutional memory |
| F11 | Dispatch Priority Queue | High | Purpose-built coordination |
| F12 | Read Receipts / Acknowledgment | Medium | Safety & compliance |
| F13 | Saved Views / Custom Layouts | Medium | Personalization |
| F14 | Alert → Task Conversion | Medium | Closed-loop accountability |

---

## Priority 2: Blend Ticket Improvements (FUTURE)

Detailed brainstorm: `docs/plans/2026-03-01-superpower-brainstorm-inventory-delivery-blendtickets.md`

| # | Feature | Effort | Impact |
|---|---------|--------|--------|
| E1 | Per-field confidence display | Low | HIGH |
| E2 | Raw OCR text viewer | Low | HIGH |
| E3 | Batch approve/reject | Low | HIGH |
| E4 | Auto-suggest order match | Medium | HIGH |
| E5 | Lot number OCR extraction | Medium | HIGH |
| E6 | Duplicate ticket detection | Low | MEDIUM |
| E7 | Reprocess OCR button | Low | MEDIUM |
| E8 | Blend math validation at OCR time | Low | MEDIUM |

---

## Priority 3: Delivery Improvements (FUTURE)

| # | Feature | Effort | Impact |
|---|---------|--------|--------|
| D3 | Delivery status notifications to customers | Medium | HIGH |
| D4 | Delivery Calendar View | Medium | MEDIUM |
| D5 | Delivery Time Window alerts | Low | MEDIUM |

---

## Priority 4: Code Quality & Infrastructure (FUTURE)

Detailed doc: `docs/plans/2026-03-01-gap-remediation-handoff.md`

| # | Feature | Effort |
|---|---------|--------|
| A1 | `unhandledrejection` safety net in `main.tsx` | 10 min |
| A3 | Production sourcemaps → Sentry upload | 30 min |
| A4 | Migrate 47 pages to `runCriticalAction()` | 2-4 hrs |
| A5 | Route-level error boundaries | 1-2 hrs |
| A6 | Skeleton loading states (10 pages) | 1-2 hrs |
| A7 | ESLint `no-console` rule | 5 min |
| A8 | Firefox E2E test matrix | 15 min |
| A9 | Accessibility lint (`jsx-a11y`) | 2-4 hrs |
| A10 | CSP `unsafe-inline` tightening | 30 min |
| A11 | Request correlation IDs | 2-3 hrs |

---

## Priority 5: Database Security (FUTURE)

| # | Feature | Effort |
|---|---------|--------|
| B1 | Add `pg_temp` to 16 SECURITY DEFINER functions with NO search_path | Medium |
| B2 | Add `pg_temp` to 141 functions missing it from search_path | Large |

---

## Priority 6: Inventory (FUTURE)

| # | Feature | Effort | Impact |
|---|---------|--------|--------|
| C2 | Suggested Reorders / Auto-PO generation | Medium | HIGH |
| C7 | Seasonal Demand Forecasting | High | MEDIUM |

---

## Completed (for reference)

- ~~Vitest coverage reporting~~ (Mar 15)
- ~~Inventory Valuation cards~~ (Mar 5)
- ~~Batch Adjustments~~ (Mar 2)
- ~~Inventory Transaction Ledger~~ (Mar 2)
- ~~Load Sheet PDF~~ (Mar 2)

---

## Removed from Backlog

| Item | Reason |
|------|--------|
| Inventory Transfer UI (C1) | Not needed |
| Lot/Expiration Tracking (C6) | Not needed |
| Route Optimization / Map View (D1) | Skipped |
| Driver Performance Metrics (D6) | Skipped |
| Recurring Delivery Schedules (D7) | Skipped |
