# Theme Synthesis — Compliance Lens

**Date:** 2026-06-19
**Lens:** compliance
**Repos scouted:** microsoft/farmvibes-ai (MIT), ekylibre/ekylibre (AGPL-3.0), LiteFarmOrg/LiteFarm (GPL-3.0), farmOS/farmOS (GPL-2.0). (frappe/erpnext + twentyhq/twenty contributed nothing compliance-relevant.)
**Synthesizer role:** dedup the 15 raw compliance ideas into a clean ranked set for CRX (ag-retail DEALER — we SELL + BLEND + APPLY and carry the regulatory load), weighted toward CRX's named gaps.

---

## How I deduped

The 15 raw ideas collapse into **7 distinct candidates**. Four big clusters of overlap drove the merge:

1. **"Put REI/PHI/signal-word/active-ingredients on products"** appeared in 4 repos (FarmVibes #6, ekylibre product-row, LiteFarm #1, farmOS Input-Log). They are the same data-model fill. **CRX already half-built this** — migration `20260610193241` added `products.rei_hours` + `products.phi_days` (both nullable, 0/604 populated), and its own comment says it's for "B4 REI/PHI field countdowns later." So the real work is **populate + add the few missing columns + the editor**, not a greenfield table. Merged into **C1**.

2. **"Enforce REI/PHI as a window / freeze label limits onto the record / flag dose-over-max"** appeared in 3 repos (FarmVibes #1 REI/PHI windows, ekylibre `intervention_input` copy-live-values + compliance jsonb, LiteFarm rate/method). This is the *consume-the-label-data* engine and is the single highest-leverage compliance build because it makes the dormant columns earn their keep. Merged into **C2**.

3. **"Harden the application record into an audit-grade artifact"** appeared in 3 repos (farmOS Input-Log Lot/Method/Source + pending→done, farmOS TO-vs-IN, LiteFarm rate-unit/method/area). All deepen the *same* `application_records` row. Merged into **C3**.

4. The standalone, genuinely-distinct ideas survive as their own candidates: a **phytosanitary label-reference registry** separate from the dealer catalog (ekylibre, the "where the data comes from" layer behind C1/C2) → **C4**; a **compliance document vault with expiry** (LiteFarm) → **C5**; a **compliance-packet exporter** (LiteFarm certification job) → **C6**; an **agronomic recommendation/prescription record** (ekylibre prescription) → **C7**.

**Killed as grower-only noise or low-fit:** GHG/carbon estimator (FarmVibes #8 — relevance 3, no named gap, factor tables are Brazil-GHG-Protocol and need US re-sourcing; a "someday sustainability" nice-to-have, not a dealer compliance need), PFI/treatment-intensity index (ekylibre — relevance 3, French IFT taxonomy, stewardship-report adjacent not compliance-core), and field organic-status history (LiteFarm #5 — relevance 3; only matters once CRX serves organic-certified growers, which is not a current segment). These are documented at the bottom rather than dropped silently.

**License posture:** everything below is **ideas / data-model shapes / formulas only**, clean-room on Supabase + React. Three of the four sources are copyleft (AGPL/GPL) so no source is copied regardless. FarmVibes is MIT (code *could* be lifted with attribution), but the only FarmVibes contribution that survives here is the conceptual REI/PHI-window idea (C2), which is built entirely on CRX's own schema — so no attribution obligation is triggered.

---

## Ranked candidate set

### C1 — Populate + complete product label data (REI/PHI/signal word/active ingredients) — **Relevance 5, Effort S**

- **CRX has:** `products` with `epa_reg_no`, an RUP flag, `signal_word`, and `rei_hours`/`phi_days` columns (migration `20260610193241`) — but **0/604 products carry any label data**, and the grower-portal label CSV is an open owner item.
- **Best repo does:** LiteFarm's `pesticide` model and ekylibre's `registered_phytosanitary_product` carry `entry_interval`/`harvest_interval` (REI/PHI), `active_ingredients`, `concentration`, `restricted_mentions` (RUP), `operator_protection_mentions` (signal/PPE) as first-class fields.
- **The idea:** Add the 2–3 columns CRX still lacks (`active_ingredients text[]`, `concentration`, and a structured `signal_word` check if not already constrained), build a small admin "label data editor" on the product page, and **load the data** (the actual 0/604 fill — partly the owner's CSV, partly an EPA/CDMS import). This is the cheapest, highest-value compliance move: it's the *fuel* every other compliance feature burns.
- **Effort S** — additive columns + one editor form + a bulk-load. **Risk:** low (additive, nullable); the only real risk is **data accuracy** — wrong REI/PHI on a label is a worker-safety claim, so the editor must show source/last-verified and the bulk-load needs a human review pass (CRX has already been burned once by AI-guessed EPA #s — see the grower-portal label memory).
- **License:** ideas/shape only (GPL); built on CRX's own columns.

### C2 — Application-time compliance check + frozen label snapshot (REI/PHI windows, dose-vs-max) — **Relevance 5, Effort M**

- **CRX has:** `application_records`, the `field_app_workflow_phase*` engine, an RUP sales register, and (after C1) the label intervals — but **nothing computes or enforces a re-entry/pre-harvest window**, and nothing checks an applied rate against the label max.
- **Best repo does:** ekylibre's `intervention_input` **copies the then-current registry limits onto the application row** at create time (so the record stays accurate even if the label later changes) and flags violations; LiteFarm/FarmVibes frame the REI→re-entry and PHI→harvest windows.
- **The idea:** A plpgsql function `compute_application_compliance()` that, on each application insert, (a) writes `rei_clear_at` and `phi_clear_harvest_after` timestamps onto the record, (b) snapshots `applied_rate` / `label_max_rate` and a `compliance` jsonb `{status: go|caution|stop, errors:[]}`, and (c) surfaces a red/amber/green badge in Field Mode + a "field restricted until <date>" banner that **blocks conflicting deliveries/jobs** on that field. Pure business logic on data CRX already has (plus C1). The frozen snapshot makes the record audit-safe.
- **Effort M** — one RPC + the badge/banner UI + a soft block on conflicting field operations. **Risk:** medium — it's a *new gate* on the apply/deliver flow, so it must default to "warn, don't hard-block" until label data coverage is high (a hard block with 0/604 data would block everything). Sequence strictly **after C1**.
- **License:** the copy-live-values pattern and go/caution/stop logic are ideas/formulas (AGPL/MIT), clean-room in plpgsql.

### C3 — Audit-grade application record (Lot / Method / Source / rate+unit / area / TO-vs-IN / planned→done) — **Relevance 5, Effort M**

- **CRX has:** `application_records` tied to the field-application engine, but the row is **not yet a complete compliance artifact** — it's missing lot number, application method, source, an explicit applied-rate-with-unit, area-treated, and a clean planned-vs-done flag.
- **Best repo does:** farmOS's **Input Log** is a decade-refined pesticide-application record (Lot number, Method, Source, Purchase date, Material Quantity = rate+unit, references the land asset + equipment, `pending→done` status); LiteFarm separates absolute quantity from **application rate** (`lb/ac`, `gal/ac`) with a method enum (BROADCAST/BANDED/SIDE_DRESS/FERTIGATION/FOLIAR) and `area_treated`; farmOS's **TO-vs-IN** split records "what got the chemical" separately from "where it was done."
- **The idea:** Harden `application_records` with `lot_number`, `application_method` (enum), `source`, `applied_rate` + `rate_unit`, `area_treated`, `pct_field_treated`, an explicit `planned|done` status, and the rate-derivation formula (`rate = quantity / area_treated`, normalized to a canonical unit). Treat the row as **the** RUP-register row and the grower-portal "what was applied to my field" view. The TO-vs-IN refinement (apply-TO field/crop vs performed-IN/AT location) lets multi-field/in-transit applications record correctly.
- **Effort M** — additive columns + the rate formula + Field Mode form fields + RUP-register surfacing. **Risk:** low-medium (additive; the planned→done flag must not collide with the existing job/delivery lifecycle — reuse, don't reinvent, the status discipline).
- **License:** data-model + formula (GPL), clean-room on Postgres.

### C4 — Phytosanitary label-reference registry (separate from the dealer catalog, versioned for sync) — **Relevance 4, Effort L**

- **CRX has:** label fields living *on* `products` (the dealer's own SKUs) — fine for the ~604 SKUs CRX stocks, but no canonical, bulk-syncable, **versioned** reference DB keyed by product × crop.
- **Best repo does:** ekylibre's `lexicon` — `registered_phytosanitary_product` + `registered_phytosanitary_usage` keyed by **product × crop**, carrying REI, PHI (+ growth-stage form), max applications/year, **max legal dose per crop**, untreated buffer zones, signal/risk phrases, registration id, and a `record_checksum` for **incremental upsert** from an externally-maintained dataset.
- **The idea:** Two Supabase tables — `chem_label_product` (epa_reg_no, active_compounds[], firm, signal_word, rup_flag, rei) and `chem_label_usage` (product × crop, max_dose+unit, phi, rei, max_apps_per_season, min_reapply_interval, buffer_zones jsonb, growth_stage_min/max, state authorized/withdrawn) — fed by a one-time EPA/CDMS/state-label import (and later a sync job), with `checksum` driving idempotent upsert. C1's product columns then *read through* this registry instead of being hand-keyed per SKU.
- **Effort L** — two tables + an import pipeline + sourcing the data. **Risk:** medium — this is the "do it right" version of C1; **don't build it first.** C1 (columns on products) is the MVP that delivers value at effort S; C4 is the scale-up once label-data coverage proves valuable and a maintainable data source is chosen. Sourcing is the long pole (CRX uses EPA/CDMS/state labels, NOT ekylibre's French EPHY dataset).
- **License:** data-model shape only (AGPL); the data is sourced independently from US EPA/CDMS/state labels.

### C5 — Compliance document vault with expiry tracking — **Relevance 4, Effort M**

- **CRX has:** Supabase Storage and PDF generation, but **no typed document vault** for the compliance paperwork a dealer must keep current — SDS sheets, applicator licenses, dealer permits, certificates of insurance.
- **Best repo does:** LiteFarm's `document` table is typed (CROP_COMPLIANCE, PEST_CONTROL_PRODUCT, SOIL_SAMPLE_RESULTS, WATER_SAMPLE_RESULTS, INVOICES, RECEIPTS…) with `valid_until` (date) + `no_expiration` (bool) + `archived`.
- **The idea:** A `compliance_documents` table on Supabase Storage with a typed enum + `valid_until`/`no_expiration`/`archived`, plus a dashboard widget "documents expiring in 30/60/90 days." Directly useful for the dealer's own license/permit/SDS shelf-life problem.
- **Effort M** — one table + storage wiring + a dashboard widget. **Risk:** low (new, additive, no lifecycle entanglement). Not a *named* gap, but a real dealer compliance capability with a clean small footprint.
- **License:** data-model shape only (GPL), clean-room on Supabase.

### C6 — Compliance packet exporter (RUP register + application records + SDS as a queued report-pack) — **Relevance 4, Effort L**

- **CRX has:** an RUP sales register, application records, and (with C5) document storage — but **no one-click "give me the compliance packet for customer X, date range Y"** export.
- **Best repo does:** LiteFarm's Bull job pipeline (`retrieve → excel → zip → upload → email`) assembles a certifier's required record set into a translated workbook, zips, and emails it.
- **The idea:** A CRX "compliance packet" exporter — given a customer + date range, generate a zip of the RUP register + application records + linked SDS docs as PDF/Excel, queued via a Supabase Edge Function + a `report_jobs` table + cron (CRX has no Bull). Adjacent to the greenfield grower-portal: the same packet is what a grower or regulator would request.
- **Effort L** — job-queue table + Edge Function + the multi-format assembler. **Risk:** medium (async job infra is new for CRX; do **not** copy LiteFarm's Excel-templating code — idea/formula only). Best sequenced after C3/C5 give it real content to package.
- **License:** idea + formula (GPL); no templating code copied.

### C7 — Agronomic recommendation / prescription as a first-class record feeding the sale — **Relevance 4, Effort M**

- **CRX has:** quotes/orders/jobs/application_records, but **no recommendation-of-record** — nothing captures the agronomist/PCA recommendation that *justifies* a chemical sale and application (and that some states require for restricted products).
- **Best repo does:** ekylibre's `prescription` — written by an authorized prescriptor, referenced by one or more interventions, with `delivered_at` and `reference_number`; farmOS's Plan/Plan-Record gives the planned-vs-actual framing.
- **The idea:** A `recommendation` table (advisor_id, customer_id, field_id, reference_number, issued_at, products+rates jsonb, attachment) that quotes/jobs/application_records can link to — closing the **recommendation → sale → application → compliance-record** loop CRX carries as a dealer. Pairs naturally with C2 (the recommendation is the planned rate; the application is the actual; compliance checks both against the label).
- **Effort M** — one table + link FKs on quote/job/application + a simple recommendation form. **Risk:** low-medium (additive; touches several entities' FKs so plan the wiring). Partially fills the thin-crop-planning gap and lays groundwork for a real agronomy layer.
- **License:** prescription-as-record shape is an idea (AGPL), clean-room.

---

## Recommended sequence (plain English for Mason)

1. **C1 first** (effort S) — load and complete the product label data. Cheapest, and *every* other compliance feature needs it.
2. **C3 next** (effort M) — make each application record a complete, audit-grade artifact. Independent of C1, high standalone value for the RUP register.
3. **C2 after C1+C3** (effort M) — turn the label data into live REI/PHI windows and dose checks. This is the headline compliance feature, but it's only safe once C1 has real data and C3 has a clean application record to attach to. Default to *warn* before *block*.
4. **C5 / C7** (effort M each) — the document vault and the recommendation record; both additive, both standalone-useful, do whichever serves a real customer ask first.
5. **C4 / C6** (effort L each) — the versioned label registry and the packet exporter; the "scale-up" versions, do once C1/C3 prove the value.

**Killed (documented, not silently dropped):** GHG/carbon estimator (relevance 3, no named gap, non-US factor tables), PFI/treatment-intensity index (relevance 3, French IFT taxonomy, stewardship not compliance-core), field organic-status history (relevance 3, only matters for an organic-certified grower segment CRX doesn't serve today).
