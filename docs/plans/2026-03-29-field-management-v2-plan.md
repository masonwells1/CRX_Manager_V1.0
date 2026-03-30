# Field Management V2 Implementation Plan

**Goal:** Build a reusable CRXMap component with pluggable layers, a new read-only Field Dashboard page, polish the Field Setup page, and upgrade the Fields List — all mobile-optimized.

**Architecture:** Composable map layers as React children of a shared CRXMap wrapper. Field Dashboard is a new page that surfaces existing application_records/jobs data. Field Setup is a refactor of FieldDetail.tsx. One new RPC aggregates dashboard data server-side.

**Tech Stack:** React 18, TypeScript, Mapbox GL JS (react-map-gl), turf.js, PostGIS, Supabase RPCs, Tailwind CSS.

**Design Doc:** `docs/plans/2026-03-29-field-management-v2-design.md`

---

## Phase 1: CRXMap Component + Layers (Foundation)

### Task 1: Create CRXMap Base Component

**Files:**
- Create: `src/components/map/CRXMap.tsx`
- Test: `src/components/map/__tests__/CRXMap.test.tsx`

Replaces scattered MapContainer usage. Props: center, zoom, baseLayer (satellite|roads|hybrid|terrain), interactive, showLayerToggle, showLocateMe, printMode, className, children, onMapLoad. Uses react-map-gl Map, manages viewState, falls back gracefully if MAPBOX_TOKEN missing. Renders NavigationControl when interactive. Children are composable layer components.

### Task 2: Create LayerToggle Component

**Files:**
- Create: `src/components/map/LayerToggle.tsx`
- Test: `src/components/map/__tests__/LayerToggle.test.tsx`

Positioned bottom-left inside CRXMap. Toggles satellite/roads/hybrid/terrain base layers. Uses Lucide icons (Layers, Satellite, Map, Mountain). Mobile-friendly tap targets.

### Task 3: Create LocateMe GPS Button

**Files:**
- Create: `src/components/map/LocateMe.tsx`
- Test: `src/components/map/__tests__/LocateMe.test.tsx`

Positioned top-left inside CRXMap. Uses browser Geolocation API. Shows Loader2 spinner while locating. Calls onLocate(lng, lat) on success.

### Task 4: Create AddressSearch Component

**Files:**
- Create: `src/components/map/AddressSearch.tsx`
- Test: `src/components/map/__tests__/AddressSearch.test.tsx`

Search bar overlaid on map. Uses Mapbox Geocoding API via fetch (no extra package). Debounced input (300ms), dropdown results. Detects coordinate input (40.123, -89.456) and flies directly. Enter key selects first result.

### Task 5: Create FieldBoundaryLayer Component

**Files:**
- Create: `src/components/map/FieldBoundaryLayer.tsx`
- Test: `src/components/map/__tests__/FieldBoundaryLayer.test.tsx`

Renders filled polygons via react-map-gl Source + Layer. Green fill (#28A26A, 20% opacity), green outline. Shows field name labels. Hover popup with field name, acres, crop, customer. Click fires onFieldClick(fieldId).

### Task 6: Refactor FieldMarkerLayer from existing FieldMarkers

**Files:**
- Create: `src/components/map/FieldMarkerLayer.tsx`
- Test: `src/components/map/__tests__/FieldMarkerLayer.test.tsx`

Same logic as existing FieldMarkers.tsx but only renders markers for fields WITHOUT boundary_geojson. Named consistently with layer convention.

### Task 7: Create DrawLayer Wrapper

**Files:**
- Create: `src/components/map/DrawLayer.tsx`
- Test: `src/components/map/__tests__/DrawLayer.test.tsx`

Thin wrapper around existing DrawControl.tsx. Auto-calculates acreage via turf/area on draw/update. Returns boundary GeoJSON + calculated acres + centroid via callbacks. Encapsulates all draw logic for FieldSetup.

### Task 8: Wire LayerToggle and LocateMe into CRXMap

**Files:**
- Modify: `src/components/map/CRXMap.tsx`
- Update: `src/components/map/__tests__/CRXMap.test.tsx`

When showLayerToggle=true, render LayerToggle. When showLocateMe=true, render LocateMe. CRXMap manages baseLayer state internally when toggle is shown. LocateMe callback updates viewState to fly to GPS coords.

---

## Phase 2: Field Dashboard Page

### Task 9: Create get_field_dashboard RPC (Migration)

**Files:**
- Create: `supabase/migrations/YYYYMMDDHHMMSS_get_field_dashboard_rpc.sql`
- Update: `docs/reference/rpc-functions.md`
- Update: `docs/reference/migration-history.md`

STABLE SECURITY DEFINER function with SET search_path = public, pg_temp. Accepts p_field_id uuid and p_season integer (defaults to current_season()). Returns JSONB with: field data (+ customer + billing_defaults + geometry via ST_AsGeoJSON), season_summary (total_apps, total_acres_treated, distinct_products), application_records (with applicator name, vehicle name, weather, product_data), recent_activity (last 10 activity_feed entries for this field).

### Task 10: Create FieldDashboard Page — Top Section + Overview Tab

**Files:**
- Create: `src/pages/FieldDashboard.tsx`
- Modify: `src/App.tsx` — add lazy import + route at `fields/:id/dashboard`
- Test: `src/pages/__tests__/FieldDashboard.test.tsx`

Route: /fields/:id/dashboard. ProtectedRoute for admin + sales_rep. Top section: CRXMap with FieldBoundaryLayer showing this field + key stats (name, customer, acres, crop, county) + Edit Field button linking to /fields/:id. Tab bar: Overview | Applications | Billing | Details. Overview tab: 4 season summary cards + recent activity timeline. Uses assertRpcResult() per ESLint rules.

### Task 11: FieldDashboard — Applications Tab

**Files:**
- Modify: `src/pages/FieldDashboard.tsx`

Full application history DataTable. Columns: Date, Products (from product_data JSONB), Acres Treated, Applicator, Vehicle, Weather summary, Source (Job/Blend Ticket link). Sortable by date (newest first). Expandable rows for full weather details. CSV export. Filter by product name.

### Task 12: FieldDashboard — Billing Tab

**Files:**
- Modify: `src/pages/FieldDashboard.tsx`

Read-only billing splits with visual percentage bar (colored segments per grower). Shows price override and pricing note per grower. Primary grower indicator. Invoice history section showing invoices linked to this field's orders.

### Task 13: FieldDashboard — Details Tab

**Files:**
- Modify: `src/pages/FieldDashboard.tsx`

Legal description, FSA numbers (farm/tract/field), soil type, irrigation status, notes. Created/updated timestamps. Activity log list from RPC response.

---

## Phase 3: Field Setup Polish

### Task 14: Rename FieldDetail to FieldSetup + Two-Panel Layout

**Files:**
- Rename: `src/pages/FieldDetail.tsx` to `src/pages/FieldSetup.tsx`
- Modify: `src/App.tsx` — update lazy import
- Update: `tests/e2e/field-detail.spec.ts` references

Two-panel on desktop: form left (lg:col-span-7), map right (lg:col-span-5). Mobile: stacked, map collapsible. All existing save logic (save_field, save_field_geometry, idempotency, activity logging) unchanged.

### Task 15: Add AddressSearch + LocateMe to FieldSetup Map

**Files:**
- Modify: `src/pages/FieldSetup.tsx`

Replace MapContainer + DrawControl with CRXMap + DrawLayer + AddressSearch. Enable showLocateMe. Address search onSelect flies map to coordinates. DrawLayer handles acreage calculation (replaces inline turf logic).

### Task 16: Collapsible Form Sections + Duplicate Detection

**Files:**
- Modify: `src/pages/FieldSetup.tsx`

FSA Numbers and Billing Splits sections collapsed by default (chevron toggle). On field name blur: query existing fields for same customer + name, show warning if duplicate found. Mobile: all sections as accordion (one open at a time).

---

## Phase 4: Fields List Upgrade

### Task 17: Swap Fields List Map to CRXMap with Boundaries

**Files:**
- Modify: `src/pages/Fields.tsx`

Replace MapContainer + FieldMarkers with CRXMap + FieldBoundaryLayer + FieldMarkerLayer. Enable showLayerToggle and showLocateMe. Click field polygon or marker navigates to /fields/:id/dashboard. List row click also navigates to dashboard.

### Task 18: Add Customer Filter + Status Filter to Fields List

**Files:**
- Modify: `src/pages/Fields.tsx`

Add customer dropdown filter (populated from data). Add active/inactive toggle. Add header stats row: total fields, total acres, fields with boundary count.

---

## Phase 5: Print Mode + Final Polish

### Task 19: Print Mode CSS

**Files:**
- Create: `src/styles/map-print.css`
- Modify: `src/components/map/CRXMap.tsx`

CSS @media print rules: hide map controls, enlarge field name labels, add scale bar. CRXMap printMode prop switches to roads base layer and applies print class.

### Task 20: Update Documentation + Final Checks

**Files:**
- Update: `CLAUDE.md` — page count (+1), migration count (+1)
- Update: `docs/reference/pages-routes.md` — add FieldDashboard
- Update: `docs/reference/rpc-functions.md` — add get_field_dashboard
- Update: `docs/reference/migration-history.md`
- Update: `docs/CHANGELOG.md`

Verification:
```bash
grep -c "lazy(" src/App.tsx                    # verify page count
ls supabase/migrations/*.sql | wc -l          # verify migration count
npm run lint && npm run build && npm run test  # all green
```

---

## Task Summary

| Phase | Tasks | Description |
|-------|-------|-------------|
| 1 | 1-8 | CRXMap component + all child layers |
| 2 | 9-13 | Field Dashboard page (RPC + 4 tabs) |
| 3 | 14-16 | Field Setup polish (rename + layout + search) |
| 4 | 17-18 | Fields List upgrade (boundaries + filters) |
| 5 | 19-20 | Print mode + documentation |

**Total: 20 tasks across 5 phases**
