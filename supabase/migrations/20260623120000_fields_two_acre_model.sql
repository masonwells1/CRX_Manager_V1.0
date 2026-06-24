-- ============================================================================
-- A1 — Two-acre model on public.fields (measured vs override) + backfill
-- ============================================================================
-- Part of the field-mapping → per-acre-billing build (Track A).
-- Design: docs/roadmap/2026-06-22-PHASE2-field-map-acres-design.md §2.
-- Grounding + refinements: docs/build-loops/field-acre-billing/PHASE0-GROUNDING.md.
--
-- WHAT THIS DOES (additive only — no existing column/RLS/lifecycle change):
--   * Adds measured_acres (server-computed) + override_acres (human-typed billable)
--     + boundary_geom geometry(MultiPolygon,4326) (canonical multi-part geometry
--     for area math) + acres_source (derived label).
--   * Billable acres = COALESCE(override_acres, measured_acres, total_acres).
--     total_acres is KEPT as the legacy fallback (NOT dropped).
--   * Backfills boundary_geom + measured_acres from the existing single `boundary`
--     and (overwriting) from the multi-part `field_polygons` store.
--   * CRITICAL — preserves every existing field's CURRENT billed acres: each
--     already-boundaried field with a total_acres gets override_acres = total_acres,
--     so billable stays IDENTICAL to today. Clearing the override later adopts the
--     server-measured number. (A naive backfill would silently re-measure and change
--     bills — Codex CRITICAL #1.)
--
-- DESIGN DEVIATION (folding Codex's anti-drift recommendation): acres_source is a
--   GENERATED column (derived from override/measured), NOT a plain writable column
--   with a CHECK. This makes it impossible to drift and means no RPC ever writes it.
--
-- PROOF: applied + asserted on a local PostGIS 3.3 scaffold (container crx-fa-proof);
--   NOT applied to prod (owner's live-apply gate). See PHASE0-GROUNDING.md.
-- Geometry types are unqualified (geometry/geography) per the existing convention
--   (20260213000000); the apply context must include `extensions` in search_path.
-- ============================================================================

-- 1) New columns (additive). measured/override mirror total_acres precision (numeric(10,2)).
ALTER TABLE public.fields ADD COLUMN IF NOT EXISTS measured_acres numeric(10,2);   -- server-computed; never client-trusted
ALTER TABLE public.fields ADD COLUMN IF NOT EXISTS override_acres numeric(10,2);   -- human-typed billable acres; NULL = use measured
ALTER TABLE public.fields ADD COLUMN IF NOT EXISTS boundary_geom geometry(MultiPolygon,4326); -- canonical full-field geometry for ST_Area

-- acres_source: derived (GENERATED) so it can never drift and no RPC writes it.
ALTER TABLE public.fields ADD COLUMN IF NOT EXISTS acres_source text
  GENERATED ALWAYS AS (
    CASE
      WHEN override_acres IS NOT NULL THEN 'override'
      WHEN measured_acres IS NOT NULL THEN 'measured'
      ELSE 'legacy'
    END
  ) STORED;

COMMENT ON COLUMN public.fields.measured_acres IS 'Server-measured acres from boundary_geom (set ONLY by set_field_boundary). Never client-trusted.';
COMMENT ON COLUMN public.fields.override_acres IS 'Human-typed billable acres (set by set_field_override_acres). NULL = bill on measured_acres. Survives a redraw.';
COMMENT ON COLUMN public.fields.boundary_geom IS 'Canonical full-field MultiPolygon (4326) for server-side ST_Area. Legacy geography(POLYGON) boundary kept for back-compat.';
COMMENT ON COLUMN public.fields.acres_source IS 'Derived label: override | measured | legacy. GENERATED — never written directly.';

-- 2) Spatial index for dedupe / overlap (find_overlapping_fields, A2).
CREATE INDEX IF NOT EXISTS idx_fields_boundary_geom ON public.fields USING GIST (boundary_geom);

-- 3) Backfill (one-time). Robust geometry normalization per Codex CRITICAL #2:
--    Force2D -> set SRID 4326 -> MakeValid -> CollectionExtract(polygons) -> UnaryUnion -> Multi.
--    ST_MakeValid can emit lines/GeometryCollections, so a bare ST_Multi(ST_MakeValid(...)) is unsafe.

-- 3a) Single-boundary fields: derive boundary_geom from the existing geography(POLYGON) boundary.
UPDATE public.fields f
SET boundary_geom = ST_Multi(
      ST_CollectionExtract(
        ST_UnaryUnion(
          ST_MakeValid(ST_Force2D(ST_SetSRID(f.boundary::geometry, 4326)))
        ), 3)
    )
WHERE f.boundary IS NOT NULL
  AND f.boundary_geom IS NULL;

-- 3b) Multi-part fields: OVERWRITE boundary_geom with the union of all field_polygons parts
--     (the single `boundary` only holds the largest ring — Codex HIGH: overwrite, don't gate on NULL).
--     polygon_geojson stores a geometry-shaped GeoJSON (as save_field_polygons feeds ST_GeomFromGeoJSON).
UPDATE public.fields f
SET boundary_geom = sub.geom
FROM (
  SELECT fp.field_id,
         ST_Multi(
           ST_CollectionExtract(
             ST_UnaryUnion(
               ST_MakeValid(ST_Force2D(ST_SetSRID(ST_Collect(ST_GeomFromGeoJSON(fp.polygon_geojson::text)), 4326)))
             ), 3)
         ) AS geom
  FROM public.field_polygons fp
  GROUP BY fp.field_id
) sub
WHERE f.id = sub.field_id
  AND sub.geom IS NOT NULL
  AND NOT ST_IsEmpty(sub.geom);

-- 3c) measured_acres from the FINAL boundary_geom (Codex HIGH: measure the cleaned geom, geodesic m^2 -> acres).
UPDATE public.fields f
SET measured_acres = round((ST_Area(f.boundary_geom::geography) / 4046.8564224)::numeric, 2)
WHERE f.boundary_geom IS NOT NULL;

-- 3d) CRITICAL — preserve current bills: existing boundaried fields that already have a
--     total_acres keep billing that exact number (override_acres = total_acres). Without this,
--     billable would silently switch from total_acres to the freshly-measured number.
UPDATE public.fields f
SET override_acres = f.total_acres
WHERE f.boundary_geom IS NOT NULL
  AND f.total_acres IS NOT NULL
  AND f.override_acres IS NULL;
-- (Boundaried fields with NO prior total_acres adopt measured as the default — acres_source='measured',
--  billable = measured. Non-boundaried legacy fields keep billing total_acres via the COALESCE fallback.)
