# Grower Portal + Precision Profitability — Vision / Brainstorm Doc

**Date:** 2026-06-10 (last iterated 2026-06-10) · **Status:** VISION — collecting & iterating ideas. NOT a plan yet.
**Branch:** `claude/customer-portal-architecture-ej5in9` (PR #74 — the living home for this doc)
**Owner:** Mason

This doc collects the vision for CRX's expansion into agronomy services
(tissue sampling, soil testing, fertilizer/nutrition programs), a customer-facing
grower portal, grower-uploaded planting/harvest data, and a field profitability map.

**How to use this doc:** dump ideas in (chat them to Claude or comment on PR #74 and
they get folded in), argue with what's here, mark things ❤️ keep / 🗑 cut. Nothing in
here is committed-to. When the vision feels settled, we'll spin the *implementation
plan* as a separate exercise (`/ship` per piece, with real data-model design). The
technical sketches below are feasibility notes — "this is buildable and roughly how" —
not specs.

---

## 1. Core architecture decision (settled)

**Separate portal app, same Supabase database.**

| Piece | Decision |
|-------|----------|
| Portal frontend | **New repo / new Vercel project** (e.g. `portal.croprxsolutions.app`). Small, mobile-first, ~10 pages. |
| Database | **Same Supabase project** (`rhyzpcqhnizqbxphqdkr`). No second DB, no syncing. |
| Wall between them | RLS + a small set of **portal-dedicated RPCs** (`portal_*` prefix), each hard-scoped to the caller's `customer_id`. The portal never gets broad table grants. |
| Internal features (agronomy data entry, program building) | Built **in CRX Manager** (this repo) — staff-facing. |
| Auth for growers | Supabase auth in the same project; a `customer_users` mapping table links an auth user → `customer_id`. New profile role: `customer` (never gets internal routes/RPCs). |

**Why separate app:** security blast radius (218 internal RPCs + RLS designed for
staff roles would all need re-audit if customers logged into the same app — the
deferred "Customer RLS upper bound is lower-bound-only" item makes this concrete),
independent deploys (internal refactors can't take the portal down in-season),
different UX (simple/branded vs 66-page ops console), and this repo's heavy
tooling stays tuned to the internal app.

**Why same DB:** everything the portal shows (customers, fields, programs, test
results, invoices, application records) already lives here. Supabase is built for
multiple frontends on one DB with RLS as the wall.

### Non-negotiables for the portal (inherit CRX red lines)
- Portal ships with **anon key only**; every read goes through `portal_*` RPCs or
  customer-scoped RLS policies. No `service_role` anywhere client-side.
- Money stays **bigint cents**.
- Every new table gets RLS before first deploy.
- The LLM assistant (later phase) is an Edge Function proxying the Claude API —
  key server-side, context strictly limited to the caller's own customer data.

---

## 2. What already exists in CRX that we build on

Surveyed 2026-06-10 — this is a *much* better starting position than greenfield:

| Asset | Where | Why it matters |
|-------|-------|----------------|
| `fields` table: `customer_id`, `field_name`, `total_acres`, `crop_type`, `boundary_geojson`, `centroid_geojson`, FSA farm/tract/field numbers, `parent_field_id` | `src/types/index.ts:1206` | Fields are already customer-owned polygons. The profitability map keys off `field_id` + season. |
| Mapbox GL map stack: `CRXMap`, `FieldBoundaryLayer`, `DrawControl`, satellite base layers, fit-bounds | `src/components/map/` | The profitability heat-map is "one more layer" on an existing, working map. |
| Boundary import pipeline: shapefile (`shpjs`), KML (`@tmcw/togeojson`), GeoJSON, projection handling (`proj4`), area calc (`@turf/area`) | `src/lib/fieldImportParser.ts` | The *same parsing stack* handles harvest-monitor yield exports (which are mostly shapefiles/CSVs). |
| Per-customer financial history: invoices, blend tickets, application records, jobs | core tables | The **cost side** of profitability can be partially auto-filled from what CRX already sold/applied to that field — a differentiator nobody else has. |
| `field_billing_defaults` (split %, price overrides) | `src/types/index.ts:1231` | Cost-share / landlord-tenant splits already modeled; profitability per *operator share* becomes possible later. |

---

## 3. New domain: agronomy services (internal-first)

Staff-facing, built in CRX Manager. Growers later *view* this through the portal.

### Proposed tables (sketch — final design via `/create-migration` when we build)
- **`soil_tests`** — field_id, customer_id, sample_date, lab, sample_grid_id?, depth,
  results jsonb (pH, OM, CEC, P, K, S, Zn, B, Mg, Ca…), status (`sampled → sent_to_lab → results_received → reviewed`), pdf storage path.
- **`tissue_samples`** — field_id, crop_stage, sample_date, results jsonb, status.
- **`nutrition_programs`** — customer_id, field_id?, season, crop, status
  (`draft → proposed → accepted → active → completed`), built from soil/tissue results.
- **`program_items`** — program_id, product_id (links to existing CRX products!),
  rate, timing window, application method, est_cost_cents.
- Dry fertilizer blends likely reuse/extend the existing blend-ticket machinery — **investigate before designing**, don't duplicate it.

Notes for future-self: results as `jsonb` keyed by analyte keeps us flexible across
labs; soil sample *grids/zones* (2.5-ac grid sampling) are spatial — same grid-cell
approach as yield data below, so design them together.

---

## 4. Grower planting & harvest data upload

Two tiers, because growers range from "has a 20-series Deere with Operations
Center" to "writes yields in a pocket notebook":

### Tier A — simple per-field season records (manual entry, MVP)
**`field_seasons`** — one row per field per season per crop:
- field_id, customer_id, season (Oct 1–Sep 30 per CRX convention — **OPEN QUESTION:
  crop year vs CRX fiscal season labeling?**), crop, hybrid/variety, planting_date,
  population, row_spacing
- harvest_date, avg_yield (numeric, bu/ac or ton/ac by crop), moisture_pct,
  total_production, sale_price_cents_per_unit (grower-entered or marketing avg)

This alone powers the **whole-field breakeven chart** (no maps needed):
`breakeven_yield = total_costs / price`, `breakeven_price = total_costs / yield`.
Ship this first — it's high value, low risk, zero geospatial complexity.

### Tier B — spatial yield data (monitor exports → heat map)
- **Sources:** John Deere Operations Center, Case AFS, AgLeader SMS, Climate
  FieldView. Exports arrive as **shapefile point clouds** (one point per second of
  harvesting: lat/lon, wet/dry yield, moisture, speed) or CSV. 10k–200k points per
  field; files 5–200 MB.
- **`yield_datasets`** — upload metadata: field_season_id, storage_path, source
  (deere/case/agleader/fieldview/csv/other), status
  (`uploaded → processing → processed → failed | needs_review`), point_count,
  error text. Mirrors the proven blend-ticket OCR pipeline shape.
- **Raw file storage:** Supabase Storage bucket `grower-uploads` with
  customer-scoped path prefix (`{customer_id}/...`) + Storage RLS policies
  (same pattern as blend-ticket storage).
- **Processing:** an Edge Function (or client-side for small files, reusing the
  `fieldImportParser` stack) cleans the points (drop zero-yield headland turns,
  flow-delay outliers, moisture-correct to dry bushels) and **bins them into grid
  cells** — we do NOT store hundreds of thousands of raw points per field.
- **`yield_grid_cells`** — yield_dataset_id, cell geometry (or grid index),
  cell_acres, avg_dry_yield, point_count. Grid size **OPEN QUESTION** — suggest
  0.1–0.25 ac (~20–30 m) cells; matches soil-sampling zone granularity well enough.

**Known mess to respect (not solve in v1):** monitor calibration error, wet-vs-dry
yield, unit soup (bu/ac vs t/ac), overlapping passes. v1 rule: trust the file,
moisture-correct, drop obvious outliers (> 3σ), show a "data quality" note.
Cap upload size (~50 MB) for MVP; revisit a background worker if Edge Function
limits bite.

**Who uploads:** both. Staff can upload on a grower's behalf in CRX Manager
(internal page, Phase 1) and growers self-serve in the portal (Phase 2+). Same
tables, same processing path.

### Cost side — `field_season_costs`
- field_season_id, category (`seed | fertilizer | chemical | application |
  land_rent | machinery | crop_insurance | drying | hauling | labor | other`),
  description, amount_cents, per_acre boolean, source (`manual | crx_invoice |
  crx_application`), source_id?
- **Auto-pull from CRX:** a `portal_get_field_season_crx_costs(field_season_id)`
  RPC can suggest cost lines from the grower's own CRX invoices / application
  records tied to that field+season. Grower confirms/edits rather than typing from
  scratch. This is the moat — competitors make growers hand-enter everything.
- v1: all costs uniform per-acre. Variable-rate spatial costs (VR fertilizer maps)
  are a later layer.

---

## 5. Profitability map

**The headline feature.** Per grid cell:

```
profit_per_acre(cell) = avg_dry_yield(cell) × price_per_unit
                        − total_costs_per_acre(field_season)
```

- Render as a Mapbox **fill layer** over the existing satellite base in `CRXMap`
  (internal) and the portal's copy of the map components: diverging color scale
  centered on $0/ac — red = losing money, white ≈ breakeven, green = profit.
  Hover/tap a cell → yield, revenue, cost, net.
- Field summary panel: total profit, profit/ac, % of acres below breakeven,
  breakeven yield & price, and "the worst 10% of acres cost you $X this year."
- That last number is the sales hook for soil testing + nutrition programs:
  *"these 14 acres lose $87/ac — let's grid-sample them."* The portal funnels
  growers into the agronomy services from §3. The features feed each other.
- Computation: cells per field are small after binning (a 160-ac field at 0.2 ac
  cells ≈ 800 cells), so profit math can run client-side or in one cheap RPC.
  No PostGIS *required* for v1 (the app already stores geometry as GeoJSON text);
  enabling PostGIS is an option later for server-side spatial joins
  (e.g. soil-zone × yield overlays). **OPEN QUESTION: enable PostGIS now or defer?**
  Leaning defer — keep v1 in the proven GeoJSON+turf lane.

---

## 6. ⭐ Chemical tracking & spray compliance (Mason priority — added 2026-06-10)

**For growers who take delivery of their own chemical and spray it themselves.**
Mason wants heavy focus here: compliance-grade application records, a "what's been
sprayed / what hasn't" checklist with dates, and reminders (e.g. when the post
spray is due). This may be the best *first* portal feature — it's daily-use
in-season (growers open the portal every week, not once at harvest), and it's
uniquely powered by CRX data.

### 6.1 The chemical shed (product inventory per grower)
- **Auto-credited from CRX deliveries** — every jug/tote/bulk load CRX delivers to
  that customer already exists in the DB. Their on-hand inventory starts itself;
  zero data entry. *This is the moat — FieldView/Deere can't see what's in the shed.*
- Manual add for product bought elsewhere (keep it honest/complete).
- Depleted by application logs (below): `delivered − applied = on hand`.
- Side effects for CRX: low-stock nudges → reorder button → a quote/order lead in
  CRX Manager. The compliance tool quietly becomes a sales channel.

### 6.2 Spray plan checklist ("what's sprayed, what's not")
- Per field per season: the planned passes — burndown, pre-emerge, post-emerge,
  fungicide, insecticide, dessication — each a row with ✓/✗, date sprayed, product(s),
  rate, who sprayed.
- Whole-farm board view: every field down the side, passes across the top —
  one screen answers "where do we stand?" during the spray rush.
- Plans can be seeded from the grower's CRX nutrition/chem program (§3) or from
  last year's plan ("copy 2026 → 2027").
- Checking a pass off **creates the compliance record** (6.3) — one action, both jobs.

### 6.3 Compliance-grade application log
Records that satisfy federal RUP recordkeeping (and IL state rules) so an inspector,
landlord, or insurer ask is a one-click export instead of a shoebox of notes:
- Product + **EPA reg. number** (auto-filled from the CRX product catalog — grower
  never types it), rate, total amount, method.
- Field/location + acres (already in `fields` — auto-filled), crop.
- Date/time, applicator name + **license/cert number**, RUP flag.
- Weather at application: wind speed/direction, temp, sky — quick-pick UI; possibly
  auto-suggested from a weather API against the field centroid at the logged time.
- Tank-mix support (multiple products per pass — mirrors blend-ticket structure).
- **Append-only after submission** (corrections as amendments, like
  `financial_audit_log`) — that's what makes it credible as a compliance record.
- Exports: per-field or whole-farm PDF/CSV, formatted for RUP audit / landlord /
  crop-insurance / sustainability programs.
- Feeds everything else: application costs flow into the profitability map (§5)
  automatically; every record lands on the field timeline (§8A).

### 6.4 Reminders & timers
- **Planned-pass reminders** — "post-emerge window for North 80 opens ~June 1"
  (date- or growth-stage-based), nudged via email/SMS with a portal deep link.
- **REI timer** — log a spray → portal shows "re-entry safe after Tue 6:00 AM"
  per field (REI hours from product label data).
- **PHI guard** — "Field X sprayed with Y on date Z → earliest legal harvest is
  date Z + PHI days." Flags conflicts with the planned harvest date.
- **Records-due nudge** — federal RUP rule: records within 14 days of application;
  remind if a checked-off pass is missing its compliance fields.
- **Resupply** — "at current pace your shed runs out of Product X in ~2 passes."

### 6.5 What CRX needs to add to make this work
- Label data on the product catalog: EPA reg #, REI hours, PHI days by crop,
  RUP yes/no, max rate/season. (One-time data lift per product CRX sells; start
  with the top 20 movers, not the whole catalog.)
- Notification delivery — email exists (`send-email` Edge Function); SMS is new
  (**OPEN QUESTION:** SMS provider, or email-only v1?).
- A `customer_chemical_inventory` ledger + `spray_plans` / `spray_passes` /
  `application_logs` tables (portal-scoped RLS; design when we plan).

### 6.6 Open questions on this piece (Mason)
1. "Reminders for when we need to **post spray**" — confirm meaning: (a) reminder
   that the post-emerge *pass* is due, (b) REI/PHI timers *after* spraying, or both?
   (Doc currently assumes **both**.)
2. Do *your own* custom-application crews also use this internally (CRX Manager
   side), or is v1 grower-self-spray only?
3. Do your growers hold applicator licenses we should track (private applicator
   cert numbers), incl. expiry-date reminders?
4. Should checking off a pass *require* the compliance fields, or allow "quick
   check now, fill details later" (with the 14-day nudge chasing them)?

---

## 6b. Rough build order (sketch only — sequencing logic, not a commitment)

| Phase | What | Where | Notes |
|-------|------|-------|-------|
| 1a | Agronomy data model + internal pages (soil tests, tissue, programs) | CRX Manager | Staff workflow first; investigate blend-ticket reuse for dry fert |
| 1b | `field_seasons` + `field_season_costs` + internal entry page + **whole-field breakeven chart** | CRX Manager | No geospatial work; immediate value; staff can demo to growers |
| 2 | Portal MVP — grower auth (`customer_users`, `customer` role), read-only: my programs, my test results, my field seasons, breakeven charts, statements | New portal repo | Security review of the ~10 `portal_*` RPCs is the gate |
| 3 | Spatial yield upload + processing + **profitability map** | Both (upload in either; map component shared/copied) | Tier B from §4; the big differentiator |
| 4 | Grower self-serve upload + cost editing in portal | Portal | Write-path security review |
| 5 | LLM assistant (Claude API via Edge Function, customer-scoped RAG) | Portal | Needs Phases 1–3 data to be useful |

Each build phase goes through the normal `/ship` pipeline when we get there.

**Sequencing note (2026-06-10):** with Mason's priority on chemical tracking (§6),
the spray checklist + compliance log is a strong candidate for the **first
grower-facing feature** — it's used weekly all season (vs harvest-time analytics),
needs no geospatial work, and auto-seeds from CRX delivery data. Could slot in as
Phase 2 alongside or ahead of the read-only portal MVP.

---

## 7. Open questions for Mason

1. **Which monitors/platforms do your growers actually run?** (Determines which
   export formats Phase 3 must parse first — Deere Ops Center is the likely 80%.)
2. **Season labeling** for `field_seasons`: crop year ("2026 corn") vs CRX's
   Oct 1–Sep 30 season? Growers think in crop years.
3. **Commodity price** for the revenue side: grower-entered per field, a single
   "marketing price" per crop per customer, or both with override?
4. **Cost-share/landlord splits** in profitability v1, or operator-100% and add
   splits later? (`field_billing_defaults` already models splits.)
5. **Portal branding/domain** — `portal.croprxsolutions.app`? Name the product?
6. Grid cell size for yield binning (default proposal: 0.2 ac).

---

## 8. Idea backlog (unfiltered — react to these: keep / cut / change)

Everything below is brainstorm material, deliberately wider than what we'd build
first. Grouped by theme. Mason: mark ❤️ / 🗑 / ✏️ or just say so in chat.

### A. Agronomy services (the new revenue lines)
- **Grid/zone soil sampling program** — 2.5-ac grid sampling, results mapped over
  the field, resample on a 3–4 year rotation with a "due for resample" tracker
- **Nutrient removal engine** — yield map × crop removal rates = what the crop
  hauled off per zone → the replacement-fertilizer rec writes itself. Soil test +
  removal + yield goal = the dry fertilizer program, defensible with the grower's
  own numbers
- **Season-long tissue program** — scheduled pulls by growth stage (V5, VT, R1…),
  trend charts across the season, flags when an analyte drops below sufficiency
- **Soil test → program → quote pipeline** — a proposed nutrition program converts
  straight into a CRX quote with one click (reuses the existing quote machinery);
  grower e-accepts in the portal
- **Variable-rate prescriptions** (later) — write Rx files back to the monitor from
  soil zones + yield history; the natural endgame of owning both data layers
- **Field history timeline** — one scrollable view per field: every application,
  soil test, tissue pull, planting, harvest, invoice. "The field's medical chart."

### B. Grower data & records
- Planting + harvest records (manual tier + monitor-upload tier — §4)
- **Spray/application records compliance view** — ⭐ promoted to its own priority
  section, see §6 (chemical shed inventory, spray checklist, compliance log,
  REI/PHI reminders)
- **Rainfall & GDD per field** — pull a weather API against field centroids;
  context layer for yield results ("that field got 4 fewer inches")
- **Storage/inventory of grain** (much later) — bushels in the bin vs sold

### C. Financial tools for growers
- **Breakeven calculator** per field/crop (the no-map MVP — §4 Tier A)
- **Profitability map** (§5 — the headline)
- **What-if sliders** — drag corn price / input costs and watch the breakeven line
  and profit map recolor live. Cheap to build once the data's there, demos great
- **Per-field P&L + whole-farm rollup** — every field a profit center
- **Rented-ground analyzer** — profitability by farm/landlord; "this $325 cash-rent
  farm lost money two years straight"
- **APH / yield history view** — formatted for crop-insurance conversations
- **Anonymized benchmarking** (later, needs scale) — "your corn-on-corn ran 12 bu
  under the area median." Sensitive — opt-in only

### D. Portal experience
- Documents hub: invoices, statements, soil PDFs, program agreements in one place
- **Program approval flow** — grower reviews + e-accepts a proposed program in the
  portal → becomes an accepted quote in CRX (signature, timestamp, audit log)
- Notifications: "soil results are in," "application completed on North 80,"
  "invoice posted" — email/SMS with portal deep links
- **LLM assistant ("agronomist in your pocket")** — answers over *their* data:
  "explain my soil test in plain English," "which field should I sample next,"
  "what did I spend on fungicide last year." Claude API via Edge Function,
  customer-scoped context only
- Mobile-first throughout — growers live in the truck cab, not at a desk

### E. Business-model angles (Mason's call entirely)
- Portal free with CRX business vs freemium (free docs/records, paid analytics tier)?
- Agronomy services priced per-acre (sampling, program design) with portal included?
- **Data as the retention moat** — every season of yield/soil/program history in the
  portal makes leaving CRX more expensive. The portal is a switching-cost machine
- White-label / multi-rep ready? (If CRX adds sales territories, reps see their
  book of growers in the same portal infra)

---

## 9. Explicitly parked (not v1, revisit when vision settles)

- Variable-rate prescription *writing* (Rx export back to monitors)
- Multi-year yield trend / stability maps (needs ≥2 seasons of data first — design
  tables so this is possible later, i.e. never overwrite a prior season's cells)
- Satellite imagery / NDVI layers
- PostGIS server-side spatial analytics
- Grain marketing / hedging tracking
- Benchmarking across growers (needs scale + opt-in framework)

---

## Iteration log

| Date | Change |
|------|--------|
| 2026-06-10 | Initial doc: architecture decision, agronomy sketch, upload tiers, profitability map, phasing | 
| 2026-06-10 | Reframed as VISION doc per Mason; added idea backlog (§8) across 5 themes + parked list |
| 2026-06-10 | ⭐ Added §6 chemical tracking & spray compliance as Mason's priority focus (shed inventory auto-fed by CRX deliveries, spray checklist, compliance-grade log, REI/PHI + post-spray reminders); flagged it as candidate first portal feature |
