# CRX Manager — Current-Capability Survey (4 walkthrough areas)

Surveyed 2026-07-11 from worktree `crx-manager-walkthrough-1fe3a4` (read-only, Explore agent), as grounding for the ChemMan gap analysis.

Note: the map stack is **Mapbox GL** (`react-map-gl/mapbox`), not MapLibre — `src/components/map/CRXMap.tsx`. PostGIS is used server-side (fields store geometry).

## 1. Field Mapping

Pages/components: `src/pages/Fields.tsx` (list + map toggle, filters, sub-field grouping, CSV/PDF export), `src/pages/FieldSetup.tsx` (two-panel editor: form + live draw map, boundary drawing, acres-to-bill override, FSA numbers, default billing splits), `src/pages/FieldDashboard.tsx`, map components in `src/components/map/` (CRXMap, DrawLayer/DrawControl/DrawingHud with live acreage HUD, FieldBoundaryLayer, ImportPreviewMap, AddressSearch, LayerToggle, LocateMe), import wizard `src/components/fields/BulkFieldImport.tsx` (+AttributeMappingStep, FieldCustomerAssignment), logic in `src/lib/fieldGeometry.ts`, `src/lib/fieldImportParser.ts` (shpjs/proj4/turf/togeojson).

RPCs/tables: `get_fields_with_geojson`, `get_field_geojson`, `get_field_polygons`, `save_field`, `set_field_boundary`, `set_field_override_acres`, `link_fields_to_parent`; tables `fields` (PostGIS boundary+centroid, measured/override acres, FSA numbers, parent_field_id), `field_polygons` (multi-part), `field_billing_defaults` (customer, split %, price override).

CAN: draw single or **multi-part** boundaries with live geodesic acreage; server-authoritative acreage (0.1–5000 band); two-acre billing model (override vs measured, divergence badges); import .zip shapefile / loose shp+dbf+prj / GeoJSON / KML with reprojection, attribute mapping, per-field customer assignment; field billing defaults drive multi-customer splits and per-acre price overrides; map display of boundaries+markers on Fields page and dispatch.

CANNOT / rough: no atomic create-with-boundary (2–3 RPC sequence, orphan-field edge case, sales_rep can't delete); shapefile import untested (binary fixtures); FieldSetup re-save can revert acres (known follow-up); MultiPolygon import previews largest ring only; Mapbox token cost/lock-in. **No FSA parcel click-to-adopt, no Legal Lookup (section/township/range auto-fill), no obstacle markers, no all-fields overlay while editing another field, one basemap provider.**

## 2. Job / Application Scheduling

Pages: `src/pages/DispatchBoard.tsx` (dark tablet dispatch view: jobs map/list + dispatch wizard + inventory stock lights), `src/components/dispatch/DispatchWizard.tsx` (3-step per-field-location dispatch to applicator/crew), `src/pages/Jobs.tsx` (office list, date filters, bulk print), `src/pages/JobDetail.tsx` (tabs: Locations, Chemicals, Loader Worksheet, Applied, Map/Logs, Notifications; applicator assignment, job_date/schedule_date, license gating, reschedule notifications), `src/pages/FieldRoute.tsx` + `FieldStop.tsx` (/my-route — **deliveries** driver runner, not spray jobs), `src/pages/TeamBoard.tsx` (notes board).

RPCs/tables: `get_dispatch_board_jobs`, `get_dispatch_stock_status`, `assign_job_applicator`, `dispatch_job_locations`; tables `jobs` (job_date, applicator_id, status, applied/total acres, loader_tank_capacity, loader_comment), `job_fields` (acres_to_treat, sort_order), `job_location_dispatches`, `ground_crews`, `job_chemicals`.

CAN: whole-job applicator + per-location dispatch to applicator or crew; shared filters across map+list; inventory-aware stock light per job (warn-only); date-based scheduling with reschedule notifications; role gating.

CANNOT / rough: **no calendar or drag-drop board** (no week/day timeline, no capacity view); no applicator job-route runner (my-route is deliveries); dispatch list capped at 500 recent; recipe filter and dispatched-list are stubs; map keeps display:none mount quirk. **No map-based crop-first global field picker on the job editor; no job tags; no Rem-ac column; no mass-edit/job batches.**

## 3. Job Printing for Sprayer Applicator

Files: `src/lib/applicatorSheetPdf.ts` + `applicatorSheetData.ts` (**three ChemMan-parity formats: Original / Enhanced / Custom**), `src/lib/chemicalApplicationReportPdf.ts`, `src/lib/wpsNoticePdf.ts`, `src/lib/jobListPrint.ts`; wired from JobDetail (format picker) and Jobs (bulk + per-row).

CAN: shared data source so all formats agree; Original (compact), Enhanced (totals + REI/PHI), Custom (admin-configurable header/logo/footer/columns via app_settings); blank hand-fill areas (as-applied acres, weather grid, signature); print audit (printed_at, last_printed_by, Jobs column); dirty-form print block; delivery-side load sheets/slips.

CANNOT / rough: **no maps on any printed sheet** (no combined "blowout" overview page, no per-field close-up pages); print config is one global blob (no per-customer templates); no equipment exports (John Deere / Shapefile / KML) of job fields; logo embed best-effort.

## 4. Mixer / Loader Sheet

Files: `src/lib/loaderWorksheet.ts` (pure per-load tank-split math, unit-tested: loads = ceil(volume/capacity), proportional per-load product amounts, penny-exact residual), `loaderWorksheetPdf.ts`, `loaderWorksheetFetch.ts`, `masterMixSummaryData/Pdf/Fetch.ts` (cross-job master mix), consumed in JobDetail (Loader Worksheet tab: inputs loader_tank_capacity, carrier_rate_gpa, loader_comment) and Jobs (bulk + master mix). Blend tickets (`src/pages/BlendTickets.tsx`, `BlendTicketDetail.tsx`, `blendMathValidator.ts`, `process-blend-ticket` edge fn) are an OCR/import-reconcile flow, not a printed mix sheet.

CAN: exact per-load per-product split incl. right-sized remainder load; guards (invalid inputs → valid:false, MAX_LOADS 200, gallon-unit check); master mix refuses to average incompatible capacities; per-load and master PDFs with print audit.

CANNOT / rough: **one worksheet per job** (no saved scenarios per vehicle); **no vehicles/fleet table** (capacity typed per job, not picked from a vehicle record); no ground-crew members on the worksheet; no load-balance modes; no per-load acres editing; no mark-load-done checklist; no condensed-vs-individual display toggle; no sprayer log-file attachment; dry blends route through the blend-ticket path with no printed mix-sheet artifact.
