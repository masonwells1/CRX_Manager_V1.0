# Field Management V2 — Design Document

**Date:** 2026-03-29
**Approach:** #2 — New Field Dashboard + Map Layer System
**Status:** Approved

---

## Problem Statement

Field management exists but needs to be production-ready before the upcoming season. The current implementation has map logic scattered across multiple components, no field-level dashboard for viewing application history and stats, and limited mobile UX. The system needs to serve two equally important user types: sales reps in the field on mobile and office staff managing bulk operations on desktop.

## Goals

1. **Reusable map component** (`<CRXMap>`) with pluggable layer system — built for future LIDAR, yield maps, NDVI, VRT
2. **Field Dashboard** — read-only page showing full field profile, application timeline, season stats, billing history
3. **Field Setup polish** — two-panel layout, mobile accordion, address search, duplicate detection
4. **Fields List improvements** — boundary polygons on map view, customer filter, click navigates to dashboard
5. **Mobile-first UX** — GPS locate, full-screen draw mode, touch-friendly controls

## Non-Goals (Deferred)

- LIDAR/elevation layer data pipeline
- Yield heat maps / VRT import
- NDVI/crop health API integration
- Soil test records table
- Crop planning / prescriptions
- Customer portal field views
- CLU/PLSS boundary snap-to-draw
- Google Maps as alternate provider

---

## Architecture

### Map Infrastructure: `<CRXMap>`

Replaces the scattered `MapContainer.tsx` + inline map code with a single reusable component using composable child layers.

**API:**
```tsx
<CRXMap
  center={[-89.0, 40.0]}
  zoom={7}
  baseLayer="satellite"       // satellite | roads | hybrid | terrain
  interactive={true}
  showLayerToggle={true}
  showLocateMe={true}
  printMode={false}
  onFieldClick={(fieldId) => {}}
>
  <FieldBoundaryLayer fields={fields} showLabels={true} />
  <FieldMarkerLayer fields={fields} />
  <DrawLayer onUpdate={handleDraw} initialGeoJSON={boundary} />
</CRXMap>
```

**Base Layers:**

| Layer | Mapbox Style | Use Case |
|-------|-------------|----------|
| Satellite | `satellite-streets-v12` | Default — boundaries on imagery |
| Roads | `streets-v12` | Driving directions, print maps |
| Hybrid | `satellite-streets-v12` + enhanced labels | Best of both |
| Terrain | `outdoors-v12` | Elevation contours, future LIDAR |

**Overlay Layers (toggleable):**
- Field boundaries — filled polygons with name labels
- Field markers — centroid dots for fields without boundaries
- County/section lines (future slot)
- Custom rasters (future slot for yield, NDVI, LIDAR)

**Mobile Features:**
- Pinch-to-zoom (native Mapbox)
- "Locate Me" GPS button — centers map on user location
- Touch-friendly layer toggle (bottom sheet, not tiny dropdown)
- Full-screen map option

**Print Mode:**
- Auto-switches to roads base layer
- Enlarges road and field name labels
- Adds scale bar and north arrow
- CSS `@media print` compatible

### File Structure

```
src/components/map/
  CRXMap.tsx              <- new reusable map wrapper
  LayerToggle.tsx         <- new layer switcher UI
  LocateMe.tsx            <- new GPS button
  AddressSearch.tsx       <- new geocoding search (Mapbox Geocoding API)
  FieldBoundaryLayer.tsx  <- new polygon overlay layer
  FieldMarkerLayer.tsx    <- refactored from existing FieldMarkers.tsx
  DrawLayer.tsx           <- new wrapper around DrawControl
  DrawControl.tsx         <- existing, unchanged
  MapContainer.tsx        <- deprecated, replaced by CRXMap

src/pages/
  Fields.tsx              <- updated list page
  FieldSetup.tsx          <- renamed from FieldDetail.tsx, polished
  FieldDashboard.tsx      <- new read-only dashboard page
```

---

## Page Designs

### 1. Field Dashboard (`/fields/:id/dashboard`) — NEW

Read-only field profile page. This is where users land when clicking a field from the list.

**Top Section (always visible):**
- Map showing field boundary via `<CRXMap>` + `<FieldBoundaryLayer>`
- Key stats beside map: field name, customer, acres, crop, county
- "Edit Field" button linking to Field Setup
- Mobile: map as compact banner, stats below

**Tab: Overview (default)**
- Season summary cards:
  - Total Applications (count from `application_records`)
  - Total Acres Treated (sum from application records)
  - Products Applied (distinct count)
  - Total Product Cost (sum from job chemicals)
- Recent activity timeline (last 5-10 items from application_records, jobs, activity_feed)

**Tab: Applications**
- Full application history table:
  - Date, Products, Rate, Acres Treated, Applicator, Vehicle, Weather, Source (Job/Blend Ticket link)
- Sortable, filterable by season and product
- Expandable rows for full weather/notes detail
- CSV export

**Tab: Billing**
- Read-only billing splits with visual percentage bar
- Invoice history linked to this field

**Tab: Details**
- Legal description, FSA numbers, soil type, irrigation, notes
- Created/updated timestamps
- Activity log for this field

**New RPC:** `get_field_dashboard(p_field_id uuid, p_season text)`
- Returns field data + application records + season summary stats in one query
- Computed server-side to avoid multiple round-trips

### 2. Field Setup (`/fields/:id` and `/fields/new`) — REFACTOR

Existing `FieldDetail.tsx` renamed and polished.

**Layout:** Two-panel on desktop (form left, map right). Stacked on mobile with collapsible map.

**Form Sections (collapsible):**
1. Field Identity — name, customer, status
2. Location & Boundary — map with draw tools, address search, acres (auto-calc), county, state
3. Crop & Soil — crop type, soil type, irrigation
4. FSA Numbers — farm, tract, field (collapsed by default)
5. Billing Splits — per-grower allocation with visual bar (collapsed by default)
6. Notes

**New Features:**
- Address/coordinate search bar on map panel
- Ghost outlines of nearby fields when drawing
- Duplicate field name warning
- Mobile: sections as accordion, full-screen map when drawing

**No Backend Changes:** Uses existing `save_field()` and `save_field_geometry()` RPCs.

### 3. Fields List (`/fields`) — UPDATE

**Map View Upgrade:**
- Uses `<CRXMap>` with `<FieldBoundaryLayer>` + `<FieldMarkerLayer>`
- Fields with boundaries show as filled polygons
- Fields without boundaries show as centroid markers
- Click field → navigates to Field Dashboard

**List View Updates:**
- Add customer filter dropdown
- Add active/inactive status filter
- Row click → Field Dashboard (not Setup)
- Quick-action edit icon → Field Setup directly

**Header Stats:** Total fields, total acres, boundary coverage count

**Mobile:** Default to map view, list accessible via toggle.

---

## Database Changes

### New RPC: `get_field_dashboard`

```sql
CREATE OR REPLACE FUNCTION get_field_dashboard(
  p_field_id uuid,
  p_season text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
-- Returns:
-- {
--   field: { ...field data with customer, billing_defaults, geometry },
--   season_summary: { total_apps, total_acres, distinct_products, total_cost_cents },
--   application_records: [ ...records with applicator/vehicle/weather ],
--   recent_activity: [ ...last 10 activity_feed entries for this field ]
-- }
$$;
```

**No new tables required.** All data already exists in `application_records`, `jobs`, `job_fields`, `job_chemicals`, `invoices`, `activity_feed`.

---

## Migration Plan

Existing pages continue to work throughout. Changes are additive:

1. Build `<CRXMap>` component and child layers
2. Build Field Dashboard page (new route, new RPC)
3. Refactor Field Setup (rename, two-panel layout, polish)
4. Update Fields List (swap map component, add filters, change navigation)
5. Deprecate `MapContainer.tsx` once all usages migrated

---

## Tech Stack

| Library | Purpose | Status |
|---------|---------|--------|
| react-map-gl / mapbox-gl | Map rendering | Already installed |
| @mapbox/mapbox-gl-draw | Polygon drawing | Already installed |
| @turf/area, @turf/centroid, @turf/bbox | Geometry calculations | Already installed |
| @mapbox/mapbox-gl-geocoder | Address search | **New dependency** |
| PostGIS | Geography storage | Already enabled |

**One new dependency:** `@mapbox/mapbox-gl-geocoder` for address/coordinate search. Alternatively, can use Mapbox Geocoding API directly via fetch (no extra package).

---

## Success Criteria

- [ ] `<CRXMap>` used on all three field pages with consistent UX
- [ ] Field Dashboard shows application timeline from existing data
- [ ] Season summary stats are accurate (verified against raw queries)
- [ ] Layer toggle works across all base layers
- [ ] "Locate Me" works on mobile browsers
- [ ] Address search flies map to correct location
- [ ] Field Setup two-panel layout works on desktop and mobile
- [ ] Print mode produces readable maps with road labels
- [ ] All existing field tests still pass
- [ ] New E2E tests cover dashboard navigation and tab switching
