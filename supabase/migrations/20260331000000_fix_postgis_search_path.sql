-- Fix: Add 'extensions' schema to search_path for all PostGIS-using functions
-- Bug: SECURITY DEFINER functions had search_path = 'public', 'pg_temp' only,
--       but PostGIS (ST_AsGeoJSON, ST_GeogFromGeoJSON) lives in 'extensions' schema.
--       This caused 404 errors on the Fields page (get_fields_with_geojson failed).

-- 1. get_fields_with_geojson
CREATE OR REPLACE FUNCTION public.get_fields_with_geojson(p_customer_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, customer_id uuid, field_name text, legal_description text, county text, state text, total_acres numeric, fsa_farm_number text, fsa_tract_number text, fsa_field_number text, crop_type text, soil_type text, irrigation boolean, notes text, is_active boolean, centroid_geojson text, boundary_geojson text, customer_name text, created_at timestamp with time zone, updated_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
  SELECT
    f.id, f.customer_id, f.field_name, f.legal_description,
    f.county, f.state, f.total_acres,
    f.fsa_farm_number, f.fsa_tract_number, f.fsa_field_number,
    f.crop_type, f.soil_type, f.irrigation, f.notes, f.is_active,
    ST_AsGeoJSON(f.centroid)::text AS centroid_geojson,
    ST_AsGeoJSON(f.boundary)::text AS boundary_geojson,
    c.farm_name AS customer_name,
    f.created_at, f.updated_at
  FROM fields f
  LEFT JOIN customers c ON c.id = f.customer_id
  WHERE (p_customer_id IS NULL OR f.customer_id = p_customer_id)
  ORDER BY f.field_name;
$function$;

-- 2. get_field_geojson
CREATE OR REPLACE FUNCTION public.get_field_geojson(p_field_id uuid)
 RETURNS TABLE(centroid_geojson text, boundary_geojson text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
  SELECT
    ST_AsGeoJSON(f.centroid)::text,
    ST_AsGeoJSON(f.boundary)::text
  FROM fields f
  WHERE f.id = p_field_id;
$function$;

-- 3. save_field_geometry
CREATE OR REPLACE FUNCTION public.save_field_geometry(p_field_id uuid, p_centroid_geojson text DEFAULT NULL::text, p_boundary_geojson text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_existing jsonb;
BEGIN
  PERFORM require_admin_or_sales_rep();
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'save_field_geometry');
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;
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
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'save_field_geometry', '{}'::jsonb);
  END IF;
END;
$function$;

-- 4. get_field_dashboard
CREATE OR REPLACE FUNCTION public.get_field_dashboard(p_field_id uuid, p_season integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_season integer;
  v_field jsonb;
  v_summary jsonb;
  v_records jsonb;
  v_activity jsonb;
BEGIN
  v_season := COALESCE(p_season, current_season());

  SELECT jsonb_build_object(
    'id', f.id,
    'customer_id', f.customer_id,
    'field_name', f.field_name,
    'legal_description', f.legal_description,
    'county', f.county,
    'state', f.state,
    'total_acres', f.total_acres,
    'crop_type', f.crop_type,
    'soil_type', f.soil_type,
    'irrigation', f.irrigation,
    'fsa_farm_number', f.fsa_farm_number,
    'fsa_tract_number', f.fsa_tract_number,
    'fsa_field_number', f.fsa_field_number,
    'notes', f.notes,
    'is_active', f.is_active,
    'centroid_geojson', ST_AsGeoJSON(f.centroid)::text,
    'boundary_geojson', ST_AsGeoJSON(f.boundary)::text,
    'created_at', f.created_at,
    'updated_at', f.updated_at,
    'customer_name', c.farm_name,
    'billing_defaults', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', bd.id,
        'customer_id', bd.customer_id,
        'split_pct', bd.split_pct,
        'is_primary', bd.is_primary,
        'notes', bd.notes,
        'price_override_cents', bd.price_override_cents,
        'pricing_note', bd.pricing_note,
        'customer_name', bc.farm_name
      ) ORDER BY bd.is_primary DESC, bc.farm_name)
      FROM field_billing_defaults bd
      JOIN customers bc ON bc.id = bd.customer_id
      WHERE bd.field_id = f.id
    ), '[]'::jsonb)
  ) INTO v_field
  FROM fields f
  LEFT JOIN customers c ON c.id = f.customer_id
  WHERE f.id = p_field_id;

  IF v_field IS NULL THEN
    RAISE EXCEPTION 'Field not found: %', p_field_id;
  END IF;

  SELECT jsonb_build_object(
    'total_applications', count(*)::integer,
    'total_acres_treated', COALESCE(sum(ar.total_acres), 0),
    'distinct_products', COALESCE((
      SELECT count(DISTINCT elem->>'product_name')::integer
      FROM application_records ar2,
           jsonb_array_elements(ar2.product_data) elem
      WHERE ar2.field_id = p_field_id AND ar2.season = v_season
    ), 0),
    'season', v_season
  ) INTO v_summary
  FROM application_records ar
  WHERE ar.field_id = p_field_id AND ar.season = v_season;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', ar.id,
    'record_number', ar.record_number,
    'application_date', ar.application_date,
    'application_time', ar.application_time,
    'total_acres', ar.total_acres,
    'total_volume', ar.total_volume,
    'total_volume_unit', ar.total_volume_unit,
    'product_data', ar.product_data,
    'weather_conditions', ar.weather_conditions,
    'notes', ar.notes,
    'source_type', ar.source_type,
    'source_id', ar.source_id,
    'applicator_name', COALESCE(p.full_name, 'Unknown'),
    'vehicle_name', v.vehicle_name
  ) ORDER BY ar.application_date DESC, ar.application_time DESC), '[]'::jsonb)
  INTO v_records
  FROM application_records ar
  LEFT JOIN profiles p ON p.id = ar.applicator_id
  LEFT JOIN vehicles v ON v.id = ar.vehicle_id
  WHERE ar.field_id = p_field_id AND ar.season = v_season;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', af.id,
    'event_type', af.event_type,
    'description', af.description,
    'performed_by_name', COALESCE(p.full_name, 'System'),
    'created_at', af.created_at
  ) ORDER BY af.created_at DESC), '[]'::jsonb)
  INTO v_activity
  FROM (
    SELECT * FROM activity_feed
    WHERE related_entity_type = 'field' AND related_entity_id = p_field_id
    ORDER BY created_at DESC
    LIMIT 10
  ) af
  LEFT JOIN profiles p ON p.id = af.performed_by;

  RETURN jsonb_build_object(
    'field', v_field,
    'season_summary', v_summary,
    'application_records', v_records,
    'recent_activity', v_activity
  );
END;
$function$;
