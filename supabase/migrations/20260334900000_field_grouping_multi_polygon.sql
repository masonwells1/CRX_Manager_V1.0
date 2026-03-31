-- Field Management V3: parent/child grouping + multi-polygon support
-- Design doc: docs/plans/2026-03-31-field-management-v3-design.md

-- 1. Add parent_field_id column for field grouping
ALTER TABLE fields
  ADD COLUMN IF NOT EXISTS parent_field_id uuid REFERENCES fields(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_fields_parent_id
  ON fields(parent_field_id) WHERE parent_field_id IS NOT NULL;

-- Prevent self-reference
ALTER TABLE fields
  ADD CONSTRAINT chk_no_self_parent
  CHECK (parent_field_id IS DISTINCT FROM id);

-- 2. Create field_polygons table for multi-polygon support
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

-- 3. save_field_polygons RPC — replaces all polygons for a field
CREATE OR REPLACE FUNCTION save_field_polygons(
  p_field_id uuid,
  p_polygons jsonb,
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
BEGIN
  PERFORM require_admin_or_sales_rep();

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'save_field_polygons');
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

  -- Update boundary from first polygon (backward compat with existing views)
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
    PERFORM save_idempotency(p_idempotency_key, 'save_field_polygons', '{}'::jsonb);
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
    v_existing := check_idempotency(p_idempotency_key, 'link_fields_to_parent');
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;

  -- Validate parent is not itself a child
  SELECT EXISTS(SELECT 1 FROM fields WHERE id = p_parent_id AND parent_field_id IS NOT NULL)
    INTO v_parent_is_child;
  IF v_parent_is_child THEN
    RAISE EXCEPTION 'Cannot use a child field as a parent';
  END IF;

  -- Link children (skip the parent itself)
  UPDATE fields SET parent_field_id = p_parent_id, updated_at = now()
  WHERE id = ANY(p_child_ids) AND id != p_parent_id;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'link_fields_to_parent', '{}'::jsonb);
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
    v_existing := check_idempotency(p_idempotency_key, 'unlink_field_from_parent');
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;

  UPDATE fields SET parent_field_id = NULL, updated_at = now()
  WHERE id = p_field_id;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'unlink_field_from_parent', '{}'::jsonb);
  END IF;
END;
$$;

-- 6. get_field_polygons RPC
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

-- 7. Update get_fields_with_geojson to include parent_field_id + child_count
-- Must DROP first because return type changed (added 2 new columns)
DROP FUNCTION IF EXISTS get_fields_with_geojson(uuid);
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

-- Grant permissions
GRANT EXECUTE ON FUNCTION save_field_polygons(uuid, jsonb, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION link_fields_to_parent(uuid, uuid[], uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION unlink_field_from_parent(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION get_field_polygons(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION get_fields_with_geojson(uuid) TO authenticated;
