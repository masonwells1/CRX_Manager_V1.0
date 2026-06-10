# CRX Manager — Roadmap

> **Last updated:** 2026-06-10 | **Owner:** Mason Wells
>
> _Q1 brainstorm docs were moved to `docs/archive/2026-Q1-brainstorms/` and the links below repointed (2026-05-31). Feature statuses reflect the March planning cycle; for current system state see `CLAUDE.md`._

---

## Priority 0: Grower Portal & Agronomy Expansion (VISION — iterating, not yet planned)

**The big bet for 2026–27:** expand CRX from internal ops into customer-facing
services — agronomy (soil/tissue testing, nutrition programs), a grower portal,
grower data uploads, and field profitability analytics.

Detailed living vision doc: **`docs/plans/2026-06-10-grower-portal-brainstorm.md`**
(PR #74 — keep iterating there; this table is the index). Settled so far:
**separate portal app, same Supabase DB**, walled off by RLS + customer-scoped
`portal_*` RPCs and a new `customer` role. Nothing below is scheduled yet — when
the vision settles, each item gets its own `/ship`-grade implementation plan.

| # | Feature | Where | Status |
|---|---------|-------|--------|
| G1 | ⭐ **Chemical tracking & spray compliance** — chemical-shed inventory auto-fed from CRX deliveries, per-field spray checklist (sprayed/not + dates), compliance-grade RUP application log (auto-filled EPA reg #s, append-only), exports | Portal + CRX | VISION (Mason priority — candidate first portal feature) |
| G2 | ⭐ **Follow-up trip timers** — pass logged → residual clock starts (e.g. pre-emerge + 26 days → "2nd trip due"); REI/PHI timers; 14-day records-due nudge; doubles as CRX delivery/crew workload forecast | Portal + CRX | VISION (Mason priority) |
| G3 | ⭐ **Internal crew spray board** — same spray-plan data model for custom acres; passes assigned grower vs CRX crew; likely `spray_passes ↔ jobs`/DispatchBoard link; job completion writes compliance record → flows to invoicing | CRX Manager | VISION (Mason priority) |
| G4 | Field seasons (planting/harvest records, manual tier) + whole-field **breakeven calculator** | CRX first, then portal | VISION |
| G5 | Field season costs w/ auto-suggested lines from the grower's own CRX invoices/applications | CRX + portal | VISION |
| G6 | Soil testing program (grid/zone sampling, results maps, resample tracker) | CRX Manager | VISION |
| G7 | Tissue sampling program (growth-stage schedule, season trend charts) | CRX Manager | VISION |
| G8 | Nutrition / dry-fertilizer program builder → one-click CRX quote; grower e-accepts in portal | CRX + portal | VISION |
| G9 | Grower portal MVP — auth (`customer_users`, `customer` role), read-only: programs, test results, documents, statements | New portal repo | VISION |
| G10 | Spatial yield upload (monitor shapefiles/CSV → cleaned → grid-binned cells) | Portal + Edge Fn | VISION |
| G11 | **Profitability map** — per-cell profit/ac (yield × price − costs), red/green over satellite on the existing Mapbox stack; "worst 10% of acres cost you $X" | Portal + CRX | VISION |
| G12 | Grower financial tools — what-if price sliders, per-field P&L, rented-ground analyzer | Portal | VISION |
| G13 | Notifications (email exists; SMS provider TBD) | Edge Fn | VISION |
| G14 | LLM assistant — Claude API via Edge Function, strictly customer-scoped context | Portal | VISION |
| G15 | Nutrient-removal engine — yield map × removal rates → replacement-fert rec / program input | CRX Manager | VISION |

Parked (revisit later): VR prescription writing, multi-year yield stability maps,
NDVI/satellite layers, PostGIS analytics, grain marketing, cross-grower benchmarking.

---

## Priority 1: Team Board Enhancements (IN PROGRESS)

Detailed brainstorm: `docs/archive/2026-Q1-brainstorms/2026-03-01-team-board-brainstorm.md`

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

Detailed brainstorm: `docs/archive/2026-Q1-brainstorms/2026-03-01-superpower-brainstorm-inventory-delivery-blendtickets.md`

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

Detailed doc: `docs/archive/2026-Q1-brainstorms/2026-03-01-gap-remediation-handoff.md`

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
| A12 | assertRpcResult on all mutation RPCs | 2-3 hrs | ✅ Done (Mar 17 — 30 RPCs across 18 files) |
| A13 | Replace all bare confirm() with ConfirmModal | 1-2 hrs | ✅ Done (Mar 17 — 9 pages, 16 calls) |
| A14 | Wire idempotency keys to all frontend RPCs | 1-2 hrs | ✅ Done (Mar 17 — 15 RPCs across 6 files) |
| A15 | Add logActivity() to ~50 mutation handlers | 3-4 hrs | TODO |
| A16 | Fix TypeScript/DB type mismatches (6 critical) | 1 hr | ✅ Done (4 fixed prior sessions, 2 fixed Mar 26 — removed dropped `balance_due`/`total_paid` from Order type) |
| A17 | Add deny-all RLS policy to rate_limit_log | 5 min | ✅ Done (migration 20260333700000) |

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
- ~~Sentry migration: ~30 console.error → Sentry.captureException~~ (Mar 16)
- ~~A11y: all click-events-have-key-events warnings fixed~~ (Mar 16)
- ~~Phase 4 safety-net tests: overload detection, idempotency, pg_temp contracts~~ (Mar 16)
- ~~Commission audit trail: Reports.tsx → create_commission_payment RPC~~ (Mar 16)
- ~~A12: assertRpcResult on 30 mutation RPCs~~ (Mar 17)
- ~~A13: Replace all bare confirm() with ConfirmModal (9 pages)~~ (Mar 17)
- ~~A14: Wire idempotency keys to 15 frontend RPCs~~ (Mar 17)
- ~~DB migration: p_idempotency_key on 5 RPCs~~ (Mar 17)
- ~~Fix Returns.tsx wrong updated_at column~~ (Mar 17)
- ~~Fix teardown-fixtures.ts wrong entity_id column~~ (Mar 17)
- ~~Fix eslint.config.js stale nested directory~~ (Mar 17)
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
