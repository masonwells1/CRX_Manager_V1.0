# Field Mapping & Per-Acre Billing — Roadmap + FarmOS Gap Analysis

**Created:** 2026-06-22
**Status:** Research complete · **current implementation verified against live code** · this is a planning document for Mason's review
**Owner ask:** "Where is FarmOS ahead of us, and how do the best apps (ChemMan especially) do field boundaries → acreage → per-acre billing? This will be a huge part of our billing process the way it currently is with ChemMan."

> ## ⚠️ Important correction (read first)
> An earlier draft of this doc assumed CRX had **no** field mapping yet. **That was wrong** — verified against the live codebase on 2026-06-22. **CRX already has a working, shipped field-mapping → acreage → per-acre-billing pipeline.** So the real question is *not* "build it from scratch" — it's **"how do we harden and extend what we already have to be world-class enough to confidently replace ChemMan?"** The good news: we are much further along than the FarmOS comparison alone suggested. The gaps that remain are real but **narrower and more sophisticated** (money-safety, validation, plan-vs-applied true-up), not greenfield.

---

## What CRX already has TODAY (verified in code, 2026-06-22)

| Capability | Status | Where |
|---|---|---|
| **Draw a field boundary on a satellite map** | ✅ Live | `src/components/map/CRXMap.tsx`, `DrawLayer.tsx` (Mapbox GL + mapbox-gl-draw) |
| **Auto-calculate acres from the polygon** | ✅ Live (client-side) | Turf.js `area()` ÷ 4046.8564224, rounded to 0.01 ac — `DrawLayer.tsx` |
| **Import shapefile / KML / GeoJSON** | ✅ Live (7-step wizard) | `src/components/fields/BulkFieldImport.tsx`, `lib/fieldImportParser.ts` |
| **Multiple polygons per field** | ✅ Live | `field_polygons` table (jsonb GeoJSON) + `save_field_polygons` RPC |
| **PostGIS enabled + boundary storage** | ✅ Live | `CREATE EXTENSION postgis`; `fields.boundary geography(POLYGON,4326)`, `fields.centroid geography(POINT,4326)` — migration `20260213000000_phase1_fields_foundation.sql` |
| **FSA metadata on the field** | ✅ Captured (metadata only) | `fields.fsa_farm_number / fsa_tract_number / fsa_field_number` |
| **Per-grower billing splits + $/acre override** | ✅ Live | `field_billing_defaults.split_pct`, `price_override_cents`, `pricing_note` |
| **Forward billing wire-up (boundary acres → invoice)** | ✅ Live | `transfer_job_to_invoice`, `create_field_app_invoice`, `create_blend_ticket_invoice` → `invoice_items.acres / rate_per_acre`, `invoice_shares.price_per_acre_cents` |
| **Routed, RLS-protected, shipped** | ✅ Live | `/fields/:id` → `FieldSetup` (admin + sales_rep); RLS on `fields` / `field_polygons` / `field_billing_defaults` |

**In plain English:** a user can already draw or import a field, the app measures the acres, and those acres flow forward into a per-acre invoice that can be split across multiple growers — *the ChemMan loop, forward, already exists in CRX.* This is genuinely impressive and ahead of where the FarmOS comparison implied.

So this document is about the **delta to "world-class / ChemMan-replacement,"** which is hardening + a few high-value additions — see Part C.

---

## Owner's actual ChemMan workflow + the verified CRX gap (confirmed 2026-06-22)

Mason walked through how he bills today in ChemMan. **This is the ground truth the roadmap is now built around.**

**His daily loop:** pre-book on **planned** acres → after application, change to **as-applied** acres (e.g. 100 → 95) → ChemMan **recomputes the blend's rate/charge off the actual acres**. A single blend covers **multiple fields**, each with its **own billing split** (100% farmer / ⅓ landlord-⅔ grower / 50-50, editable per field), and the invoice **auto-figures each payer's share** across all fields in the blend. He can **type acres to override** the measured number (keeping the boundary). The **application service fee is a separate $/acre line item** (distinct from the product/chemical lines) and **must also recompute** when applied acres change. ChemMan can auto-pull as-applied acres from the **John Deere API** — but Mason wants that **deferred**: manual entry first, John Deere / Raven monitor ingestion later.

**What CRX already does (verified in code):**
- ✅ **Multi-field blend with per-field splits auto-aggregated per customer** — `transfer_job_to_invoice` sums `field_billing_defaults.split_pct × acres` per customer across all fields in the job. Matches his "4 of 5 fields 100%, 1 split → auto-figures" workflow. *(migration `20260611002255`)*
- ✅ Planned acres per field per job (`job_fields.acres_to_treat`, editable).
- ✅ Blend recipes carry `rate_per_acre` (`blend_recipe_items`).
- ✅ A *separate* field-application flow (`save_field_app_invoice`) already captures manually-entered `applied_acres` in `field_app_locations`.

**The gap — CORRECTED after a deeper dive (2026-06-22):** my first pass looked only at the thin `transfer_job_to_invoice` job-shortcut and concluded the as-applied recompute "doesn't exist." **That was wrong.** A deeper investigation found the **canonical Field Application Invoice engine already does most of Mason's daily loop.**

**Already built** (Field Application Invoice feature, shipped ~Apr–Jun 2026):
- ✅ **Enter applied acres per field → product quantities recompute** (`rate_per_acre × applied_acres`) — `FieldAppChemicalEntry.tsx:136-141` (client-side).
- ✅ **Separate application-service $/acre line that recomputes** off acres — `compute_application_service_fee()` + `save_field_app_invoice` insert an `is_application_fee=true` line.
- ✅ **Multi-field, per-customer splits** that recompute on acre change — `derive_customer_shares_from_fields()` + `field_app_locations` / `field_app_location_shares`.
- ✅ Invokable standalone (`FieldApplicationInvoice.tsx`) or from an approved blend ticket (`create_invoice_from_blend_ticket`).

**The narrower REAL gaps (the actual to-do):**
- ❌ **The job→invoice shortcut `transfer_job_to_invoice` is incomplete** — emits chemicals only, **drops the service-fee line**, and (security) **doesn't bind the actor to `auth.uid()`** (actor-forgery, HIGH). It should converge onto the canonical `save_field_app_invoice` engine. *(Already identified as "G1 / Phase 1c" in the as-applied plan.)*
- ❌ **Recompute is client-side only** — the product-line recompute lives in the React component, not a server-authoritative RPC (money-safety gap).
- ❌ **Recipe pricing is $0** — `load_recipe_into_job` sets `price_per_unit_cents=0`; a recipe-loaded job needs manual re-pricing before billing.
- ❌ **No "applied but not yet invoiced" reconciliation view** (designed, not built).
- ❌ **Field MAP → acres not wired to billing** — boundaries (`fields.boundary_geojson`), the Mapbox draw stack, and shapefile/KML import all exist, but acreage is **client-side turf.js with no server-side `ST_Area` validation**, and a drawn/imported boundary's **measured acres don't flow into the planned/billed acres** on a job or field-app invoice. *This is the original "field boundaries drive the bill" ask — the genuine connective-tissue gap.*

**Bottom line (corrected):** Mason's per-acre recompute + split billing is **largely already built** — I over-stated the gap last turn. The real remaining work is (1) finishing/securing the job shortcut, (2) the field-MAP → acreage tie-in, and (3) a few polish items — plus a large, already-designed grower-portal roadmap this feeds (next section).

---

## The bigger picture — past work already designed (so we don't lose it) — 2026-06-22

Three read-only investigators mined the codebase + past design docs. CRX has **far more of this already built or designed** than the FarmOS comparison implied. Key existing design docs: `docs/plans/2026-06-14-portal-roadmap-build-vs-reuse-audit.md`, `docs/audits/2026-06-10-grower-portal-brainstorm.md`, `docs/audits/2026-06-14-spray-compliance-data-model.md`, `docs/audits/2026-06-18-as-applied-application-invoices-plan.md`.

**Split-billing foundation — BUILT (some dormant, no live data yet):**
- `field_billing_defaults` = per-field owner-split matrix (landlord/tenant %, `price_override_cents`) — **live, foundational**, validated to sum 100%.
- `order_item_field_allocations` + `create_split_invoices_from_order()` = order-side split engine, **penny-exact (largest-remainder), smoke-tested, edit-locked after post** — built but **0 live split invoices yet** (production-ready, just unused).
- `field_app_location_shares` / `invoice_shares` = per-field/per-invoice split snapshots — used by the field-app engine.
- `order_shares` = order-level UI denorm only — **not** part of invoicing logic; leave alone.

**As-applied / Field Invoices — SHIPPED (with the gaps above):** segregated Field Invoices area, per-acre-only billing, editable until posted, reconciled against blend ticket, dedicated PDF (`drawFieldApplicationLayout`).

**Field mapping / spatial — LIVE & reusable:** `fields.boundary_geojson` + `centroid_geojson`; Mapbox stack (`CRXMap`, `FieldBoundaryLayer`, `DrawControl`, satellite); import pipeline (shapefile via shpjs, KML via togeojson, GeoJSON, proj4, turf area); **PostGIS enabled** (server-side spatial joins possible).

**The strategic blocker — field_id linkage (G5):** `orders` / `invoices` / `quotes` / `order_items` have **no `field_id`** (only free-text `invoice.field_names`); reliable field linkage exists **only** via `application_records.field_id` + `blend_tickets.field_id`. This blocks per-field invoice attribution and the portal's "auto-fill costs from your own invoices" moat. Audit recommends v1 = application/blend-first (lowest lift); long-term = add `field_id` to order/invoice items.

**Grower-portal vision (G1–G15) — DESIGNED, not built:** `field_seasons` + whole-field **breakeven calculator** + `field_season_costs` (auto-suggest from the grower's own invoices) → **field profitability map** (one more Mapbox layer; the "worst 10% of your acres cost you $X" sales hook) → soil/tissue tests → nutrition programs → yield upload (`yield_datasets`/`yield_grid_cells`). Architecture decided: separate portal app, same Supabase DB, `customer` role + `portal_*` RPCs (the heavy-review gate, sequenced last; internal-first recommended).

**Spray compliance (G1–G3) — DESIGNED:** chemical-shed inventory **auto-credited from CRX deliveries** (`delivered − applied = on-hand`); per-field spray checklist; compliance-grade application log (≈70% built in `application_records`); **follow-up trip timers** (pre-emerge applied → "2nd trip due ~May 31" countdown + email/SMS) — *prerequisite: label data (REI/PHI/EPA#), currently 0% populated*; private-vs-commercial compliance regimes; internal crew spray board.

---

# PART A — FarmOS Gap Analysis

## The framing that matters
FarmOS and CRX are **not** competitors — they sit on opposite sides of the same transaction:
- **FarmOS = the grower's notebook** (Drupal, open-source, GPL). Field records + planning for the farmer; **no invoicing, no AR, no sales pipeline, no commissions** (verified against its module list).
- **CRX = the retailer's business system.** Quotes → orders → deliveries → invoices → AR → commissions → sellable inventory → blend tickets — **plus** the field-mapping/per-acre-billing pipeline above.

So "what are we lacking vs FarmOS" only bites on the **grower-facing / agronomic side**.

## Where FarmOS is ahead (gap concepts), with CRX's *actual* current state

| # | FarmOS capability | CRX today (verified) | Still worth borrowing? |
|---|---|---|---|
| A1 | **Field mapping (geospatial)** — draw/import boundaries, acreage, KML/GeoJSON | **Already built & live** (draw + import + acreage + billing) | Mostly DONE — remaining delta is hardening (Part C), not the feature itself |
| A2 | **Flexible "log" production records** — observation / soil-test / scouting / harvest, custom log types | Narrow (application + billing); no general agronomic log | Yes — grower-portal depth |
| A3 | **The farm's own assets** — land/equipment/livestock/plantings with history & movement | CRX tracks *sellable product* inventory, not the grower's gear/crops | Low-Medium (portal) |
| A4 | **API-first + offline + sensors** — JSON:API + OAuth2, sensor/IoT streams | Supabase auto-API; Field Mode offline-replay still a to-do | Medium — integrations |
| A5 | **Crop planning** — plans/plantings/rotations/seasons | "Season" for sales, not crop planning | Low |
| A6 | **Compliance / traceability framework** — organic/GAP audits, lot tracking | RUP/REI/PHI starting; label data **0 of 604 products loaded** | Medium — ties to existing label-data gap |
| A7 | **Add fields without a migration** (Drupal entity/field system) | Migration per schema change (safer, less flexible) | Informational trade-off |

**Net:** FarmOS's headline advantage (A1, mapping) is **the one area CRX has already substantially closed.** The remaining FarmOS-flavored gaps are on the *records / portal / compliance* side (A2, A6), not mapping.

## Where CRX is far ahead of FarmOS
Real financial engine (invoices, AR aging, payments, credit memos, finance charges, period close, append-only audit log, money-as-cents) · full sales pipeline with enforced lifecycles · commissions · sellable-inventory math · blend tickets + OCR · **and a per-acre field-billing pipeline FarmOS doesn't attempt** · engineering rigor (RLS, idempotency, generated columns, guardrails).

---

# PART B — How the best apps do Boundaries → Acreage → Per-Acre Billing (the benchmark)

*Research basis: 8 parallel research agents, ~170 web sources, June 2026. Confidence flagged honestly; the biggest caveat is on ChemMan itself (§B6). Use this as the **yardstick** to measure CRX's existing pipeline against.*

## B1. The benchmark: ChemMan = "Chem-Man" by DataSmart Software
"ChemMan" is **Chem-Man by DataSmart Software (Jonesboro, AR)** — a 30+ year custom-application platform (aerial + ground), with a Retailer/Co-op plan. **Not** a precision-ag mapping cloud (no John Deere / FieldView). Its reputation is specifically the **billing-from-acres loop**:

1. **Boundary in** — USDA FSA/CLU border, **draw**, or **import** KML/shapefile; auto legal-description lookup (lat/long, section/township/range/county).
2. **Acres** — FSA "Calculated Acres" for CLU fields; measured for drawn fields.
3. **Load/recipe math** — *"calculates equal or full loads determined by the vehicle capacity, acres, and target rate"* → product qty = **acres × rate/acre**, split into loads by tank/hopper capacity; calculator back-solves the rate.
4. **One-click job → invoice**; full AR / statements / aging.

**HIGH confidence:** boundary methods, acres×rate load calc, job→invoice→AR.
**LOW confidence / undocumented (confirm from Mason's hands-on use):** drawn-acre method, **planned vs as-applied (GPS) acre billing**, billable-acre override, retailer multi-grower hierarchy. *(No G2/Capterra/public tech docs — vendor + 2 trade articles only.)*

## B2. The "world-class" pattern (the yardstick)
1. Boundary created once (draw / shapefile / CLU / JD-FieldView sync), bound to **Customer → Farm → Field**.
2. Acres auto-derived (planimetric), **interior exclusions** (waterways/buildings/pivot corners) subtracted.
3. **Two/three acre figures kept distinct, never silently merged** — measured (geometry) vs FSA-reported vs manual billable override; editing the boundary updates *measured* but does **not** auto-change the *billed* acre (deliberate, audited). *(Agvance "GIS vs Reported"; FieldAlytics boundary/FSA/insurance/billable.)*
4. **Rate × acres = line qty**; per-acre service fee and product sold are **separate line categories** *(Raven AgSync "Charges vs Products")*; bidirectional rate calculator.
5. One-click job → invoice → AR.
6. **Plan-vs-applied true-up** — bill planned acres at order, reconcile to **as-applied/GPS acres** at completion, push the delta *(Raven `CompletedAcres`; FieldAlytics Entered→Accepted→Completed)*. **Most vendors are weakest here — and CRX's `confirm → complete` delivery lifecycle is the right shape to leapfrog.**

> **Key strategic finding:** *None* of the grower-side mapping clouds (John Deere Operations Center, Climate FieldView, Granular) do per-acre billing — they're agronomy/equipment/analytics. **The billing differentiator lives in the retail ERP.** CRX already owns that *and* has built the mapping front-end — so it's in a strong position; the work is polish, not invention.

## B3. Benchmark matrix (incl. where CRX stands today)

| Product | Boundary creation / import | Storage | Acreage method | Per-acre billing tie-in | Confidence |
|---|---|---|---|---|---|
| **CRX Manager (today)** | **Draw (Mapbox) + shapefile/KML/GeoJSON import + multi-polygon** | `geography(POLYGON,4326)` + `field_polygons` jsonb | **Client-side Turf.js**, stored denormalized in `fields.total_acres` (user-overridable) | **Live:** acres + per-grower split/override → `transfer_job_to_invoice` → invoice items + shares | Verified in code |
| **ChemMan (DataSmart)** | FSA/CLU, draw, KML/shapefile, GPS log | Proprietary | FSA "Calculated Acres"; draw-path undocumented | acres×rate → load calc → 1-click job→invoice → AR | Med (vendor only) |
| **Agvance SKY (SSI)** | Draw, shapefile, bulk; FieldView export; nightly JD/Raven/FieldView pull | Shapefile interchange | Planimetric "GIS Acres" separate from "Reported Acres" | Field Plan → blend ticket (Rate/Acre calc, 4 "Price By") → invoice; "Acres Applied" uninvoiced dashboard | High |
| **FieldAlytics + Merchant Ag** | Draw exterior+interior, pivot, shapefile, **USDA CLU** | Field model | Planimetric (ext−int); **+ FSA / insurance / billable override** | rate × billable-acres → work order → Accepted (ERP batch) → Completed (true-up to applied) → invoice | High |
| **Raven Slingshot / AgSync** | Draw (live area), machine coverage (`AppliedWkt`), aerial | **WKT** + REST API | Live planimetric; **`CompletedAcres` = GPS applied acres bills** | order→work order→applied acres→invoice; **Charges vs Products**; **BillingEntities %-split** | High |
| **JD Operations Center** | Draw, RTK drive, generate-from-as-applied, shapefile | **GeoJSON MultiPolygon** API | Auto planimetric; machine ≠ FSA acres | **None** — source only; CRX ingests | High |
| **Climate FieldView** | Draw, in-cab, shapefile, GeoJSON API | **GeoJSON Feature**; 1 boundary = field | Planimetric (caps 20k ac) | **None** — source only; no native export | High |
| **agX / Sirrus** | CLU "Pick a Field", draw, pivot, shapefile | agX; **GUID + version per boundary** | Planimetric / CLU | **None natively** — data-standard layer | Med |
| **Conservis / Traction** | Draw, CLU/FSA, shapefile + **GeoJSON**, mass import | **GeoJSON + shapefile** | Planimetric; operational-vs-FSA, prorated | **No customer invoicing** — internal cost/acre | High |

> Only **ChemMan, Agvance, FieldAlytics+Merchant Ag, Raven AgSync — and now CRX** — are genuine ag-retail per-acre *billing* engines. Trimble/Granular/Conservis compute grower *cost*, not a customer invoice.

## B4. Interoperability — what we already do vs what's expected
Convergent standard: **GeoJSON MultiPolygon in WGS84 (EPSG:4326)** canonical; **ESRI shapefile** universal interchange.
- **CRX already supports** shapefile + KML + GeoJSON import and on-map draw. ✅ (That's the table-stakes set.)
- **Strongly expected, not yet done:** **USDA CLU "Pick a Field"** one-click capture. **Honest caveat:** the 2008 Farm Bill §1619 restricts CLU distribution — only the 2008 vintage is public; current CLUs are limited to FSA-certified cooperators. So we **can't promise a live national CLU lookup** — keep relying on grower-supplied imports.
- **Differentiating, not yet done:** John Deere Operations Center (OAuth → GeoJSON + Boundary-Events webhooks) and Climate FieldView (per-field "Send Key" consent). Middleware **Leaf Agriculture** collapses many providers into one normalized API with a **"Merged Field ID"** (paid dependency) — the fast multi-source path.

> **Highest-leverage interop idea (Leaf): the canonical / merged field.** One physical field arrives from several sources as overlapping polygons with different acre numbers; de-duplicating into ONE canonical billable field (geometry + name + season match, source-tagged, versioned) is most of what separates "we import shapefiles" (CRX today) from "world-class acres-for-billing." CRX's importer currently does **not** dedupe by spatial overlap — that's a real gap.

## B5. The hardening delta (turn CRX's existing pipeline into "world-class")
CRX already has the pipeline; these are the specific upgrades that close the distance to the benchmark. Each is small and bounded.

1. **Make acreage server-authoritative (money-safety — highest value).** Today acres are computed **client-side in Turf.js** and stored denormalized in `fields.total_acres` (user can type any number; no validation). The benchmark systems treat the billed acre as a *defensible, auditable* number. **Recompute acres server-side in the save RPC** with PostGIS: `round(ST_Area(boundary::geography)/4046.8564224, 2)` — **using the `::geography` (geodesic) cast** (raw 4326 geometry returns square *degrees*). Keep the Turf.js number as the live on-screen preview only. *(Note: multi-polygons are stored as jsonb GeoJSON, not PostGIS geometry — to ST_Area them, parse with `ST_GeomFromGeoJSON` or also store a `geometry` column.)*
2. **Validate the polygon before it can bill.** Add `ST_IsValid` / `ST_MakeValid` + an area sanity band (e.g. 0.1–5,000 ac) in the save RPC so a self-intersecting or fat-fingered draw can't mint a 40,000-acre invoice. Currently there is **no geometry validation**.
3. **Make the three-acre model explicit + audited.** Today `total_acres` is a single overridable number and FSA numbers are metadata only. Store **measured_acres** (PostGIS), optional **fsa_acres**, and optional **override_acres** separately; bill off `COALESCE(override, fsa-if-chosen, measured)`; **audit-log which acre billed and when**, and make "apply a new measured acre to billing" a deliberate action so re-drawing a boundary can't silently change a bill. *(This matches CRX's "changing a billing number is a checked action" culture — and there is currently no acreage audit trail.)*
4. **Plan-vs-applied true-up (the leapfrog).** Bill planned acres at order/confirm, reconcile to **as-applied acres** at delivery `complete`, push the delta — the place ChemMan and most rivals under-document. CRX's `confirm → complete` lifecycle is already the right hook; today applied acres aren't reconciled back to the field/invoice.
5. **Import dedup / canonical field.** Add spatial-overlap duplicate detection on bulk import (Leaf "merged field" idea) so re-importing the same field doesn't create orphan duplicates with conflicting acres.
6. **(Optional) CLU "Pick a Field"** where obtainable, with the §1619 caveat.

> **Note on map library:** CRX already uses **Mapbox GL** (`mapbox-gl ^3.18.1` + `@mapbox/mapbox-gl-draw`), which requires a `VITE_MAPBOX_TOKEN` and is on Mapbox's **usage-metered, proprietary** license (v2+). That's a *business/cost* item, not a bug — but worth a periodic check that the token tier and per-map-load costs are acceptable as field usage grows. (MapLibre is the BSD-licensed swap-in if costs ever become a concern; not recommended to switch reactively.)

## B6. Honest gaps, risks & caveats
- **ChemMan is the thinnest-sourced product in the brief — treat the benchmark skeptically.** Confirm from Mason's hands-on use before anchoring the build: (1) planned vs as-applied acres? (2) per-field billable-acre override? (3) retailer multi-grower structure? (4) drawn-polygon acreage method? Also: **ChemMan does NOT integrate John Deere or Climate FieldView** — so matching it doesn't require those connectors; beating it on telematics ingest would be a *differentiator*.
- **The #1 real-world dispute: which acre bills correctly?** Planimetric (map), FSA-reported, and GPS as-applied acres **legitimately differ**. There's no single "right" number — store all three, let the user choose per field, log the choice, surface them side-by-side. (CRX today has measured+override but not a distinct FSA acre or an audit of which billed.)
- **Licensing:** Mapbox GL v2+ (already in use) is proprietary/metered — confirm cost tolerance. Satellite imagery basemap commercial-use terms must be confirmed for a revenue app (ESRI free tier has revenue restrictions; Mapbox/MapTiler metered; Sentinel-2 open) — a business/legal check for Mason. `farmOS-map` (if ever borrowed for UX) is **MIT** (the farmOS Drupal app is GPL).
- **Confidence:** agX claims medium (primary docs unreachable); Agvance/FieldAlytics/Merchant Ag internal billing wiring is feature-level only (proprietary).

---

# PART C — Roadmap (the to-do) — corrected & consolidated 2026-06-22

> **Reality check:** a deep dive found the per-acre **recompute + split billing Mason does daily is largely ALREADY BUILT** (Field Application Invoice engine). The real work is finishing/securing the edges, wiring **field MAPS → acres → bill** (the original ask), and the bigger already-designed grower-portal roadmap. SQL/money/RLS work routes through `/ship` + migration review + Codex gate; a live migration needs Mason's explicit OK.
>
> **Confirmed (Mason):** the application service fee is a separate $/acre line and recomputes with the product lines when applied acres change.

### Phase 0 — Decisions (no code; mostly Mason's call)
- [ ] **Priority call (Mason):** which thread first — **(A)** prove/finish the as-applied billing loop, **(B)** wire field-map → acres into billing (the original ask), or **(C)** the `field_id`-linkage + portal foundation? *(Recommendation: A → B, with C as a separate strategic decision.)*
- [ ] **Field-linkage decision** (the strategic blocker): orders/invoices have **no `field_id`** — reliable linkage is only via `application_records` + `blend_tickets`. Pick: v1 = application/blend-first (lowest lift) vs long-term `field_id` on order/invoice items. *(From the 2026-06-14 build-vs-reuse audit.)*
- [x] **Confirmed (Mason):** service fee is a separate $/acre line; both product + service lines recompute on applied-acre change.
- [ ] Mapbox token-cost / imagery commercial-use terms — a business check.

### Phase 1 — Finish & secure the as-applied billing loop (mostly completing existing work)
- [x] **PROVEN (2026-06-22, rolled-back live smoke).** Ran the real `save_field_app_invoice` engine against the live schema in a rolled-back transaction: 2 fields (F1=100ac 100% Farm A via fallback; F2=80ac split A 67% / B 33%), product @2/ac×$10, service @$13/ac. Planned run → Farm A **$5,068.80**, Farm B **$871.20**. Changing F1 100→95 → Farm A **$4,903.80** (exactly −$165.00: $100 product + $65 service) and Farm B **unchanged**. Confirms: product line + separate `is_application_fee` service line + per-customer multi-field splits all recompute off applied acres, **server-side**, penny-exact. *(Scope: proves the canonical engine used by the Field Application editor + blend tickets; does NOT cover the `transfer_job_to_invoice` shortcut — still on the list below.)* + Codex independent review (see `docs/audits` / session notes).
- [x] **Recompute IS server-authoritative** — corrected: `save_field_app_invoice` recomputes product quantity server-side (`v_chem_qty_b = rate_per_acre × share_acres`); the `FieldAppChemicalEntry.tsx` math is only a live preview. (Confirmed reading live source + Codex.)
- [ ] **Codex independent-review punch-list (2026-06-22) — harden before production reliance** (raw: `.claude/session-state/codex-billing-review-latest.txt`; verdict HAS-BUGS = edge-cases, the proven happy path stands):
  - **HIGH — reject 0 / negative applied acres.** UI sends `applied_acres || total_acres` so a real **0 becomes full-field acres**; negatives pass unchecked → negative bill. Fix: positive-acres guard in `save_field_app_invoice` + UI `min`. (`FieldApplicationInvoice.tsx:414,762`; `20260616191740…sql:532,662`)
  - **HIGH — make grouped delete/edit/post `deleted_at`-aware.** Group queries select by `invoice_group_id` without excluding soft-deleted siblings → a deleted invoice can be reused on edit or included in `post_invoice_group`. *Verify, then fix.* (`FieldApplicationInvoice.tsx:552`; `20260616191740…sql:606`; `20260614144252…sql:121`)
  - **MED — capture product cost on override (grower-share) acres.** `v_chem_qty_a` lines insert `cost_cents=0` and aren't added to `v_invoice_cost` → **margin overstated** on override-acre invoices (customer bill is correct). (`20260616191740…sql:705,717,785`)
  - **MED — acre-rounding drift.** `derive_customer_shares_from_fields` rounds `share_acres` to 2 dp before billing; on tiny splits the billed-acre sum can drift a few cents. (`20260429140635…sql:151`)
  - **MED — bind/admin-gate `salesman_id`.** `p_performed_by` is actor-bound (good) but `p_invoice.salesman_id` is client-trusted → a rep could attribute an invoice to another user. (`20260616191740…sql:486,627,638`)
- [ ] **Converge `transfer_job_to_invoice` onto the canonical engine** so the job→invoice shortcut emits the **service-fee line** and binds the **actor to `auth.uid()`**. *(The as-applied plan's "G1 / Phase 1c".)*

### Phase 2 — Field MAP → acres → bill (the original "field boundaries" ask)
- [ ] Server-side acreage: `ST_Area(boundary::geography)/4046.8564224` + `ST_IsValid`/`ST_MakeValid` + area-band guard (today acreage is client-side turf.js, no validation).
- [ ] Make a drawn/imported boundary's **measured acres flow into the planned acres** on a job / field-app invoice, and be the default for the applied-acres entry + override.
- [ ] Distinct **measured / FSA / billed** acres + audit-log of which acre billed (today `total_acres` is one number).

### Phase 3 — Polish
- [ ] **Recipe pricing** — add `$/unit` to `blend_recipe_items` so a recipe-loaded job doesn't need manual re-pricing (today `price_per_unit_cents=0`).
- [ ] **"Applied but not yet invoiced" reconciliation view** (designed, not built — AR-leakage guard).

### Phase 4 — The bigger grower-portal roadmap (already designed — see "bigger picture" section)
- [ ] Field-linkage build (per the Phase-0 decision) → unlocks per-field cost attribution.
- [ ] `field_seasons` + breakeven calculator + `field_season_costs` (internal-first, no portal needed).
- [ ] Field **profitability map** (one more Mapbox layer) — the "worst 10% of your acres cost you $X" sales hook.
- [ ] Spray compliance: chemical shed (auto-credit from deliveries), spray checklist, **follow-up trip timers** (label data is the prerequisite — 0% populated today).
- [ ] Yield upload → grid cells; soil/tissue tests; nutrition programs.
- [ ] Portal security wall (`customer` role + `portal_*` RPCs) — the heavy-review gate, last.

### Phase 5 — As-applied AUTO-ingestion (DEFERRED per Mason)
- [ ] John Deere Operations Center + Raven monitor API → auto-pull as-applied acres (manual entry ships first). Import dedupe / USDA CLU where obtainable.

### Already working (no action needed)
- ✅ As-applied recompute of product lines + separate service-fee line + per-customer multi-field splits (Field Application Invoice engine).
- ✅ Order-side split-invoice engine (`order_item_field_allocations` + `create_split_invoices_from_order`, penny-exact) — built & smoke-tested, just no live data yet.
- ✅ Field boundaries (`boundary_geojson`) + Mapbox draw stack + shapefile/KML/GeoJSON import + per-field owner splits (`field_billing_defaults`).

---

## Sources (key)
ChemMan: chem-man.com, datasmartonline.com, agairupdate.com · Agvance: helpcenter.agvance.net · FieldAlytics: help.fieldalytics.com, ever.ag · Raven AgSync: developer.ravenslingshot.com · John Deere: developer.deere.com/dev-docs/boundaries · Climate FieldView: dev.fieldview.com · agX/Sirrus: help.sirrus.proagrica.com · Conservis/Traction: success.tractionag.com · Leaf: withleaf.io · Standards: aggateway.org (ADAPT), postgis.net (ST_Area), RFC 7946, fsa.usda.gov (CLU) · Libraries: maplibre-gl-js, farmOS-map, shapefile-js · FarmOS: github.com/farmOS/farmOS, farmos.org/model.

**CRX current-state evidence (verified 2026-06-22):** `src/pages/FieldSetup.tsx`, `src/components/map/{CRXMap,DrawLayer,FieldBoundaryLayer}.tsx`, `src/components/fields/BulkFieldImport.tsx`, `lib/fieldImportParser.ts`, migrations `20260213000000_phase1_fields_foundation.sql`, `20260214000000_phase4b_mapbox_integration.sql`, `20260221200000_grower_share_pricing.sql`, `20260334900000_field_grouping_multi_polygon.sql`; RPCs `save_field`, `save_field_geometry`, `save_field_polygons`, `transfer_job_to_invoice`, `create_field_app_invoice`, `create_blend_ticket_invoice`.

*Full structured research (8 agents, all sources, per-product confidence) is preserved in the workflow transcript for this session.*
