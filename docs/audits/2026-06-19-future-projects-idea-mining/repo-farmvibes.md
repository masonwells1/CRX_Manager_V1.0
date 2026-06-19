# Repo Scout — microsoft/farmvibes-ai

_Mined 2026-06-19 for ideas, data-models, and formulas that could improve CRX Manager._

## Identity & stack
- **Repo:** microsoft/farmvibes-ai (FarmVibes.AI — "multi-modal geospatial ML for agriculture").
- **Confirmed license:** **MIT** (verified via `gh api repos/microsoft/farmvibes-ai/license --jq '.license.spdx_id'` → `MIT`). Actual code reuse is license-safe **with attribution**; CRX still re-implements on its own stack.
- **Stack:** Python. A DAG "workflow" engine where each node is an **op** (`ops/*.py`) wired by YAML (`workflows/**`, mirrored as docs in `docs/source/docfiles/markdown/workflow_yaml/**`). Core data classes in `src/vibe_core/vibe_core/data/*.py`. Runs on a local k8s/AKS cluster, pulls imagery from Microsoft Planetary Computer.
- **What it is, in one line:** a library of remote-sensing + weather + soil + ML pipelines (NDVI/indices, cloud removal "SpaceEye", canopy cover, emergence, irrigation classification, soil-sample placement, nutrient heatmaps, GHG fluxes). It is a **grower/agronomy field-intelligence engine**, not a business system — so we TRANSLATE its field-intel into CRX's dealer compliance/agronomy world and discard its farm-ops modeling.

## Top features (cited)
- **Spectral index library with explicit formulas** — `ops/compute_index/index.py` ships clean-room formulas for NDRE `(nir−re)/(nir+re)`, PRI `re/(nir+re)`, RECI `(nir/re)−1`, plus a methane index; the broader set comes from the `spyndex` "awesome-spectral-indices" library (EVI, MSAVI, NDVI…). Evidence: `ops/compute_index/index.py`; `docs/.../farm_ai/sensor/optimal_locations.md`.
- **NDVI summary as a time-series of stats** — mean/std/max/min per date over a field polygon, cloud-masked. `docs/.../farm_ai/agriculture/ndvi_summary.md`.
- **Canopy-cover estimation from NDVI** — a pre-fit degree-3 polynomial Ridge regression turns NDVI into % canopy cover; coefficients are hard-coded for inference. `ops/estimate_canopy_cover/estimate_canopy.py`.
- **Emergence detection** — thresholded MSAVI (>0.2) summarized over time → crop emergence/stand. `docs/.../farm_ai/agriculture/emergence_summary.md`.
- **Change detection / outlier zones** — NDVI across dates run through a Gaussian Mixture Model to flag anomalous zones within a field. `docs/.../farm_ai/agriculture/change_detection.md`.
- **Optimal soil-sample placement** — Gaussian Mixture clustering of an index raster to propose N sample points (with lat/long) for a field; documented yields for a 100-ac farm by `n_clusters`/`sieve_size`. `docs/.../farm_ai/sensor/optimal_locations.md`.
- **Nutrient heatmaps** — spatial interpolation (kriging / nearest-neighbor / cluster-overlap) of lab sample values (C, N, P, pH) into a per-field map. `docs/.../farm_ai/agriculture/heatmap_using_neighboring_data_points.md`.
- **Soil ingestion catalog** — SoilGrids variables with units (bulk density, CEC, clay/sand/silt %, nitrogen g/kg, pH, SOC, organic-carbon stock) + USDA soil classes. `docs/.../data_ingestion/soil/soilgrids.md`, `.../usda.md`.
- **Weather ingestion + forecast** — NOAA GFS forecast and historical (ERA5, GridMET, TerraClimate, CHIRPS, Herbie). `docs/.../data_ingestion/weather/*.md`.
- **GHG / carbon footprint engine** — IPCC-methodology emission factors per fertilizer type and crop, GWP constants (N2O=298, CH4=25), biome carbon stocks. `ops/compute_ghg_fluxes/compute_ghg_fluxes.py`.
- **Irrigation classification** — pixel-wise irrigation-probability map from Landsat + DEM via a logistic-regression model. `docs/.../farm_ai/water/irrigation_classification.md`.

## Data-model highlights (cited)
- **`SeasonalFieldInformation`** (`src/vibe_core/vibe_core/data/farm.py`): a per-field, per-season record carrying `crop_name`, `crop_type`, and **lists of typed practice events** — `FertilizerInformation` (application_type, total_nitrogen, EE-phosphorus), `TillageInformation` (implement, start/end), `OrganicAmendmentInformation` (type, amount, %N, C:N ratio), `HarvestInformation` (is_grain, crop_yield kg/ha, residue removal). This is a clean "field season = crop + a typed list of operations" shape.
- **`DataVibe` base type** (`src/vibe_core/vibe_core/data/core_types.py`): every data object = id + **time_range + bounding-box + geometry**; derived `TimeSeries`, `DataSummaryStatistics`, `DataSequence`. The reusable idea: every agronomic observation is stamped with (when, where-polygon).
- **Weather hashing** (`src/vibe_core/vibe_core/data/weather.py`): `gen_forecast_time_hash_id` = SHA-256 over (name + WKT geometry + publish_time + time_range) — a deterministic idempotency/dedupe key for "the same forecast pull."
- **GHG factor tables** (`ops/compute_ghg_fluxes/compute_ghg_fluxes.py`): `Fertilizer(source, co2, n2o, nitrogen_ratio, unit)`, `GLOBAL_HEATING_POTENTIAL_GHG`, `BIOME_TO_CARBON_STOCK`, `GHG_CONVERSION` — a ready emission-factor data model.
- **SoilGrids variable dictionary** (units + identifiers) — a ready lookup table for soil-test attributes. `docs/.../data_ingestion/soil/soilgrids.md`.

## CRX grounding (so "fills_gap" is honest)
CRX already has: `products` with EPA reg (`20260206195903`) and an REI/PHI/signal-word label-data migration (`20260610193241_products_rei_phi_label_data.sql`), `fields` foundation (`20260213000000`), `application_records` (`20260214220000`), and a deep field-application workflow (the `field_app_workflow_phase*` series). The named CRX gaps this repo can fill: **no NDVI/remote-sensing**, **no weather/soil integration**, **crop PLANNING thin**, and (label data) **0/604 products carry REI/PHI** today. FarmVibes is grower-side imagery; we translate it into **dealer-side agronomy/compliance value** (zone maps that justify a prescription we sell, soil-test sampling plans we charge for, REI/PHI windows we enforce at delivery).

---

## Candidate table

| # | Title | Lens | Relevance | Effort | Borrow |
|---|-------|------|-----------|--------|--------|
| 1 | Field NDVI/health time-series & zone map | field-intel | 5 | L | idea+formula |
| 2 | Spectral-index formula catalog | field-intel | 4 | S | formula+code |
| 3 | Soil-sampling plan generator (clustered sample points) | field-intel | 4 | M | idea+formula |
| 4 | Soil-test attribute model + nutrient interpolation | field-intel | 4 | M | data-model+formula |
| 5 | Weather/forecast layer keyed to field polygons | field-intel | 4 | M | idea+formula |
| 6 | REI/PHI compliance windows from label data | compliance | 5 | S | idea |
| 7 | Seasonal-field crop-plan & practice-event model | CRM-UX | 4 | M | data-model |
| 8 | GHG / carbon-footprint estimator for an application | compliance | 3 | M | data-model+formula |
| 9 | Crop-emergence / stand summary | field-intel | 3 | M | formula |
| 10 | Geometry+time idempotency hash for external data pulls | architecture | 3 | S | code |

Full per-candidate detail is returned in the structured object accompanying this doc.

### Notes on borrowing
- **MIT means the index/canopy/GHG formula code can be lifted with attribution**, but every candidate is re-built on Supabase Postgres + React anyway; the *value* is the formula/data-model, not the Python.
- The heavy ML pieces (cloud-removal "SpaceEye", crop segmentation, spectral super-resolution) are **out of scope** for CRX — they need a GPU pipeline and grower-side imagery ops that a dealer ERP shouldn't host. Prefer calling an imagery API (e.g. Sentinel Hub / Planetary Computer statistics endpoint) and storing the **summary** rather than reproducing the cluster.
- Anything that only models a grower running their own farm (tillage/harvest/yield bookkeeping) is **discarded** except where it gives CRX a crop-plan/agronomy record that ties to what we sell (candidate 7).
