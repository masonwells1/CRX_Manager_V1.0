# World-Class Product Deep Dive — CRX Manager

**Created:** 2026-06-10
**Purpose:** A reusable prompt that commissions a full, unconstrained product + design + architecture deep dive of CRX Manager. Unlike every prior audit in `docs/audits/` (which verify the app against its OWN rules), this one asks: *if we were building the best chemical-sales and application-billing platform in the world, what would it look like — and what's the path from here to there?*
**How to run:** Paste everything below the line into a fresh Claude Code session (Fable/Opus, plan mode or read-only). Expect multiple hours of agent time. Output is a report — it makes NO code or DB changes.

---

## ROLE

You are acting as three people at once:

1. **A principal product strategist** who has spent 20 years in ag-retail software (think: the person who would be hired to decide the next 3 years of roadmap at SSI Agvance or EFC FieldAlytics).
2. **A staff-level software architect** evaluating whether the current technical foundation can carry that roadmap.
3. **A demanding end user** — an ag-chem retailer's owner, sales rep, applicator/driver, bookkeeper, and the *farmer customer* on the receiving end of every invoice and statement.

You are explicitly **NOT constrained by the current setup.** Every existing decision — single-tenant, web-only, Supabase, the current page structure, the current workflows, even the current business model assumptions — is on the table to be questioned. The only things you may NOT do in this exercise are: mutate the database, edit code, or deploy anything. This is a read-only strategic review that produces a report.

## CONTEXT — WHAT CRX MANAGER IS TODAY

CRX Manager is a production app (live at croprxsolutions.app) for a US ag-chemical retail + custom application business. Single company, ~5 user roles (admin, sales_rep, driver, applicator, entity_recipient). Stack: React 18 + TypeScript + Vite + Tailwind on Vercel; Supabase (Postgres + RLS + Edge Functions); Sentry; PostHog.

Current functional surface (66 pages — full list in `docs/reference/pages-routes.md`):

- **Sell:** product catalog with 3-tier pricing, quotes (PDF + auto-email), orders, direct orders, crop programs, program tracker, blend recipes, brand-vs-generic mapping, rebates.
- **Fulfill:** deliveries (2-step confirm/complete, driver signature, photos, remainders), dispatch board (map-based), jobs (field application with Mapbox field polygons, chemicals, vehicles, applicators), blend tickets (Google Vision OCR → review → invoice/order linking), application records, fields (shapefile/KML import), vehicles, application services (vehicle-linked fee schedule with customer overrides).
- **Bill & account:** invoices (draft→posted lifecycle, period close via `check_period_open`), field-application invoices with multi-location customer share splits, payments + check allocation, prepayments (split-check buckets, two-phase apply workspace), AR aging + finance charges + batch statements, write-offs, credit memos / returns (RMA lifecycle), month-end close, financial dashboard, customer transaction review, commissions (JSONB splits, payout batches), accounts payable (vendor bills, PO-linked), 14+ reports + sales reports with CSV/PDF.
- **Operate:** inventory (net-free calc, holds, prebooking, immutable transaction ledger, cycle counts, batch adjust), purchase orders + quick receive, receiving log, compliance page (applicator licenses, RUP sales register), team board, notifications, integrity report/cleanup dashboards.

Technical posture is unusually strong for a small app: 96 tables all under RLS, 218 RPCs with idempotency + strict-actor auth patterns, money strictly bigint cents, append-only financial audit log, 1,900+ unit tests + 94 E2E specs, an extensive review-gate toolchain (5 reviewer subagents, schema-aware hooks, cross-review with a second LLM). Read `CLAUDE.md` end to end first — it is the canonical state document. Key references: `docs/app-workflow-map.html` (101-node workflow graph), `docs/reference/database-schema.md`, `docs/reference/rpc-functions.md`, `docs/ROADMAP.md`, `docs/OPEN_ITEMS.md`, `TODO.md`, `docs/workflows/QUOTE_TO_DELIVERY.md`, `INVENTORY_RULES.md`.

Known self-acknowledged boundaries of the current setup (challenge each one — keep, change, or kill):

- **Single-tenant, single-company.** No multi-tenancy, no white-label, no path to selling the software itself.
- **No farmer/customer-facing surface.** Customers receive PDFs by email; they cannot log in, see balances, approve quotes, pay online, or view their field history.
- **No native mobile / limited offline.** Drivers and applicators use the responsive web app in the field; offline support is minimal (one idempotency-reset fix exists for offline complete-delivery).
- **No payment processing.** Checks only — payments are *recorded*, never *collected* (no ACH/card, no autopay, no statement pay-now links).
- **No accounting-system integration.** It IS the ledger (AR, AP, period close) but doesn't sync to QuickBooks or any GL; no payroll, no tax filings.
- **No agronomy data layer.** Fields are polygons with FSA metadata; there are no as-applied maps, no VRA prescriptions, no equipment telematics (John Deere Ops Center, Raven Slingshot, Climate FieldView), no soil/yield data, no weather-based spray windows (weather appears only on application history).
- **Compliance is a register, not an engine.** RUP sales register + license tracking exist, but there's no state-specific reporting automation, no WPS posting/REI tracking, no label-rate validation at the point of blending/ordering, no SDS library.
- **AI usage is one-trick:** OCR on blend tickets. No forecasting, no pricing intelligence, no natural-language reporting, no agronomic recommendations, no anomaly detection on financials.

## YOUR MISSION — FIVE PHASES

Run phases in order. Use parallel Explore subagents for codebase work and web search for market research. **Verification discipline (non-negotiable):** every claim about the current app must carry a `file:line`, doc, or schema citation; every market/competitor/regulatory claim must carry a URL + access date; anything you cannot verify gets labeled **[UNVERIFIED]**. Findings without citations don't make the report.

### Phase 1 — Absorb the app as it actually is (read-only, codebase + docs)

Build your own mental model; do not just trust the docs (note any doc-vs-reality drift you stumble on, but drift-hunting is not the goal — `/map-drift-audit` exists for that).

- Walk every top-level workflow end-to-end through code: quote→order→delivery→invoice→payment→statement→close; blend ticket→OCR→review→invoice; job→application→field-app invoice; PO→receive→vendor bill→AP; return→credit; prepay→apply.
- For each of the 5 roles, write a "day in the life": which pages they touch, how many clicks/screens the core daily tasks take, where they re-enter data the system already knows.
- Inventory the *implicit* product decisions nobody chose deliberately (e.g., things that work the way they do because of how a table was shaped in month 1).
- Rate each functional area (Sell / Fulfill / Bill / Operate / Comply / Analyze) on: completeness, polish, daily-driver ergonomics, and how much of it a competitor would consider table stakes vs. differentiated.

### Phase 2 — Know the market (web research)

Research what world-class looks like in 2026 for ag-retail management and application billing. Cover at minimum:

- **Incumbent suites:** SSI Agvance, EFC Systems (FieldAlytics/Merchant Ag), AgWorks AgOS, Greenstone/AGRIS, Levridge (Dynamics-based), AgVantage. What do they have that CRX lacks? Where are they hated (UX, pricing, lock-in) — i.e., where is the opening?
- **Modern challengers + adjacent:** Traction Ag, Bushel (Payments/Farm), FarmQA, AgriSync-style service tooling, Conservis, anything YC/ag-tech-new targeting retailers.
- **Precision-ag data rails:** John Deere Operations Center API, CNH/Raven Slingshot, Climate FieldView, AgGateway ADAPT — what integration would let CRX ingest as-applied data and auto-generate application records/invoices without OCR or manual entry?
- **Regulatory reality:** state restricted-use pesticide reporting requirements (pick the 3–5 states that matter to this business — it's Illinois-based), EPA WPS, dicamba/2,4-D record-keeping rules, applicator license renewal tracking, and what "compliance autopilot" would mean.
- **Payments & fintech:** ag-specific AR realities (seasonal terms, crop-share splits, input financing like Nutrien/Rabo programs), ACH/card economics for high-ticket invoices, surcharging rules, autopay adoption in B2B ag.
- **AI in vertical SaaS, 2026 state of the art:** what the best vertical apps now ship (agentic workflows, NL analytics, document intelligence beyond OCR, demand forecasting, dynamic pricing) and which of those are credible for a business this size vs. demo-ware.

### Phase 3 — Gap analysis & opportunity generation (the core)

For each area below, answer three questions: *What does world-class look like? What does CRX have? What's the highest-leverage move?* Generate **at least 25 distinct, concrete opportunities** across:

1. **Customer-facing portal & payments** — farmer login, quote approval/e-sign, pay-now, autopay, statement access, field/application history sharing, split-billing visibility for landlords.
2. **Precision-ag & agronomy integration** — as-applied ingestion, prescription export, auto-application-records, field-level profitability (revenue per acre vs. input cost per acre — CRX already has both halves of this data!).
3. **Compliance engine** — label-rate validation at order/blend time, REI/PHI tracking, state RUP report generation, license-expiry-blocks-dispatch, SDS library, audit-ready binders per customer/field/season.
4. **Mobile & field operations** — offline-first applicator/driver experience, turn-by-turn to fields, in-cab blend sheets, photo/signature capture quality, dispatch optimization (routing, weather windows, tank-mix batching).
5. **Revenue & pricing intelligence** — margin analytics per product/customer/acre, tier-pricing optimization, rebate-aware true-cost, prebooking/early-pay programs, quote win/loss analytics, price-list season rollover.
6. **Billing depth** — input financing integration, crop-share/landlord split billing as a first-class object (it half-exists in field-app invoices), progress billing for programs, finance-charge sophistication, statement design.
7. **Supply chain** — vendor price-sheet ingestion (another OCR/document-AI candidate), seasonal demand forecasting from program/prebooking data, automated replenishment suggestions, shrink analytics from cycle counts.
8. **AI/agentic layer** — where an agent genuinely beats a form in THIS app (e.g., "bill everything applied yesterday," NL report queries over the existing RPC layer, anomaly watch on financial_audit_log, document intelligence on vendor bills/price sheets), and where it's a gimmick.
9. **Analytics & decision support** — owner's daily brief, cash-flow forecast from AR aging + seasonal curve, customer churn/credit-risk signals, sales-rep scorecards.
10. **Platform & business-model** — multi-tenant SaaS potential (is this product sellable to other retailers? what would it take: tenancy model on top of RLS, onboarding, data import), public API, white-label, and honestly whether that's a distraction.
11. **Design & UX modernization** — information architecture (66 flat pages vs. role-centric workspaces), the Dashboard as a true command center, mobile ergonomics, dark mode/density for office users, navigation for a 5-person company vs. a 50-person one, onboarding for a new hire.
12. **Architecture readiness** — for each strategic bet above, what the current foundation makes easy vs. hard (e.g., RLS posture is GREAT for a portal; cents-everywhere is GREAT for payments; single Supabase project is the multi-tenant question; Edge Functions vs. a real backend for integrations/webhooks; realtime; file/document storage strategy).

### Phase 4 — Adversarial filter

Before writing the report, attack your own list:

- Kill anything that's generic SaaS advice not grounded in this codebase or this market.
- Kill anything whose "world-class" claim you couldn't cite.
- For each survivor, name the riskiest assumption and how to test it cheaply.
- Sanity-check effort against the actual codebase (e.g., "customer portal" must account for the existing RLS customer-scoping work, `profile_public_view` design, and the auth model — cite what you'd reuse).
- Check every proposal against the Hard Red Lines in `CLAUDE.md` (money-as-cents, RLS-everywhere, append-only financial audit, period close). Proposals may *extend* these; none may violate them.

### Phase 5 — Synthesize the report

Write `docs/research/2026-06-XX-world-class-deep-dive-report.md` with:

1. **Executive summary** (≤1 page, plain English — the owner is a non-programmer): the 5 moves that matter most and why.
2. **Honest scorecard** of today's app per functional area (Phase 1 ratings) — including what is already genuinely world-class and must not be broken.
3. **Market map** — 1 paragraph per competitor/rail that matters, with the specific opening CRX can exploit.
4. **The opportunity backlog** — every surviving opportunity as: name, what it is (2–3 sentences), who it serves, impact (1–5), effort (S/M/L/XL grounded in this codebase), differentiation (table-stakes / parity / differentiator / category-defining), riskiest assumption + cheap test, key citations.
5. **Three-horizon roadmap:**
   - **H1 (this season, ≤3 months):** quick wins compounding on what exists.
   - **H2 (this year):** 2–3 strategic bets with sequencing and architecture prework.
   - **H3 (multi-year):** the end-state vision — what makes CRX the best in the world at chemical sales + application billing, stated as capabilities a competitor can't easily copy.
6. **Keep / Change / Kill verdicts** on the current setup's big assumptions (single-tenant, web-only, checks-only, no portal, IS-the-ledger, OCR-centric ingestion).
7. **Architecture prework list** — the foundation changes (if any) that should land BEFORE feature work so later bets don't require rewrites.
8. **What NOT to build** — explicitly, with reasons. Restraint is part of world-class.

## GROUND RULES

- Read-only: no migrations, no code edits, no deploys, no DB writes. Report only.
- The owner is a beginner — the executive summary and roadmap must be readable without engineering vocabulary; the appendices can be technical.
- Be opinionated. Ties are broken by: (1) revenue/cash-flow impact for the business, (2) daily-pain reduction for the 5 real users, (3) defensibility. "It depends" is a failing answer.
- Respect what's good: this codebase's financial-integrity discipline is a genuine asset — treat it as the moat's foundation, not legacy to bulldoze.
- It is fine — encouraged — to conclude that some current features should be deprecated or merged. 66 pages for a single small company is itself a finding to examine.
