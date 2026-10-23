-- Written 2026-10-23. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md.
--
-- WHAT (To-Do row 11.4, part A of the fix plan in docs/manual/KNOWN_ISSUES.md, entry "OPEN 2026-10-22
--   (HIGH; To-Do List row 11.4)"): field roles stop reading every customer's fields, field maps and
--   money totals through SECURITY DEFINER functions that checked nothing. Those functions run with the
--   owner's rights, so row security never applied inside them, and every signed-in account
--   (applicators, drivers, an entity_recipient profile, a deactivated user with a live token) got:
--     get_fields_with_geojson            every field with boundary, owner, legal description, FSA ids
--     get_fields_geojson_by_ids          any field's boundary and owner, by id
--     get_field_geojson                  any field's centroid and boundary, by id
--     get_field_polygons                 any field's boundary parts
--     get_field_dashboard                any field's billing splits with price overrides, spray records
--     derive_customer_shares_from_fields owner names, price tier, price overrides for any fields
--     get_customer_farm_group            any customer's farm group names
--     get_field_billing_splits_for_order / _for_blend_ticket   customer ids and split percentages
--     get_customer_summary               any customer's accounts-receivable balance
--     check_customer_credit_limit        any customer's credit limit and outstanding balance
--     get_dashboard_action_items         company-wide overdue invoices, deliveries, jobs, stock, quotes
--     global_search                      customer names and contacts, order/invoice/delivery numbers
--     get_notes_for_entity               every team note on any record, by id (through this function;
--                                        team_notes' own policy still admits every active profile,
--                                        and the Team Board reads it directly: not changed here)
--   Found by the part A review, same class and no caller in the app or the database (live read
--   2026-10-23), so made office-only here too:
--     _check_credit_limit                its error text names a customer's credit limit and AR
--                                        balance, and the caller picks the added amount
--     get_customer_delivery_remainders   every customer's undelivered remainders, orders, products
--     check_duplicate_delivery           an order's open delivery numbers and dates
--
-- HOW:
--   * New helper public._can_see_field(field_id): true for an active admin or sales rep; for the
--     whole-job applicator (jobs.applicator_id), the fields on that job unless it is soft-deleted;
--     for a per-field or crew assignee, only the field their own job_location_dispatches row points at
--     (job_field_id -> job_fields.field_id), never the job's other fields, under every check
--     _is_dispatched_to_me makes (active profile; dispatch open, or completed within 7 days, never
--     cancelled; a crew dispatch needs an active crew and an active membership) plus
--     jobs.deleted_at IS NULL. It does not reuse _is_dispatched_to_me, which is job-level.
--   * get_fields_geojson_by_ids (Field View, Dispatch Board) and get_field_geojson (Job Detail) return
--     only fields that pass it.
--   * get_fields_with_geojson, get_field_polygons, get_field_dashboard,
--     derive_customer_shares_from_fields, get_customer_farm_group, both
--     get_field_billing_splits_for_*, get_customer_summary, check_customer_credit_limit and
--     get_dashboard_action_items, and the three above, start with require_admin_or_sales_rep() (active admin or sales rep,
--     else 'Permission denied: requires admin or sales_rep role'). The three SQL-language ones become
--     plpgsql so the gate runs before the query; #variable_conflict use_column keeps their
--     unqualified column names meaning the columns, as they did in SQL. Every screen that calls them
--     is an office-only page (src/appPages.tsx), Job Detail runs the credit check only when the office
--     creates a job, and the three definer callers of derive_customer_shares_from_fields
--     (_save_field_app_invoice_impl_20260714, _preview_field_app_invoice_split_impl_20260908,
--     create_invoice_from_blend_ticket) already require an active admin or sales rep first.
--   * global_search returns no rows to anyone but an active admin or sales rep (the command palette
--     sits in every role's layout, so it must not error).
--   * get_notes_for_entity becomes SECURITY INVOKER and first checks that the caller can read the
--     linked record under that record's own table row security (customers, orders, deliveries, jobs,
--     purchase_orders, quotes, invoices, products); an unknown type is office-only. team_notes' own
--     policy (active profile) now applies too. Job Detail and Delivery Detail keep showing notes to
--     the applicator or driver who can open that job or delivery. One narrowing for office staff:
--     a sales rep no longer gets notes on an invoice invoices_select hides from them (another rep's);
--     no screen shows invoice notes (RelatedNotes is mounted only on customer, order, delivery, job
--     and purchase-order pages).
--   * operational_dashboard_summary is re-emitted byte-for-byte as live has it. Live refuses anyone
--     but an active admin or sales rep; the 2026-07-27 baseline carries that check, but its newest
--     pre-baseline migration file (20260323100000) has none, so this puts the live body back in the
--     migration files. No behavior change.
--
-- SOURCE OF THE BODIES: live, as pinned below (each pinned md5 also matches the body a replay of the
--   checked-in baseline and migrations produces). Only the gate lines above were added.
--
-- NOT CHANGED: what an active admin or sales rep gets from any of these (except the invoice-notes
--   narrowing above); return types, owner
--   (postgres), ACLs, search_path; no rows change. CREATE OR REPLACE keeps each OID.
--   Tables are part B (fields_select and its followers, job_fields dispatchee rows, fbd/arf, the
--   field rows of get_job_fields_with_geojson, get_dispatch_board_jobs and the billed-customer
--   functions); the whole-job applicator's lifecycle window is part C.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE field_functions_require_field_access_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

CREATE TEMP TABLE field_functions_require_field_access_attrs ON COMMIT DROP AS
SELECT p.oid AS fn_oid, pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl,
       p.proconfig, p.prorettype, p.provolatile
  FROM pg_proc p
 WHERE false;

DO $preflight$
DECLARE
  v_pin record;
  v_md5 text;
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  IF to_regclass('pg_temp.field_functions_require_field_access_tx') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.field_functions_require_field_access_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF to_regprocedure('public._can_see_field(uuid)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_proc WHERE proname = '_can_see_field' AND pronamespace = 'public'::regnamespace) THEN
    RAISE EXCEPTION 'FIELD_ACCESS_BASELINE_DRIFT: public._can_see_field already exists';
  END IF;
  IF to_regprocedure('public.require_admin_or_sales_rep()') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: public.require_admin_or_sales_rep() is missing';
  END IF;

  FOR v_pin IN
    SELECT * FROM (VALUES
      ('public.get_fields_geojson_by_ids(uuid[])',                 'f764ceff8af270c717038e45bc4818e9'),
      ('public.get_field_geojson(uuid)',                           '5422a5b8550b18e80c840ea98faf2424'),
      ('public.get_fields_with_geojson(uuid)',                     '2ab8cb993757a803fa41fc108a1c37c8'),
      ('public.get_field_polygons(uuid)',                          '2f95e990cd78ef8c34b082811dc71d40'),
      ('public.get_customer_farm_group(uuid)',                     'b02461f51a28aff92a6616d5493a7f1a'),
      ('public.get_field_dashboard(uuid,integer)',                 '46e563a5903e0bfcd22832c27150f0c3'),
      ('public.derive_customer_shares_from_fields(uuid[],jsonb)',  '6c0dc7a1e2f43a7fad03e5a248cdd9bb'),
      ('public.get_field_billing_splits_for_order(uuid)',          'cfd939349a42addacb54714f7288ce0b'),
      ('public.get_field_billing_splits_for_blend_ticket(uuid)',   '33b8b51ac86ba86b3ff71df9911240b0'),
      ('public.get_customer_summary(uuid)',                        '0c62f7918b943433e972dd7885a64249'),
      ('public.check_customer_credit_limit(uuid)',                 '3adc17f7fa1612df87264a4702d72858'),
      ('public.get_dashboard_action_items(integer)',               '7098f5204a98631d48b0018559af19f7'),
      ('public._check_credit_limit(uuid,bigint)',                  'a2dabc88b5b048aac831663c483df8bb'),
      ('public.get_customer_delivery_remainders(uuid)',            '5114589c721170e7e3496309a664af51'),
      ('public.check_duplicate_delivery(uuid)',                    '475c6d2c251ef31637a2f5df3e8c02a2'),
      ('public.global_search(text,integer)',                       '8b52e155e2d36ac7e83001c02e943822'),
      ('public.get_notes_for_entity(text,uuid)',                   '53ff9cf1f416bb8eac2875ccda300a70'),
      ('public.operational_dashboard_summary()',                   '77655108c73c1a98d826a21d55d7739d')
    ) AS t(sig, live_md5)
  LOOP
    IF (SELECT count(*) FROM pg_proc
         WHERE proname = split_part(replace(v_pin.sig, 'public.', ''), '(', 1)
           AND pronamespace = 'public'::regnamespace) <> 1 THEN
      RAISE EXCEPTION 'PREFLIGHT_FAIL: % must have exactly one overload', v_pin.sig;
    END IF;
    SELECT md5(replace(prosrc, chr(13), '')) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure(v_pin.sig);
    IF v_md5 IS DISTINCT FROM v_pin.live_md5 THEN
      -- Already applied, or live drifted from the body this file was written against.
      RAISE EXCEPTION 'FIELD_ACCESS_BASELINE_DRIFT: % is %', v_pin.sig, v_md5;
    END IF;
    INSERT INTO pg_temp.field_functions_require_field_access_attrs
    SELECT p.oid, pg_get_userbyid(p.proowner), p.proacl::text, p.proconfig, p.prorettype, p.provolatile
      FROM pg_proc p WHERE p.oid = to_regprocedure(v_pin.sig);
  END LOOP;
END;
$preflight$;

-- The per-field visibility helper. -------------------------------------------------------------------
CREATE FUNCTION public._can_see_field(p_field_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  -- Who may see one field (its row, boundary and map lookups). Every leg needs an ACTIVE profile.
  SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = (SELECT auth.uid()) AND p.is_active)
  AND (
    -- Office staff see every field.
    public.is_admin() OR public.is_sales_rep()
    -- The whole-job applicator (jobs.applicator_id) sees the fields on that job, never on a
    -- soft-deleted job. Part C of row 11.4 adds the job's lifecycle window here and in jobs_select.
    OR (public.is_applicator() AND EXISTS (
          SELECT 1
            FROM public.job_fields jf
            JOIN public.jobs j ON j.id = jf.job_id
           WHERE jf.field_id = p_field_id
             AND j.applicator_id = (SELECT auth.uid())
             AND j.deleted_at IS NULL))
    -- A per-field or crew assignee sees only the field their own dispatch row points at, never the
    -- job's other fields (_is_dispatched_to_me is job-level, so it is not reused here). Same checks
    -- as _is_dispatched_to_me: open, or completed within 7 days, never cancelled; a crew dispatch
    -- needs an active crew and an active membership. Plus: the job is not soft-deleted.
    OR EXISTS (
          SELECT 1
            FROM public.job_location_dispatches d
            JOIN public.job_fields jf ON jf.id = d.job_field_id AND jf.job_id = d.job_id
            JOIN public.jobs j ON j.id = d.job_id
           WHERE jf.field_id = p_field_id
             AND j.deleted_at IS NULL
             AND (
               d.dispatch_status = 'dispatched'
               OR (d.dispatch_status = 'completed' AND d.updated_at >= now() - interval '7 days')
             )
             AND (
               d.applicator_id = (SELECT auth.uid())
               OR (
                 d.crew_id IS NOT NULL
                 AND EXISTS (
                   SELECT 1
                     FROM public.ground_crew_members gcm
                     JOIN public.ground_crews gc ON gc.id = gcm.crew_id
                    WHERE gcm.crew_id = d.crew_id
                      AND gcm.profile_id = (SELECT auth.uid())
                      AND gcm.is_active
                      AND gc.is_active
                 )
               )
             ))
  );
$function$;

COMMENT ON FUNCTION public._can_see_field(uuid) IS
  'Row 11.4: may the caller see this field? Active office staff: any. Whole-job applicator: fields on their non-deleted job. Dispatch or crew assignee: only the field of their own open (or completed within 7 days, never cancelled) dispatch on a non-deleted job.';

-- Deliberate grants: callable from row security (part B) by signed-in users; never by anon.
REVOKE ALL ON FUNCTION public._can_see_field(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._can_see_field(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_fields_geojson_by_ids(p_field_ids uuid[])
 RETURNS TABLE(id uuid, customer_id uuid, field_name text, total_acres numeric, measured_acres numeric, override_acres numeric, crop_type text, is_active boolean, centroid_geojson text, boundary_geojson text, customer_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
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
    -- Only the fields this caller may see (office staff, or assigned to them; row 11.4).
    AND public._can_see_field(f.id)
  ORDER BY f.field_name;
$function$;

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
  WHERE f.id = p_field_id
    -- Only a field this caller may see (office staff, or assigned to them; row 11.4).
    AND public._can_see_field(f.id);
$function$;

CREATE OR REPLACE FUNCTION public.get_fields_with_geojson(p_customer_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, customer_id uuid, field_name text, legal_description text, county text, state text, total_acres numeric, fsa_farm_number text, fsa_tract_number text, fsa_field_number text, crop_type text, soil_type text, irrigation boolean, notes text, is_active boolean, centroid_geojson text, boundary_geojson text, customer_name text, created_at timestamp with time zone, updated_at timestamp with time zone, parent_field_id uuid, child_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
#variable_conflict use_column
BEGIN
  -- Office staff only (active admin or sales rep); every other account is refused (row 11.4).
  PERFORM public.require_admin_or_sales_rep();

  RETURN QUERY
  SELECT f.id, f.customer_id, f.field_name, f.legal_description,
      f.county, f.state, f.total_acres,
      f.fsa_farm_number, f.fsa_tract_number, f.fsa_field_number,
      f.crop_type, f.soil_type, f.irrigation, f.notes, f.is_active,
      ST_AsGeoJSON(f.centroid)::text AS centroid_geojson,
      ST_AsGeoJSON(f.boundary)::text AS boundary_geojson,
      c.farm_name AS customer_name, f.created_at, f.updated_at,
      f.parent_field_id,
      (SELECT count(*) FROM fields ch WHERE ch.parent_field_id = f.id) AS child_count
    FROM fields f LEFT JOIN customers c ON c.id = f.customer_id
    WHERE (p_customer_id IS NULL OR f.customer_id = p_customer_id)
    ORDER BY f.field_name;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_field_polygons(p_field_id uuid)
 RETURNS TABLE(id uuid, field_id uuid, polygon_geojson jsonb, label text, acres numeric, sort_order integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
BEGIN
  -- Office staff only (active admin or sales rep); every other account is refused (row 11.4).
  PERFORM public.require_admin_or_sales_rep();

  RETURN QUERY
  SELECT fp.id, fp.field_id, fp.polygon_geojson, fp.label, fp.acres, fp.sort_order
    FROM field_polygons fp WHERE fp.field_id = p_field_id ORDER BY fp.sort_order;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_customer_farm_group(p_customer_id uuid)
 RETURNS TABLE(id uuid, farm_name text, is_parent boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
BEGIN
  -- Office staff only (active admin or sales rep); every other account is refused (row 11.4).
  PERFORM public.require_admin_or_sales_rep();

  RETURN QUERY
  -- Find the root parent (if selected customer IS a child, go up)
    WITH RECURSIVE root AS (
      SELECT c.id, c.farm_name, c.parent_customer_id
      FROM customers c WHERE c.id = p_customer_id
      UNION ALL
      SELECT p.id, p.farm_name, p.parent_customer_id
      FROM customers p
      JOIN root r ON r.parent_customer_id = p.id
    )
    -- The topmost customer is the parent
    , top_parent AS (
      SELECT id FROM root WHERE parent_customer_id IS NULL
      LIMIT 1
    )
    -- Return parent + all direct children
    SELECT c.id, c.farm_name,
           (c.id = tp.id) AS is_parent
    FROM customers c
    CROSS JOIN top_parent tp
    WHERE c.id = tp.id
       OR c.parent_customer_id = tp.id
    ORDER BY (c.id = tp.id) DESC, c.farm_name;
END;
$function$;

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
  -- Office staff only (active admin or sales rep); every other account is refused (row 11.4).
  PERFORM public.require_admin_or_sales_rep();
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
    'applicator_name', COALESCE(ar.applicator_name, p.full_name, 'Unknown'), -- D1: prefer the completion-time snapshot (N2-7 #106b); profiles is the legacy fallback.
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

CREATE OR REPLACE FUNCTION public.derive_customer_shares_from_fields(p_field_ids uuid[], p_applied_acres_map jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  -- Office staff only (active admin or sales rep); every other account is refused (row 11.4).
  PERFORM public.require_admin_or_sales_rep();
  WITH field_data AS (
    SELECT
      f.id           AS field_id,
      f.field_name,
      f.customer_id  AS field_owner_id,
      f.total_acres,
      f.crop_type,
      COALESCE(
        (p_applied_acres_map ->> f.id::text)::numeric,
        f.total_acres
      ) AS applied_acres
    FROM fields f
    WHERE f.id = ANY(p_field_ids)
  ),
  billing_split AS (
    SELECT
      fd.field_id, fd.field_name, fd.applied_acres, fd.total_acres,
      fbd.customer_id, c.farm_name AS customer_name, c.assigned_tier AS tier,
      fbd.split_pct, fbd.is_primary,
      fbd.price_override_cents, fbd.pricing_note,
      false AS used_fallback
    FROM field_data fd
    JOIN field_billing_defaults fbd ON fbd.field_id = fd.field_id
    JOIN customers c               ON c.id        = fbd.customer_id
  ),
  billing_fallback AS (
    SELECT
      fd.field_id, fd.field_name, fd.applied_acres, fd.total_acres,
      fd.field_owner_id AS customer_id, c.farm_name AS customer_name, c.assigned_tier AS tier,
      100.0 AS split_pct, true AS is_primary,
      NULL::bigint AS price_override_cents, NULL::text AS pricing_note,
      true AS used_fallback
    FROM field_data fd
    JOIN customers c ON c.id = fd.field_owner_id
    WHERE NOT EXISTS (SELECT 1 FROM field_billing_defaults fbd WHERE fbd.field_id = fd.field_id)
  ),
  combined AS (
    SELECT * FROM billing_split UNION ALL SELECT * FROM billing_fallback
  ),
  agg AS (
    SELECT
      cb.customer_id, cb.customer_name,
      bool_or(cb.is_primary) AS is_primary,
      ROUND(SUM(cb.applied_acres * cb.split_pct / 100.0), 2) AS total_share_acres,
      CASE WHEN SUM(SUM(cb.applied_acres * cb.split_pct / 100.0)) OVER () > 0
        THEN ROUND(SUM(cb.applied_acres * cb.split_pct / 100.0)
                   / SUM(SUM(cb.applied_acres * cb.split_pct / 100.0)) OVER () * 100, 4)
        ELSE 0
      END AS overall_split_pct,
      MAX(cb.tier) AS tier,
      bool_or(cb.price_override_cents IS NOT NULL) AS has_override
    FROM combined cb
    GROUP BY cb.customer_id, cb.customer_name
  )
  SELECT jsonb_build_object(
    'rows', COALESCE(jsonb_agg(
      jsonb_build_object(
        'field_id', cb.field_id, 'field_name', cb.field_name,
        'customer_id', cb.customer_id, 'customer_name', cb.customer_name,
        'is_primary', cb.is_primary, 'split_pct', cb.split_pct,
        'share_acres', ROUND(cb.applied_acres * cb.split_pct / 100.0, 2),
        'price_override_cents', cb.price_override_cents,
        'pricing_note', cb.pricing_note,
        'tier', cb.tier,
        'field_total_acres', cb.total_acres,
        'field_applied_acres', cb.applied_acres,
        'used_fallback', cb.used_fallback
      ) ORDER BY cb.is_primary DESC, cb.customer_name, cb.field_name
    ) FILTER (WHERE cb.field_id IS NOT NULL), '[]'::jsonb),
    'customers', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'customer_id', a.customer_id, 'customer_name', a.customer_name,
        'is_primary', a.is_primary,
        'total_share_acres', a.total_share_acres,
        'overall_split_pct', a.overall_split_pct,
        'tier', a.tier, 'has_override', a.has_override
      ) ORDER BY a.is_primary DESC, a.total_share_acres DESC) FROM agg a
    ), '[]'::jsonb),
    'total_applied_acres', (SELECT COALESCE(SUM(fd.applied_acres), 0) FROM field_data fd),
    'field_count', array_length(p_field_ids, 1),
    'fallback_used_field_ids', COALESCE((
      SELECT jsonb_agg(DISTINCT bf.field_id) FROM billing_fallback bf
    ), '[]'::jsonb)
  ) INTO v_result
  FROM combined cb;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_field_billing_splits_for_order(p_order_id uuid)
 RETURNS TABLE(customer_id uuid, split_pct numeric, is_primary boolean, field_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Office staff only (active admin or sales rep); every other account is refused (row 11.4).
  PERFORM public.require_admin_or_sales_rep();
  RETURN QUERY
    SELECT DISTINCT fbd.customer_id, fbd.split_pct, fbd.is_primary, fbd.field_id
    FROM orders o JOIN quotes q ON q.id = o.quote_id
    JOIN quote_sections qs ON qs.quote_id = q.id
    JOIN field_billing_defaults fbd ON fbd.field_id = qs.field_id
    WHERE o.id = p_order_id AND qs.field_id IS NOT NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_field_billing_splits_for_blend_ticket(p_blend_ticket_id uuid)
 RETURNS TABLE(customer_id uuid, split_pct numeric, is_primary boolean, field_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Office staff only (active admin or sales rep); every other account is refused (row 11.4).
  PERFORM public.require_admin_or_sales_rep();
  RETURN QUERY
    SELECT DISTINCT fbd.customer_id, fbd.split_pct, fbd.is_primary, fbd.field_id
    FROM blend_ticket_fields btf JOIN field_billing_defaults fbd ON fbd.field_id = btf.field_id
    WHERE btf.blend_ticket_id = p_blend_ticket_id
    UNION
    SELECT DISTINCT fbd.customer_id, fbd.split_pct, fbd.is_primary, fbd.field_id
    FROM blend_tickets bt JOIN field_billing_defaults fbd ON fbd.field_id = bt.field_id
    WHERE bt.id = p_blend_ticket_id AND bt.field_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM blend_ticket_fields btf2 WHERE btf2.blend_ticket_id = p_blend_ticket_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_customer_summary(p_customer_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
  v_ar_balance bigint;
  v_order_count int;
  v_delivery_count int;
  v_credit_tier int;
  v_last_activity timestamptz;
  v_season_start date;
  v_season_end date;
BEGIN
  -- Office staff only (active admin or sales rep); every other account is refused (row 11.4).
  PERFORM public.require_admin_or_sales_rep();
  IF extract(month FROM current_date) >= 10 THEN
    v_season_start := make_date(extract(year FROM current_date)::int, 10, 1);
    v_season_end := make_date(extract(year FROM current_date)::int + 1, 9, 30);
  ELSE
    v_season_start := make_date(extract(year FROM current_date)::int - 1, 10, 1);
    v_season_end := make_date(extract(year FROM current_date)::int, 9, 30);
  END IF;

  SELECT COALESCE(sum(balance_cents), 0)
  INTO v_ar_balance
  FROM invoices
  WHERE customer_id = p_customer_id
    AND status IN ('posted', 'overdue');

  SELECT count(*)
  INTO v_order_count
  FROM orders
  WHERE customer_id = p_customer_id
    AND order_date >= v_season_start
    AND order_date <= v_season_end
    AND status NOT IN ('cancelled', 'voided');

  SELECT count(*)
  INTO v_delivery_count
  FROM deliveries
  WHERE customer_id = p_customer_id
    AND status = 'completed'
    AND completed_at >= v_season_start
    AND completed_at <= v_season_end;

  SELECT assigned_tier
  INTO v_credit_tier
  FROM customers
  WHERE id = p_customer_id;

  SELECT max(created_at)
  INTO v_last_activity
  FROM activity_feed
  WHERE customer_id = p_customer_id;

  v_result := jsonb_build_object(
    'ar_balance_cents', v_ar_balance,
    'order_count', v_order_count,
    'delivery_count', v_delivery_count,
    'credit_tier', v_credit_tier,
    'last_activity', v_last_activity
  );

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.check_customer_credit_limit(p_customer_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_credit_limit_cents bigint;
  v_farm_name text;
  v_outstanding_ar_cents bigint;
BEGIN
  -- Office staff only (active admin or sales rep); every other account is refused (row 11.4).
  PERFORM public.require_admin_or_sales_rep();
  -- Get customer info
  SELECT credit_limit_cents, farm_name
  INTO v_credit_limit_cents, v_farm_name
  FROM customers
  WHERE id = p_customer_id;

  IF v_credit_limit_cents IS NULL OR v_credit_limit_cents <= 0 THEN
    RETURN jsonb_build_object(
      'exceeded', false,
      'credit_limit', 0,
      'outstanding_ar', 0,
      'farm_name', COALESCE(v_farm_name, '')
    );
  END IF;

  SELECT COALESCE(SUM(GREATEST(balance_cents, 0)), 0)
  INTO v_outstanding_ar_cents
  FROM invoices
  WHERE customer_id = p_customer_id
    AND status IN ('posted', 'overdue', 'unposted')
    AND deleted_at IS NULL;

  RETURN jsonb_build_object(
    'exceeded', v_outstanding_ar_cents > v_credit_limit_cents,
    'credit_limit', v_credit_limit_cents / 100.0,
    'outstanding_ar', v_outstanding_ar_cents / 100.0,
    'available_credit', GREATEST(v_credit_limit_cents - v_outstanding_ar_cents, 0) / 100.0,
    'farm_name', COALESCE(v_farm_name, '')
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_dashboard_action_items(p_limit integer DEFAULT 5)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb := '{}'::jsonb;
  v_today date := (now() AT TIME ZONE 'America/Chicago')::date;
BEGIN
  -- Office staff only (active admin or sales rep); every other account is refused (row 11.4).
  PERFORM public.require_admin_or_sales_rep();
  -- 1. Overdue Invoices
  SELECT jsonb_agg(row_to_json(t))
  INTO v_result
  FROM (
    SELECT
      'overdue_invoice' AS category,
      i.id,
      i.invoice_number AS primary_text,
      c.farm_name AS secondary_text,
      (v_today - i.due_date) AS days_overdue,
      i.balance_cents AS amount_cents
    FROM invoices i
    JOIN customers c ON c.id = i.customer_id
    WHERE i.status = 'overdue'
      AND i.balance_cents > 0
      AND i.invoice_type <> 'credit_memo'
      AND i.deleted_at IS NULL
    ORDER BY (v_today - i.due_date) DESC
    LIMIT p_limit
  ) t;

  v_result := jsonb_build_object('overdue_invoices', COALESCE(v_result, '[]'::jsonb));

  -- 2. Cancelled Orders with Posted Invoices
  v_result := v_result || jsonb_build_object('cancelled_posted', (
    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    FROM (
      SELECT
        o.id,
        o.order_number AS primary_text,
        c.farm_name AS secondary_text,
        i.invoice_number
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      JOIN invoices i ON i.order_id = o.id
        AND i.status = 'posted'
        AND i.invoice_type <> 'credit_memo'
        AND i.deleted_at IS NULL
      WHERE o.status = 'cancelled'
      ORDER BY o.created_at DESC
      LIMIT p_limit
    ) t
  ));

  -- 3. Overdue Deliveries
  v_result := v_result || jsonb_build_object('overdue_deliveries', (
    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    FROM (
      SELECT
        d.id,
        d.delivery_number AS primary_text,
        c.farm_name AS secondary_text,
        (v_today - d.scheduled_date) AS days_overdue
      FROM deliveries d
      JOIN customers c ON c.id = d.customer_id
      WHERE d.status IN ('scheduled', 'in_progress')
        AND d.scheduled_date < v_today
      ORDER BY d.scheduled_date ASC
      LIMIT p_limit
    ) t
  ));

  -- 4. Low Stock Items
  v_result := v_result || jsonb_build_object('low_stock', (
    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    FROM (
      SELECT
        p.id,
        p.product_name AS primary_text,
        p.category AS secondary_text,
        COALESCE(inv.quantity_available, 0) AS current_qty,
        COALESCE(inv.reorder_point, 0) AS reorder_point
      FROM products p
      JOIN inventory inv ON inv.product_id = p.id
      WHERE p.is_active = true
        AND (
          (inv.reorder_point IS NOT NULL
            AND inv.reorder_point > 0
            AND COALESCE(inv.quantity_available, 0) < inv.reorder_point)
          OR COALESCE(inv.quantity_available, 0) < 0
        )
      ORDER BY (COALESCE(inv.quantity_available, 0)::float / NULLIF(inv.reorder_point, 0)) ASC
      LIMIT p_limit
    ) t
  ));

  -- 5. Expiring Quotes (within 7 days)
  v_result := v_result || jsonb_build_object('expiring_quotes', (
    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    FROM (
      SELECT
        q.id,
        q.quote_number AS primary_text,
        c.farm_name AS secondary_text,
        (q.expires_at::date - v_today) AS days_until_expiry
      FROM quotes q
      JOIN customers c ON c.id = q.customer_id
      WHERE q.status IN ('sent', 'revised')
        AND q.is_planned = false
        AND q.expires_at IS NOT NULL
        AND q.expires_at::date BETWEEN v_today AND (v_today + interval '7 days')
      ORDER BY q.expires_at ASC
      LIMIT p_limit
    ) t
  ));

  -- 6. Unassigned Deliveries
  v_result := v_result || jsonb_build_object('unassigned_deliveries', (
    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    FROM (
      SELECT
        d.id,
        d.delivery_number AS primary_text,
        c.farm_name AS secondary_text,
        d.scheduled_date
      FROM deliveries d
      JOIN customers c ON c.id = d.customer_id
      WHERE d.status = 'scheduled'
        AND d.assigned_driver IS NULL
      ORDER BY d.scheduled_date ASC
      LIMIT p_limit
    ) t
  ));

  -- U13<<< 7. Unassigned Jobs (findings #15-21/#111): a SCHEDULED job with no
  -- currently-active per-location dispatch — neither the wizard's per-location
  -- assignment NOR (indirectly, via the sync triggers above) a whole-job
  -- applicator has reached the field crew. deleted_at IS NULL mirrors the other
  -- job reads.
  v_result := v_result || jsonb_build_object('unassigned_jobs', (
    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    FROM (
      SELECT
        j.id,
        j.job_number AS primary_text,
        c.farm_name AS secondary_text,
        j.job_date AS scheduled_date
      FROM jobs j
      JOIN customers c ON c.id = j.customer_id
      WHERE j.status = 'scheduled'
        AND j.deleted_at IS NULL
        -- Codex R1 P2: a job with a legacy WHOLE-JOB applicator is assigned,
        -- not "unassigned" — pre-trigger jobs have no dispatch rows yet (no
        -- backfill: business-data writes are outside this run's additive-only
        -- mandate; rows materialize via the triggers on the next edit, and
        -- FieldView already surfaces legacy assignments client-side).
        AND j.applicator_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM job_location_dispatches d
          WHERE d.job_id = j.id AND d.dispatch_status = 'dispatched'
        )
      ORDER BY j.job_date ASC
      LIMIT p_limit
    ) t
  ));
  -- >>>U13

  -- 8. Due-today deliveries that have not been started.
  v_result := v_result || jsonb_build_object('due_today_not_started', (
    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    FROM (
      SELECT
        d.id,
        d.delivery_number AS primary_text,
        c.farm_name AS secondary_text,
        d.scheduled_date
      FROM deliveries d
      JOIN customers c ON c.id = d.customer_id
      WHERE d.scheduled_date = v_today
        AND d.status = 'scheduled'
        AND d.deleted_at IS NULL
      ORDER BY d.delivery_number ASC
      LIMIT p_limit
    ) t
  ));

  -- 9. Completed deliveries not covered by an active delivery- or order-level invoice,
  --    and not billed outside CRX (delivery_external_billings).
  v_result := v_result || jsonb_build_object('unbilled_deliveries', (
    SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    FROM (
      SELECT
        d.id,
        d.delivery_number AS primary_text,
        c.farm_name AS secondary_text,
        d.scheduled_date
      FROM deliveries d
      JOIN customers c ON c.id = d.customer_id
      WHERE d.status = 'completed'
        AND d.deleted_at IS NULL
        AND d.order_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM invoices i
          WHERE i.order_id = d.order_id
            AND i.status NOT IN ('voided', 'cancelled')
            AND (i.delivery_id = d.id OR i.delivery_id IS NULL)
            AND i.invoice_type <> 'credit_memo'
            AND i.deleted_at IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM delivery_external_billings b WHERE b.delivery_id = d.id
        )
      ORDER BY d.scheduled_date ASC
      LIMIT p_limit
    ) t
  ));

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public._check_credit_limit(p_customer_id uuid, p_additional_cents bigint DEFAULT 0)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_customer    record;
  v_ar_balance  bigint;
BEGIN
  -- Office staff only (active admin or sales rep); every other account is refused (row 11.4).
  PERFORM public.require_admin_or_sales_rep();
  SELECT credit_limit_cents, farm_name INTO v_customer FROM customers WHERE id = p_customer_id;
  IF COALESCE(v_customer.credit_limit_cents, 0) = 0 THEN RETURN; END IF;

  SELECT COALESCE(SUM(balance_cents), 0) INTO v_ar_balance
  FROM invoices WHERE customer_id = p_customer_id AND status IN ('draft', 'posted', 'overdue');

  v_ar_balance := v_ar_balance + p_additional_cents;

  IF v_ar_balance >= v_customer.credit_limit_cents THEN
    RAISE EXCEPTION 'Credit limit exceeded for customer "%": limit $%, current AR balance $%',
      v_customer.farm_name, (v_customer.credit_limit_cents / 100.0)::numeric(12,2), (v_ar_balance / 100.0)::numeric(12,2);
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_customer_delivery_remainders(p_customer_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  -- Office staff only (active admin or sales rep); every other account is refused (row 11.4).
  PERFORM public.require_admin_or_sales_rep();
  SELECT COALESCE(jsonb_agg(row_to_json(r)), '[]'::jsonb) INTO v_result
  FROM (
    SELECT
      dr.id,
      dr.original_delivery_id,
      dr.order_id,
      dr.order_item_id,
      dr.customer_id,
      dr.product_id,
      dr.quantity_remaining,
      dr.unit_size,
      dr.status,
      dr.followup_delivery_id,
      dr.notes,
      dr.created_at,
      c.farm_name AS customer_name,
      p.product_name,
      d.delivery_number AS original_delivery_number,
      d.scheduled_date AS original_delivery_date,
      o.order_number
    FROM delivery_remainders dr
    JOIN customers c ON c.id = dr.customer_id
    JOIN products p ON p.id = dr.product_id
    JOIN deliveries d ON d.id = dr.original_delivery_id
    JOIN orders o ON o.id = dr.order_id
    WHERE (p_customer_id IS NULL OR dr.customer_id = p_customer_id)
    ORDER BY dr.created_at DESC
  ) r;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.check_duplicate_delivery(p_order_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  -- Office staff only (active admin or sales rep); every other account is refused (row 11.4).
  PERFORM public.require_admin_or_sales_rep();
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'delivery_id', d.id,
    'delivery_number', d.delivery_number,
    'status', d.status,
    'scheduled_date', d.scheduled_date
  )), '[]'::jsonb)
  INTO v_result
  FROM deliveries d
  WHERE d.order_id = p_order_id
    AND d.status IN ('scheduled', 'in_progress');

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.global_search(p_query text, p_limit integer DEFAULT 5)
 RETURNS TABLE(entity_type text, id uuid, primary_text text, secondary_text text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pattern text;
  v_escaped text;
BEGIN
  -- The command palette is in every role's layout; only office staff get results (row 11.4).
  IF NOT (public.is_admin() OR public.is_sales_rep()) THEN
    RETURN;
  END IF;

  IF length(trim(p_query)) < 2 THEN
    RETURN;
  END IF;

  v_escaped := regexp_replace(trim(p_query), '([%_\\])', E'\\\\\\1', 'g');
  v_pattern := '%' || v_escaped || '%';

  RETURN QUERY
  (
    SELECT
      'customer'::text AS entity_type,
      c.id,
      c.farm_name AS primary_text,
      COALESCE(c.contact_name, '')::text AS secondary_text
    FROM customers c
    WHERE c.is_active = true
      AND (c.farm_name ILIKE v_pattern OR c.contact_name ILIKE v_pattern OR c.account_number ILIKE v_pattern)
    ORDER BY c.farm_name
    LIMIT p_limit
  )
  UNION ALL
  (
    SELECT
      'order'::text AS entity_type,
      o.id,
      o.order_number AS primary_text,
      COALESCE(c2.farm_name, '')::text AS secondary_text
    FROM orders o
    LEFT JOIN customers c2 ON c2.id = o.customer_id
    WHERE o.order_number ILIKE v_pattern
    ORDER BY o.created_at DESC
    LIMIT p_limit
  )
  UNION ALL
  (
    SELECT
      'invoice'::text AS entity_type,
      i.id,
      i.invoice_number AS primary_text,
      COALESCE(c3.farm_name, '')::text AS secondary_text
    FROM invoices i
    LEFT JOIN customers c3 ON c3.id = i.customer_id
    WHERE i.invoice_number ILIKE v_pattern
    ORDER BY i.created_at DESC
    LIMIT p_limit
  )
  UNION ALL
  (
    SELECT
      'delivery'::text AS entity_type,
      d.id,
      d.delivery_number AS primary_text,
      COALESCE(c4.farm_name, '')::text AS secondary_text
    FROM deliveries d
    LEFT JOIN customers c4 ON c4.id = d.customer_id
    WHERE d.delivery_number ILIKE v_pattern
    ORDER BY d.created_at DESC
    LIMIT p_limit
  )
  UNION ALL
  (
    SELECT
      'product'::text AS entity_type,
      p.id,
      p.product_name AS primary_text,
      COALESCE(p.category, '')::text AS secondary_text
    FROM products p
    WHERE p.is_active = true
      AND (p.product_name ILIKE v_pattern OR p.sku ILIKE v_pattern)
    ORDER BY p.product_name
    LIMIT p_limit
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_notes_for_entity(p_entity_type text, p_entity_id uuid)
 RETURNS SETOF team_notes
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_can_read_record boolean;
BEGIN
  -- Runs as the caller (SECURITY INVOKER), so the row security of team_notes and of the linked
  -- record's own table both apply: notes come back only for a record the caller can already read
  -- (office staff any; an applicator a job they may see; a driver a delivery assigned to them),
  -- and never to an inactive account (row 11.4). An unknown type is office-only.
  v_can_read_record := CASE p_entity_type
    WHEN 'customer'       THEN EXISTS (SELECT 1 FROM public.customers       x WHERE x.id = p_entity_id)
    WHEN 'order'          THEN EXISTS (SELECT 1 FROM public.orders          x WHERE x.id = p_entity_id)
    WHEN 'delivery'       THEN EXISTS (SELECT 1 FROM public.deliveries      x WHERE x.id = p_entity_id)
    WHEN 'job'            THEN EXISTS (SELECT 1 FROM public.jobs            x WHERE x.id = p_entity_id)
    WHEN 'purchase_order' THEN EXISTS (SELECT 1 FROM public.purchase_orders x WHERE x.id = p_entity_id)
    WHEN 'quote'          THEN EXISTS (SELECT 1 FROM public.quotes          x WHERE x.id = p_entity_id)
    WHEN 'invoice'        THEN EXISTS (SELECT 1 FROM public.invoices        x WHERE x.id = p_entity_id)
    WHEN 'product'        THEN EXISTS (SELECT 1 FROM public.products        x WHERE x.id = p_entity_id)
    ELSE (public.is_admin() OR public.is_sales_rep())
  END;
  IF v_can_read_record IS NOT TRUE THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT tn.*
    FROM team_notes tn
    WHERE tn.linked_entity_type = p_entity_type
      AND tn.linked_entity_id = p_entity_id
      AND tn.deleted_at IS NULL
    ORDER BY tn.is_pinned DESC, tn.created_at DESC;
END;
$function$;

CREATE OR REPLACE FUNCTION public.operational_dashboard_summary()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  result       jsonb;
  _season_start date;
  _season_end   date;
BEGIN
  -- Role check (ROLE-8)
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- Calculate season boundaries (Oct 1 – Sep 30)
  IF EXTRACT(MONTH FROM CURRENT_DATE) >= 10 THEN
    _season_start := MAKE_DATE(EXTRACT(YEAR FROM CURRENT_DATE)::int, 10, 1);
    _season_end   := MAKE_DATE(EXTRACT(YEAR FROM CURRENT_DATE)::int + 1, 9, 30);
  ELSE
    _season_start := MAKE_DATE(EXTRACT(YEAR FROM CURRENT_DATE)::int - 1, 10, 1);
    _season_end   := MAKE_DATE(EXTRACT(YEAR FROM CURRENT_DATE)::int, 9, 30);
  END IF;

  WITH
  active_orders AS (
    SELECT COUNT(*) AS cnt
    FROM orders
    WHERE status IN ('confirmed', 'partially_fulfilled')
      AND deleted_at IS NULL
  ),
  open_quotes AS (
    SELECT
      COUNT(*) FILTER (WHERE status = 'draft') AS draft_cnt,
      COUNT(*) FILTER (WHERE status = 'sent')  AS sent_cnt
    FROM quotes
  ),
  pending_deliveries AS (
    SELECT COUNT(*) AS cnt
    FROM deliveries
    WHERE status IN ('scheduled', 'in_progress')
  ),
  open_pos AS (
    SELECT COUNT(*) AS cnt
    FROM purchase_orders
    WHERE status IN ('submitted', 'partially_received')
  ),
  inv_agg AS (
    SELECT
      COALESCE(SUM(quantity_available), 0) AS total_available,
      COALESCE(SUM(quantity_prebooked), 0) AS total_prebooked
    FROM inventory
  ),
  on_order_units AS (
    SELECT
      COALESCE(SUM(poi.quantity_ordered - COALESCE(poi.quantity_received, 0)), 0) AS units,
      COUNT(DISTINCT po.id) AS po_count
    FROM purchase_order_items poi
    JOIN purchase_orders po ON po.id = poi.purchase_order_id
    WHERE po.status IN ('submitted', 'partially_received')
  ),
  committed_units AS (
    SELECT
      COALESCE(SUM(oi.quantity_remaining), 0) AS units,
      COUNT(DISTINCT o.id) AS order_count
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.status IN ('confirmed', 'partially_fulfilled')
      AND o.deleted_at IS NULL
      AND oi.quantity_remaining > 0
  ),
  upcoming AS (
    SELECT jsonb_agg(row_to_json(ud)::jsonb ORDER BY ud.scheduled_date ASC) AS arr
    FROM (
      SELECT
        d.id,
        d.delivery_number,
        d.scheduled_date::text AS scheduled_date,
        d.status,
        cust.farm_name AS customer_name,
        drv.full_name  AS driver_name,
        d.assigned_driver
      FROM deliveries d
      LEFT JOIN customers cust ON cust.id = d.customer_id
      LEFT JOIN profiles  drv  ON drv.id  = d.assigned_driver
      WHERE d.status IN ('scheduled', 'in_progress')
      ORDER BY d.scheduled_date ASC
      LIMIT 10
    ) ud
  ),
  delivery_stats AS (
    SELECT
      COUNT(*) FILTER (WHERE d.scheduled_date = CURRENT_DATE)                                AS today_count,
      COUNT(*) FILTER (WHERE d.scheduled_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 6)     AS this_week_count,
      COUNT(*) FILTER (WHERE d.assigned_driver IS NULL)                                       AS unassigned_count
    FROM deliveries d
    WHERE d.status IN ('scheduled', 'in_progress')
  ),
  remainder_count AS (
    SELECT COUNT(*) AS cnt
    FROM delivery_remainders
    WHERE status = 'pending'
  ),
  quote_pipeline AS (
    SELECT
      COUNT(*) FILTER (WHERE status = 'draft')    AS draft_cnt,
      COUNT(*) FILTER (WHERE status = 'sent')     AS sent_cnt,
      COUNT(*) FILTER (WHERE status = 'accepted') AS accepted_cnt
    FROM quotes
  ),
  orders_ytd AS (
    SELECT
      COUNT(*) AS season_total,
      COUNT(*) FILTER (
        WHERE DATE_TRUNC('month', COALESCE(order_date, created_at::date)) = DATE_TRUNC('month', CURRENT_DATE)
      ) AS this_month
    FROM orders
    WHERE COALESCE(order_date, created_at::date) >= _season_start
      AND deleted_at IS NULL
  ),
  deliveries_completed AS (
    SELECT
      COUNT(*) AS season_total,
      COUNT(*) FILTER (
        WHERE DATE_TRUNC('month', completed_at) = DATE_TRUNC('month', CURRENT_DATE)
      ) AS this_month
    FROM deliveries
    WHERE status = 'completed'
      AND completed_at >= _season_start
  ),
  low_stock AS (
    SELECT COUNT(*) AS cnt
    FROM inventory
    WHERE reorder_point > 0
      AND quantity_available <= reorder_point
  ),
  driver_issues AS (
    SELECT COUNT(*) AS cnt
    FROM deliveries
    WHERE issue_type IS NOT NULL
      AND status = 'completed'
  ),
  expired_holds AS (
    SELECT COUNT(DISTINCT q.id) AS cnt
    FROM quotes q
    JOIN inventory_holds ih ON ih.source_id = q.id AND ih.is_active = true
    WHERE q.status IN ('expired', 'declined')
  ),
  cancelled_posted AS (
    SELECT COUNT(DISTINCT d.id) AS cnt
    FROM deliveries d
    JOIN orders o ON o.id = d.order_id
    JOIN invoices i ON i.order_id = o.id
    WHERE d.status = 'cancelled'
      AND i.status = 'posted'
  ),
  expiring_quotes AS (
    SELECT COUNT(*) AS cnt
    FROM quotes
    WHERE status IN ('draft', 'sent')
      AND expires_at IS NOT NULL
      AND expires_at BETWEEN CURRENT_DATE AND CURRENT_DATE + 3
  ),
  overdue_deliveries AS (
    SELECT COUNT(*) AS cnt
    FROM deliveries
    WHERE scheduled_date < CURRENT_DATE
      AND status IN ('scheduled', 'in_progress')
  ),
  pos_expected_today AS (
    SELECT COUNT(*) AS cnt
    FROM purchase_orders
    WHERE expected_delivery_date = CURRENT_DATE
      AND status IN ('submitted', 'partially_received')
  ),
  expiring_licenses AS (
    SELECT COUNT(*) AS cnt
    FROM applicator_licenses
    WHERE is_active = true
      AND expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30
  ),
  monthly_activity AS (
    SELECT jsonb_agg(row_to_json(ma)::jsonb ORDER BY ma.month) AS arr
    FROM (
      SELECT
        m.month,
        COALESCE(oc.cnt, 0) AS orders_created,
        COALESCE(dc.cnt, 0) AS deliveries_completed,
        COALESCE(pr.cnt, 0) AS pos_received
      FROM (
        SELECT TO_CHAR(d, 'YYYY-MM') AS month
        FROM generate_series(
          DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '11 months',
          DATE_TRUNC('month', CURRENT_DATE),
          '1 month'::interval
        ) d
      ) m
      LEFT JOIN (
        SELECT TO_CHAR(COALESCE(order_date, created_at::date), 'YYYY-MM') AS month, COUNT(*) AS cnt
        FROM orders WHERE deleted_at IS NULL GROUP BY 1
      ) oc ON oc.month = m.month
      LEFT JOIN (
        SELECT TO_CHAR(completed_at, 'YYYY-MM') AS month, COUNT(*) AS cnt
        FROM deliveries WHERE status = 'completed' AND completed_at IS NOT NULL GROUP BY 1
      ) dc ON dc.month = m.month
      LEFT JOIN (
        SELECT TO_CHAR(received_at, 'YYYY-MM') AS month, COUNT(*) AS cnt
        FROM receiving_records GROUP BY 1
      ) pr ON pr.month = m.month
      ORDER BY m.month
    ) ma
  ),
  period_info AS (
    SELECT
      COALESCE(TO_CHAR(period_start, 'Mon YYYY'), TO_CHAR(NOW(), 'Mon YYYY')) AS name,
      COALESCE(status, 'open') AS status,
      CASE
        WHEN period_end IS NOT NULL
          THEN GREATEST(EXTRACT(DAY FROM period_end - NOW())::int, 0)
        ELSE EXTRACT(DAY FROM (DATE_TRUNC('month', NOW()) + INTERVAL '1 month' - INTERVAL '1 day') - NOW())::int
      END AS days_remaining
    FROM accounting_periods
    WHERE status = 'open'
    ORDER BY period_start DESC
    LIMIT 1
  ),
  activity AS (
    SELECT jsonb_agg(row_to_json(af)::jsonb ORDER BY af.created_at DESC) AS arr
    FROM (
      SELECT id, event_type, description, created_at
      FROM activity_feed
      ORDER BY created_at DESC
      LIMIT 15
    ) af
  ),
  team_action_items AS (
    SELECT jsonb_agg(row_to_json(ti)::jsonb) AS arr
    FROM (
      SELECT
        tn.id,
        tn.title,
        tn.priority,
        tn.due_date::text AS due_date,
        tn.note_type,
        tn.is_pinned,
        tn.assigned_to,
        p.full_name AS assignee_name
      FROM team_notes tn
      LEFT JOIN profiles p ON p.id = tn.assigned_to
      WHERE tn.is_completed = false
        AND tn.deleted_at IS NULL
        AND (
          tn.is_pinned = true
          OR tn.priority IN ('urgent', 'high')
          OR (tn.due_date IS NOT NULL AND tn.due_date < CURRENT_DATE)
          OR tn.assigned_to = auth.uid()
        )
      ORDER BY
        CASE WHEN tn.is_pinned THEN 0 ELSE 1 END,
        CASE tn.priority
          WHEN 'urgent' THEN 0
          WHEN 'high'   THEN 1
          WHEN 'medium' THEN 2
          ELSE 3
        END,
        tn.due_date NULLS LAST
      LIMIT 10
    ) ti
  )

  SELECT jsonb_build_object(
    'active_orders_count',        ao.cnt,
    'open_quotes_draft',          oq.draft_cnt,
    'open_quotes_sent',           oq.sent_cnt,
    'pending_deliveries_count',   pd.cnt,
    'open_pos_count',             op.cnt,
    'team_action_items',          COALESCE(tai.arr, '[]'::jsonb),
    'inventory_available',        ia.total_available,
    'inventory_prebooked',        ia.total_prebooked,
    'on_order_units',             oou.units,
    'on_order_po_count',          oou.po_count,
    'committed_units',            cu.units,
    'committed_order_count',      cu.order_count,
    'upcoming_deliveries',        COALESCE(ud.arr, '[]'::jsonb),
    'delivery_today',             ds.today_count,
    'delivery_this_week',         ds.this_week_count,
    'delivery_unassigned',        ds.unassigned_count,
    'delivery_remainders_count',  rc.cnt,
    'quote_pipeline_draft',       qp.draft_cnt,
    'quote_pipeline_sent',        qp.sent_cnt,
    'quote_pipeline_accepted',    qp.accepted_cnt,
    'orders_ytd_total',           oytd.season_total,
    'orders_this_month',          oytd.this_month,
    'deliveries_completed_total', dcomp.season_total,
    'deliveries_completed_this_month', dcomp.this_month,
    'low_stock_count',            ls.cnt,
    'driver_issues_count',        di.cnt,
    'expired_holds_count',        eh.cnt,
    'cancelled_posted_count',     cp.cnt,
    'expiring_quotes_count',      eq.cnt,
    'overdue_deliveries_count',   od.cnt,
    'pos_expected_today_count',   pet.cnt,
    'expiring_licenses_count',    el.cnt,
    'monthly_activity',           COALESCE(mact.arr, '[]'::jsonb),
    'season_label',               CASE WHEN EXTRACT(MONTH FROM CURRENT_DATE) >= 10
                                    THEN EXTRACT(YEAR FROM CURRENT_DATE)::int || '-' || (EXTRACT(YEAR FROM CURRENT_DATE)::int + 1)
                                    ELSE (EXTRACT(YEAR FROM CURRENT_DATE)::int - 1) || '-' || EXTRACT(YEAR FROM CURRENT_DATE)::int
                                  END,
    'season_days_remaining',      (_season_end - CURRENT_DATE),
    'season_days_elapsed',        (CURRENT_DATE - _season_start),
    'period_name',                COALESCE(pi.name, TO_CHAR(NOW(), 'Mon YYYY')),
    'period_status',              COALESCE(pi.status, 'open'),
    'period_days_remaining',      COALESCE(pi.days_remaining, 0),
    'recent_activity',            COALESCE(act.arr, '[]'::jsonb)
  ) INTO result
  FROM active_orders       ao
  CROSS JOIN open_quotes        oq
  CROSS JOIN pending_deliveries pd
  CROSS JOIN open_pos           op
  CROSS JOIN inv_agg            ia
  CROSS JOIN on_order_units     oou
  CROSS JOIN committed_units    cu
  CROSS JOIN upcoming           ud
  CROSS JOIN delivery_stats     ds
  CROSS JOIN remainder_count    rc
  CROSS JOIN quote_pipeline     qp
  CROSS JOIN orders_ytd         oytd
  CROSS JOIN deliveries_completed dcomp
  CROSS JOIN low_stock          ls
  CROSS JOIN driver_issues      di
  CROSS JOIN expired_holds      eh
  CROSS JOIN cancelled_posted   cp
  CROSS JOIN expiring_quotes    eq
  CROSS JOIN overdue_deliveries od
  CROSS JOIN pos_expected_today pet
  CROSS JOIN expiring_licenses  el
  CROSS JOIN monthly_activity   mact
  CROSS JOIN activity           act
  CROSS JOIN team_action_items  tai
  LEFT JOIN  period_info        pi ON true;

  RETURN result;
END;
$function$;
DO $postflight$
DECLARE
  v_fn record;
BEGIN
  IF to_regclass('pg_temp.field_functions_require_field_access_tx') IS NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: not the transaction the preflight ran in';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.field_functions_require_field_access_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: not the transaction the preflight ran in';
  END IF;

  FOR v_fn IN
    SELECT t.sig, t.new_md5, p.prosecdef, md5(replace(p.prosrc, chr(13), '')) AS body_md5,
           pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl, p.proconfig, p.prorettype, p.provolatile,
           a.owner AS was_owner, a.acl AS was_acl, a.proconfig AS was_config, a.prorettype AS was_rettype,
           a.provolatile AS was_volatile
      FROM (VALUES
      ('public.get_fields_geojson_by_ids(uuid[])',                 '872546370509ca21593a7e33242589e2'),
      ('public.get_field_geojson(uuid)',                           '94eaee40f427e356181468f649266ea1'),
      ('public.get_fields_with_geojson(uuid)',                     'c3b67d317374c73c6e2dd237989334b4'),
      ('public.get_field_polygons(uuid)',                          'e4aa703e62fc691ece702f882aec3bf8'),
      ('public.get_customer_farm_group(uuid)',                     '6f944c766a46db222e245baeba9a990a'),
      ('public.get_field_dashboard(uuid,integer)',                 'f7da583a4e6edc44d042f5784df3e77f'),
      ('public.derive_customer_shares_from_fields(uuid[],jsonb)',  'de9703b6a4bd4d02d32308a53ee89f54'),
      ('public.get_field_billing_splits_for_order(uuid)',          '5576ef1e59aa9ce2ce978cdbba460861'),
      ('public.get_field_billing_splits_for_blend_ticket(uuid)',   'dabade47ec02785e7de8f6ff543180c5'),
      ('public.get_customer_summary(uuid)',                        'bf700aa02e7df78c79f02a0dc425e583'),
      ('public.check_customer_credit_limit(uuid)',                 'fb3f50390b8354225714fe169aa579e2'),
      ('public.get_dashboard_action_items(integer)',               '7f919a8d0189478cbe1e023a6c7a7e5a'),
      ('public._check_credit_limit(uuid,bigint)',                  'ad51c24c9ffb4f0bb8f405520415a121'),
      ('public.get_customer_delivery_remainders(uuid)',            'bebc8009b2afb99f9dc1160af415d0a7'),
      ('public.check_duplicate_delivery(uuid)',                    'c3ddc5cd4118281a5240390e2e7bb11d'),
      ('public.global_search(text,integer)',                       '521ab818601d81960eb96ddadd8e0922'),
      ('public.get_notes_for_entity(text,uuid)',                   '3aff5d6775914808e15bccac72e92ec1'),
      ('public.operational_dashboard_summary()',                   '77655108c73c1a98d826a21d55d7739d')
      ) AS t(sig, new_md5)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(t.sig)
      -- CREATE OR REPLACE keeps each OID, so the preflight snapshot is matched by OID (not by the
      -- printed signature, which depends on the session search_path).
      LEFT JOIN pg_temp.field_functions_require_field_access_attrs a ON a.fn_oid = p.oid
  LOOP
    IF v_fn.body_md5 IS DISTINCT FROM v_fn.new_md5
       OR v_fn.was_owner IS NULL
       OR v_fn.owner IS DISTINCT FROM v_fn.was_owner
       OR v_fn.acl IS DISTINCT FROM v_fn.was_acl
       OR v_fn.proconfig IS DISTINCT FROM v_fn.was_config
       OR v_fn.prorettype IS DISTINCT FROM v_fn.was_rettype
       OR v_fn.provolatile IS DISTINCT FROM v_fn.was_volatile
       -- Every one stays SECURITY DEFINER except get_notes_for_entity, which now runs as the caller.
       OR v_fn.prosecdef IS DISTINCT FROM (v_fn.sig <> 'public.get_notes_for_entity(text,uuid)') THEN
      RAISE EXCEPTION 'POSTFLIGHT_FAIL: % is not the expected body/attributes (md5 %)', v_fn.sig, v_fn.body_md5;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_temp.field_functions_require_field_access_attrs) <> 18 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: not every pinned function was snapshotted';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = to_regprocedure('public._can_see_field(uuid)')
       AND p.prosecdef AND p.provolatile = 's' AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proconfig = ARRAY['search_path=public, pg_temp']
       AND p.proacl::text = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
       AND md5(replace(p.prosrc, chr(13), '')) = '0b7f544337f93adc79163cafe581222c') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: public._can_see_field(uuid) does not have the expected attributes or grants';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK: field functions require field access (row 11.4 part A)';
END;
$postflight$;
