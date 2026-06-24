-- ============================================================================
-- A2 — Server-authoritative acreage RPCs (the missing safety floor)
-- ============================================================================
-- Part of the field-mapping → per-acre-billing build (Track A).
-- Design: docs/roadmap/2026-06-22-PHASE2-field-map-acres-design.md §4.
-- Grounding + refinements: docs/build-loops/field-acre-billing/PHASE0-GROUNDING.md.
-- Depends on: 20260623120000 (the two-acre columns).
--
-- Three functions, all SECURITY DEFINER + SET search_path = public, extensions, pg_temp
-- (PostGIS lives in `extensions`), authenticated-only, in-body admin/sales gate:
--   * set_field_boundary       — the ONLY writer of fields.measured_acres / boundary_geom.
--   * set_field_override_acres — sets/clears the human billable override.
--   * find_overlapping_fields  — read-only >80% overlap dedupe for import.
--
-- INPUT CONTRACT (Codex CRITICAL #4): p_boundary_geojson is a GeoJSON GEOMETRY
--   (Polygon or MultiPolygon), NOT a Feature/FeatureCollection — ST_GeomFromGeoJSON
--   only accepts a geometry. Callers (FieldSetup draw / BulkFieldImport) extract/combine
--   the geometry before calling.
--
-- GEOMETRY NORMALIZATION (Codex CRITICAL #2): a bare ST_Multi(ST_MakeValid(...)) is unsafe
--   (MakeValid can emit lines/GeometryCollections), so every entry uses:
--   Force2D → SetSRID(4326) → MakeValid → CollectionExtract(3) → UnaryUnion → Multi,
--   then reject anything that is not a non-empty MultiPolygon.
--
-- Tables referenced unqualified (resolved via search_path=public) per the codebase
-- convention. PROVEN on a local PostGIS 3.3 scaffold; NOT applied to prod (owner gate).
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────
-- set_field_boundary
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_field_boundary(
  p_field_id uuid,
  p_boundary_geojson text,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_actor    uuid := auth.uid();
  v_existing jsonb;
  v_customer uuid;
  v_override numeric;
  v_geom     geometry;
  v_mpoly    geometry(MultiPolygon,4326);
  v_largest  geometry;
  v_measured numeric;
  v_billable numeric;
  v_result   jsonb;
BEGIN
  -- 1) strict-actor + role gate (source-verifiable inline binding + the project role helper)
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  PERFORM require_admin_or_sales_rep();

  -- 2) lock the field row (serialize concurrent boundary writes), then claim idempotency in the lock
  SELECT customer_id, override_acres INTO v_customer, v_override
  FROM fields WHERE id = p_field_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FIELD_NOT_FOUND: %', p_field_id; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing FROM idempotency_keys
    WHERE idempotency_key = p_idempotency_key AND operation = 'set_field_boundary';
    IF FOUND THEN RETURN v_existing; END IF;
  END IF;

  -- 3) parse + normalize geometry (contract: a Polygon/MultiPolygon geometry GeoJSON)
  v_geom := ST_GeomFromGeoJSON(p_boundary_geojson);
  v_geom := ST_Force2D(v_geom);
  v_geom := ST_SetSRID(v_geom, 4326);
  IF NOT ST_IsValid(v_geom) THEN v_geom := ST_MakeValid(v_geom); END IF;
  v_geom := ST_UnaryUnion(ST_CollectionExtract(v_geom, 3));   -- polygons only, dissolve overlaps
  v_mpoly := ST_Multi(v_geom);
  IF v_mpoly IS NULL OR ST_IsEmpty(v_mpoly) OR GeometryType(v_mpoly) <> 'MULTIPOLYGON' THEN
    RAISE EXCEPTION 'INVALID_GEOMETRY: boundary did not resolve to a polygon';
  END IF;

  -- 4) geodesic measure (m^2 -> acres), 2dp
  v_measured := round((ST_Area(v_mpoly::geography) / 4046.8564224)::numeric, 2);

  -- 5) sanity band — stop a fat-fingered / self-intersecting polygon minting a bad bill
  IF v_measured < 0.1 OR v_measured > 5000 THEN
    RAISE EXCEPTION 'AREA_OUT_OF_BAND: measured % ac (allowed 0.1-5000). Split the field or set an explicit override.', v_measured;
  END IF;

  -- 6) legacy single boundary = the largest part (a MultiPolygon cannot cast to geography(POLYGON))
  SELECT d.geom INTO v_largest
  FROM (SELECT (ST_Dump(v_mpoly)).geom AS geom) d
  ORDER BY ST_Area(d.geom::geography) DESC
  LIMIT 1;

  -- 7) write. acres_source is GENERATED — never written here. total_acres mirrors billable so
  --    legacy readers (that still read total_acres directly) stay correct until B2 threads precedence.
  v_billable := COALESCE(v_override, v_measured);
  PERFORM set_config('app.acre_authority_write', 'on', true);   -- authorize the authority-column write
  UPDATE fields
  SET boundary_geom  = v_mpoly,
      boundary       = v_largest::geography,
      centroid       = ST_Centroid(v_mpoly)::geography,
      measured_acres = v_measured,
      total_acres    = v_billable,
      updated_at     = now()
  WHERE id = p_field_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'FIELD_NOT_FOUND: %', p_field_id; END IF;
  PERFORM set_config('app.acre_authority_write', 'off', true);

  -- 7b) keep the legacy field_polygons editing store (read by get_field_polygons in FieldSetup)
  --     in sync with the new boundary — regenerate one row per part so the map editor never
  --     reopens stale polygons. (Labels are not carried across a boundary replacement.)
  DELETE FROM field_polygons WHERE field_id = p_field_id;
  INSERT INTO field_polygons (field_id, polygon_geojson, acres, sort_order)
  SELECT p_field_id,
         ST_AsGeoJSON(d.geom)::jsonb,
         round((ST_Area(d.geom::geography) / 4046.8564224)::numeric, 2),
         (d.path)[1] - 1
  FROM ST_Dump(v_mpoly) d;

  -- 8) audit (table is activity_feed, NOT activity_log)
  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('field_acres_changed',
          'Boundary set: measured ' || v_measured || ' ac (billable ' || v_billable || ')',
          v_actor, 'field', p_field_id, v_customer);

  v_result := jsonb_build_object(
    'field_id', p_field_id,
    'measured_acres', v_measured,
    'billable_acres', v_billable,
    'acres_source', CASE WHEN v_override IS NOT NULL THEN 'override' ELSE 'measured' END
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'set_field_boundary', v_result)
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_field_boundary(uuid, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_field_boundary(uuid, text, uuid, text) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- set_field_override_acres  (NULL clears -> reverts to measured)
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_field_override_acres(
  p_field_id uuid,
  p_override_acres numeric,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_actor    uuid := auth.uid();
  v_existing jsonb;
  v_customer uuid;
  v_measured numeric;
  v_total    numeric;
  v_override numeric := round(p_override_acres, 2);   -- validate/store at the column's numeric(10,2) precision
  v_billable numeric;
  v_result   jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  PERFORM require_admin_or_sales_rep();

  -- validate at STORED precision (numeric(10,2)): NULL clears; otherwise must round to >= 0.01
  -- (so 0.004 -> 0.00 is rejected, not silently stored as zero) and <= 5000 (1000x-typo guard).
  IF v_override IS NOT NULL AND (v_override <= 0 OR v_override > 5000) THEN
    RAISE EXCEPTION 'INVALID_OVERRIDE_ACRES: must round to > 0 and <= 5000 ac at 2dp (or NULL to clear)';
  END IF;

  SELECT customer_id, measured_acres, total_acres INTO v_customer, v_measured, v_total
  FROM fields WHERE id = p_field_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FIELD_NOT_FOUND: %', p_field_id; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing FROM idempotency_keys
    WHERE idempotency_key = p_idempotency_key AND operation = 'set_field_override_acres';
    IF FOUND THEN RETURN v_existing; END IF;
  END IF;

  -- override never touches boundary_geom/measured_acres (so it survives a redraw).
  -- billable precedence override -> measured -> legacy total; clearing an override on a
  -- legacy field MUST fall back to its existing total_acres (never erase the legacy bill).
  v_billable := COALESCE(v_override, v_measured, v_total);
  PERFORM set_config('app.acre_authority_write', 'on', true);   -- authorize the authority-column write
  UPDATE fields
  SET override_acres = v_override,
      total_acres    = v_billable,
      updated_at     = now()
  WHERE id = p_field_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'FIELD_NOT_FOUND: %', p_field_id; END IF;
  PERFORM set_config('app.acre_authority_write', 'off', true);

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('field_acres_changed',
          CASE WHEN v_override IS NULL
               THEN 'Override cleared -> billable ' || COALESCE(v_billable::text, 'n/a')
               ELSE 'Override set: billable ' || v_override || ' ac (measured ' || COALESCE(v_measured::text,'n/a') || ')' END,
          v_actor, 'field', p_field_id, v_customer);

  v_result := jsonb_build_object(
    'field_id', p_field_id,
    'override_acres', v_override,
    'billable_acres', v_billable,
    'acres_source', CASE WHEN v_override IS NOT NULL THEN 'override'
                         WHEN v_measured IS NOT NULL THEN 'measured' ELSE 'legacy' END
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'set_field_override_acres', v_result)
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_field_override_acres(uuid, numeric, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_field_override_acres(uuid, numeric, uuid, text) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- find_overlapping_fields  (read-only dedupe; overlap = intersection / LEAST(areas))
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.find_overlapping_fields(
  p_boundary_geojson text,
  p_customer_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_geom   geometry;
  v_mpoly  geometry(MultiPolygon,4326);
  v_area   double precision;
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  PERFORM require_admin_or_sales_rep();

  v_geom := ST_GeomFromGeoJSON(p_boundary_geojson);
  v_geom := ST_Force2D(v_geom);
  v_geom := ST_SetSRID(v_geom, 4326);
  IF NOT ST_IsValid(v_geom) THEN v_geom := ST_MakeValid(v_geom); END IF;
  v_geom := ST_UnaryUnion(ST_CollectionExtract(v_geom, 3));
  v_mpoly := ST_Multi(v_geom);
  IF v_mpoly IS NULL OR ST_IsEmpty(v_mpoly) OR GeometryType(v_mpoly) <> 'MULTIPOLYGON' THEN
    RAISE EXCEPTION 'INVALID_GEOMETRY: boundary did not resolve to a polygon';
  END IF;
  v_area := ST_Area(v_mpoly::geography);

  SELECT COALESCE(jsonb_agg(row_to_json(t) ORDER BY t.overlap_pct DESC), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT f.id AS field_id,
           f.field_name,
           f.customer_id,
           f.measured_acres,
           round((ST_Area(ST_Intersection(f.boundary_geom, v_mpoly)::geography)
                  / NULLIF(LEAST(ST_Area(f.boundary_geom::geography), v_area), 0) * 100)::numeric, 1) AS overlap_pct
    FROM fields f
    WHERE f.boundary_geom IS NOT NULL
      AND f.is_active
      AND (p_customer_id IS NULL OR f.customer_id = p_customer_id)
      AND f.boundary_geom && v_mpoly                                  -- GIST bbox prefilter
      AND ST_Intersects(f.boundary_geom, v_mpoly)
      AND ST_Area(ST_Intersection(f.boundary_geom, v_mpoly)::geography)
          / NULLIF(LEAST(ST_Area(f.boundary_geom::geography), v_area), 0) > 0.8
  ) t;

  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.find_overlapping_fields(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.find_overlapping_fields(text, uuid) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- Server-authoritative columns: only the SECURITY DEFINER RPCs above may write the
-- acre/geometry authority columns (measured_acres, override_acres, boundary_geom), so
-- per-acre billing can trust them (no bypass of the PostGIS measure / 0.1–5000 band /
-- audit). A column-level REVOKE does NOT work here (Supabase grants `authenticated`
-- TABLE-level UPDATE, which supersedes a column REVOKE), so a trigger enforces it: the
-- RPCs set a txn-local flag right before their UPDATE; a direct client UPDATE never
-- does, so it cannot change these columns. total_acres is intentionally NOT guarded —
-- it stays user-enterable via save_field for legacy fields. Other columns are unaffected.
-- ─────────────────────────────────────────────────────────────────────────
-- SECURITY DEFINER so the geometry comparison resolves PostGIS (in `extensions`) regardless
-- of the writing role's schema privileges; it only reads NEW/OLD + a GUC and raises.
CREATE OR REPLACE FUNCTION public.fields_acre_authority_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  IF current_setting('app.acre_authority_write', true) = 'on' THEN
    RETURN NEW;   -- a SECURITY DEFINER acreage RPC authorized this write
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- a direct field INSERT must not seed the authority columns (save_field leaves them NULL;
    -- they are populated only later by set_field_boundary / set_field_override_acres).
    IF NEW.measured_acres IS NOT NULL OR NEW.override_acres IS NOT NULL OR NEW.boundary_geom IS NOT NULL THEN
      RAISE EXCEPTION 'ACRE_AUTHORITY_VIOLATION: measured_acres/override_acres/boundary_geom are set only by set_field_boundary / set_field_override_acres, not on a direct insert';
    END IF;
  ELSE  -- UPDATE: boundary_geom compared via WKB bytes (geometry = geometry is ambiguous in PostGIS).
    IF NEW.measured_acres IS DISTINCT FROM OLD.measured_acres
       OR NEW.override_acres IS DISTINCT FROM OLD.override_acres
       OR ST_AsBinary(NEW.boundary_geom) IS DISTINCT FROM ST_AsBinary(OLD.boundary_geom) THEN
      RAISE EXCEPTION 'ACRE_AUTHORITY_VIOLATION: measured_acres/override_acres/boundary_geom are written only by set_field_boundary / set_field_override_acres';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_fields_acre_authority
  BEFORE INSERT OR UPDATE ON public.fields
  FOR EACH ROW EXECUTE FUNCTION public.fields_acre_authority_guard();
