-- 20260701214000_get_fields_geojson_by_ids.sql
-- Codex fix-review of F1. The F1 frontend fix routed DispatchBoard + FieldView map
-- geometry through get_fields_with_geojson(), which returns EVERY field's geojson and only
-- filters client-side. Both pages are applicator-accessible (App.tsx allowedRoles), so this
-- OVER-FETCHES all fields into the browser — a regression from the prior id-scoped fetch.
-- (Not a strict access-control leak: the fields RLS SELECT policy already allows
--  admin/sales_rep/applicator to read all fields; but it ships far more data than the map
--  needs and reverses the prior scoping.)
--
-- This adds an id-SCOPED geojson RPC so those pages request ONLY the fields on the caller's
-- visible jobs. Mirrors get_fields_with_geojson (SECDEF SQL fn, search_path incl. extensions
-- for ST_AsGeoJSON) but filters WHERE id = ANY(p_field_ids) and also returns the billable-acre
-- columns the map's billableAcres() reads (measured_acres/override_acres — which
-- get_fields_with_geojson omits). Read-only; anon revoked.

CREATE OR REPLACE FUNCTION public.get_fields_geojson_by_ids(p_field_ids uuid[])
 RETURNS TABLE(
   id uuid, customer_id uuid, field_name text, total_acres numeric,
   measured_acres numeric, override_acres numeric, crop_type text, is_active boolean,
   centroid_geojson text, boundary_geojson text, customer_name text)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
  SELECT f.id, f.customer_id, f.field_name, f.total_acres,
    f.measured_acres, f.override_acres, f.crop_type, f.is_active,
    ST_AsGeoJSON(f.centroid)::text AS centroid_geojson,
    ST_AsGeoJSON(f.boundary)::text AS boundary_geojson,
    c.farm_name AS customer_name
  FROM fields f
  LEFT JOIN customers c ON c.id = f.customer_id
  WHERE f.id = ANY(p_field_ids)
  ORDER BY f.field_name;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_fields_geojson_by_ids(uuid[]) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_fields_geojson_by_ids(uuid[]) TO authenticated, service_role;

-- Verification: single overload; anon has no EXECUTE.
DO $$
DECLARE v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'get_fields_geojson_by_ids';
  IF v_count <> 1 THEN RAISE EXCEPTION 'get_fields_geojson_by_ids overload count is % (expected 1)', v_count; END IF;
  IF has_function_privilege('anon', 'public.get_fields_geojson_by_ids(uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon should not have EXECUTE on get_fields_geojson_by_ids';
  END IF;
END $$;
