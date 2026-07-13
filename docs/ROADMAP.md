# CRX Manager — Roadmap

> **Last updated:** 2026-07-13 | **Owner:** Mason Wells
>
> _Q1 brainstorm docs were moved to `docs/archive/2026-Q1-brainstorms/` and the links below repointed (2026-05-31). Feature statuses for Priorities 1–6 reflect the March planning cycle; for current system state see `CLAUDE.md`._

---

## Shipped since last update (2026-06-15 → 2026-07-13)

A large amount landed in this window — see `docs/CHANGELOG.md` for full detail on each. Two categories:

**Items that were open rows on this roadmap and have since shipped** (moved out of their tables below, left a pointer in place):
- **C3** — As-applied vs. billed reconciliation report ("bill every acre you applied") — ✅ **Shipped 2026-06-21** as the Field Invoices "Unbilled Applications" reconciliation view (`/field-invoices/unbilled`), part of the As-Applied / Field Invoices feature merge.

**Major work that shipped in this window but was never an itemized row on this roadmap** (built off later strategic reviews / owner requests, not this document — listed here only so this file doesn't read as if nothing happened; don't expect a 1:1 row match above):
- Sell-side quote-lifecycle roadmap items #2–#7 (booking draw-downs, partial-order conversion, and related quote/order flow work) — shipped live 2026-06-21.
- Field mapping + per-acre billing: two-acre model, shapefile/KML/GeoJSON import, and the USDA Crop Sequence Boundary "click-to-adopt" tool — shipped 2026-06-23 through 2026-07-12.
- ChemMan-parity feature set (map pages, print options, loader worksheets, dispatch/field-editor polish) — 10+ units shipped 2026-07-11/12.
- Mobile overhaul + UI overhaul (bottom nav, phone-card layouts, Office Cockpit consolidation) — shipped 2026-07-11.
- Credit-memo apply (apply a credit memo to an open invoice) — shipped 2026-07-10.
- EPA label lookup Stage 1 (per-product "Look up EPA" + data-quality report) and the in-app Label Data Quality bulk-fix tool — shipped 2026-07-10.
- Inventory-aware scheduling Layer 2 (job reservations draw against bookings) — shipped 2026-07-02.
- Weekly in-database backup (pg_cron) and the off-site encrypted GitHub backup — shipped 2026-07-12/13.
- Workflow-waves (U14–U20) daily-flow/billing/booking/nav fixes and the Today/Office Cockpit dashboard consolidation — shipped 2026-07-09 through 2026-07-11.

---

## ⭐ Strategic Roadmap (2026-06-10 world-class deep dive)

**Source:** `docs/research/2026-06-10-world-class-deep-dive-report.md` (full scored backlog, market research with citations, architecture prework, and the reasoning behind every item below). Opportunity IDs (A1, B1, C1, …) refer to that report. This section supersedes the March priorities below in strategic direction — the March items remain valid as tactical backlog.

**The 5 moves that matter most:**
1. Let customers pay online (ACH pay-now links → grower portal) — biggest gap vs. every competitor
2. Compliance autopilot (weakest area, 2.5/5 → differentiator using data already captured)
3. Bill from the machine (ISOXML as-applied ingestion — category-defining, unserved for small retailers)
4. Expand AI doc-intelligence to vendor bills + price sheets (proven pattern, <$0.01/doc)
5. Field-level profitability (both data halves already in the schema)

### H1 — This season (≤3 months): cash + compliance quick wins
| ID | Item | Effort | Status |
|---|---|---|---|
| A1 | ACH pay-now links on emailed invoices/statements (Stripe ACH, $5 cap) + webhook Edge Function | M | ⏸ Deferred 2026-06-10 (Mason's call — revisit later). To restart: create a Stripe account (stripe.com, ~15 min) and provide the API keys; this also gates the H2 grower-portal payment features (A2/A4). |
| B1 | RUP point-of-sale certification check (warn/block on expired/missing buyer cert) | S | ✅ Done (2026-06-10 — NewOrder banner + InvoiceDetail post-confirm warning, `feat/h1-quick-wins-2026-06-10`) |
| B5 | License-expiry gates on job assignment + renewal reminders | S | ✅ Done (2026-06-10 — jobs trigger + `assign_job_applicator` RPC + Dashboard card, migrations live) |
| B3 | WPS pre-application info sheet auto-generation | S | ✅ Done (2026-06-10 — `wpsNoticePdf.ts` + JobDetail button + products REI/PHI columns live) |
| ~~B6~~ | ~~State dealer report pack~~ | S | ❌ Closed 2026-06-10 — Mason confirmed IL-only; IL requires records on demand and the /compliance RUP register + CSV export already satisfies it (8 Ill. Adm. Code 250.150, 2-yr retention). Reopen only if licensing expands to WI/other reporting states. |
| E3 | Owner's daily brief (cash, AR movement, today's work, exceptions) | S | ✅ Done (2026-06-10 — DailyBrief admin Dashboard card) |
| D1 | Vendor-bill LLM extraction pilot (gate: 10-bill manual accuracy test) | M | ⏸ Deferred 2026-06-10 (Mason's call — revisit later). To restart: attach ~10 real vendor bills (PDF/photo) for the accuracy gate; production build also needs an Anthropic API key in Edge Function secrets. |
| C4 | Weather auto-capture at application time (replace hand-typed entries) | S | ✅ Done (2026-06-10 — Open-Meteo prefill in Complete Job modal) |
| — | **Cheap tests that gate H2:** collect 3 real ISOXML monitor files (C1); CDMS/Greenbook label-data pricing inquiry (B7); A1 click-through data (gates A2) | — | TODO |

### H2 — This year: the two strategic bets
| ID | Item | Effort | Status |
|---|---|---|---|
| P1/P3 | Prework: customer-organization model + server-side PDF generation | M+M | TODO |
| A2 | Grower portal v1 (login, balance, statements, invoice PDFs, pay) | L | TODO |
| A3 | Online quote approval/e-sign in portal (likely industry-first) | M | TODO |
| A4 | Autopay + scheduled payments | M | TODO |
| C1 | ISOXML/ADAPT as-applied file upload → proposed application records (review queue) | L | TODO |
| C3 | As-applied vs. billed reconciliation report ("bill every acre you applied") | S | ✅ Shipped 2026-06-21 — see "Shipped since last update" section above |
| B2 | Dicamba 72-hour record auto-draft | M | TODO |
| B4 | REI/PHI tracking per field + dispatch warnings | M | TODO |
| E4 | Field-level profitability (margin per acre per field/customer/season) | M | TODO |
| D2 | Vendor price-sheet ingestion → proposed cost updates | M | TODO |
| E1 | Driver/applicator mobile workspace (refactor DeliveryDetail into task-first flow) | L | ✅ v1 Done (2026-06-14 — **Field Mode** `/my-route` + `/my-route/:id`, `assign_job_applicator`; PR #80/#81 merged + live). ✅ On-device pass Done (2026-07-11 — mobile overhaul: bottom nav/drawer, compact TopBar, phone-card layouts for Jobs/Dispatch/Inventory/Receiving, full-screen modals, PWA polish). Remaining follow-up: offline replay. |

### H3 — Multi-year: the defensible end-state
| ID | Item | Notes |
|---|---|---|
| C2 | Leaf API integration (John Deere / FieldView / CNH auto-pull) | After C1 proves reconciliation logic |
| B7 | Label-rate validation at blend/order time | Gated on CDMS/Greenbook data licensing |
| E2 | Role-workspace IA redesign (66 flat pages → Sell/Field/Money/Stock) | Only after portal + mobile usage data exists |
| F3 | Multi-tenancy decision point (sell CRX to other retailers?) | Funded decision, not speculative; ~3–4 wk schema retrofit |

### Keep / Change / Kill (current-setup verdicts)
- **KILL:** checks-only payments; no customer-facing surface; compliance-as-passive-register
- **KEEP:** single-tenant (for now); web PWA (no native apps); CRX **is** the ledger (accountant export only, no QuickBooks two-way sync)
- **CHANGE:** OCR-centric intake (machine data above it, manual entry below it); 3 hard-coded price tiers (contract pricing before chasing larger accounts)

### Explicitly NOT building (don't re-add without new evidence)
Native iOS/Android apps · multi-tenancy now · ML demand forecasting (supersedes C7 below) · autonomous AI agents on financial records · QuickBooks two-way sync · grain/energy/feed modules · direct OEM telematics agreements as a first step · big-bang UI redesign.

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

**Design/grounding docs (2026-06-14, verified live):**
[`spray-compliance-data-model.md`](plans/2026-06-14-spray-compliance-data-model.md) (G1–G3 first-build data model) ·
[`portal-roadmap-build-vs-reuse-audit.md`](plans/2026-06-14-portal-roadmap-build-vs-reuse-audit.md) (what's already built vs greenfield across G4–G15 — PostGIS/pg_cron already on, but `orders`/`invoices` lack `field_id` and the `customer` role + `portal_*` RPCs are all greenfield).

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
| ~~C7~~ | ~~Seasonal Demand Forecasting~~ | High | ❌ Dropped 2026-06-10 — deep dive "what NOT to build" (one data point per SKU-season; classical reorder points win at this scale) |

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
