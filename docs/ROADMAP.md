# CRX Manager — Roadmap

> **Last updated:** 2026-03-16 | **Owner:** Mason Wells

---

## Priority 1: Team Board Enhancements (IN PROGRESS)

Detailed brainstorm: `docs/plans/2026-03-01-team-board-brainstorm.md`

| # | Feature | Effort | Notes | Status |
|---|---------|--------|-------|--------|
| F1 | Entity Linking (notes → deliveries/orders/customers) | Medium | Foundation for everything else | ✅ Done (Mar 15 — Team Board V2) |
| F2 | "Create Task From Here" buttons on operational pages | Medium | Remove friction between ops and board | ✅ Done (Mar 15 — QuickTaskModal on 5 detail pages) |
| F3 | Delivery Communication Thread | Medium | Biggest operational blind spot | ✅ Partial (Mar 15 — TodaysDeliveries + YesterdayRecap bulletins) |
| F4 | Daily Briefing / Morning Digest | Medium | Immediate value for every role | ✅ Partial (Mar 15 — TodaysDeliveries + YesterdayRecap on Board tab) |
| F5 | Escalation Engine (stale task alerts) | Medium | Prevents things going silent | ✅ Done (Mar 16 — StaleTasksAlert) |
| F6 | Quick Status Updates (driver mobile) | Medium | 5-second field communication | TODO |
| F7 | Workload Visibility | Medium | Better assignment decisions | ✅ Done (Mar 16 — WorkloadView tab) |
| F8 | Recurring Tasks / Checklists | Medium | Automate repeatable ops tasks | TODO |
| F9 | Customer Context Cards on linked notes | Low | Faster decision-making | ✅ Done (Mar 16 — CustomerContextCard) |
| F10 | Handoff Notes (end-of-day) | Low | Institutional memory | TODO |
| F11 | Dispatch Priority Queue | High | Purpose-built coordination | TODO |
| F12 | Read Receipts / Acknowledgment | Medium | Safety & compliance | TODO |
| F13 | Saved Views / Custom Layouts | Medium | Personalization | TODO |
| F14 | Alert → Task Conversion | Medium | Closed-loop accountability | TODO |

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
| D3 | Delivery status notifications to customers | Medium | HIGH | ✅ Done (Mar 16 — email opt-out + in-app notifications) |
| D4 | Delivery Calendar View | Medium | MEDIUM | ✅ Done (Mar 16 — @fullcalendar/react toggle) |
| D5 | Delivery Time Window alerts | Low | MEDIUM |

---

## Priority 4: Code Quality & Infrastructure (FUTURE)

Detailed doc: `docs/plans/2026-03-01-gap-remediation-handoff.md`

| # | Feature | Effort |
|---|---------|--------|
| A1 | `unhandledrejection` safety net in `main.tsx` | 10 min | ✅ Done (Mar 16) |
| A3 | Production sourcemaps → Sentry upload | 30 min | ✅ Done (Mar 16 — needs SENTRY_AUTH_TOKEN in Vercel) |
| A4 | Migrate 47 pages to `runCriticalAction()` | 2-4 hrs | ✅ Done (Mar 16 — overnight session) |
| A5 | Route-level error boundaries | 1-2 hrs | ✅ Done (Mar 16 — inline ErrorBoundary + RouteShell) |
| A6 | Skeleton loading states (10 pages) | 1-2 hrs | ✅ Done (Mar 16 — overnight session) |
| A7 | ESLint `no-console` rule | 5 min | ✅ Done (Mar 16) |
| A8 | Firefox E2E test matrix | 15 min | ✅ Done (Mar 16 — overnight session) |
| A9 | Accessibility lint (`jsx-a11y`) | 2-4 hrs | ✅ Done (Mar 16 — 18 rules at warn) |
| A10 | CSP `unsafe-inline` tightening | 30 min | ⏭️ Skipped (Mapbox needs unsafe-inline) |
| A11 | Request correlation IDs | 2-3 hrs | ✅ Done (Mar 16 — overnight session) |

---

## Priority 5: Database Security (FUTURE)

| # | Feature | Effort |
|---|---------|--------|
| B1 | Add `pg_temp` to 16 SECURITY DEFINER functions with NO search_path | Medium | ✅ Done (Mar 16 — overnight session) |
| B2 | Add `pg_temp` to 141 functions missing it from search_path | Large | ✅ Done (Mar 16 — covered all functions via ALTER FUNCTION) |

---

## Priority 6: Inventory (FUTURE)

| # | Feature | Effort | Impact |
|---|---------|--------|--------|
| C2 | Suggested Reorders / Auto-PO generation | Medium | HIGH |
| C7 | Seasonal Demand Forecasting | High | MEDIUM |

---

## Completed (for reference)

- ~~F1: Entity Linking~~ (Mar 15 — Team Board V2)
- ~~F2: Create Task From Here~~ (Mar 15 — QuickTaskModal)
- ~~F3/F4: Delivery Bulletins~~ (Mar 15 — TodaysDeliveries + YesterdayRecap, partial)
- ~~Team Board V2: photo attachments, mobile optimization~~ (Mar 15)
- ~~Replace window.confirm with ConfirmModal~~ (Mar 15)
- ~~Parallelize Orders/Deliveries DB queries~~ (Mar 15)
- ~~Vitest coverage reporting~~ (Mar 15)
- ~~A1: Unhandled rejection safety net~~ (Mar 16)
- ~~A3: Sentry sourcemap uploads~~ (Mar 16)
- ~~A4: Migrate 47 pages to runCriticalAction~~ (Mar 16 — overnight)
- ~~A5: Route-level error boundaries~~ (Mar 16)
- ~~A6: Skeleton loading states (10 pages)~~ (Mar 16 — overnight)
- ~~A7: ESLint no-console rule~~ (Mar 16)
- ~~A8: Firefox E2E test matrix~~ (Mar 16 — overnight)
- ~~A9: Accessibility lint (jsx-a11y)~~ (Mar 16 — overnight)
- ~~A11: Request correlation IDs~~ (Mar 16 — overnight)
- ~~B1+B2: pg_temp search_path on all SECURITY DEFINER functions~~ (Mar 16 — overnight)
- ~~D3: Delivery status notifications~~ (Mar 16 — overnight, email + in-app)
- ~~D4: Delivery Calendar View~~ (Mar 16 — overnight, @fullcalendar/react)
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
