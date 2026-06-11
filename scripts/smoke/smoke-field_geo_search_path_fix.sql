-- ============================================================================
-- SMOKE TEST (rolled back by design): field_geo_search_path_fix
-- ----------------------------------------------------------------------------
-- Verifies scripts/.staging-migrations/field_geo_search_path_fix.sql
-- (run POST-APPLY by the APPLY role):
--   * save_field_geometry with a minimal valid GeoJSON Point (centroid) +
--     Polygon (boundary) SUCCEEDS — i.e. the PostGIS call now resolves (the
--     42883 "st_geogfromgeojson(text) does not exist" is gone; the deployed
--     body now uses ST_GeomFromGeoJSON(...)::geography) — and the geography
--     actually lands on fields.centroid / fields.boundary;
--   * save_field_polygons with a one-element polygon payload SUCCEEDS —
--     field_polygons row written, fields.total_acres rolled up, and the
--     derived boundary + centroid (the second PostGIS call site) land.
-- PRE-FIX both calls abort with 42883 at the first geometry UPDATE, so mere
-- completion of each call is itself part of the assertion surface.
--
-- The DO block ALWAYS ends in RAISE EXCEPTION — on success it raises
-- 'SMOKE_PASS_ROLLBACK' — so nothing here ever commits. Any other error =
-- FAIL.
--
-- Calling context: both RPCs gate via require_admin_or_sales_rep(), which
-- reads auth.uid() (request.jwt.claims ->> 'sub') against
-- profiles.role/is_active. Auth is therefore established with a
-- transaction-local set_config('request.jwt.claims', ...) carrying a REAL
-- active admin profile id, resolved at runtime (an active admin verified
-- present on live 2026-06-10: 0b03fc35-49b5-454c-b7ca-eb56b20e8a5e; the
-- lookup below stays dynamic so the smoke cannot go stale).
--
-- Fixtures: all synthetic, [SMOKE]-prefixed (1 customer, 2 fields, 1
-- field_polygons row via the RPC). No existing rows are referenced except
-- the admin profile id (read-only). Everything rolls back.
--
-- DRY-VALIDATED REFERENCES (42703 discipline — every table/column/function
-- below was checked against the live catalog 2026-06-10):
--   profiles:        id uuid, role text, is_active boolean, created_at timestamptz
--   customers:       id uuid DEFAULT gen_random_uuid(), farm_name text NOT NULL
--                    (only NOT-NULL-without-default column; no user triggers)
--   fields:          id uuid DEFAULT gen_random_uuid(), customer_id uuid NOT
--                    NULL FK->customers(id), field_name text NOT NULL,
--                    centroid geography(Point,4326), boundary
--                    geography(Polygon,4326), total_acres numeric,
--                    updated_at timestamptz NOT NULL DEFAULT now()
--                    (triggers: set_fields_updated_at BEFORE UPDATE — benign;
--                    trg_snapshot_crop_history fires only when crop_type
--                    changes — never touched here)
--   field_polygons:  field_id uuid NOT NULL FK->fields(id), polygon_geojson
--                    jsonb NOT NULL, label text, acres numeric, sort_order
--                    int DEFAULT 0
--   functions:       public.save_field_geometry(uuid,text,text,text) [1
--                    overload], public.save_field_polygons(uuid,jsonb,uuid,
--                    text) [1 overload], public.require_admin_or_sales_rep()
--                    [internal gate], public.check_idempotency(text,text) +
--                    public.save_idempotency(text,text,jsonb) [internal; not
--                    exercised — NULL idempotency keys passed],
--                    extensions.st_geomfromgeojson(text),
--                    extensions.st_centroid(geometry)
--   builtins:        set_config, json_build_object, gen_random_uuid, substr,
--                    has_function_privilege
-- ============================================================================

DO $$
DECLARE
  v_admin     uuid;
  v_customer  uuid;
  v_field_geo uuid;   -- fixture for the save_field_geometry scenario
  v_field_pol uuid;   -- fixture for the save_field_polygons scenario
  v_centroid_geojson text := '{"type":"Point","coordinates":[-88.995,40.005]}';
  v_boundary_geojson text := '{"type":"Polygon","coordinates":[[[-89.0,40.0],[-88.99,40.0],[-88.99,40.01],[-89.0,40.01],[-89.0,40.0]]]}';
  v_polygons  jsonb;
  v_ok        boolean;
  v_count     int;
  v_acres     numeric;
BEGIN
  -- ---- auth: real active admin, transaction-local JWT claims ----
  SELECT id INTO v_admin
  FROM profiles
  WHERE role = 'admin' AND is_active = true
  ORDER BY created_at
  LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP_FAILED: no active admin profile found';
  END IF;
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text,
    true
  );

  -- ---- synthetic fixtures ([SMOKE] prefixed) ----
  INSERT INTO customers (farm_name)
  VALUES ('[SMOKE] FieldGeo 42883 ' || substr(gen_random_uuid()::text, 1, 8))
  RETURNING id INTO v_customer;

  INSERT INTO fields (customer_id, field_name)
  VALUES (v_customer, '[SMOKE] FieldGeo geometry fixture')
  RETURNING id INTO v_field_geo;

  INSERT INTO fields (customer_id, field_name)
  VALUES (v_customer, '[SMOKE] FieldGeo polygons fixture')
  RETURNING id INTO v_field_pol;

  -- ---- scenario 1: save_field_geometry (deltas G1 + G2) ----
  -- Pre-fix: this call raises 42883 at the UPDATE. Post-fix it must succeed
  -- AND persist both geographies.
  PERFORM public.save_field_geometry(v_field_geo, v_centroid_geojson, v_boundary_geojson, NULL);

  SELECT (centroid IS NOT NULL) AND (boundary IS NOT NULL) INTO v_ok
  FROM fields WHERE id = v_field_geo;
  IF NOT COALESCE(v_ok, false) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: save_field_geometry completed but centroid/boundary did not persist';
  END IF;

  -- ---- scenario 2: save_field_polygons (deltas P1 + P2) ----
  v_polygons := jsonb_build_array(
    jsonb_build_object(
      'polygon_geojson', v_boundary_geojson::jsonb,
      'label', '[SMOKE] Poly A',
      'acres', 40.5,
      'sort_order', 0
    )
  );
  PERFORM public.save_field_polygons(v_field_pol, v_polygons, v_admin, NULL);

  SELECT count(*) INTO v_count FROM field_polygons WHERE field_id = v_field_pol;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: expected 1 field_polygons row, found %', v_count;
  END IF;

  SELECT total_acres, (boundary IS NOT NULL) AND (centroid IS NOT NULL)
  INTO v_acres, v_ok
  FROM fields WHERE id = v_field_pol;
  IF v_acres IS DISTINCT FROM 40.5 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: fields.total_acres = % (expected 40.5)', v_acres;
  END IF;
  IF NOT COALESCE(v_ok, false) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: save_field_polygons completed but derived boundary/centroid did not persist';
  END IF;

  -- ---- belt-and-braces: grants unchanged by the migration ----
  IF has_function_privilege('anon', 'public.save_field_geometry(uuid,text,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.save_field_polygons(uuid,jsonb,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: anon can EXECUTE a field-geometry RPC — grant regression';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.save_field_geometry(uuid,text,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.save_field_polygons(uuid,jsonb,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: authenticated lost EXECUTE on a field-geometry RPC';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $$;
