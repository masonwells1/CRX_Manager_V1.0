# Field Management V3 — Map Intelligence + Field Grouping Design

**Date:** 2026-03-31
**Status:** Approved
**Builds on:** `2026-03-29-field-management-v2-design.md` (already implemented)

---

## Problem Statement

Field Management V2 shipped CRXMap, FieldDashboard, FieldSetup, and DrawLayer. Two critical problems remain:

1. **Maps never zoom to data** — All map views default to central Illinois at zoom 7. Clicking a field in the dashboard shows the entire state, not the field. No `fitBounds()` logic exists anywhere.
2. **No field grouping / multi-polygon** — Physical fields like "Lindley 100" are split into 3-6 separate DB records (one per customer or sub-parcel) with no way to link them. The draw tool only allows one polygon per field. Users can't represent non-contiguous parcels or see a complete view of a physical field.

## Goals

1. **Auto-zoom all maps** to fit visible field data using `fitBounds()`
2. **Click-to-zoom** on map markers and boundaries
3. **Multi-polygon drawing** — draw multiple polygons per field, each auto-calculates acres
4. **Parent/child field model** — group related fields under a parent, aggregating acres and showing all polygons together
5. **"Group Fields" action** — bulk-select existing fields and link them as sub-fields

## Non-Goals (Deferred)

- PostGIS spatial indexing (not needed at current data volume)
- CLU/PLSS boundary snap-to-draw
- Polygon import from shapefile/KML
- Field boundary sharing between customers
- Recursive nesting beyond parent → child

---

## Pillar A: Map Intelligence

### A1. `useFitBounds` Hook

New hook that computes a bounding box from an array of GeoJSON features and calls `map.fitBounds()`.

```tsx
// Usage
const bounds = useFitBounds(fields.map(f => f.boundary_geojson).filter(Boolean));

<CRXMap bounds={bounds} ...>
```

**Implementation:**
- Uses `@turf/bbox` to compute `[minLng, minLat, maxLng, maxLat]` from a FeatureCollection
- CRXMap gets a new `bounds?: [number, number, number, number]` prop
- When `bounds` changes, calls `map.fitBounds(bounds, { padding: 60, maxZoom: 16 })`
- Falls back to existing `center`/`zoom` if `bounds` is null/empty

### A2. Fields List Map View — Auto-Zoom

**Current:** Shows all of Illinois at zoom 7, no matter what.

**Fix:**
- After fields load, compute bounding box of all filtered fields that have centroids or boundaries
- Pass as `bounds` prop to CRXMap
- If no fields have geo data, keep IL default
- Re-compute bounds when filters change (customer, crop, county, status)

### A3. Field Dashboard — Zoom to Field

**Current:** Uses centroid at zoom 14 (or zoom 7 if no centroid). Shows half the state.

**Fix:**
- If field has boundary: `fitBounds()` to boundary polygon with padding
- If field has centroid only: center at centroid, zoom 15
- If no geo data: show IL default with "No boundary drawn" message

### A4. Field Setup — Zoom to Boundary

**Current:** Shows IL default even when editing a field with an existing boundary.

**Fix:**
- When loading existing field with boundary: `fitBounds()` to boundary
- When loading with centroid only: center on centroid, zoom 15
- When creating new: use geolocation (LocateMe) or IL default

### A5. Click-to-Zoom on Map Markers

**Current:** Clicking a field marker navigates directly to the dashboard. Map never zooms.

**Fix in Fields list map view:**
- Single click on marker/boundary: zoom to that field's boundary + show popup with field name, customer, acres
- Popup has "View Dashboard" link to navigate
- This replaces the immediate navigation, giving users a preview first

### A6. CRXMap `bounds` Prop

Add `bounds` prop to CRXMap component:

```tsx
interface CRXMapProps {
  // existing props...
  bounds?: [number, number, number, number]; // [minLng, minLat, maxLng, maxLat]
  boundsOptions?: { padding?: number; maxZoom?: number };
}
```

When `bounds` changes (and is non-null), override the viewState with a `fitBounds()` call.

---

## Pillar B: Field Grouping + Multi-Polygon

### B1. Database Changes

#### New Column: `fields.parent_field_id`

```sql
ALTER TABLE fields
  ADD COLUMN parent_field_id uuid REFERENCES fields(id) ON DELETE SET NULL;

CREATE INDEX idx_fields_parent_id ON fields(parent_field_id) WHERE parent_field_id IS NOT NULL;

-- RLS: inherits from existing fields policies (same customer_id check)
```

**Rules:**
- `parent_field_id IS NULL` = standalone field or parent
- `parent_field_id IS NOT NULL` = child/sub-field
- One level only — a child cannot itself be a parent (enforced by CHECK or app logic)
- Parent fields can have their own polygons too (not just a grouping container)

#### New Table: `field_polygons`

```sql
CREATE TABLE field_polygons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  field_id uuid NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  polygon_geojson jsonb NOT NULL,
  label text,                    -- e.g. "North Parcel", "East 40"
  acres numeric(12,2),           -- auto-calculated from polygon
  sort_order int DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_field_polygons_field_id ON field_polygons(field_id);

-- RLS: same as fields (join to fields.customer_id)
ALTER TABLE field_polygons ENABLE ROW LEVEL SECURITY;
CREATE POLICY field_polygons_tenant ON field_polygons
  USING (field_id IN (SELECT id FROM fields));
```

#### Updated RPCs

**`save_field_polygons(p_field_id, p_polygons jsonb, p_performed_by, p_idempotency_key)`**
- Deletes existing polygons for this field
- Inserts new polygon records
- Recomputes `fields.boundary_geojson` as the union (or first polygon if only one)
- Recomputes `fields.total_acres` as sum of polygon acres (if user hasn't manually overridden)
- Recomputes centroid from combined geometry

**`link_fields_to_parent(p_parent_id, p_child_ids uuid[], p_performed_by, p_idempotency_key)`**
- Sets `parent_field_id` on each child
- Validates parent is not itself a child
- Logs activity

**`unlink_field_from_parent(p_field_id, p_performed_by, p_idempotency_key)`**
- Sets `parent_field_id = NULL`

**`get_field_group(p_field_id)`**
- Returns parent field + all children with their polygons
- Used by FieldDashboard to show complete field group

**Updated `get_fields_with_geojson()`**
- Returns `parent_field_id` and `child_count` for each field
- Allows frontend to build the tree view

### B2. Multi-Polygon Drawing (Field Setup)

**Current:** DrawControl allows exactly one polygon. `handleBoundaryChange` replaces the whole boundary.

**New behavior:**
- DrawControl allows multiple polygons (remove the "delete existing before drawing new" logic)
- Each polygon gets a label and auto-calculated acres
- Left sidebar shows list of drawn polygons with:
  - Label (editable, defaults to "Polygon 1", "Polygon 2"...)
  - Acres (auto-calculated)
  - Delete button (trash icon)
- Total acres = sum of all polygons (shown prominently)
- Save calls `save_field_polygons()` instead of `save_field_geometry()`

**DrawControl changes:**
- Allow `defaultMode: 'draw_polygon'` to stay active after first polygon
- On `draw.create`, append to polygon list (don't replace)
- On `draw.delete`, remove from polygon list
- On `draw.update`, update the specific polygon

### B3. Field Grouping UI (Fields List)

**Tree view in list mode:**
- Parent fields show with expand/collapse chevron
- Expanded: shows child sub-fields indented below
- Parent row shows aggregate: total acres (sum of children + own), child count badge
- Standalone fields (no parent, no children) show normally

**"Group Fields" bulk action:**
- Select 2+ fields using checkboxes
- New bulk action button: "Group as Sub-fields"
- Prompts: "Which field should be the parent?" (radio select from selected fields)
- OR: "Create new parent field" (enters a name, inherits customer from first selected)
- Calls `link_fields_to_parent()`

**"Ungroup" action on child fields:**
- In the field row's context menu or detail page
- Calls `unlink_field_from_parent()`

### B4. Field Dashboard — Group View

When viewing a parent field:
- Map shows ALL polygons from parent + children, each in a different color
- Summary stats aggregate across all children
- Application records table includes apps from all children
- Children listed with links to their individual dashboards

### B5. Updated Types

```typescript
// src/types/index.ts additions
interface Field {
  // ...existing fields...
  parent_field_id?: string | null;
}

interface FieldPolygon {
  id: string;
  field_id: string;
  polygon_geojson: object;
  label: string | null;
  acres: number | null;
  sort_order: number;
  created_at: string;
}

interface FieldWithGroup extends Field {
  child_count?: number;
  children?: Field[];
  polygons?: FieldPolygon[];
}
```

---

## Migration Plan

All changes are additive. Existing fields continue to work:

### Phase 1: Map Intelligence (no DB changes)
1. Create `useFitBounds` hook
2. Add `bounds` prop to CRXMap
3. Wire fitBounds into Fields list map view
4. Wire fitBounds into FieldDashboard
5. Wire fitBounds into FieldSetup
6. Add click-to-zoom popup on map markers

### Phase 2: Multi-Polygon Infrastructure (DB + backend)
7. Migration: `parent_field_id` column + `field_polygons` table
8. RPC: `save_field_polygons`
9. RPC: `link_fields_to_parent` / `unlink_field_from_parent`
10. RPC: `get_field_group`
11. Update `get_fields_with_geojson` to include parent/child data

### Phase 3: Multi-Polygon Drawing (frontend)
12. Update DrawControl to support multiple polygons
13. Add polygon list sidebar in FieldSetup
14. Wire save to `save_field_polygons` RPC

### Phase 4: Field Grouping UI (frontend)
15. Tree view in Fields list
16. "Group as Sub-fields" bulk action
17. "Ungroup" action
18. FieldDashboard group aggregate view

---

## Backward Compatibility

- `boundary_geojson` stays on the `fields` table — recomputed as first/union polygon
- `centroid_geojson` stays — recomputed from combined geometry
- Existing `save_field_geometry()` RPC still works for single-polygon saves
- Fields without children or polygons behave exactly as before
- `get_fields_with_geojson()` returns same shape with optional new fields

---

## Success Criteria

- [ ] All 3 map views auto-zoom to show field data (not whole state)
- [ ] Clicking a marker on the Fields map zooms to the field and shows popup
- [ ] Multiple polygons can be drawn on one field with per-polygon acre calc
- [ ] Fields can be grouped as parent/child with aggregate stats
- [ ] "Group as Sub-fields" bulk action works from Fields list
- [ ] FieldDashboard for a parent shows all children's polygons and stats
- [ ] Existing fields with single boundaries continue to work unchanged
- [ ] All existing tests pass
- [ ] New unit tests for useFitBounds, polygon acre calculation
- [ ] New E2E tests for multi-polygon drawing and field grouping
