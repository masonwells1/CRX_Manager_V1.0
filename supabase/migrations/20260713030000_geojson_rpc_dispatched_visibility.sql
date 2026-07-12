-- ChemMan parity follow-up: map-page field geometry for location-dispatched crews.
--
-- get_job_fields_with_geojson gated visibility on jobs_select only (admin /
-- sales / the assigned applicator), so an applicator who sees the job through a
-- LOCATION DISPATCH (jobs_select_location_dispatchee → _is_dispatched_to_me)
-- got an empty result: JobFieldMap and the printed map pages rendered blank for
-- exactly the crew members the maps are for. Add the dispatch path so the RPC's
-- gate matches the full jobs SELECT breadth.
--
-- Body below is a deliberate full re-emit checked line-by-line against the
-- LIVE definition on 2026-07-11 (the live body is newer than any disk file —
-- it carries the Codex post-fix P2 boundary_geom fallback). Only change: the
-- `_is_dispatched_to_me` arm in the visibility gate.

CREATE OR REPLACE FUNCTION public.get_job_fields_with_geojson(p_job_id uuid)
 RETURNS TABLE(id uuid, customer_id uuid, field_name text, total_acres numeric, measured_acres numeric, override_acres numeric, centroid_geojson text, boundary_geojson text, sort_order integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
  SELECT
    f.id, f.customer_id, f.field_name, f.total_acres,
    -- Two-acre model (migration 20260623120000): the map's billable-acre label uses
    -- override ?? measured ?? total. Carry both so the label isn't stale legacy acres.
    f.measured_acres, f.override_acres,
    ST_AsGeoJSON(f.centroid)::text  AS centroid_geojson,
    -- Codex post-fix P2: fields.boundary_geom is the CANONICAL full-field MultiPolygon
    -- (set by set_field_boundary; multi-part fields union all field_polygons parts into
    -- it). The legacy geography(POLYGON) `boundary` holds only the first/single part, so
    -- using it would silently drop the other parts of a multi-part field on the map.
    -- Prefer boundary_geom; fall back to the legacy boundary only when geom is absent.
    ST_AsGeoJSON(COALESCE(f.boundary_geom, f.boundary::geometry))::text AS boundary_geojson,
    jf.sort_order
  FROM public.job_fields jf
  JOIN public.fields f ON f.id = jf.field_id
  WHERE jf.job_id = p_job_id
    -- Same visibility gate as the jobs SELECT policies: admin / sales_rep / the
    -- assigned applicator (jobs_select) OR a location-dispatched crew member
    -- (jobs_select_location_dispatchee).
    AND EXISTS (
      SELECT 1 FROM public.jobs j
      WHERE j.id = p_job_id
        AND (
          is_admin()
          OR is_sales_rep()
          OR (is_applicator() AND j.applicator_id = (SELECT auth.uid()))
          OR _is_dispatched_to_me(j.id)
        )
    )
  ORDER BY jf.sort_order NULLS LAST, f.field_name;
$function$;
