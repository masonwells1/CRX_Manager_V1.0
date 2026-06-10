# Grower Portal + Precision Profitability — Brainstorm / Design Doc

**Date:** 2026-06-10 · **Status:** BRAINSTORM (no code, no migrations — this doc is the deliverable)
**Branch:** `claude/customer-portal-architecture-ej5in9`
**Owner:** Mason

This doc captures the working plan for CRX's expansion into agronomy services
(tissue sampling, soil testing, fertilizer/nutrition programs), a customer-facing
grower portal, grower-uploaded planting/harvest data, and a field profitability map.
It is meant to be iterated on — sections marked **OPEN QUESTION** need Mason's input
before that piece gets built.

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

## 6. Phasing (revised)

| Phase | What | Where | Notes |
|-------|------|-------|-------|
| 1a | Agronomy data model + internal pages (soil tests, tissue, programs) | CRX Manager | Staff workflow first; investigate blend-ticket reuse for dry fert |
| 1b | `field_seasons` + `field_season_costs` + internal entry page + **whole-field breakeven chart** | CRX Manager | No geospatial work; immediate value; staff can demo to growers |
| 2 | Portal MVP — grower auth (`customer_users`, `customer` role), read-only: my programs, my test results, my field seasons, breakeven charts, statements | New portal repo | Security review of the ~10 `portal_*` RPCs is the gate |
| 3 | Spatial yield upload + processing + **profitability map** | Both (upload in either; map component shared/copied) | Tier B from §4; the big differentiator |
| 4 | Grower self-serve upload + cost editing in portal | Portal | Write-path security review |
| 5 | LLM assistant (Claude API via Edge Function, customer-scoped RAG) | Portal | Needs Phases 1–3 data to be useful |

Each build phase goes through the normal `/ship` pipeline when we get there.

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

## 8. Explicitly out of scope for v1

- Variable-rate prescription *writing* (Rx export back to monitors)
- Multi-year yield trend / stability maps (needs ≥2 seasons of data first — design
  tables so this is possible later, i.e. never overwrite a prior season's cells)
- Satellite imagery / NDVI layers
- PostGIS server-side spatial analytics
- Grain marketing / hedging tracking
