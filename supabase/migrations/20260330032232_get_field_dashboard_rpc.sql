-- =============================================================================
-- get_field_dashboard: Returns comprehensive field data for the dashboard page
-- Aggregates field info, season summary, application records, and activity
-- =============================================================================

CREATE OR REPLACE FUNCTION get_field_dashboard(
  p_field_id uuid,
  p_season integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_season integer;
  v_field jsonb;
  v_summary jsonb;
  v_records jsonb;
  v_activity jsonb;
BEGIN
  -- Default to current season (Oct 1 - Sep 30)
  v_season := COALESCE(p_season, current_season());

  -- ─── Field data with customer, geometry, billing defaults ───
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

  -- ─── Season summary stats ───
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

  -- ─── Application records for this field and season ───
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

  -- ─── Recent activity feed entries for this field ───
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
$$;
