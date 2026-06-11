-- idempotency-body-check: exempt
-- ============================================================================
-- field_geo_search_path_fix — save_field_geometry + save_field_polygons:
-- fix the plpgsql_check 42883 ("function st_geogfromgeojson(text) does not
-- exist") latent break in BOTH field-geometry RPCs, in one migration.
-- (STAGED DRAFT — APPLY role stamps + moves this file; per the race guard it
-- must NOT be placed under supabase/migrations/ until post-review.)
-- APPLY-TIME CHECKLIST item (CHECK 7, reviewer MED): immediately after
-- stamping, the APPLY role MUST add the stamped row
-- (<version>_field_geo_search_path_fix) to docs/reference/migration-history.md
-- in the same change — the row cannot be added pre-stamp because the APPLY
-- role assigns the version.
-- ----------------------------------------------------------------------------
-- BUG (from docs/audits/2026-06-10-error-prevention-execution-log.md §4.1):
-- the plpgsql_check sweep reported 42883 for save_field_geometry and
-- save_field_polygons — every call that actually carries geometry payload
-- fails at runtime the moment the UPDATE executes. Both functions are
-- latent-broken in production: a field-mapping save has never been able to
-- persist centroid/boundary through these RPCs as deployed.
--
-- ROOT-CAUSE CORRECTION (live-catalog-verified 2026-06-10; this header
-- supersedes the execution log's "search_path hides the PostGIS schema"
-- diagnosis for these two functions):
--   (a) The live search_path does NOT hide PostGIS. Live proconfig on BOTH
--       functions is already exactly:
--           search_path=public, extensions, pg_temp
--       (pg_catalog query of pg_proc.proconfig, 2026-06-10).
--   (b) PostGIS lives in schema "extensions":
--           SELECT e.extname, n.nspname FROM pg_extension e
--           JOIN pg_namespace n ON n.oid = e.extnamespace
--           WHERE extname LIKE 'postgis%'  ->  (postgis, extensions)
--   (c) ST_GeogFromGeoJSON DOES NOT EXIST IN ANY SCHEMA. A full pg_proc scan
--       (no namespace filter) for 'st_geogfrom%' / 'st_geomfromgeojson%'
--       returns ONLY:
--           extensions.st_geogfromtext(text)
--           extensions.st_geogfromwkb(bytea)
--           extensions.st_geomfromgeojson(text)
--           extensions.st_geomfromgeojson(json)
--           extensions.st_geomfromgeojson(jsonb)
--       PostGIS has never shipped an ST_GeogFromGeoJSON function. NO
--       search_path setting can ever resolve it; a search_path-only migration
--       would be a verbatim no-op that leaves the 42883 in place.
-- THE FIX is therefore the call itself, the standard PostGIS idiom:
--           ST_GeomFromGeoJSON(<text>)::geography
-- GeoJSON is WGS84 by spec; ST_GeomFromGeoJSON returns SRID-4326 geometry;
-- the ::geography cast is the canonical conversion. Target columns confirmed
-- live: fields.centroid geography(Point,4326), fields.boundary
-- geography(Polygon,4326) — the assignment cast from generic geography to the
-- constrained typmod is implicit and standard.
--
-- SEARCH_PATH (security note, required statement): 'public, extensions,
-- pg_temp' is the standard Supabase pattern for PostGIS-using SECDEF
-- functions — the extensions schema is added AFTER public, so public still
-- shadows it (a malicious same-name function cannot be planted ahead of
-- public's resolution), and pg_temp stays LAST so temp-schema objects can
-- never shadow anything. In THIS migration the search_path is RESTATED
-- VERBATIM from live (it already includes extensions) — it is NOT a delta.
--
-- BASELINE (live, read 2026-06-10 via pg_get_functiondef + md5(prosrc)):
--   public.save_field_geometry(uuid,text,text,text)
--       md5(prosrc) = 9504880a5318b8d58ec584dafe14b027
--       SECURITY DEFINER, owner postgres,
--       proconfig = {search_path=public, extensions, pg_temp}
--       proacl = {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}
--   public.save_field_polygons(uuid,jsonb,uuid,text)
--       md5(prosrc) = 299351dfadd73cbd1411b8d4e49caa1d
--       SECURITY DEFINER, owner postgres,
--       proconfig = {search_path=public, extensions, pg_temp}
--       proacl = {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}
--   One overload each (live-verified). Bodies below are VERBATIM from live
--   pg_get_functiondef output except the sentinel-delimited deltas.
--
-- EXHAUSTIVE DELTA LIST (every change vs the live bodies; sentinel token
-- FIELD_GEO_42883_DELTA marks each in-body site; the old function name is
-- deliberately NOT repeated inside the $function$ bodies so the
-- self-verification can assert it is fully gone from prosrc):
--   G1 (save_field_geometry, centroid CASE branch):
--       was:  ST_GeogFromGeoJSON(p_centroid_geojson)
--       now:  ST_GeomFromGeoJSON(p_centroid_geojson)::geography
--   G2 (save_field_geometry, boundary CASE branch):
--       was:  ST_GeogFromGeoJSON(p_boundary_geojson)
--       now:  ST_GeomFromGeoJSON(p_boundary_geojson)::geography
--   P1 (save_field_polygons, boundary assignment in the final UPDATE):
--       was:  boundary = ST_GeogFromGeoJSON(v_first_geojson::text)
--       now:  boundary = ST_GeomFromGeoJSON(v_first_geojson::text)::geography
--   P2 (save_field_polygons, centroid assignment in the same UPDATE):
--       was:  centroid = ST_Centroid(ST_GeogFromGeoJSON(v_first_geojson::text)::geometry)::geography
--       now:  centroid = ST_Centroid(ST_GeomFromGeoJSON(v_first_geojson::text))::geography
--       (ST_GeomFromGeoJSON already returns geometry, so the live code's
--       geography->geometry round-trip cast is dropped as part of the rename;
--       extensions.st_centroid(geometry) confirmed live. Semantics identical
--       to the live INTENT: planar centroid of the SRID-4326 geometry, cast
--       to geography. No behavior change vs the live code's intent — the
--       live code never executed successfully.)
--   NO other changes: signatures, RETURNS void, LANGUAGE, SECURITY DEFINER,
--   search_path, parameter defaults, all other statements byte-identical to
--   live (including save_field_polygons' unused p_performed_by parameter —
--   out of scope here, noted for a future cleanup).
--
-- GRANTS: restated verbatim from live proacl below (authenticated +
-- service_role EXECUTE; anon/PUBLIC none). CREATE OR REPLACE preserves the
-- ACL; the restatement + self-verification make it explicit. The in-body
-- gate is require_admin_or_sales_rep() (auth.uid() vs profiles.role/is_active
-- — live-verified), so authenticated EXECUTE is safe-by-design.
--
-- SELF-VERIFICATION (DO block at end): per function — exactly 1 overload;
-- FIELD_GEO_42883_DELTA sentinel present in prosrc; zero occurrences of the
-- old (nonexistent) call in prosrc; new call + ::geography present; SECDEF;
-- proconfig exactly 'search_path=public, extensions, pg_temp' (pg_temp LAST);
-- grant assertions (authenticated/service_role EXECUTE, anon none); PostGIS
-- target extensions.st_geomfromgeojson(text) resolvable; and — the
-- definitive predicate — plpgsql_check_function() reports ZERO error lines
-- post-apply (guarded on the extension being installed; it is live since
-- 20260610192229).
-- ============================================================================

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
      WHEN p_centroid_geojson IS NOT NULL THEN ST_GeomFromGeoJSON(p_centroid_geojson)::geography -- FIELD_GEO_42883_DELTA G1
      ELSE centroid
    END,
    boundary = CASE
      WHEN p_boundary_geojson IS NOT NULL THEN ST_GeomFromGeoJSON(p_boundary_geojson)::geography -- FIELD_GEO_42883_DELTA G2
      ELSE boundary
    END,
    updated_at = now()
  WHERE id = p_field_id;
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'save_field_geometry', '{}'::jsonb);
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.save_field_polygons(p_field_id uuid, p_polygons jsonb, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v_existing jsonb; v_poly jsonb; v_total_acres numeric := 0; v_first_geojson jsonb;
BEGIN
  PERFORM require_admin_or_sales_rep();
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'save_field_polygons');
    IF v_existing IS NOT NULL THEN RETURN; END IF;
  END IF;
  DELETE FROM field_polygons WHERE field_id = p_field_id;
  FOR v_poly IN SELECT * FROM jsonb_array_elements(p_polygons) LOOP
    INSERT INTO field_polygons (field_id, polygon_geojson, label, acres, sort_order)
    VALUES (p_field_id, v_poly->'polygon_geojson', v_poly->>'label', (v_poly->>'acres')::numeric, COALESCE((v_poly->>'sort_order')::int, 0));
    v_total_acres := v_total_acres + COALESCE((v_poly->>'acres')::numeric, 0);
  END LOOP;
  UPDATE fields SET total_acres = v_total_acres, updated_at = now() WHERE id = p_field_id;
  SELECT polygon_geojson INTO v_first_geojson FROM field_polygons WHERE field_id = p_field_id ORDER BY sort_order LIMIT 1;
  IF v_first_geojson IS NOT NULL THEN
    -- FIELD_GEO_42883_DELTA P1+P2 BEGIN (both PostGIS calls on the next line)
    UPDATE fields SET boundary = ST_GeomFromGeoJSON(v_first_geojson::text)::geography, centroid = ST_Centroid(ST_GeomFromGeoJSON(v_first_geojson::text))::geography, updated_at = now() WHERE id = p_field_id;
    -- FIELD_GEO_42883_DELTA P1+P2 END
  END IF;
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'save_field_polygons', '{}'::jsonb);
  END IF;
END; $function$;

-- ----------------------------------------------------------------------------
-- Grants: restated verbatim from live proacl
-- ({postgres,authenticated,service_role}; anon/PUBLIC none).
--
-- B10 per-function caller analysis (grant-change-guard.mjs requirement; both
-- functions HAVE live callers in the fresh 2026-06-10 .claude/caller-graph.json;
-- live proacl re-read read-only 2026-06-10 — identical to the BASELINE above):
-- caller-analysis: save_field_geometry :: REVOKE FROM PUBLIC/anon is a verbatim restatement of live proacl (live proacl = {postgres=X,authenticated=X,service_role=X} — no anon/PUBLIC entry; anon never had EXECUTE); authenticated EXECUTE re-granted in the next statement of this same migration; authenticated UI callers (src/components/fields/BulkFieldImport.tsx:362, src/pages/FieldSetup.tsx:366) run as authenticated, unaffected
-- caller-analysis: save_field_polygons :: same verbatim ACL restatement (live proacl has no anon/PUBLIC entry; anon never had EXECUTE); authenticated EXECUTE re-granted next statement; UI caller src/pages/FieldSetup.tsx:346 runs as authenticated, unaffected
-- ----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.save_field_geometry(uuid,text,text,text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.save_field_geometry(uuid,text,text,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.save_field_polygons(uuid,jsonb,uuid,text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.save_field_polygons(uuid,jsonb,uuid,text) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Self-verification
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_fn   text;
  v_sig  text;
  v_count int;
  v_src  text;
  v_cfg  text;
  v_errs int;
BEGIN
  FOR v_fn, v_sig IN
    SELECT t.fn, t.sig FROM (VALUES
      ('save_field_geometry', 'public.save_field_geometry(uuid,text,text,text)'),
      ('save_field_polygons', 'public.save_field_polygons(uuid,jsonb,uuid,text)')
    ) AS t(fn, sig)
  LOOP
    -- (1) exactly one overload
    SELECT count(*) INTO v_count
    FROM pg_proc WHERE proname = v_fn AND pronamespace = 'public'::regnamespace;
    IF v_count <> 1 THEN
      RAISE EXCEPTION '%: overload count = %, expected 1', v_fn, v_count;
    END IF;

    SELECT prosrc, array_to_string(proconfig, ',') INTO v_src, v_cfg
    FROM pg_proc WHERE proname = v_fn AND pronamespace = 'public'::regnamespace;

    -- (2) delta sentinels present; old nonexistent call fully gone; fix present
    IF v_src NOT LIKE '%FIELD_GEO_42883_DELTA%' THEN
      RAISE EXCEPTION '%: FIELD_GEO_42883_DELTA sentinel missing from deployed prosrc', v_fn;
    END IF;
    IF lower(v_src) LIKE '%st_geogfromgeojson%' THEN
      RAISE EXCEPTION '%: nonexistent st_geogfromgeojson call still present in prosrc', v_fn;
    END IF;
    IF lower(v_src) NOT LIKE '%st_geomfromgeojson%' OR v_src NOT LIKE '%::geography%' THEN
      RAISE EXCEPTION '%: expected ST_GeomFromGeoJSON(...)::geography rewrite not found', v_fn;
    END IF;

    -- (3) SECDEF + exact search_path (public first shadows extensions; pg_temp LAST)
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc
      WHERE proname = v_fn AND pronamespace = 'public'::regnamespace AND prosecdef
    ) THEN
      RAISE EXCEPTION '%: must be SECURITY DEFINER', v_fn;
    END IF;
    IF v_cfg IS DISTINCT FROM 'search_path=public, extensions, pg_temp' THEN
      RAISE EXCEPTION '%: search_path must be exactly ''public, extensions, pg_temp'' (got: %)', v_fn, COALESCE(v_cfg, '<none>');
    END IF;

    -- (4) grant assertions: authenticated + service_role EXECUTE, anon none
    IF NOT has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION '%: authenticated lost EXECUTE', v_fn;
    END IF;
    IF has_function_privilege('anon', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION '%: anon has EXECUTE', v_fn;
    END IF;
    IF NOT has_function_privilege('service_role', v_sig, 'EXECUTE') THEN
      RAISE EXCEPTION '%: service_role lost EXECUTE', v_fn;
    END IF;

    -- (5) definitive predicate: plpgsql_check reports ZERO error lines post-fix
    --     (guarded; plpgsql_check installed live since 20260610192229)
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'plpgsql_check') THEN
      SELECT count(*) INTO v_errs
      FROM public.plpgsql_check_function(v_sig::regprocedure) AS line
      WHERE line LIKE 'error:%';
      IF v_errs <> 0 THEN
        RAISE EXCEPTION '%: plpgsql_check still reports % error line(s) post-apply', v_fn, v_errs;
      END IF;
    END IF;
  END LOOP;

  -- (6) the PostGIS target is resolvable exactly where the search_path expects it
  IF to_regprocedure('extensions.st_geomfromgeojson(text)') IS NULL THEN
    RAISE EXCEPTION 'extensions.st_geomfromgeojson(text) not found — PostGIS is not in the expected schema';
  END IF;
END $$;
