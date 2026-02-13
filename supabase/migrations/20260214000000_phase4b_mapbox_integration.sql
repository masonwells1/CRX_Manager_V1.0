-- Phase 4B: Mapbox Map Integration
-- Adds RPCs for reading/writing PostGIS geography data as GeoJSON,
-- and latitude/longitude columns to customer_addresses for future delivery mapping.

-- ============================================================
-- 1. Add latitude/longitude to customer_addresses
-- ============================================================

ALTER TABLE customer_addresses
  ADD COLUMN IF NOT EXISTS latitude double precision,
  ADD COLUMN IF NOT EXISTS longitude double precision;

-- ============================================================
-- 2. RPC: get_fields_with_geojson
--    Returns fields with centroid/boundary as GeoJSON text strings
--    (PostgREST returns geography columns as hex WKB, not usable)
-- ============================================================

CREATE OR REPLACE FUNCTION get_fields_with_geojson(p_customer_id uuid DEFAULT NULL)
RETURNS TABLE (
  id uuid,
  customer_id uuid,
  field_name text,
  legal_description text,
  county text,
  state text,
  total_acres numeric,
  fsa_farm_number text,
  fsa_tract_number text,
  fsa_field_number text,
  crop_type text,
  soil_type text,
  irrigation boolean,
  notes text,
  is_active boolean,
  centroid_geojson text,
  boundary_geojson text,
  customer_name text,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT
    f.id,
    f.customer_id,
    f.field_name,
    f.legal_description,
    f.county,
    f.state,
    f.total_acres,
    f.fsa_farm_number,
    f.fsa_tract_number,
    f.fsa_field_number,
    f.crop_type,
    f.soil_type,
    f.irrigation,
    f.notes,
    f.is_active,
    ST_AsGeoJSON(f.centroid)::text AS centroid_geojson,
    ST_AsGeoJSON(f.boundary)::text AS boundary_geojson,
    c.farm_name AS customer_name,
    f.created_at,
    f.updated_at
  FROM fields f
  LEFT JOIN customers c ON c.id = f.customer_id
  WHERE (p_customer_id IS NULL OR f.customer_id = p_customer_id)
  ORDER BY f.field_name;
$$;

-- ============================================================
-- 3. RPC: get_field_geojson
--    Returns geojson for a single field (used by FieldDetail page)
-- ============================================================

CREATE OR REPLACE FUNCTION get_field_geojson(p_field_id uuid)
RETURNS TABLE (
  centroid_geojson text,
  boundary_geojson text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT
    ST_AsGeoJSON(f.centroid)::text,
    ST_AsGeoJSON(f.boundary)::text
  FROM fields f
  WHERE f.id = p_field_id;
$$;

-- ============================================================
-- 4. RPC: save_field_geometry
--    Saves centroid and/or boundary from GeoJSON strings
--    Separate from save_field() to avoid breaking existing code
-- ============================================================

CREATE OR REPLACE FUNCTION save_field_geometry(
  p_field_id uuid,
  p_centroid_geojson text DEFAULT NULL,
  p_boundary_geojson text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  UPDATE fields SET
    centroid = CASE
      WHEN p_centroid_geojson IS NOT NULL THEN ST_GeogFromGeoJSON(p_centroid_geojson)
      ELSE centroid
    END,
    boundary = CASE
      WHEN p_boundary_geojson IS NOT NULL THEN ST_GeogFromGeoJSON(p_boundary_geojson)
      ELSE boundary
    END,
    updated_at = now()
  WHERE id = p_field_id;
END;
$$;
