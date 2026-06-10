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
- **Follow-up trip timers (Mason's core ask, confirmed 2026-06-10)** — logging a
  pass starts the clock on the *next* one: pre-emerge applied May 5 with a ~26-day
  residual → "2nd trip on North 80 due ~May 31," with a countdown on the spray
  board and an email/SMS nudge as the window approaches. The interval is set per
  product (default residual days on the catalog) or overridden per plan/pass.
  Chains too: 2nd trip logged → fungicide timer starts, etc.
- **CRX side of the same timer:** ops/sales see every customer whose 2nd-trip
  window opens this week → schedule the chemical delivery or the custom-app crew
  *before* the grower calls. The reminder engine doubles as a workload forecast.
- **REI timer** — log a spray → portal shows "re-entry safe after Tue 6:00 AM"
  per field (REI hours from product label data).
- **PHI guard** — "Field X sprayed with Y on date Z → earliest legal harvest is
  date Z + PHI days." Flags conflicts with the planned harvest date.
- **Records-due nudge** — federal RUP rule: records within 14 days of application;
  remind if a checked-off pass is missing its compliance fields.
- **Resupply** — "at current pace your shed runs out of Product X in ~2 passes."

### 6.5 Internal crew use — custom acres + work planning (confirmed 2026-06-10)
Mason: CRX's own crew should use this too, for custom-applied acres and to
**plan/schedule future work**. Implications:
- **One data model, two front doors.** The same spray plan / pass / application-log
  tables serve both: a pass is *assigned* to either the grower (self-spray) or a
  CRX crew (custom). A field can mix both in one season (grower sprays pre, CRX
  flies the fungicide).
- **Internal spray board in CRX Manager** — whole-book view across all customers:
  every custom-acre pass, filterable by crew/rep/week, fed by the same follow-up
  timers ("17 fields enter their 2nd-trip window next week" = the work forecast).
- **Reuse, don't duplicate, the existing machinery:** CRX already has a Job
  lifecycle (`scheduled → in_progress → completed → invoiced`) and a DispatchBoard
  page. A scheduled custom pass is probably just a *planned job* with spray-plan
  context attached — completing the job writes the compliance record (6.3) with the
  crew's applicator license auto-filled. Investigate linking `spray_passes ↔ jobs`
  rather than building a parallel scheduler.
- Custom passes completed by CRX flow straight to billing (job → invoice — the
  existing `transfer_job_to_invoice` path), so the compliance tool also tightens
  the custom-app revenue loop.

### 6.6 What CRX needs to add to make this work
- Label data on the product catalog: EPA reg #, REI hours, PHI days by crop,
  RUP yes/no, max rate/season, **default residual/follow-up interval days** (one-time
  data lift per product CRX sells; start with the top 20 movers, not the whole catalog).
- Notification delivery — email exists (`send-email` Edge Function); SMS is new
  (**OPEN QUESTION:** SMS provider, or email-only v1?).
- A `customer_chemical_inventory` ledger + `spray_plans` / `spray_passes` /
  `application_logs` tables (portal-scoped RLS; design when we plan).

### 6.7 Open questions on this piece (Mason)
1. ~~"Post spray" meaning~~ — **ANSWERED 2026-06-10:** follow-up trip timers —
   e.g. pre-emerge applied → ~26 days of residual → reminder that the 2nd trip is
   due. (REI/PHI timers kept as well — they're cheap once the log exists.)
2. ~~Internal crew use?~~ — **ANSWERED 2026-06-10: yes** — crew uses it for custom
   acres and for planning/scheduling future work (see 6.5).
3. Do your growers hold applicator licenses we should track (private applicator
   cert numbers), incl. expiry-date reminders?
4. Should checking off a pass *require* the compliance fields, or allow "quick
   check now, fill details later" (with the 14-day nudge chasing them)?
5. Where do the residual/follow-up intervals come from — a default per product
   that you maintain (e.g. "26 days"), set per customer program, or both
   (product default + per-plan override)? Doc assumes both.

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

## 10. Implementation realities & blind spots (added 2026-06-10 — 2nd iteration)

The non-feature stuff that decides whether this succeeds. Each gets a decision
eventually; none block idea-collection now.

### 10.1 Adoption — the empty-portal problem
- A grower who logs in to an empty screen never comes back. **Rule: CRX pre-loads
  everything before the invite goes out** — fields/boundaries drawn, this season's
  spray plan seeded from their program, chemical shed already showing what we've
  delivered. First login should feel like "my farm is already in here."
- Invite flow: customer record in CRX → "Invite to portal" button → email/text
  with magic link. Staff-driven, not self-signup.
- **Pilot group:** 5–10 friendly growers for season one. Pick growers who (a) take
  their own chemical, (b) text Mason already, (c) will complain honestly.
- Tech comfort varies wildly: phone-first UI, big tap targets, max 2 taps to check
  off a pass. If it's harder than a text message, they'll text instead.

### 10.2 Offline & connectivity
- Spraying happens where cell coverage doesn't. Checking off a pass / logging an
  application **must tolerate offline**: PWA with a local queue that syncs when
  signal returns (CRX already solved a version of this for offline
  complete-delivery — reuse the idempotency-key pattern so a queued retry can't
  double-log).
- "Add to home screen" PWA before native apps. App stores are a maintenance tax
  we don't need in year one.

### 10.3 Who's at the keyboard — users within a farm
- One customer ≠ one person: owner, spouse doing books, hired hand spraying.
  `customer_users` is many-to-one already; v1 keeps it simple — **everyone on the
  account sees everything**. Later: an "applicator" role (log sprays, no financials).
- Landlords: NOT users in v1. Sharing = grower exports the per-field PDF.

### 10.4 Data ownership & trust (selling point, not fine print)
- Growers are deeply wary of ag-data platforms. A one-page plain-English policy —
  **"your data is yours; export everything anytime; we never sell it or share it
  without your say-so"** — is a competitive weapon vs the big platforms. Put it on
  the marketing page, not buried in a TOS.
- Export-everything (CSV/PDF) needs to be real from day one, not promised.

### 10.5 Liability & label data (the sharp edge — needs care)
- REI/PHI/residual numbers come from **product labels, which change**. If the
  portal says PHI = 14 days and the current label says 21, that's a real problem.
  - Mitigations: label fields carry a "verified on <date> against label <EPA reg #>"
    stamp; annual pre-season label review as a standing CRX task; visible
    disclaimer: **"always confirm against the product label — the label is the law."**
- Application *recommendations* may legally require a licensed agronomist/CCA in
  some states. The portal **records and reminds; it does not prescribe.** Timers
  say "you planned a 2nd trip ~26 days out," not "you should spray X at Y rate."
- **LLM guardrails (matters when we get to G14):** the assistant explains *their
  data* ("your K is low on the east 40," "you spent $61k on chem") and must refuse
  rate/product prescriptions — hand those to Mason/agronomist. This is a liability
  wall, not a nice-to-have.
- Compliance log: grower attests accuracy on submit; CRX provides the record-keeping
  tool, grower owns the records. (Run the framing past insurance/attorney before launch.)

### 10.6 Reminder engine plumbing (implementation note for later)
- Timers = rows, not background magic: each logged pass writes its follow-up dates
  (next-trip date, REI-expiry, PHI-earliest-harvest) to a `reminders` table; a
  daily **pg_cron** job (already used in this stack) scans due reminders → existing
  `send-email` Edge Function. SMS = add Twilio (or similar) to the same dispatch
  point. Email-only pilot is fine; spray-rush users will want SMS fast.

### 10.7 Label/catalog data maintenance (recurring chore — assign an owner)
- EPA reg #s, REI, PHI, residual-interval defaults: ~top-20 products to start,
  reviewed every winter before season. This is a named annual task (Mason or
  agronomist), or it silently rots — see 10.5.

### 10.8 Seasonal launch timing
- A spray-compliance tool must be **live before burndown season** (Feb–Mar in IL)
  or it waits a year. Working backwards: pilot-ready by ~Feb 1 → build in
  fall/winter (Oct–Jan) → vision settled + planned by ~Sep. Harvest-time features
  (yield upload, profitability map) have a *different* deadline: ready by
  September. Two natural release windows; don't fight the calendar.

### 10.9 Success metrics (so we know if it's working)
- In-season weekly active growers (the honest number for a spray tool)
- % of chemical deliveries auto-landing in a shed inventory
- Passes checked off in-portal vs "grower texted Mason anyway"
- Compliance exports pulled (each one = a shoebox of notes we replaced)
- Reorders/leads originating from portal nudges (the revenue loop)

### 10.10 Competitive positioning (one paragraph, so we stay honest)
- FieldView / Deere Ops Center / Traction / Conservis own machine data and broad
  farm-management. **We don't compete there.** CRX's portal is the
  *retailer-connected* layer: shed inventory that fills itself from deliveries,
  costs that flow from real invoices, programs from our own agronomist, compliance
  records growers actually keep. The pitch: "you don't type anything twice —
  because we're already your supplier." No platform can copy that without being
  the supplier.

### 10.11 Stepping-stone option worth considering (Mason call)
- G1/G3 could ship **internal-first**: crew + staff run the spray board for custom
  acres inside CRX Manager (no portal auth needed yet), and growers get the output
  as emailed/printed reports for a season. Proves the data model, builds the label
  catalog, trains the crew — then the portal launch is "here's self-serve access
  to the thing that already works" instead of a cold start. Trade-off: slower
  wow-factor for growers who self-spray.
| 2026-06-10 | Initial doc: architecture decision, agronomy sketch, upload tiers, profitability map, phasing | 
| 2026-06-10 | Reframed as VISION doc per Mason; added idea backlog (§8) across 5 themes + parked list |
| 2026-06-10 | ⭐ Added §6 chemical tracking & spray compliance as Mason's priority focus (shed inventory auto-fed by CRX deliveries, spray checklist, compliance-grade log, REI/PHI + post-spray reminders); flagged it as candidate first portal feature |
| 2026-06-10 | §6 iterated per Mason: "post spray" = follow-up trip timers (pre applied → ~26-day residual → 2nd-trip reminder; product-default interval + per-plan override); internal crew use confirmed (custom acres + work planning — new 6.5, likely `spray_passes ↔ jobs`/DispatchBoard link, job completion writes the compliance record, flows to invoicing) |
| 2026-06-10 | Added §10 implementation realities & blind spots: adoption/empty-portal rule, offline PWA queue, multi-user farms, data-ownership policy as selling point, label-data liability + LLM guardrails, reminder-engine plumbing (pg_cron), label maintenance chore, seasonal launch windows (spray tool live by ~Feb), success metrics, competitive positioning, internal-first stepping-stone option |
