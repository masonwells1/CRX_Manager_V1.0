# Field Management V3 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix map auto-zoom across all field pages, add multi-polygon drawing per field, and add parent/child field grouping.

**Architecture:** Two pillars — (A) map intelligence via a `useFitBounds` hook + `bounds` prop on CRXMap, wired into all 3 field pages; (B) field grouping via `parent_field_id` self-FK + `field_polygons` table, multi-polygon DrawControl, and tree-view list UI.

**Tech Stack:** React 18, TypeScript, Mapbox GL JS via `react-map-gl`, `@turf/bbox` (already installed), `@mapbox/mapbox-gl-draw`, Supabase RPCs, PostGIS.

---

## Phase 1: Map Intelligence (no DB changes)

### Task 1: Install `@turf/bbox` types and create `useFitBounds` hook

**Files:**
- Create: `src/hooks/useFitBounds.ts`
- Create: `src/hooks/useFitBounds.test.ts`

**Step 1: Write the test**

```typescript
// src/hooks/useFitBounds.test.ts
import { describe, it, expect } from 'vitest';
import { computeBounds } from '../hooks/useFitBounds';

describe('computeBounds', () => {
  it('returns null for empty array', () => {
    expect(computeBounds([])).toBeNull();
  });

  it('returns null when all entries are null/undefined', () => {
    expect(computeBounds([null, undefined, ''])).toBeNull();
  });

  it('computes bbox from a single polygon GeoJSON string', () => {
    const polygon = JSON.stringify({
      type: 'Polygon',
      coordinates: [[[-89.5, 40.0], [-89.4, 40.0], [-89.4, 40.1], [-89.5, 40.1], [-89.5, 40.0]]],
    });
    const result = computeBounds([polygon]);
    expect(result).not.toBeNull();
    // bbox returns [minLng, minLat, maxLng, maxLat]
    expect(result![0]).toBeCloseTo(-89.5, 1);
    expect(result![1]).toBeCloseTo(40.0, 1);
    expect(result![2]).toBeCloseTo(-89.4, 1);
    expect(result![3]).toBeCloseTo(40.1, 1);
  });

  it('computes bbox from multiple point GeoJSON strings', () => {
    const p1 = JSON.stringify({ type: 'Point', coordinates: [-89.0, 40.0] });
    const p2 = JSON.stringify({ type: 'Point', coordinates: [-88.0, 41.0] });
    const result = computeBounds([p1, p2]);
    expect(result).not.toBeNull();
    expect(result![0]).toBeCloseTo(-89.0, 1); // minLng
    expect(result![2]).toBeCloseTo(-88.0, 1); // maxLng
  });

  it('skips invalid JSON gracefully', () => {
    const valid = JSON.stringify({ type: 'Point', coordinates: [-89.0, 40.0] });
    const result = computeBounds(['not-json', valid, '{bad}']);
    expect(result).not.toBeNull();
    expect(result![0]).toBeCloseTo(-89.0, 1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /c/Users/mason/CRX_Manager_V1.0 && npx vitest run src/hooks/useFitBounds.test.ts`
Expected: FAIL — module not found

**Step 3: Implement `useFitBounds`**

```typescript
// src/hooks/useFitBounds.ts
import { useMemo } from 'react';
import bbox from '@turf/bbox';
import type { BBox } from 'geojson';

export type Bounds = [number, number, number, number]; // [minLng, minLat, maxLng, maxLat]

/**
 * Pure function: compute a bounding box from an array of GeoJSON strings.
 * Returns null if no valid geometries found.
 */
export function computeBounds(
  geojsonStrings: (string | null | undefined)[]
): Bounds | null {
  const features: GeoJSON.Feature[] = [];

  for (const raw of geojsonStrings) {
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      // Could be a raw geometry or a Feature
      if (parsed.type === 'Feature') {
        features.push(parsed);
      } else if (parsed.type && parsed.coordinates) {
        features.push({ type: 'Feature', properties: {}, geometry: parsed });
      }
    } catch {
      // Skip invalid JSON
    }
  }

  if (features.length === 0) return null;

  const collection: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features,
  };

  const box: BBox = bbox(collection);
  // bbox returns [minX, minY, maxX, maxY] which is [minLng, minLat, maxLng, maxLat]
  return [box[0], box[1], box[2], box[3]];
}

/**
 * React hook: memoizes bounding box computation from GeoJSON strings.
 * Pass boundary_geojson and/or centroid_geojson strings from fields.
 */
export function useFitBounds(
  geojsonStrings: (string | null | undefined)[]
): Bounds | null {
  return useMemo(() => computeBounds(geojsonStrings), [geojsonStrings]);
}
```

**Step 4: Run test to verify it passes**

Run: `cd /c/Users/mason/CRX_Manager_V1.0 && npx vitest run src/hooks/useFitBounds.test.ts`
Expected: PASS (all 5 tests)

**Step 5: Commit**

```bash
cd /c/Users/mason/CRX_Manager_V1.0
git add src/hooks/useFitBounds.ts src/hooks/useFitBounds.test.ts
git commit -m "feat(fields): add useFitBounds hook for auto-zoom map logic"
```

---

### Task 2: Add `bounds` prop to CRXMap

**Files:**
- Modify: `src/components/map/CRXMap.tsx`

**Step 1: Add bounds prop and useEffect to CRXMap**

In `src/components/map/CRXMap.tsx`, add to the `CRXMapProps` interface (after line 28):

```typescript
  bounds?: [number, number, number, number] | null; // [minLng, minLat, maxLng, maxLat]
  boundsOptions?: { padding?: number; maxZoom?: number };
```

Add to destructured props (after `onMapLoad`):

```typescript
  bounds = null,
  boundsOptions = { padding: 60, maxZoom: 16 },
```

Add a `mapRef` and a `useEffect` that calls `fitBounds` when bounds change. Add this import at top:

```typescript
import { useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
```

Inside the component, after the `handleLocate` callback:

```typescript
  const mapRef = useRef<MapRef | null>(null);

  const handleLoad = useCallback(
    (evt: { target: MapRef }) => {
      mapRef.current = evt.target;
      onMapLoad?.(evt.target);
      // If bounds were set before map loaded, apply now
      if (bounds) {
        evt.target.fitBounds(
          [[bounds[0], bounds[1]], [bounds[2], bounds[3]]],
          { padding: boundsOptions?.padding ?? 60, maxZoom: boundsOptions?.maxZoom ?? 16 }
        );
      }
    },
    [onMapLoad, bounds, boundsOptions]
  );

  useEffect(() => {
    if (!bounds || !mapRef.current) return;
    mapRef.current.fitBounds(
      [[bounds[0], bounds[1]], [bounds[2], bounds[3]]],
      { padding: boundsOptions?.padding ?? 60, maxZoom: boundsOptions?.maxZoom ?? 16 }
    );
  }, [bounds, boundsOptions]);
```

**Important:** Replace the existing `handleLoad` callback (lines 55-60) with the new one above that also stores the mapRef and applies initial bounds.

**Step 2: Run build to verify no TS errors**

Run: `cd /c/Users/mason/CRX_Manager_V1.0 && npx tsc --noEmit`
Expected: No errors

**Step 3: Run existing tests to verify no regressions**

Run: `cd /c/Users/mason/CRX_Manager_V1.0 && npx vitest run`
Expected: All existing tests pass

**Step 4: Commit**

```bash
git add src/components/map/CRXMap.tsx
git commit -m "feat(map): add bounds prop to CRXMap for auto-zoom fitBounds"
```

---

### Task 3: Wire fitBounds into Fields list map view

**Files:**
- Modify: `src/pages/Fields.tsx`

**Step 1: Import and compute bounds**

At top of `src/pages/Fields.tsx`, add import:

```typescript
import { useFitBounds } from '../hooks/useFitBounds';
```

After the `withBoundary` calculation (line 81), add:

```typescript
  // Compute map bounds from all filtered fields with geo data
  const geoStrings = useMemo(
    () => filtered.flatMap((f) => [f.boundary_geojson, f.centroid_geojson]),
    [filtered]
  );
  const mapBounds = useFitBounds(geoStrings);
```

Add `useMemo` to the existing imports from React if not already there (line 1).

**Step 2: Pass bounds to CRXMap**

In the map view section (around line 299), update the `<CRXMap>` to include `bounds`:

```tsx
<CRXMap
  className="h-[500px] w-full rounded-lg overflow-hidden"
  showLayerToggle
  showLocateMe
  bounds={mapBounds}
>
```

This replaces the existing CRXMap that has no bounds prop.

**Step 3: Run build**

Run: `cd /c/Users/mason/CRX_Manager_V1.0 && npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add src/pages/Fields.tsx
git commit -m "feat(fields): auto-zoom Fields list map to show all field locations"
```

---

### Task 4: Wire fitBounds into FieldDashboard

**Files:**
- Modify: `src/pages/FieldDashboard.tsx`

**Step 1: Import computeBounds and compute bounds from field data**

At top, add:

```typescript
import { computeBounds } from '../hooks/useFitBounds';
```

Replace the existing `mapCenter` useMemo (lines 67-74) with a bounds calculation:

```typescript
  const mapBounds = useMemo(() => {
    if (!data) return null;
    const geoStrings = [
      data.field.boundary_geojson,
      data.field.centroid_geojson,
    ].filter(Boolean);
    return computeBounds(geoStrings as string[]);
  }, [data]);
```

**Step 2: Pass bounds to CRXMap instead of center/zoom**

Update the `<CRXMap>` (around line 141) — replace `center={mapCenter}` and `zoom={mapCenter ? 14 : 7}` with the `bounds` prop:

```tsx
<CRXMap
  bounds={mapBounds}
  showLayerToggle
  className="h-[300px] w-full"
>
```

Remove the now-unused `mapCenter` constant if it was the only usage. Keep the import of `useMemo` from React.

**Step 3: Run build**

Run: `cd /c/Users/mason/CRX_Manager_V1.0 && npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add src/pages/FieldDashboard.tsx
git commit -m "feat(fields): auto-zoom FieldDashboard map to field boundary"
```

---

### Task 5: Wire fitBounds into FieldSetup

**Files:**
- Modify: `src/pages/FieldSetup.tsx`

**Step 1: Import computeBounds**

```typescript
import { computeBounds } from '../hooks/useFitBounds';
```

**Step 2: Compute bounds from loaded field boundary**

After the existing `mapCenter`/`mapZoom` state declarations (around line 65-66), add a computed bounds value:

```typescript
  const initialBounds = useMemo(() => {
    if (!boundaryGeoJSON) return null;
    return computeBounds([JSON.stringify(boundaryGeoJSON.geometry)]);
  }, [boundaryGeoJSON]);
```

Add `useMemo` to the React imports if not already there.

**Step 3: Pass bounds to CRXMap**

Update the `<CRXMap>` in the right panel (around line 794):

```tsx
<CRXMap
  center={mapCenter}
  zoom={mapZoom}
  bounds={initialBounds}
  showLocateMe
  showLayerToggle
  className="h-[400px] w-full"
>
```

The `bounds` prop takes priority in CRXMap (fitBounds overrides center/zoom). When user draws a new polygon, `mapCenter` updates still work for that interaction.

**Step 4: Run build + tests**

Run: `cd /c/Users/mason/CRX_Manager_V1.0 && npx tsc --noEmit && npx vitest run`
Expected: All pass

**Step 5: Commit**

```bash
git add src/pages/FieldSetup.tsx
git commit -m "feat(fields): auto-zoom FieldSetup map to existing boundary"
```

---

### Task 6: Click-to-zoom popup on map markers/boundaries

**Files:**
- Modify: `src/components/map/FieldMarkerLayer.tsx`
- Modify: `src/components/map/FieldBoundaryLayer.tsx`
- Modify: `src/pages/Fields.tsx`

**Step 1: Add click-to-zoom to FieldMarkerLayer**

Currently `onFieldClick` navigates immediately (line 69). Change the Marker `onClick` to set a `selected` state instead, showing a popup with a "View Dashboard" link.

Replace the existing `hovered` state + Marker onClick + Popup with:

```typescript
const [selected, setSelected] = useState<FieldGeo | null>(null);
```

Update the Marker onClick (line 67-69):

```typescript
onClick={(e) => {
  e.originalEvent.stopPropagation();
  setSelected(m);
}}
```

Update the Popup section (replace lines 80-105) — show on `selected` instead of `hovered`, include a "View Dashboard" button:

```tsx
{selected && (
  <Popup
    longitude={selected.lng}
    latitude={selected.lat}
    anchor="bottom"
    offset={12}
    closeButton={true}
    closeOnClick={false}
    onClose={() => setSelected(null)}
    className="field-marker-popup"
  >
    <div className="text-xs px-1 py-1 space-y-1">
      <p className="font-semibold text-nav-dark">{selected.field_name}</p>
      {selected.total_acres && (
        <p className="text-secondary">{selected.total_acres.toLocaleString()} acres</p>
      )}
      {selected.crop_type && (
        <p className="text-secondary capitalize">{selected.crop_type}</p>
      )}
      {selected.customer_name && (
        <p className="text-secondary">{selected.customer_name}</p>
      )}
      <button
        onClick={() => onFieldClick?.(selected.id)}
        className="mt-1 text-xs font-medium text-crx-green hover:underline"
      >
        View Dashboard →
      </button>
    </div>
  </Popup>
)}
```

Keep the hover behavior for the green dot (onMouseEnter/onMouseLeave) but show a simple tooltip, not the full popup.

**Step 2: Add click handler to FieldBoundaryLayer**

In `src/components/map/FieldBoundaryLayer.tsx`, add an `onFieldClick` prop:

```typescript
interface FieldBoundaryLayerProps {
  fields: FieldWithCustomer[];
  showLabels?: boolean;
  onFieldClick?: (fieldId: string) => void;
}
```

Add a click handler to the fill layer by using `useMap` from react-map-gl:

```typescript
import { Source, Layer, useMap } from 'react-map-gl/mapbox';
import { useEffect } from 'react';
```

Inside the component, after the geojson memo:

```typescript
const { current: map } = useMap();

useEffect(() => {
  if (!map || !onFieldClick) return;
  const handler = (e: mapboxgl.MapMouseEvent) => {
    const features = map.queryRenderedFeatures(e.point, {
      layers: ['field-boundaries-fill'],
    });
    if (features && features.length > 0) {
      const id = features[0].properties?.id;
      if (id) onFieldClick(id);
    }
  };
  map.on('click', 'field-boundaries-fill', handler);
  // Change cursor on hover
  map.on('mouseenter', 'field-boundaries-fill', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'field-boundaries-fill', () => {
    map.getCanvas().style.cursor = '';
  });
  return () => {
    map.off('click', 'field-boundaries-fill', handler);
  };
}, [map, onFieldClick]);
```

**Step 3: Update Fields.tsx to handle click-to-zoom**

In `src/pages/Fields.tsx`, update the `FieldMarkerLayer` and `FieldBoundaryLayer` usage in the map view. Instead of navigating directly, set a selected field and zoom:

```tsx
const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);

const selectedFieldBounds = useMemo(() => {
  if (!selectedFieldId) return null;
  const f = filtered.find((f) => f.id === selectedFieldId);
  if (!f) return null;
  return computeBounds([f.boundary_geojson, f.centroid_geojson]);
}, [selectedFieldId, filtered]);
```

Update the CRXMap bounds prop to use selectedFieldBounds when a field is selected, otherwise mapBounds:

```tsx
<CRXMap
  className="h-[500px] w-full rounded-lg overflow-hidden"
  showLayerToggle
  showLocateMe
  bounds={selectedFieldBounds || mapBounds}
  boundsOptions={selectedFieldBounds ? { padding: 80, maxZoom: 16 } : undefined}
>
  <FieldBoundaryLayer
    fields={filtered}
    onFieldClick={(id) => setSelectedFieldId(id)}
  />
  <FieldMarkerLayer
    fields={filtered}
    onFieldClick={(id) => navigate(`/fields/${id}/dashboard`)}
  />
</CRXMap>
```

Import `computeBounds`:

```typescript
import { useFitBounds, computeBounds } from '../hooks/useFitBounds';
```

**Step 4: Run build + tests**

Run: `cd /c/Users/mason/CRX_Manager_V1.0 && npx tsc --noEmit && npx vitest run`
Expected: All pass

**Step 5: Commit**

```bash
git add src/components/map/FieldMarkerLayer.tsx src/components/map/FieldBoundaryLayer.tsx src/pages/Fields.tsx
git commit -m "feat(fields): click-to-zoom on map markers and boundary polygons"
```

---

## Phase 2: Multi-Polygon Infrastructure (DB)

### Task 7: Migration — `parent_field_id` + `field_polygons` table + RPCs

**Files:**
- Create: `supabase/migrations/20260334900000_field_grouping_multi_polygon.sql`

**Step 1: Write the migration**

Use the `create-migration` skill to create the migration file. The SQL must include:

```sql
-- Field Management V3: parent/child grouping + multi-polygon support

-- 1. Add parent_field_id column
ALTER TABLE fields
  ADD COLUMN IF NOT EXISTS parent_field_id uuid REFERENCES fields(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_fields_parent_id
  ON fields(parent_field_id) WHERE parent_field_id IS NOT NULL;

-- Prevent circular: a child cannot be a parent
ALTER TABLE fields
  ADD CONSTRAINT chk_no_circular_parent
  CHECK (parent_field_id IS DISTINCT FROM id);

-- 2. Create field_polygons table
CREATE TABLE IF NOT EXISTS field_polygons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  field_id uuid NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  polygon_geojson jsonb NOT NULL,
  label text,
  acres numeric(12,2),
  sort_order int DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_field_polygons_field_id ON field_polygons(field_id);

ALTER TABLE field_polygons ENABLE ROW LEVEL SECURITY;

CREATE POLICY field_polygons_select ON field_polygons FOR SELECT
  USING (field_id IN (SELECT id FROM fields));

CREATE POLICY field_polygons_insert ON field_polygons FOR INSERT
  WITH CHECK (field_id IN (SELECT id FROM fields));

CREATE POLICY field_polygons_update ON field_polygons FOR UPDATE
  USING (field_id IN (SELECT id FROM fields));

CREATE POLICY field_polygons_delete ON field_polygons FOR DELETE
  USING (field_id IN (SELECT id FROM fields));

-- 3. save_field_polygons RPC
CREATE OR REPLACE FUNCTION save_field_polygons(
  p_field_id uuid,
  p_polygons jsonb,           -- array of {polygon_geojson, label, acres, sort_order}
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_existing jsonb;
  v_poly jsonb;
  v_total_acres numeric := 0;
  v_first_geojson jsonb;
  v_first_centroid text;
BEGIN
  PERFORM require_admin_or_sales_rep();

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;

  -- Delete existing polygons for this field
  DELETE FROM field_polygons WHERE field_id = p_field_id;

  -- Insert new polygons
  FOR v_poly IN SELECT * FROM jsonb_array_elements(p_polygons)
  LOOP
    INSERT INTO field_polygons (field_id, polygon_geojson, label, acres, sort_order)
    VALUES (
      p_field_id,
      v_poly->'polygon_geojson',
      v_poly->>'label',
      (v_poly->>'acres')::numeric,
      COALESCE((v_poly->>'sort_order')::int, 0)
    );
    v_total_acres := v_total_acres + COALESCE((v_poly->>'acres')::numeric, 0);
  END LOOP;

  -- Update field total_acres from polygon sum
  UPDATE fields SET total_acres = v_total_acres, updated_at = now()
  WHERE id = p_field_id;

  -- Update boundary from first polygon (for backward compat)
  SELECT polygon_geojson INTO v_first_geojson
  FROM field_polygons WHERE field_id = p_field_id
  ORDER BY sort_order LIMIT 1;

  IF v_first_geojson IS NOT NULL THEN
    UPDATE fields SET
      boundary = ST_GeogFromGeoJSON(v_first_geojson::text),
      centroid = ST_Centroid(ST_GeogFromGeoJSON(v_first_geojson::text)::geometry)::geography,
      updated_at = now()
    WHERE id = p_field_id;
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'save_field_polygons', '{}'::text);
  END IF;
END;
$$;

-- 4. link_fields_to_parent RPC
CREATE OR REPLACE FUNCTION link_fields_to_parent(
  p_parent_id uuid,
  p_child_ids uuid[],
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing jsonb;
  v_parent_is_child boolean;
BEGIN
  PERFORM require_admin_or_sales_rep();

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;

  -- Validate parent is not itself a child
  SELECT EXISTS(SELECT 1 FROM fields WHERE id = p_parent_id AND parent_field_id IS NOT NULL)
    INTO v_parent_is_child;
  IF v_parent_is_child THEN
    RAISE EXCEPTION 'Cannot use a child field as a parent';
  END IF;

  -- Link children
  UPDATE fields SET parent_field_id = p_parent_id, updated_at = now()
  WHERE id = ANY(p_child_ids) AND id != p_parent_id;

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'link_fields_to_parent', '{}'::text);
  END IF;
END;
$$;

-- 5. unlink_field_from_parent RPC
CREATE OR REPLACE FUNCTION unlink_field_from_parent(
  p_field_id uuid,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing jsonb;
BEGIN
  PERFORM require_admin_or_sales_rep();

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;

  UPDATE fields SET parent_field_id = NULL, updated_at = now()
  WHERE id = p_field_id;

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'unlink_field_from_parent', '{}'::text);
  END IF;
END;
$$;

-- 6. Update get_fields_with_geojson to include parent_field_id + child_count
CREATE OR REPLACE FUNCTION get_fields_with_geojson(p_customer_id uuid DEFAULT NULL)
RETURNS TABLE(
  id uuid, customer_id uuid, field_name text, legal_description text,
  county text, state text, total_acres numeric,
  fsa_farm_number text, fsa_tract_number text, fsa_field_number text,
  crop_type text, soil_type text, irrigation boolean, notes text, is_active boolean,
  centroid_geojson text, boundary_geojson text,
  customer_name text, created_at timestamptz, updated_at timestamptz,
  parent_field_id uuid, child_count bigint
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT
    f.id, f.customer_id, f.field_name, f.legal_description,
    f.county, f.state, f.total_acres,
    f.fsa_farm_number, f.fsa_tract_number, f.fsa_field_number,
    f.crop_type, f.soil_type, f.irrigation, f.notes, f.is_active,
    ST_AsGeoJSON(f.centroid)::text AS centroid_geojson,
    ST_AsGeoJSON(f.boundary)::text AS boundary_geojson,
    c.farm_name AS customer_name,
    f.created_at, f.updated_at,
    f.parent_field_id,
    (SELECT count(*) FROM fields ch WHERE ch.parent_field_id = f.id) AS child_count
  FROM fields f
  LEFT JOIN customers c ON c.id = f.customer_id
  WHERE (p_customer_id IS NULL OR f.customer_id = p_customer_id)
  ORDER BY f.field_name;
$$;

-- 7. get_field_polygons RPC
CREATE OR REPLACE FUNCTION get_field_polygons(p_field_id uuid)
RETURNS TABLE(id uuid, field_id uuid, polygon_geojson jsonb, label text, acres numeric, sort_order int)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT fp.id, fp.field_id, fp.polygon_geojson, fp.label, fp.acres, fp.sort_order
  FROM field_polygons fp
  WHERE fp.field_id = p_field_id
  ORDER BY fp.sort_order;
$$;
```

**Step 2: Apply migration to Supabase**

Use the Supabase MCP `apply_migration` tool.

**Step 3: Verify no overloads**

```sql
SELECT proname, count(*) FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND proname IN ('save_field_polygons', 'link_fields_to_parent', 'unlink_field_from_parent', 'get_field_polygons', 'get_fields_with_geojson')
GROUP BY proname HAVING count(*) > 1;
```

Expected: ZERO rows.

**Step 4: Update TypeScript types**

In `src/types/index.ts`, add after the `Field` interface (around line 1213):

```typescript
export interface FieldPolygon {
  id: string;
  field_id: string;
  polygon_geojson: object;
  label: string | null;
  acres: number | null;
  sort_order: number;
  created_at?: string;
}
```

Add to the `Field` interface:

```typescript
  parent_field_id?: string | null;
```

Add a new extended type:

```typescript
export interface FieldWithGroup extends Field {
  child_count?: number;
  children?: Field[];
  polygons?: FieldPolygon[];
}
```

**Step 5: Run build + tests**

Run: `cd /c/Users/mason/CRX_Manager_V1.0 && npm run build && npx vitest run`
Expected: All pass

**Step 6: Update docs**

- Add migration to `docs/reference/migration-history.md`
- Add `field_polygons` table to `docs/reference/database-schema.md`
- Add new RPCs to `docs/reference/rpc-functions.md`
- Update `CLAUDE.md` migration count

**Step 7: Commit**

```bash
git add supabase/migrations/20260334900000_field_grouping_multi_polygon.sql src/types/index.ts docs/
git commit -m "feat(fields): add parent/child grouping + field_polygons table + RPCs"
```

---

## Phase 3: Multi-Polygon Drawing (Frontend)

### Task 8: Update DrawControl to support multiple polygons

**Files:**
- Modify: `src/components/map/DrawControl.tsx`
- Modify: `src/components/map/DrawLayer.tsx`

**Step 1: Update DrawControl to not delete-all on create**

In `DrawControl.tsx`, the key change is removing the `draw.deleteAll()` call in `loadInitial` that clears everything. Instead, support adding multiple initial features.

Update the `initialGeoJSON` prop type to accept an array:

```typescript
interface DrawControlProps {
  onDrawCreate?: (feature: GeoJSON.Feature) => void;
  onDrawUpdate?: (feature: GeoJSON.Feature) => void;
  onDrawDelete?: (featureIds: string[]) => void;
  initialGeoJSON?: GeoJSON.Feature | GeoJSON.Feature[] | null;
}
```

Update `loadInitial` to handle arrays:

```typescript
const loadInitial = useCallback(() => {
  if (!draw || !initialGeoJSON) return;
  try {
    draw.deleteAll();
    const features = Array.isArray(initialGeoJSON) ? initialGeoJSON : [initialGeoJSON];
    for (const f of features) {
      draw.add(f as unknown as GeoJSON.FeatureCollection);
    }
  } catch {
    // Silently handle invalid GeoJSON
  }
}, [initialGeoJSON, draw]);
```

Update the `draw.delete` handler to pass deleted feature IDs:

```typescript
map.on('draw.delete', (e: { features: GeoJSON.Feature[] }) => {
  onDrawDelete?.(e.features?.map(f => f.id as string) || []);
});
```

**Step 2: Update DrawLayer to support multi-polygon**

Replace `DrawLayer.tsx` with a multi-polygon-aware version:

```typescript
// src/components/map/DrawLayer.tsx
import { useCallback } from 'react';
import area from '@turf/area';
import centroid from '@turf/centroid';
import DrawControl from './DrawControl';
import type { Feature, Polygon } from 'geojson';

export interface DrawnPolygon {
  drawId: string;        // Mapbox Draw feature ID
  polygon: Feature<Polygon>;
  acres: number;
  label: string;
}

interface DrawLayerProps {
  initialPolygons?: DrawnPolygon[];
  onPolygonsChange?: (polygons: DrawnPolygon[]) => void;
  // Legacy single-polygon API (backward compat)
  initialGeoJSON?: Feature<Polygon> | null;
  onBoundaryChange?: (boundary: Feature<Polygon>, acres: number, center: [number, number]) => void;
  onBoundaryDelete?: () => void;
}

export default function DrawLayer({
  initialPolygons,
  onPolygonsChange,
  initialGeoJSON,
  onBoundaryChange,
  onBoundaryDelete,
}: DrawLayerProps) {
  // Determine initial features for DrawControl
  const initialFeatures = initialPolygons
    ? initialPolygons.map(p => p.polygon)
    : initialGeoJSON
    ? [initialGeoJSON]
    : undefined;

  const handleCreate = useCallback((feature: GeoJSON.Feature) => {
    if (feature.geometry.type !== 'Polygon') return;
    const polygon = feature as Feature<Polygon>;
    const sqMeters = area(polygon);
    const acres = Math.round((sqMeters / 4046.8564224) * 100) / 100;
    const center = centroid(polygon);
    const [lng, lat] = center.geometry.coordinates;

    // Multi-polygon mode
    if (onPolygonsChange && initialPolygons) {
      const newPoly: DrawnPolygon = {
        drawId: (feature.id as string) || crypto.randomUUID(),
        polygon,
        acres,
        label: `Polygon ${initialPolygons.length + 1}`,
      };
      onPolygonsChange([...initialPolygons, newPoly]);
      return;
    }

    // Legacy single-polygon mode
    onBoundaryChange?.(polygon, acres, [lng, lat]);
  }, [onPolygonsChange, initialPolygons, onBoundaryChange]);

  const handleUpdate = useCallback((feature: GeoJSON.Feature) => {
    if (feature.geometry.type !== 'Polygon') return;
    const polygon = feature as Feature<Polygon>;
    const sqMeters = area(polygon);
    const acres = Math.round((sqMeters / 4046.8564224) * 100) / 100;
    const center = centroid(polygon);
    const [lng, lat] = center.geometry.coordinates;

    if (onPolygonsChange && initialPolygons) {
      const drawId = feature.id as string;
      const updated = initialPolygons.map(p =>
        p.drawId === drawId ? { ...p, polygon, acres } : p
      );
      onPolygonsChange(updated);
      return;
    }

    onBoundaryChange?.(polygon, acres, [lng, lat]);
  }, [onPolygonsChange, initialPolygons, onBoundaryChange]);

  const handleDelete = useCallback((featureIds: string[]) => {
    if (onPolygonsChange && initialPolygons) {
      const remaining = initialPolygons.filter(p => !featureIds.includes(p.drawId));
      onPolygonsChange(remaining);
      return;
    }
    onBoundaryDelete?.();
  }, [onPolygonsChange, initialPolygons, onBoundaryDelete]);

  return (
    <DrawControl
      initialGeoJSON={initialFeatures && initialFeatures.length > 0 ? initialFeatures : null}
      onDrawCreate={handleCreate}
      onDrawUpdate={handleUpdate}
      onDrawDelete={handleDelete}
    />
  );
}
```

**Step 3: Run build + tests**

Run: `cd /c/Users/mason/CRX_Manager_V1.0 && npx tsc --noEmit && npx vitest run`
Expected: All pass (backward-compatible API)

**Step 4: Commit**

```bash
git add src/components/map/DrawControl.tsx src/components/map/DrawLayer.tsx
git commit -m "feat(map): support multi-polygon drawing in DrawControl + DrawLayer"
```

---

### Task 9: Add polygon list panel to FieldSetup

**Files:**
- Modify: `src/pages/FieldSetup.tsx`

**Step 1: Add multi-polygon state management**

In `FieldSetup.tsx`, add new state for polygons:

```typescript
import type { DrawnPolygon } from '../components/map/DrawLayer';

// After the existing boundaryGeoJSON state:
const [drawnPolygons, setDrawnPolygons] = useState<DrawnPolygon[]>([]);
```

**Step 2: Load existing polygons from DB**

In `fetchField`, after loading boundary GeoJSON, also fetch field_polygons:

```typescript
// After the existing geo fetch, add:
const { data: polyData } = await supabase.rpc('get_field_polygons', { p_field_id: id });
if (polyData && Array.isArray(polyData) && polyData.length > 0) {
  const loaded: DrawnPolygon[] = polyData.map((p: { id: string; polygon_geojson: object; label: string | null; acres: number | null; sort_order: number }, i: number) => ({
    drawId: p.id,
    polygon: { type: 'Feature' as const, properties: {}, geometry: p.polygon_geojson as GeoJSON.Polygon },
    acres: p.acres ?? 0,
    label: p.label || `Polygon ${i + 1}`,
  }));
  setDrawnPolygons(loaded);
}
```

**Step 3: Update DrawLayer usage to multi-polygon mode**

Replace the existing `<DrawLayer>` in the map panel with:

```tsx
<DrawLayer
  initialPolygons={drawnPolygons}
  onPolygonsChange={(polys) => {
    setDrawnPolygons(polys);
    // Auto-update total acres
    const totalAcres = polys.reduce((sum, p) => sum + p.acres, 0);
    update('total_acres', Math.round(totalAcres * 100) / 100);
    // Update map center from first polygon
    if (polys.length > 0) {
      const center = turfCentroid(polys[0].polygon);
      setMapCenter([center.geometry.coordinates[0], center.geometry.coordinates[1]]);
    }
  }}
/>
```

**Step 4: Add polygon list panel below the map**

Below the `<CRXMap>` component, add:

```tsx
{drawnPolygons.length > 0 && (
  <div className="mt-3 space-y-2">
    <p className="text-xs font-medium text-secondary">Drawn Polygons</p>
    {drawnPolygons.map((poly, idx) => (
      <div key={poly.drawId} className="flex items-center gap-3 p-2 border border-gray-100 rounded-lg">
        <div className="w-3 h-3 rounded-full bg-crx-green flex-shrink-0" />
        <input
          type="text"
          value={poly.label}
          onChange={(e) => {
            const updated = [...drawnPolygons];
            updated[idx] = { ...updated[idx], label: e.target.value };
            setDrawnPolygons(updated);
          }}
          className="flex-1 text-sm px-2 py-1 border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-crx-green/30"
          placeholder={`Polygon ${idx + 1}`}
        />
        <span className="text-xs text-secondary whitespace-nowrap">{poly.acres.toFixed(2)} ac</span>
        <button
          onClick={() => setDrawnPolygons(prev => prev.filter((_, i) => i !== idx))}
          className="text-gray-400 hover:text-red-500 p-1"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    ))}
    <div className="flex justify-between text-xs px-2 pt-1 font-medium text-crx-green">
      <span>Total</span>
      <span>{drawnPolygons.reduce((s, p) => s + p.acres, 0).toFixed(2)} acres</span>
    </div>
  </div>
)}
```

**Step 5: Update handleSave to call save_field_polygons**

In the `handleSave` function, after saving the field, replace the existing geometry save block with:

```typescript
// Save polygons if any were drawn
if (drawnPolygons.length > 0 && savedFieldId) {
  const polygonPayload = drawnPolygons.map((p, i) => ({
    polygon_geojson: p.polygon.geometry,
    label: p.label,
    acres: p.acres,
    sort_order: i,
  }));
  const geoIdemKey = saveFieldGeoIdem.getKey();
  const { error: geoError } = await supabase.rpc('save_field_polygons', {
    p_field_id: savedFieldId,
    p_polygons: polygonPayload,
    p_performed_by: profile!.id,
    p_idempotency_key: geoIdemKey,
  });
  if (geoError) {
    Sentry.captureException(geoError, { tags: { source: 'critical_action', action: 'save_field_polygons' } });
    toast('error', 'Field saved but polygons could not be saved.');
  } else {
    saveFieldGeoIdem.resetKey();
  }
} else if (boundaryGeoJSON && savedFieldId) {
  // Legacy single-polygon fallback
  // ... keep existing save_field_geometry code ...
}
```

**Step 6: Run build + tests**

Run: `cd /c/Users/mason/CRX_Manager_V1.0 && npm run build && npx vitest run`
Expected: All pass

**Step 7: Commit**

```bash
git add src/pages/FieldSetup.tsx
git commit -m "feat(fields): multi-polygon drawing UI with polygon list panel in FieldSetup"
```

---

## Phase 4: Field Grouping UI

### Task 10: Tree view in Fields list

**Files:**
- Modify: `src/pages/Fields.tsx`

**Step 1: Update FieldWithCustomer type to include group fields**

```typescript
type FieldWithCustomer = Field & {
  customer_name: string;
  parent_field_id?: string | null;
  child_count?: number;
};
```

**Step 2: Build tree structure from flat list**

After filtering, group fields into parent/child:

```typescript
const { parents, standalone, childMap } = useMemo(() => {
  const childMap = new Map<string, FieldWithCustomer[]>();
  const parentSet = new Set<string>();
  const standalone: FieldWithCustomer[] = [];

  // First pass: identify children and their parents
  for (const f of filtered) {
    if (f.parent_field_id) {
      const siblings = childMap.get(f.parent_field_id) || [];
      siblings.push(f);
      childMap.set(f.parent_field_id, siblings);
    }
  }

  // Second pass: identify parents and standalone
  const parents: FieldWithCustomer[] = [];
  for (const f of filtered) {
    if (f.parent_field_id) continue; // skip children (shown under parent)
    if ((f.child_count && f.child_count > 0) || childMap.has(f.id)) {
      parents.push(f);
    } else {
      standalone.push(f);
    }
  }

  return { parents, standalone, childMap };
}, [filtered]);
```

**Step 3: Add expandable rows to DataTable**

Add state for expanded parents:

```typescript
const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set());
const toggleExpand = (id: string) => {
  setExpandedParents(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
};
```

Build the display list that interleaves parents with their children:

```typescript
const displayRows = useMemo(() => {
  const rows: (FieldWithCustomer & { _isChild?: boolean; _isParent?: boolean })[] = [];
  for (const p of parents) {
    rows.push({ ...p, _isParent: true });
    if (expandedParents.has(p.id)) {
      const children = childMap.get(p.id) || [];
      for (const c of children) {
        rows.push({ ...c, _isChild: true });
      }
    }
  }
  for (const s of standalone) {
    rows.push(s);
  }
  return rows;
}, [parents, standalone, childMap, expandedParents]);
```

Update the field_name column render to show expand/collapse chevron for parents and indent for children:

```typescript
render: (row) => (
  <div className="flex items-center gap-2">
    {row._isParent ? (
      <button
        onClick={(e) => { e.stopPropagation(); toggleExpand(row.id); }}
        className="p-0.5"
      >
        {expandedParents.has(row.id)
          ? <ChevronDown className="w-4 h-4 text-secondary" />
          : <ChevronRight className="w-4 h-4 text-secondary" />
        }
      </button>
    ) : row._isChild ? (
      <span className="w-5 ml-2 border-l-2 border-gray-200 h-4" />
    ) : (
      <MapPin className="w-4 h-4 text-crx-green flex-shrink-0" />
    )}
    <span className="font-medium text-nav-dark">{row.field_name}</span>
    {row._isParent && row.child_count && row.child_count > 0 && (
      <Badge variant="info" className="text-[10px]">{row.child_count} sub-fields</Badge>
    )}
  </div>
),
```

Import `ChevronDown` and `ChevronRight` from lucide-react.

Pass `displayRows` to `DataTable` instead of `filtered`.

**Step 4: Run build**

Run: `cd /c/Users/mason/CRX_Manager_V1.0 && npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add src/pages/Fields.tsx
git commit -m "feat(fields): tree view for parent/child field groups in Fields list"
```

---

### Task 11: "Group as Sub-fields" bulk action

**Files:**
- Modify: `src/pages/Fields.tsx`

**Step 1: Add GroupFieldsModal component**

Create an inline modal component in Fields.tsx (or extract to `src/components/fields/GroupFieldsModal.tsx`):

The modal should:
- Show selected field names
- Radio buttons to pick which field becomes the parent
- "Group" button calls `link_fields_to_parent` RPC
- On success, refresh fields list

**Step 2: Add to bulk actions**

```typescript
const bulkActions = [
  // ...existing CSV, PDF, delete actions...
  {
    key: 'group',
    label: 'Group Fields',
    icon: <Link className="w-4 h-4" />,
    onClick: () => setGroupModalOpen(true),
    disabled: selectedCount < 2,
  },
];
```

**Step 3: Run build + tests**

**Step 4: Commit**

```bash
git add src/pages/Fields.tsx
git commit -m "feat(fields): add Group as Sub-fields bulk action"
```

---

### Task 12: FieldDashboard group aggregate view

**Files:**
- Modify: `src/pages/FieldDashboard.tsx`

**Step 1: Fetch child fields when viewing a parent**

After fetching the dashboard data, check if the field has children:

```typescript
const [children, setChildren] = useState<Field[]>([]);

// In fetchDashboard, after setting data:
if (dashboard.field.child_count && dashboard.field.child_count > 0) {
  const { data: childData } = await supabase
    .rpc('get_fields_with_geojson')
    .then(res => ({
      data: (res.data || []).filter((f: FieldWithCustomer) => f.parent_field_id === id)
    }));
  setChildren(childData);
}
```

**Step 2: Show all children's boundaries on the map**

Pass both parent and children to `FieldBoundaryLayer`:

```tsx
<FieldBoundaryLayer fields={[data.field, ...children]} showLabels />
```

Compute bounds from all fields:

```typescript
const mapBounds = useMemo(() => {
  const allFields = [data.field, ...children];
  const geoStrings = allFields.flatMap(f => [f.boundary_geojson, f.centroid_geojson]);
  return computeBounds(geoStrings as string[]);
}, [data, children]);
```

**Step 3: Show children list in Overview tab**

Add a "Sub-fields" section in the overview tab:

```tsx
{children.length > 0 && (
  <Card className="p-4">
    <h3 className="text-sm font-medium text-secondary mb-3">Sub-fields ({children.length})</h3>
    <div className="space-y-2">
      {children.map(child => (
        <button
          key={child.id}
          onClick={() => navigate(`/fields/${child.id}/dashboard`)}
          className="w-full flex items-center justify-between p-2 rounded-lg hover:bg-gray-50 transition-colors text-left"
        >
          <div className="flex items-center gap-2">
            <MapPin className="w-3.5 h-3.5 text-crx-green" />
            <span className="text-sm font-medium">{child.field_name}</span>
          </div>
          <span className="text-xs text-secondary">{child.total_acres?.toLocaleString() ?? '—'} ac</span>
        </button>
      ))}
    </div>
  </Card>
)}
```

**Step 4: Run build + tests**

Run: `cd /c/Users/mason/CRX_Manager_V1.0 && npm run build && npx vitest run`
Expected: All pass

**Step 5: Commit**

```bash
git add src/pages/FieldDashboard.tsx
git commit -m "feat(fields): show grouped sub-fields and aggregate view in FieldDashboard"
```

---

### Task 13: Update docs and final verification

**Files:**
- Modify: `CLAUDE.md` — update page count, migration count, RPC count, table count
- Modify: `docs/reference/migration-history.md`
- Modify: `docs/reference/rpc-functions.md`
- Modify: `docs/reference/database-schema.md`
- Modify: `docs/CHANGELOG.md`

**Step 1: Update all docs**

Use the `update-docs` skill.

**Step 2: Run full test suite**

```bash
cd /c/Users/mason/CRX_Manager_V1.0
npm run lint
npm run build
npx vitest run
```

Expected: All pass, 0 errors, 0 warnings.

**Step 3: Final commit**

```bash
git add .
git commit -m "docs: update documentation for Field Management V3"
```

---

## Summary

| Phase | Tasks | Key Files |
|-------|-------|-----------|
| 1. Map Intelligence | Tasks 1-6 | `useFitBounds.ts`, `CRXMap.tsx`, `Fields.tsx`, `FieldDashboard.tsx`, `FieldSetup.tsx`, `FieldMarkerLayer.tsx`, `FieldBoundaryLayer.tsx` |
| 2. Multi-Polygon DB | Task 7 | Migration SQL, `types/index.ts` |
| 3. Multi-Polygon UI | Tasks 8-9 | `DrawControl.tsx`, `DrawLayer.tsx`, `FieldSetup.tsx` |
| 4. Field Grouping | Tasks 10-12 | `Fields.tsx`, `FieldDashboard.tsx` |
| 5. Docs | Task 13 | `CLAUDE.md`, reference docs |
