# Scope of Work — Field Mapping + Per-Acre Billing (autonomous, Codex-gated)

> **Read this first, then `BUILD-LOOP.md`.** This is the self-contained spec for a dedicated session to build the field-mapping → per-acre-billing upgrades to "ready" (reviewed + dev-branch-proven + parked), stopping at the owner's live-apply gate.

## The detailed specs (the real design — this file distills them)
- **What/why:** `docs/roadmap/2026-06-22-field-mapping-and-per-acre-billing-roadmap.md`
- **How, all phases:** `docs/roadmap/2026-06-22-field-mapping-billing-BUILD-SPEC.md`
- **Phase 2 deep design (line-grounded):** `docs/roadmap/2026-06-22-PHASE2-field-map-acres-design.md`

These three are the source of truth. This SOW adds the **track split, acceptance criteria, and hard gates** for the loop.

## Owner decisions already locked (Mason 2026-06-22)
1. **0 applied acres → REJECT/block** with a message (never bill 0, never fall back to full acres).
2. **Two-acre model only:** `measured_acres` (map polygon) + a typed `override` (the billable number; keeps the boundary; editable anytime; defaults to measured). **No FSA-acres concept.** `billable = COALESCE(override_acres, measured_acres, total_acres)`.
3. **Import-first:** Mason has many boundaries in **shapefiles + John Deere Operations Center + Climate FieldView** exports — all WGS84 shapefiles, so **one `.zip` shapefile importer covers all three.** Hand-draw is the secondary fallback. Live JD/FieldView **API** connectors are deferred (out of scope here).
4. **Straight product sales do NOT link to fields — only applications/blends do** (already carry `field_id`). No `field_id` on `order_items`/`invoice_items`.

## What ALREADY EXISTS — do NOT rebuild (verified in code 2026-06-22)
- Hand-draw: `CRXMap` (Mapbox satellite) + `DrawControl` (mapbox-gl-draw) + `DrawLayer`.
- Import: `BulkFieldImport.tsx` 7-step wizard + `fieldImportParser.ts` (shpjs / proj4 / @tmcw/togeojson / turf) — shapefile/KML/GeoJSON, reproject to WGS84.
- PostGIS 3.3.7 enabled; `fields.boundary geography(POLYGON,4326)` + `fields.centroid` populated; proven idiom `ST_GeomFromGeoJSON(text)::geography` (search_path `public, extensions, pg_temp`).
- RPCs `save_field` / `save_field_geometry` / `save_field_polygons`; read RPCs `get_fields_with_geojson` / `get_field_geojson` / `get_field_polygons`.
- The per-acre billing engine `save_field_app_invoice` → `derive_customer_shares_from_fields` + the editable applied-acres UX in `FieldApplicationInvoice.tsx`.

## ═══ TRACK SPLIT (the parallel-session safety design) ═══
A separate live session is building on **`feat/as-applied-invoices`** (checked out at `C:/CRX_Manager`), editing the **field-application invoice engine** (`save_field_app_invoice`, `FieldApplicationInvoice.tsx`, `preview_field_app_invoice_split`).

- **TRACK A — Field-mapping foundation (BUILD NOW).** Touches `fields` / import / map files ONLY — **no overlap** with the as-applied session. The loop builds this immediately on a dev branch.
- **TRACK B — Billing-engine hardening + bill tie-in (BLOCKED).** Touches the exact files the as-applied session is editing. **Do NOT build until that session merges to `main`** and Track B is re-grounded against the merged code (its line numbers / function bodies will move). Track B phases stay `BLOCKED` in `STATE.md` until the owner says "the as-applied session is merged."

### Track A — what to build (details in PHASE2 design §2–§4, §7)
- **A1 (migration):** add `fields.measured_acres`, `fields.override_acres`, `fields.boundary_geom geometry(MultiPolygon,4326)`, `fields.acres_source`; GIST index on `boundary_geom`; backfill `measured_acres`/`boundary_geom` from existing `fields.boundary`. RLS unchanged (no new table/policy). Keep `total_acres` as legacy fallback.
- **A2 (migration):** new SECURITY DEFINER `set_field_boundary(p_field_id, p_boundary_geojson, p_performed_by, p_idempotency_key)` — the ONLY writer of `measured_acres`: `ST_MakeValid` + geodesic `ST_Area(::geography)/4046.8564224` + 0.1–5,000 ac sanity band + strict-actor + idempotency. Plus `set_field_override_acres` (validate `>0`; NULL clears) and read-only `find_overlapping_fields` (>80% overlap dedupe).
- **A3 (types):** `measured_acres`/`override_acres`/`acres_source` on `Field`, `ParsedImportField`, `FieldLocation` in `src/types/index.ts`.
- **A4 (UI — FieldSetup):** "Billable Acres (override)" input bound to `override_acres` + read-only "Measured: X ac" label; **remove the unconditional `total_acres` overwrite** (the `onPolygonsChange` clobber ~`FieldSetup.tsx:854-857` — the #1 defect: a redraw silently changes a billed acre); draw save → `set_field_boundary`.
- **A5 (import):** add a `.zip` entry branch to `fieldImportParser.ts` (shpjs accepts a zip ArrayBuffer); preserve multi-part (stop reducing to largest ring); `BulkFieldImport.tsx` accepts `.zip`, calls `set_field_boundary`, shows the dedupe choice (Skip/Replace/New).
- **A6 (tests + docs):** regression tests for the acreage RPC guards + override-survives-redraw; update `database-schema.md`, `rpc-functions.md`, CLAUDE.md Snapshot, CHANGELOG; `check-doc-drift` = 0.

### Track B — what to build LATER (details in BUILD-SPEC Phase 1 + PHASE2 §6)
- **B1:** `save_field_app_invoice` hardening (Codex's findings): reject 0/negative applied acres; `deleted_at`-aware group queries; capture product cost on override acres; bind/admin-gate `salesman_id`; acre-rounding precision.
- **B2:** bill tie-in — `FieldApplicationInvoice.tsx:313` default `f.total_acres` → `f.override_acres ?? f.measured_acres ?? f.total_acres` + the 5 fallback threadings + the server `COALESCE` in `save_field_app_invoice`/`preview_field_app_invoice_split` + the `ZERO_APPLIED_ACRES` server guard.
- **B3:** converge `transfer_job_to_invoice` onto the canonical engine (service-fee line + actor binding).
- **B4:** polish — recipe pricing (`blend_recipe_items.price_per_unit_cents`); "applied but not yet invoiced" reconciliation view.

## Acceptance criteria
- **Track A:** import a `.zip` shapefile / Ops Center export / FieldView export → server-measured acres correct; `set_field_boundary` rejects bad/oversized/empty geometry (0.1–5,000 band); a typed override **survives a redraw**; entering 0 is rejected; a field-app invoice (existing engine) defaults its applied-acres from `override ?? measured ?? total`. All dev-branch-proven + Codex SHIP + subagent-clean; migrations parked (not applied live).
- **Track B:** the 5 Codex findings closed; the bill tie-in proven (mapped acres default into the invoice); all dev-branch-proven + Codex SHIP.
- **Both:** `npm run typecheck/lint/build/test` green; `check-doc-drift` = 0; never `--no-verify`/`@ts-ignore`/`any`.

## Hard gates (binding — the loop NEVER crosses these)
- **No live migration apply. No merge/push to `main`. No deploy. No data deletion.** All parked for the owner's explicit OK at handoff.
- **Migration proof is dev-branch ONLY** (`create_branch` → record the dev-branch ID in `STATE.md` → `apply_migration` ONLY against that ID). Prod is `rhyzpcqhnizqbxphqdkr` — **never** apply there. If a dev branch can't be created, fall back to rolled-back `BEGIN…ROLLBACK` smokes ending in `SMOKE_PASS_ROLLBACK`. Target-lock: if you can't positively confirm the apply target is the dev branch, ABORT.
- **Codex review is mandatory each phase.** If Codex is down → STOP and hand off; never self-certify.
- Pushing the **feature branch** `feat/field-acre-billing` to origin is allowed (backup); pushing/merging to `main` is NOT.
- **Track B stays BLOCKED** until the owner confirms `feat/as-applied-invoices` is merged + Track B is re-grounded against the merged code.
- One DB writer at a time on **prod**; this loop only touches a dev branch / rolled-back transactions.

## Out of scope (do NOT build here)
- Live JD/FieldView **API** connectors (manual shapefile export covers it; deferred).
- `field_id` on order/invoice items (owner decision: product sales don't link to fields).
- The grower-portal program (field_seasons, profitability map, spray compliance) — a later, separate effort.
- USDA CLU "pick a field" (distribution-restricted).
