# Repo Scout — LiteFarmOrg/LiteFarm

**Date:** 2026-06-19
**Scout target:** `LiteFarmOrg/LiteFarm`
**Lens focus:** compliance (pesticide/fertilizer/nutrient plans, organic certification), field-intel, CRM-UX
**Purpose:** mine ideas / data-models / formulas (clean-room) to improve CRX Manager.

---

## Identity & stack

LiteFarm is an open-source, community-led **farm management system** for growers (with a strong focus on organic/regenerative smallholders and decision support). It is a **grower's own-farm app**, NOT an ag-retail dealer system — so most candidates below are *translated* into CRX's dealer/applier/compliance-carrier role, and grower-only features (animal management, crop planning UI, harvest yields, employee wages/shifts) are discarded.

- **Stack:** React (web app) + Node.js API using **Objection.js ORM + Knex** migrations on **PostgreSQL**; Redis/Bull job queues; i18n via i18next. (Evidenced by `packages/api/src/models/*.js` Objection models and `packages/api/db/migration/*.js` Knex migrations.)
- **Notable architecture:** task-centric data model (one `task` table with per-type child tables: `soil_amendment_task`, `pest_control_task`, `soil_sample_task`, etc.); a Bull job pipeline that assembles **organic-certification export packets** (`packages/api/src/jobs/certification/`); an `offline_event_log` for offline/PWA telemetry; 8 UI locales.

## Confirmed license

**GPL-3.0** — confirmed via the GitHub license API: `gh api repos/LiteFarmOrg/LiteFarm/license --jq '.license.spdx_id'` → `GPL-3.0` ("GNU General Public License v3.0").

**Borrow rule:** GPL-3.0 is copyleft. CRX is hosted SaaS but built on a different stack (Supabase/React vs Node/Objection), so code-lift is neither safe nor relevant. **All candidates below are IDEAS / DATA-MODEL shapes / FORMULAS only**, clean-room re-implementable on Supabase Postgres + React. No source is copied.

## Top features (observed)

1. **Task system with typed sub-tasks** — `soil_amendment_task`, `pest_control_task`, `soil_sample_task`, `cleaning_task`, irrigation, scouting, harvest, etc., all sharing one `task` parent with assignee/due-date/abandonment-reason lifecycle. (`packages/api/src/models/taskModel.js`)
2. **Rich nutrient/soil-amendment product chemistry** — elemental analysis (N,P,K,Ca,Mg,S,Cu,Mn,B), molecular compounds (ammonium/nitrate), moisture %, with unit + percentage CHECK constraints. (`packages/api/db/migration/20240504185218_create_soil_amendement_task_products_table.js`)
3. **Pesticide model carrying REI/PHI** — `entry_interval` (re-entry interval), `harvest_interval` (pre-harvest interval), active ingredients, concentration. (`packages/api/src/models/pesiticideModel.js`)
4. **Organic-certification export packet generator** — Bull job pipeline retrieves → builds Excel "Record D / Record A / Record I" → zips → uploads → emails to certifier. (`packages/api/src/jobs/certification/`)
5. **Compliance document vault** — typed documents (`CROP_COMPLIANCE`, `PEST_CONTROL_PRODUCT`, `SOIL_SAMPLE_RESULTS`, `WATER_SAMPLE_RESULTS`…) with `valid_until` + `no_expiration` expiry tracking. (`packages/api/src/models/documentModel.js`)
6. **Organic status history** — per-location `organic_history` with `Non-Organic / Transitional / Organic` status and `effective_date` (point-in-time status). (`packages/api/src/models/organicHistoryModel.js`)
7. **Offline event log** — session-scoped telemetry of offline/online transitions for a PWA. (`packages/api/db/migration/20260209223930_add_offline_event_log.js`)
8. **Soil-sample protocol capture** — samples-per-location, multi-depth ranges (jsonb), sampling tool enum, with jsonb-length CHECK constraints. (`packages/api/db/migration/20250520185926_create_soil_sample_task_table.js`)
9. **8-language i18n** (de/en/es/fr/hi/ml/pa/pt) wired through both web app and the certification PDF/Excel jobs. (`packages/webapp/public/locales/*`, `packages/api/src/jobs/locales/*`)

## Data-model highlights (cited)

- **`soil_amendment_product`** — `product_id` (PK→product), `soil_amendment_fertiliser_type_id` (DRY/LIQUID), decimals for `n,p,k,calcium,magnesium,sulfur,copper,manganese,boron`, `elemental_unit` enum (`percent|ratio|ppm|mg/kg`), `ammonium`/`nitrate` + `molecular_compounds_unit` (`ppm|mg/kg`), `moisture_content_percent`. CHECK: if any element set then unit set; if `elemental_unit='percent'` then `sum(elements) <= 100`. (`.../20240504185218_create_soil_amendement_task_products_table.js`)
- **`soil_amendment_task_products`** — join of task↔product with `weight`/`weight_unit`, `volume`/`volume_unit`, **`application_rate_weight_unit`** and **`application_rate_volume_unit`** (large enum incl. `lb/ac`, `kg/ha`, `gal/ac`, `l/ha`…), `percent_of_location_amended`, `total_area_amended`. CHECK: exactly-one-of weight/volume; if weight then weight_unit+rate present (and same for volume). (`.../20240504185218…`, `packages/api/src/models/soilAmendmentTaskProductsModel.js`)
- **Amendment method + purpose vocab** — `soil_amendment_method` keys `BROADCAST/BANDED/FURROW_HOLE/SIDE_DRESS/FERTIGATION/FOLIAR/OTHER`; `soil_amendment_purpose` keys `STRUCTURE/MOISTURE_RETENTION/NUTRIENT_AVAILABILITY/PH/OTHER`; `furrow_hole_depth` + unit. (`.../20240504185218…`)
- **`pesticide`** — `pesticide_name`, `active_ingredients`, `concentration`, **`entry_interval`** (REI), **`harvest_interval`** (PHI). (`packages/api/src/models/pesiticideModel.js`)
- **`document`** — `name`, `farm_id`, `type` enum (10 compliance types), `valid_until` (date), `no_expiration` (bool), `archived`, files relation. (`packages/api/src/models/documentModel.js`)
- **`organic_history`** — `location_id`, `organic_status` (`Non-Organic|Transitional|Organic`), `effective_date`. (`packages/api/src/models/organicHistoryModel.js`)
- **`offline_event_log`** — `session_id` (uuid), `event_name`, `status_code`, `url`, `network`, `browser`/`os`/`device_model`, `app_version`, `event_at`, `went_online_at`; UNIQUE(`session_id`,`event_name`,`event_at`) for idempotent replay. (`.../20260209223930_add_offline_event_log.js`)
- **`soil_sample_task`** — `samples_per_location`, `sample_depths` jsonb array of `{from,to}`, `sample_depths_unit` (cm/in), `sampling_tool` (`SOIL_PROBE|AUGER|SPADE`); CHECK that `jsonb_array_length(sample_depths) = samples_per_location`. (`.../20250520185926…`)

---

## Candidate table

| # | Title | Lens | Relevance | Effort | Borrow | Fills gap |
|---|-------|------|-----------|--------|--------|-----------|
| 1 | Product label-data fields: REI/PHI + signal word from a pesticide model | compliance | 5 | S | data-model | label data (0/604) |
| 2 | Elemental nutrient analysis (N-P-K + micronutrients) on blend/fertilizer products | compliance | 5 | M | data-model | label data; crop planning |
| 3 | Application-rate units + method/purpose vocab on application_records | compliance | 4 | M | data-model + formula | (deepens compliance) |
| 4 | Compliance document vault with expiry tracking | compliance | 4 | M | data-model | none (new) |
| 5 | Organic / status-history of a field (effective-dated) | compliance | 3 | S | data-model | crop planning |
| 6 | Organic-certification export packet generator | compliance | 4 | L | idea + formula | grower portal (adjacent) |
| 7 | Offline event log for Field Mode replay | architecture | 5 | M | data-model | offline Field Mode replay |
| 8 | Soil-sample protocol + results capture | field-intel | 3 | M | data-model | weather/soil integration |
| 9 | i18n architecture (locale-keyed strings, translated PDFs) | architecture | 3 | L | idea | i18n |
| 10 | "Searched/treated/GE" input-review attributes for crop-input compliance | compliance | 3 | S | data-model | label data |

---

### Candidate detail

**1. Product label-data fields: REI/PHI + signal word.**
*What it is:* LiteFarm's `pesticide` model carries `entry_interval` (re-entry interval / REI), `harvest_interval` (pre-harvest interval / PHI), `active_ingredients`, `concentration`. (`packages/api/src/models/pesiticideModel.js`)
*What we'd build:* add `rei_hours`, `phi_days`, `signal_word`, `active_ingredients`, `epa_reg_no` (already have) to CRX `products`, plus a small "label data" editor. CRX already declares these columns as a known gap (0/604 carry REI/PHI/signal_word) and the grower-portal label CSV is an open owner item — this is the cheapest, highest-value fill. *License:* idea/shape only (GPL). *Relevance 5, Effort S.*

**2. Elemental nutrient analysis (N-P-K + micronutrients) on products.**
*What it is:* `soil_amendment_product` stores decimal `n,p,k,calcium,magnesium,sulfur,copper,manganese,boron` + `elemental_unit` (`percent|ratio|ppm|mg/kg`) + `ammonium`/`nitrate` molecular compounds + `moisture_content_percent`, guarded by CHECKs (unit-presence; percent sum ≤ 100). (`.../20240504185218_create_soil_amendement_task_products_table.js`)
*What we'd build:* a `product_nutrient_analysis` table (or columns on `products`) capturing guaranteed analysis for fertilizers/blends, so CRX can label blend tickets, compute nutrients-applied per acre, and feed a future nutrient-management report. Re-implement the percent-≤-100 and unit-presence CHECKs as Postgres CHECK constraints. *License:* data-model shape (GPL). *Relevance 5, Effort M.* Fills label-data and thin crop-planning gaps; complements CRX's existing OCR blend tickets.

**3. Application-rate units + method/purpose vocabulary.**
*What it is:* `soil_amendment_task_products` separates absolute quantity (`weight`/`volume`) from **application rate** (`application_rate_weight_unit`/`application_rate_volume_unit`, e.g. `lb/ac`, `kg/ha`, `gal/ac`), plus `percent_of_location_amended`/`total_area_amended`, and an application-method enum (`BROADCAST/BANDED/SIDE_DRESS/FERTIGATION/FOLIAR/…`) + purpose enum. CHECK enforces exactly-one-of weight/volume and rate-unit-presence. (`.../20240504185218…`, `soilAmendmentTaskProductsModel.js`)
*What we'd build:* extend CRX `application_records` with `rate`, `rate_unit`, `application_method`, `area_treated`, `pct_field_treated`, and the rate-derivation formula (`rate = quantity / area_treated`, normalized to a canonical unit). This makes CRX's "we APPLY chemicals" data audit-grade and feeds RUP register + nutrient reporting. *License:* data-model + formula (GPL). *Relevance 4, Effort M.*

**4. Compliance document vault with expiry tracking.**
*What it is:* `document` table — typed (`CROP_COMPLIANCE`, `PEST_CONTROL_PRODUCT`, `SOIL_SAMPLE_RESULTS`, `WATER_SAMPLE_RESULTS`, `INVOICES`, `RECEIPTS`…), with `valid_until` (date) + `no_expiration` (bool) + `archived`, files relation. (`packages/api/src/models/documentModel.js`, `.../20220519200622_add_documents_enums.js`)
*What we'd build:* a `compliance_documents` table on Supabase Storage with the same typed enum + `valid_until`/`no_expiration`, and a dashboard widget "documents expiring in 30/60/90 days." As a dealer carrying compliance load, CRX has no document vault today — useful for SDS sheets, applicator licenses, dealer permits, certificates. *License:* data-model shape (GPL). *Relevance 4, Effort M.* New capability, not a named gap.

**5. Organic / status-history of a field (effective-dated).**
*What it is:* `organic_history` records `organic_status` (`Non-Organic|Transitional|Organic`) per location with an `effective_date`, queryable as a point-in-time timeline. (`packages/api/src/models/organicHistoryModel.js`)
*What we'd build:* a `field_status_history` (organic / certification / restricted) table keyed to CRX `fields`, so the dealer can know — at the date of an application — whether a field was organic/transitional (which products are legal). Pairs with CRX's RUP register. *License:* data-model shape (GPL). *Relevance 3, Effort S.*

**6. Organic-certification export packet generator.**
*What it is:* a Bull job pipeline (`retrieve → excel → zip → upload → email`) that assembles a certifier's required record set (Record D = crop inputs with Y/N flags for organic/searched/treated/GE; plus Record A/I) into translated Excel, zips, and emails the certifier. (`packages/api/src/jobs/certification/index.js`, `record_d_generation.js`)
*What we'd build:* a CRX "compliance packet" exporter — given a customer + date range, generate a zip of RUP sales register + application records + SDS docs as a PDF/Excel packet, queued via a Supabase Edge Function + a job table (CRX has no Bull; use a `report_jobs` table + cron). Translate the certifier-mail step to "email the grower or the regulator." *License:* idea + formula (GPL; do not copy the Excel templating code). *Relevance 4, Effort L.* Adjacent to the greenfield grower-portal gap.

**7. Offline event log for Field Mode replay.**
*What it is:* `offline_event_log` — `session_id` uuid, `event_name`, `status_code`, `url`, `network/browser/os/device_model`, `app_version`, `event_at`, `went_online_at`, with **UNIQUE(session_id, event_name, event_at)** so replays are idempotent. (`.../20260209223930_add_offline_event_log.js`, `offlineEventLogModel.js`)
*What we'd build:* CRX's offline Field Mode replay is incomplete; adopt this exact shape — a `field_mode_offline_events` table with a uniqueness key on (device session, event, timestamp) so a driver's queued deliveries/applications replay exactly-once on reconnect. This directly mirrors CRX's existing idempotency-key discipline. *License:* data-model shape (GPL). *Relevance 5, Effort M.* Fills the named offline-Field-Mode-replay gap.

**8. Soil-sample protocol + results capture.**
*What it is:* `soil_sample_task` — `samples_per_location`, `sample_depths` jsonb `[{from,to}]`, `sample_depths_unit`, `sampling_tool` (`SOIL_PROBE|AUGER|SPADE`), with a CHECK that `jsonb_array_length(sample_depths) = samples_per_location`. (`.../20250520185926_create_soil_sample_task_table.js`)
*What we'd build:* a `soil_sample` job type + results table tied to CRX `fields`, capturing depth ranges and (extending LiteFarm) lab results (pH, OM, P, K, CEC). As a dealer offering agronomy, soil sampling is a billable service CRX could schedule + invoice; results feed fertilizer recommendations. *License:* data-model shape (GPL). *Relevance 3, Effort M.* Partial fill of weather/soil-integration gap.

**9. i18n architecture (locale-keyed strings + translated PDFs).**
*What it is:* 8 locales (de/en/es/fr/hi/ml/pa/pt) via i18next, applied both in the web app and in server-side report/PDF generation (the certification jobs pull translated strings). (`packages/webapp/public/locales/*`, `packages/api/src/jobs/certification/record_d_generation.js` calls `i18n.t(...)`)
*What we'd build:* introduce react-i18next to CRX with an `en`/`es` baseline (Spanish-speaking field crews are common in US ag), and a translation layer for generated PDFs/statements. *License:* idea/architecture only (GPL). *Relevance 3, Effort L.* Fills the named i18n gap.

**10. Input-review attributes ("searched / treated / GE") for crop-input compliance.**
*What it is:* Record-D generation maps per-input booleans `organic`, `searched`, `treated` (with treated-doc), `genetically_engineered` to Y/N/N-A cells for the certifier. (`packages/api/src/jobs/certification/record_d_generation.js`, `dataToCellMapping`)
*What we'd build:* add compliance-flag columns to CRX products (`is_organic_approved`, `is_treated`, `is_gmo`, `omri_listed`) so a dealer can filter the catalog for organic-eligible customers and stamp the flags on the RUP/compliance register. *License:* data-model shape (GPL). *Relevance 3, Effort S.*

---

## Discarded (grower-only, low value for a dealer)

Animal/livestock management (`animal*`, `barn`, `fence`, `gate`), crop variety planting/bed plans, harvest yields, employee wage/shift tracking, farm map drawing (CRX already has Mapbox field polygons), nominations/market directory (grower-to-buyer marketplace), `happiness`/task-satisfaction. These only make sense for a farmer running their own operation.
