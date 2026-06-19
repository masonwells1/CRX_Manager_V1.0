# Theme synthesis — "field-intel" lens

_Synthesized 2026-06-19 from the 6 repo scouts in this folder._
_Repos scouted: frappe/erpnext · twentyhq/twenty · microsoft/farmvibes-ai · ekylibre/ekylibre · LiteFarmOrg/LiteFarm · farmOS/farmOS._

## What "field-intel" means here, and what got cut

"Field-intel" = turning a CRX **field** (we already have Mapbox polygons + FSA on `fields`) into a source of agronomic data: remote-sensing/NDVI, weather, soil/lab tests, and the sensor/observation substrate that holds it. CRX is a **dealer**, not a grower's farm app, so every idea below is reframed to dealer value: data that **justifies a prescription/blend we sell**, a **billable agronomy service** we schedule and invoice, or **compliance evidence** (REI/PHI vs forecast) we carry for the grower.

The raw field-intel candidate pool came almost entirely from **three** repos:
- **microsoft/farmvibes-ai (MIT)** — NDVI/spectral-index formulas, soil-sampling plan, soil-attribute dictionary + nutrient interpolation, weather/forecast layer, emergence. This is the only **MIT** source, so its formula/code is reusable *with attribution* (still re-built on our stack).
- **LiteFarmOrg/LiteFarm (GPL-3.0)** — soil-sample protocol (depths/tool) + lab results capture.
- **farmOS/farmOS (GPL-2.0)** — Lab Test Log shape (soil/tissue/water + method + lab) and the generic **Data Stream** sensor-ingestion shape.

The other three repos (erpnext, twenty, ekylibre) contributed **nothing genuinely field-intel** — their value is financial-ledger, CRM-pipeline, and compliance-registry, which belong to those other lenses. ekylibre uses PostGIS for "working zones" but that's a compliance/application-record concern, not field intelligence.

## Dedup decisions (what merged into what)

| Merged-away raw candidate(s) | Folded into kept idea | Why |
|---|---|---|
| farmvibes "Spectral-index formula catalog" (#2) · "Crop-emergence/stand summary" (#6) | **FI-1 Field imagery & health time-series** | Both ride the *same* imagery pipeline; NDRE/MSAVI/emergence are extra indices/thresholds on the one summary feed, not separate features. Ship them as sub-pieces of FI-1. |
| farmvibes "Soil-test attribute model + nutrient interpolation" (#4) · litefarm "Soil-sample protocol + results capture" (#7) · farmOS "Lab Test Log" | **FI-2 Lab/soil test record + results capture** | Three repos describe the identical thing: store a test event tied to a field + typed result rows (analyte/value/unit/method). farmvibes adds the canonical SoilGrids attribute/unit dictionary; farmOS adds the soil/tissue/**water** test-type split + per-result method; litefarm adds sample-depth/tool capture. One merged table set. |
| farmvibes "Soil-sampling plan generator" (#3) | **FI-3 Soil-sampling plan generator** (kept separate) | This is the *where-to-sample plan* (geo points), a distinct precursor that **feeds** FI-2's results. Kept as its own idea but explicitly paired with FI-2. |
| farmvibes "Weather/forecast layer" (#5) | **FI-4 Field weather + REI/PHI collision warning** | Distinct payoff (dispatch/spray-window safety), not imagery. Kept. |
| farmOS "Data Stream sensor-ingestion shape" | **FI-5 Sensor data-stream ingestion substrate** | The generic substrate under FI-1/FI-2/FI-4 if CRX ever ingests live device feeds. Lower priority — only worth it once there's a real sensor/feed to land. |

Grower-only noise cut entirely: farmvibes' GPU ML (SpaceEye cloud-removal, crop segmentation, irrigation classification, GHG flux engine), litefarm animal/harvest, farmOS herds/planting UI. CRX should **call a hosted imagery/weather API and store the summary**, never host a raster pipeline.

---

## Ranked, deduped idea set

### FI-1 — Field imagery & crop-health time-series (NDVI/NDRE + zones)  ·  relevance 5 · effort L
**CRX has** Mapbox field polygons (`fields`) + a deep application workflow, but **no remote-sensing at all** (named gap).
**Best repo does** (farmvibes, MIT): pulls Sentinel-2/Landsat for a polygon, cloud-masks, computes per-date NDVI/NDRE/MSAVI stats (mean/std/min/max), and flags anomaly zones via a Gaussian Mixture Model. Index formulas are clean-room in `ops/compute_index/index.py` (NDRE `(nir−re)/(nir+re)`, RECI `(nir/re)−1`, PRI); NDVI-summary, change-detection, and emergence (thresholded MSAVI>0.2) are documented workflows.
**We'd build** an `imagery_observations` table keyed to `fields.id` storing `(observed_on, index_code, mean/std/min/max as scaled ints)`; a Supabase **Edge Function** calls a hosted statistics API (Sentinel Hub / Planetary Computer) on the polygon and writes summary rows — **do NOT host the raster pipeline**. A small `index_definitions` reference table (code, band inputs, display range like NDVI [-1,1]) lets us compute more than NDVI (NDRE = nitrogen status → upsell N applications; MSAVI → emergence date to time post-emergence sales). A React `FieldHealth` tab charts the time-series + a low/med/high zone overlay. **Dealer value:** visual evidence that justifies the blend/prescription we sell.
**Risk:** external imagery-API cost + reliability; large-effort UI; only useful once a field has a season of pulls. Start with NDVI-only, one provider, store summaries only.
**License:** MIT — index/summary formulas copyable *with attribution*; re-expressed as SQL/JS. Heavy ML intentionally not reproduced.

### FI-2 — Lab/soil-test record + results capture (soil · tissue · water)  ·  relevance 5 · effort M
**CRX has** no soil/lab integration and thin crop planning (named gaps); blend tickets exist but nothing stores *why* a blend is right for a field.
**Best repo does** — three repos converge: **farmOS** Lab Test Logs (test header with Laboratory term, test type soil/tissue/water, soil texture; result rows where each value carries its own method); **litefarm** `soil_sample_task` (sample depths jsonb `[{from,to}]`, tool enum, CHECK that depth-count = samples-per-location); **farmvibes** SoilGrids variable/unit dictionary (CEC cmol/kg, clay/sand/silt %, N g/kg, pH, SOC) + an inverse-distance/kriging nutrient heatmap.
**We'd build** a `lab_tests` header (`field_id`, lab, sample_date, test_type ∈ soil/tissue/water, soil_texture) + `lab_test_results` rows (analyte, value, unit, method) using the SoilGrids attribute set as the canonical column/unit vocabulary; optional sample-depth capture from litefarm. Feed results into blend/recommendation logic and the grower portal. A simple per-field IDW heatmap (PostGIS is already enabled) can come later.
**Risk:** low — additive tables; main judgment call is the canonical analyte/unit list (use SoilGrids). Interpolation is optional and deferrable.
**License:** GPL (farmOS/litefarm) → shapes only; SoilGrids dictionary (farvibes, MIT) reusable.

### FI-3 — Soil-sampling plan generator (geo sample points)  ·  relevance 4 · effort M
**CRX has** thin crop planning; agronomy is a service we *could* bill but don't formalize.
**Best repo does** (farmvibes, MIT): clusters a field's index raster with a Gaussian Mixture model to propose N geo-located sample points (documents ~20 points for a 100-ac field at n_clusters=5/sieve_size=10).
**We'd build** a "Generate sampling plan" action on a CRX field → an Edge Function returns lat/long points stored in `soil_sample_plans` + `soil_sample_points` (tied to `fields.id`) for the agronomist to visit; results flow back into **FI-2**. A **simple stratified-grid fallback** (no imagery) delivers most of the value with zero dependency on FI-1, and turns soil sampling into a schedulable/invoiceable agronomy service.
**Risk:** GMM version depends on FI-1's imagery; mitigate by shipping the grid fallback first. Low data risk.
**License:** MIT — clustering approach reusable; clean-room (grid fallback needs no borrow at all).

### FI-4 — Field weather + REI/PHI spray-window collision warning  ·  relevance 4 · effort M
**CRX has** dispatch/jobs + application services but **no weather integration** (named gap), and (separately) 0/604 products carry REI/PHI.
**Best repo does** (farmvibes, MIT): downloads NOAA GFS forecast + historical climate for a geometry+time-range, and dedupes pulls with a deterministic SHA-256 hash of (name + WKT + publish_time + time_range).
**We'd build** a `field_weather` cache (`field_id`, observed_at, source, temp/precip/wind…) populated by a scheduled Edge Function against a weather API, using the geometry+time-range query pattern and the dedupe-hash idea (maps cleanly onto CRX's existing idempotency discipline). **Immediate dealer payoff:** a delivery/application planner that warns when wind/rain makes an application unsafe, or when an **REI/PHI window collides with forecast rain** — ties directly into dispatch and into label-data work in the compliance lens.
**Risk:** the REI/PHI half depends on label data existing (the 0/604 owner item); the wind/rain-safety half stands alone. Weather-API cost/quota.
**License:** MIT — borrow the query pattern + dedupe-hash idea; source weather from a commercial/free API.

### FI-5 — Sensor data-stream ingestion substrate  ·  relevance 3 · effort L
**CRX has** no substrate for live device feeds (relevant to both the NDVI and weather/soil gaps).
**Best repo does** (farmOS, GPL-2.0): a **Data Stream** is a device feed (per-stream private key, public flag) referencing the Asset(s) it monitors, deliberately **decoupled from the device** so a sensor can be moved/reused and history follows the stream's UUID.
**We'd build** a `data_streams` + `stream_readings` pair keyed to `fields`, with an ingestion endpoint (Edge Function + per-stream key) accepting weather-station / soil-moisture / NDVI feeds tied to a `field_id`, decoupled from the physical device. This is the **general substrate** under FI-1/FI-2/FI-4 *if* CRX ever ingests real-time feeds.
**Risk:** speculative — only worth building once there's a concrete device/feed to land; otherwise FI-1/FI-2/FI-4 store their own summaries directly. Build last, or skip until a partner integration appears.
**License:** GPL-2.0 — clean-room shape only; ingestion built on Supabase.

---

## Recommended sequence (plain English for Mason)

1. **Start with FI-2 (lab/soil test records).** Lowest risk, fills a named gap, no external API, and it's a natural grower-portal feature ("here are your soil results"). It also gives blend recommendations a backing.
2. **Then FI-3's grid fallback** — turns soil sampling into a service you can schedule and bill, and feeds FI-2. No imagery dependency.
3. **FI-4's wind/rain safety check** is a high-value, self-contained dispatch feature; add the REI/PHI-vs-rain collision once products carry label data.
4. **FI-1 (NDVI imagery)** is the flashiest but the heaviest and depends on a paid imagery API — do it once 1–3 prove the field-intel direction earns its keep.
5. **FI-5 (sensor substrate)** only when a real device/feed partner exists.

The one **MIT** repo (farmvibes) is the only place code can be lifted (with attribution); everything else is ideas/shapes re-built clean-room on Supabase + React.
