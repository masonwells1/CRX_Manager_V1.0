# Repo Scout — farmOS/farmOS

**Date:** 2026-06-19
**Scout lens focus:** compliance (input/application logs as pesticide records), architecture (asset + log + quantity + taxonomy model), field-intel
**Purpose:** Mine farmOS for ideas / data-model shapes / formulas that could improve CRX Manager (ag-retail dealer app). Ideas only — copyleft license, see below.

---

## Identity

- **Repo:** farmOS/farmOS — https://github.com/farmOS/farmOS
- **What it is:** A web-based application for farm management, planning, and record keeping, built by a volunteer community as a *standard platform* for farmers, developers, and researchers. UN-verified Digital Public Good. (`README`, https://raw.githubusercontent.com/farmOS/farmOS/HEAD/README.md)
- **Maintainer/sponsors:** Michael Stenta; sponsored by Cornell, USDA NRCS, Rothamsted Research, OpenTEAM, US Forest Service, and many ag research bodies — i.e. it is a research-grade, standards-oriented data model, not a hobby project. (`README`)
- **It is a grower's own-farm app, NOT a dealer app.** Its strength for CRX is its *data model*, which we translate to the dealer side. Most of its UI/feature surface (planting, herds, harvest) is grower-only and discarded.

## Stack

- **Drupal 10 / PHP** (entity-based CMS framework). Data model is expressed as Drupal entities + bundles + config YAML, not raw SQL. Config lives in `modules/**/config/install/*.yml`; the model is documented prose-first under `docs/model/`.
- Irrelevant to CRX's runtime (we are Supabase Postgres + React) — we borrow **shapes and logic**, re-implemented clean-room on Postgres.

## CONFIRMED License

- **GPL-2.0** — confirmed via the license API: `gh api repos/farmOS/farmOS/license --jq '.license.spdx_id'` → `GPL-2.0`. Corroborated by the README license badge.
- **Copyleft.** Building CRX *on* this source could force us to publish CRX's source. CRX is a hosted SaaS. **Therefore: borrow IDEAS / DATA-MODEL shapes / FORMULAS only (clean-room re-implementation on Supabase+React). Do NOT lift any PHP/YAML source into CRX.** Since the source is PHP/Drupal and CRX is Postgres/React, code-lift is not even useful here.

## Top features (translated relevance to CRX in brackets)

1. **Universal Asset + Log model** — everything tracked is an *Asset* (land, plant, equipment, material, product, sensor, group); everything that happens is a *Log* (activity, observation, input, harvest, lab test, maintenance, seeding…). Logs reference Assets; rich history accrues on the Asset by querying its Logs. (`docs/model/type/asset.md`, `docs/model/type/log.md`) [CRX: a unified event-log spine for application/delivery/observation history]
2. **Input Logs = pesticide/fertilizer application records** — an Input Log carries Lot number, Method, Source, Purchase date, plus Material Quantities (rate/amount + unit). (`docs/model/type/log.md` → "Input Logs"; `modules/log/input/config/install/log.type.input.yml`) [CRX: the compliance-grade application record / RUP register backbone]
3. **Quantity records** — granular typed measurements (Measure ∈ Count/Weight/Area/Volume/Rate/… ; Value as numerator/denominator integers; Label; Unit as a taxonomy Term). Attached to Logs. (`docs/model/type/quantity.md`) [CRX: exact-fraction rate math; avoids float drift]
4. **Inventory via adjustment Quantities** — inventory is *derived*, not stored: sum increments − decrements since the last "reset", per (measure, unit) pair. (`docs/model/logic/inventory.md`) [CRX: an audit-friendly event-sourced inventory ledger]
5. **Location/movement logic** — an Asset's location/geometry is *computed* from "movement" Logs over time; full location history is queryable. Fixed assets carry intrinsic geometry. (`docs/model/logic/location.md`) [CRX: time-travel field/asset location; minor relevance]
6. **Lab Test Logs** — soil / tissue / water test types, with Laboratory term, Test type, Soil texture, and Test Quantities (method per quantity). (`modules/log/lab_test/config/install/*`, `docs/model/type/log.md`) [CRX: fills the soil/tissue-test gap; ties to recommendations]
7. **Plans + Plan Records** — higher-level goal records (e.g. a Crop Plan / Input Plan) that reference Assets+Logs and store *relationship metadata* (Target vs Actual, days-to-harvest). (`docs/model/type/plan.md`, `docs/model/type/plan_record.md`) [CRX: a planned-vs-actual program model; thin-planning gap]
8. **Terms / vocabularies with Ontology URI + hierarchy** — user-extensible taxonomies (Material type, Product type, Season, Unit) with parent hierarchy and external ontology links. (`docs/model/type/term.md`) [CRX: metadata-driven catalog classification + custom-field-lite]
9. **Data Streams** — sensor/device data feeds keyed to Assets, with per-stream key + public flag. (`docs/model/type/data_stream.md`) [CRX: weather/soil-sensor ingestion shape; field-intel gap]
10. **Flags + Categories** — Flags (Priority / Needs review / Monitor / Organic) are code-defined attention markers spanning Assets/Logs/Plans; Categories are user-managed multi-assign taxonomy on Logs. (`docs/model/type/log.md`) [CRX: cheap cross-entity triage/filtering layer]

## Data-model highlights (cited)

- **Asset** standard attributes: Name, Flags, Geometry (computed), Intrinsic geometry, Is location, Is fixed, Notes, ID Tags, **Data (freeform JSON/YAML "escape hatch" field for external system IDs + unstructured metadata)**, Archived; relationships: Location, Parents (lineage/hierarchy, no cycles), Owners, Images, Files. (`docs/model/type/asset.md`)
- **Log** standard attributes: Name (auto from `name_pattern`), Timestamp, **Status ∈ pending / done / abandoned** (planned → actual; every edit is a revision), Flags, Geometry, Is movement, Notes, Data; relationships: Assets ("happened TO"), Locations ("happened IN"), Quantities, Owners, Categories, Equipment used, Images, Files. Crucial distinction: TO vs IN. (`docs/model/type/log.md`)
- **Input Log** type-specific: Lot number, Method, Purchase date, Source; default quantity type = `material`. (`docs/model/type/log.md`; `modules/log/input/config/install/log.type.input.yml`)
- **Quantity**: Measure (enumerated list incl. Rate, Area, Volume, Ratio, Probability), Value (numerator/denominator integers → exact fractions), Label, Unit (Term ref); optional Inventory adjustment {reset|increment|decrement} + Inventory asset ref. (`docs/model/type/quantity.md`)
- **Inventory formula:** `inventory(asset, measure, unit) = Σ(increments) − Σ(decrements)` over all adjustment Quantities **since the most recent `reset` (else 0)**, computed **per (measure, unit) pair**. (`docs/model/logic/inventory.md`)
- **Lab Test Log** type-specific: Test type, Soil texture, Laboratory (Term); soil/tissue/water bundles; default quantity type = `test` (each Test Quantity carries a Test method Term). (`docs/model/type/log.md`; `modules/log/lab_test/config/install/farm_lab_test.lab_test_type.soil.yml`, `…lab_test_type.tissue.yml`, `log.type.lab_test.yml`)
- **Plan / Plan Record:** Plan default workflow = planning / active / done / abandoned; a Plan Record stores **metadata of the Plan↔record relationship** (e.g. Input Plan's Target vs the Log's Actual; Crop Plan's days-to-harvest seeded from a Term default and overridable). (`docs/model/type/plan.md`, `docs/model/type/plan_record.md`)
- **Term:** Name, Description, **Ontology URI** (link to external ontology), Weight (ordering), Parent (hierarchy). (`docs/model/type/term.md`)
- **Data Stream:** Name, Private key, Public flag; references Assets; device data decoupled from the Asset so a sensor can be moved/reused. (`docs/model/type/data_stream.md`)
- **Architectural throughline:** behaviors are added by *enabling a module* that hangs fields off the shared base types — Inventory module adds the inventory field to all Assets; Equipment module adds "Equipment used" to all Logs. Composition over a wide table. (`docs/model/type/asset.md` "Additional attributes", `docs/model/type/log.md` "Additional relationships")

---

## Candidate table

| # | Title | Lens | Relevance | Effort | Borrow | Fills gap |
|---|-------|------|-----------|--------|--------|-----------|
| 1 | Input-Log application record (Lot/Method/Source/rate-qty) | compliance | 5 | M | data-model | label data / RUP register |
| 2 | Derived event-sourced inventory (reset+adjust ledger) | architecture | 4 | M | formula | inventory valuation/method |
| 3 | Lab Test Log (soil/tissue/water + method) | field-intel | 5 | M | data-model | weather/soil integration |
| 4 | Exact-fraction Quantity (numerator/denominator) for rates | architecture | 3 | S | formula | none (hardening) |
| 5 | Plan + Plan-Record planned-vs-actual program model | CRM-UX | 4 | M | data-model | crop planning thin |
| 6 | Term vocabularies w/ Ontology URI + hierarchy | architecture | 4 | M | data-model | metadata custom fields |
| 7 | pending/done/abandoned status + revision history on events | architecture | 3 | M | idea | none (hardening) |
| 8 | Data Stream sensor-ingestion shape | field-intel | 4 | L | data-model | weather/soil + NDVI |
| 9 | Asset "Data" JSON escape-hatch + ID Tags | architecture | 3 | S | idea | metadata custom fields |
| 10 | Flags (code) vs Categories (user) triage layer | CRM-UX | 3 | S | idea | CRM sales pipeline |
| 11 | TO-vs-IN reference split (asset acted-on vs location) | compliance | 4 | S | idea | label data / app records |

Full detail per candidate is in the structured output. Evidence paths are cited inline above and per-candidate.

---

## Scout's bottom line for Mason (plain English)

farmOS is a *grower's* app, so almost none of its screens matter to us — but it has spent a decade refining **how to record "a chemical was applied to a field," in a way auditors and researchers trust.** That recording shape is exactly CRX's weakest spot today (we have application services but 0/604 products carry label data and no formal application/lab record).

The three highest-value, dealer-relevant borrows:

1. **The application-record shape** (Input Log): every application carries *what product, what rate, what lot number, what method, what source, on what field, when, status pending→done*. Re-implemented on Supabase this is the spine of a compliant RUP register + the grower-portal "what did the dealer put on my field" view.
2. **Soil/tissue/water Lab Test records** — a clean shape for storing test results that then justify a blend recommendation. Directly fills the "no soil integration / thin planning" gap and is a natural grower-portal feature.
3. **The Plan / planned-vs-actual idea** — store the *target* rate on the plan and the *actual* on the application; the gap is the report. That is real crop-planning value with a small data footprint.

All of these are clean-room IDEAS/SHAPES rebuilt on our stack. We copy nothing from their GPL PHP.
