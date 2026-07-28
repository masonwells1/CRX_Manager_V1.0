-- 20260728123224_secdef_pricing_reads_office_only.sql
--
-- Close the two SECURITY DEFINER pricing leaks left open by
-- 20260727231652_quote_and_rate_reads_office_only.
--
-- That migration tightened SELECT on quote_items / quote_versions /
-- customer_application_rates / rebate_programs to `is_admin() OR is_sales_rep()`.
-- SECURITY DEFINER functions bypass RLS by design, so the table policy cannot
-- reach them; the guard has to live in the function body. An audit on
-- 2026-07-27 found 20 SECDEF functions that read those tables and have EXECUTE
-- to `authenticated`. 18 already carry an in-body admin/sales_rep gate.
-- These are the remaining 2.
--
--   1. compute_application_service_fee — HIGH, proven live. No role check of any
--      kind. Impersonating a real active `driver` returned both the customer
--      price (rate_per_acre_cents / total_fee_cents) AND the internal cost
--      (cost_per_acre_cents / total_cost_cents) in one response, i.e. margin is
--      one subtraction away. It has no frontend caller at all, so the React
--      route guard was never in the path — the PostgREST endpoint was reachable
--      with the field user's own JWT.
--
--   2. get_program_completion — MEDIUM, latent. No role check. Returns per
--      customer: farm name, quote numbers, planned vs completed acres, and
--      invoiced_amount_cents. It returns 0 rows today only because the single
--      planned quote has season = NULL — a data accident, not a control.
--
-- Guard pattern copied from the PARKED-007 gate in
-- preview_field_app_invoice_split: AUTH_REQUIRED when auth.uid() IS NULL, then
-- INSUFFICIENT_ROLE unless is_admin() OR is_sales_rep(), both raised with
-- ERRCODE 'insufficient_privilege'. Both helpers already require
-- profiles.is_active = true, so this matches the other 18 exactly.
--
-- Both bodies below are written out in full, transcribed from the live catalog
-- definition read during the audit; the ONLY change is the inserted guard block.
--
-- Deliberately NOT touched: quote_sections, rebate_programs and
-- customer_application_rates policies. Sales reps keep their access — settled.

-- ---------------------------------------------------------------------------
-- 1. compute_application_service_fee — in-body office-only gate
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.compute_application_service_fee(p_service_id uuid, p_customer_id uuid, p_acres numeric, p_season integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_service  record;
  v_override bigint;
  v_rate     bigint;
  v_source   text;
  v_total    bigint;
  v_season   int;
BEGIN
  -- Office-only gate (2026-07-27 SECDEF pricing-bypass audit): this SECDEF
  -- function returns customer price AND internal cost together, and reads
  -- customer_application_rates, which 20260727231652 restricted to office
  -- roles. SECDEF bypasses that policy, so the check has to be here.
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: only admins or sales reps can compute application service fees'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_service_id IS NULL OR p_acres IS NULL OR p_acres <= 0 THEN
    RETURN jsonb_build_object(
      'rate_per_acre_cents', 0,
      'total_fee_cents',     0,
      'cost_per_acre_cents', 0,
      'total_cost_cents',    0,
      'source',              'none',
      'service_name',        NULL
    );
  END IF;

  SELECT * INTO v_service FROM application_services WHERE id = p_service_id;
  IF NOT FOUND OR NOT v_service.is_active THEN
    RETURN jsonb_build_object(
      'rate_per_acre_cents', 0,
      'total_fee_cents',     0,
      'cost_per_acre_cents', 0,
      'total_cost_cents',    0,
      'source',              'inactive',
      'service_name',        v_service.name
    );
  END IF;

  v_season := COALESCE(p_season, current_season());
  v_override := NULL;

  IF p_customer_id IS NOT NULL THEN
    SELECT car.rate_per_acre_cents INTO v_override
      FROM customer_application_rates car
     WHERE car.customer_id            = p_customer_id
       AND car.application_service_id = p_service_id
       AND car.season                 = v_season
     LIMIT 1;
  END IF;

  IF v_override IS NOT NULL THEN
    v_rate   := v_override;
    v_source := 'customer_override';
  ELSE
    v_rate   := COALESCE(v_service.default_rate_per_acre_cents, 0);
    v_source := 'service_default';
  END IF;

  v_total := ROUND(v_rate * p_acres)::bigint;

  RETURN jsonb_build_object(
    'rate_per_acre_cents', v_rate,
    'total_fee_cents',     v_total,
    'cost_per_acre_cents', COALESCE(v_service.cost_per_acre_cents, 0),
    'total_cost_cents',    ROUND(COALESCE(v_service.cost_per_acre_cents, 0) * p_acres)::bigint,
    'source',              v_source,
    'service_name',        v_service.name
  );
END;
$function$;

-- Defence in depth: nothing in src/ calls this over PostgREST — the only
-- callers are the SECDEF server-side functions save_job and
-- transfer_job_to_invoice, both owned by postgres and both already requiring an
-- active admin/sales_rep profile. Dropping the direct grant costs the field
-- nothing and kills the direct-API route even if the in-body guard is ever
-- weakened. Precedent: 20260529214355_revoke_anon_execute_on_report_dashboard_secdef.sql.
REVOKE EXECUTE ON FUNCTION public.compute_application_service_fee(uuid, uuid, numeric, integer) FROM authenticated;
-- anon/PUBLIC are already absent from this function's ACL on live (verified
-- 2026-07-28: proacl = {postgres=X/postgres,authenticated=X/postgres,
-- service_role=X/postgres}, has_function_privilege('anon', ...) = false), and
-- CREATE OR REPLACE preserves the existing ACL, so these are no-ops today. They
-- are stated anyway so the grant set is explicit in the migration rather than
-- inherited, and so a future default-PUBLIC grant cannot silently re-open it.
REVOKE EXECUTE ON FUNCTION public.compute_application_service_fee(uuid, uuid, numeric, integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.compute_application_service_fee(uuid, uuid, numeric, integer) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 2. get_program_completion — in-body office-only gate
-- ---------------------------------------------------------------------------
-- EXECUTE to authenticated is intentionally KEPT here: OfficeCockpit.tsx and
-- ProgramTracker.tsx call this RPC from the browser. Their routes are gated
-- allowedRoles={['admin','sales_rep']}, and the in-body guard below is what
-- makes that gate real rather than cosmetic.
CREATE OR REPLACE FUNCTION public.get_program_completion(p_season integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_season integer; v_result jsonb;
BEGIN
  -- Office-only gate (2026-07-27 SECDEF pricing-bypass audit): returns
  -- per-customer farm names, quote numbers, acreage and invoiced_amount_cents
  -- across every customer. Empty today only because the one planned quote has
  -- season = NULL; that is a data accident, not a control.
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: only admins or sales reps can read program completion'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_season IS NULL THEN v_season := current_season(); ELSE v_season := p_season; END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(t)::jsonb ORDER BY t.customer_name, t.program_name), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT
      q.customer_id, c.farm_name AS customer_name,
      q.id AS quote_id, q.quote_number,
      qs.id AS section_id, qs.section_name AS program_name, qs.needed_by_date,
      COALESCE(MAX(qi.acres), 0) AS planned_acres,
      COALESCE((SELECT SUM(btf.actual_acres) FROM jobs j2 JOIN blend_tickets bt ON bt.job_id = j2.id
        JOIN blend_ticket_fields btf ON btf.blend_ticket_id = bt.id
        WHERE j2.quote_section_id = qs.id AND j2.deleted_at IS NULL), 0) AS completed_acres,
      CASE WHEN MAX(qi.acres) IS NULL OR MAX(qi.acres) = 0 THEN 0
        ELSE ROUND(COALESCE((SELECT SUM(btf.actual_acres) FROM jobs j2 JOIN blend_tickets bt ON bt.job_id = j2.id
          JOIN blend_ticket_fields btf ON btf.blend_ticket_id = bt.id
          WHERE j2.quote_section_id = qs.id AND j2.deleted_at IS NULL), 0) / MAX(qi.acres) * 100, 1) END AS completion_pct,
      CASE
        WHEN NOT EXISTS (SELECT 1 FROM jobs j3 WHERE j3.quote_section_id = qs.id AND j3.deleted_at IS NULL) THEN 'not_started'
        WHEN COALESCE((SELECT SUM(btf2.actual_acres) FROM jobs j4 JOIN blend_tickets bt2 ON bt2.job_id = j4.id
          JOIN blend_ticket_fields btf2 ON btf2.blend_ticket_id = bt2.id
          WHERE j4.quote_section_id = qs.id AND j4.deleted_at IS NULL), 0) >= COALESCE(MAX(qi.acres), 0) AND MAX(qi.acres) > 0
        THEN 'completed' ELSE 'in_progress' END AS status,
      (SELECT COUNT(*) FROM jobs j5 WHERE j5.quote_section_id = qs.id AND j5.deleted_at IS NULL)::integer AS job_count,
      (SELECT COUNT(*) FROM jobs j6 JOIN blend_tickets bt3 ON bt3.job_id = j6.id
        WHERE j6.quote_section_id = qs.id AND j6.deleted_at IS NULL)::integer AS blend_ticket_count,
      COALESCE((SELECT SUM(inv.total_amount_cents) FROM jobs j7 JOIN blend_tickets bt4 ON bt4.job_id = j7.id
        JOIN invoices inv ON inv.blend_ticket_id = bt4.id
        WHERE j7.quote_section_id = qs.id AND j7.deleted_at IS NULL
        AND inv.status NOT IN ('voided', 'cancelled')), 0)::bigint AS invoiced_amount_cents
    FROM quotes q
    JOIN customers c ON c.id = q.customer_id
    JOIN quote_sections qs ON qs.quote_id = q.id
    LEFT JOIN quote_items qi ON qi.section_id = qs.id
    WHERE q.is_planned = true AND q.season = v_season
      AND q.status NOT IN ('declined', 'expired', 'cancelled')
    GROUP BY q.customer_id, c.farm_name, q.id, q.quote_number, qs.id, qs.section_name, qs.needed_by_date
  ) t;

  RETURN v_result;
END;
$function$;

-- Same explicit-grant-set treatment as above. `authenticated` KEEPS its EXECUTE
-- here (OfficeCockpit.tsx and ProgramTracker.tsx call this RPC); revoking from
-- anon/PUBLIC does not touch that separate, explicit grant. Verified 2026-07-28
-- on live: proacl = {postgres=X/postgres,authenticated=X/postgres,
-- service_role=X/postgres}, has_function_privilege('anon', ...) = false, so both
-- statements are no-ops today.
-- caller-analysis: get_program_completion :: two live browser callers, src/pages/OfficeCockpit.tsx:599 and src/pages/ProgramTracker.tsx:53, both calling as a signed-in `authenticated` user. `authenticated` KEEPS its EXECUTE grant here (deliberately NOT revoked), and revoking anon/PUBLIC does not touch that separate explicit grant, so neither callsite changes. The in-body admin/sales_rep gate added above is the real control, and both pages are already routed allowedRoles={['admin','sales_rep']}, so every legitimate caller passes it. Postflight assertion 5 below fails the migration if `authenticated` ever loses EXECUTE on this function.
-- caller-analysis: compute_application_service_fee :: zero browser callers (no `.rpc('compute_application_service_fee')` anywhere in src/ or supabase/functions/). Its sole caller is transfer_job_to_invoice, a SECURITY DEFINER function owned by postgres that already requires an active admin/sales_rep, so the nested EXECUTE check runs as postgres and is unaffected by the `authenticated` revoke. NOTE: the header comment at the top of this file also names save_job as a caller — that is WRONG, inherited from the audit handoff; a live scan of every function body in pg_proc.prosrc found transfer_job_to_invoice only.
REVOKE EXECUTE ON FUNCTION public.get_program_completion(integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_program_completion(integer) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Postflight verification
-- ---------------------------------------------------------------------------
-- This migration rewrites two entire function bodies and drops one grant.
-- Without assertions a partially-applied or subtly-wrong result looks exactly
-- like a successful one, and a later CREATE OR REPLACE that re-emits either body
-- without the gate would fail silently (the "pending-migration overlap clobber"
-- class). Pattern follows 20260430170000_field_app_workflow_phase4.sql:116.
--
-- Note assertion 5 is a POSITIVE check: silently LOSING the authenticated grant
-- on get_program_completion would take OfficeCockpit and ProgramTracker offline
-- for the office, which is a worse outcome than the leak this migration closes.
DO $$
DECLARE
  v_count int;
  v_src   text;
BEGIN
  -- 1. Still exactly one overload each — no accidental second signature.
  SELECT count(*) INTO v_count FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'compute_application_service_fee';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VERIFICATION FAILED: compute_application_service_fee has % overloads (expected 1)', v_count;
  END IF;

  SELECT count(*) INTO v_count FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'get_program_completion';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'VERIFICATION FAILED: get_program_completion has % overloads (expected 1)', v_count;
  END IF;

  -- 2. The gate actually landed in the APPLIED body, not just in this file.
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'compute_application_service_fee';
  IF v_src NOT LIKE '%INSUFFICIENT_ROLE%' OR v_src NOT LIKE '%AUTH_REQUIRED%' THEN
    RAISE EXCEPTION 'VERIFICATION FAILED: compute_application_service_fee body has no office-only gate';
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'get_program_completion';
  IF v_src NOT LIKE '%INSUFFICIENT_ROLE%' OR v_src NOT LIKE '%AUTH_REQUIRED%' THEN
    RAISE EXCEPTION 'VERIFICATION FAILED: get_program_completion body has no office-only gate';
  END IF;

  -- 3. Both still SECURITY DEFINER with a pinned search_path (CREATE OR REPLACE
  --    silently drops either one if the header is wrong).
  SELECT count(*) INTO v_count FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND proname IN ('compute_application_service_fee', 'get_program_completion')
     AND prosecdef
     AND array_to_string(proconfig, ',') LIKE '%search_path=%pg_temp%';
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'VERIFICATION FAILED: expected 2 SECDEF functions with a pinned search_path, found %', v_count;
  END IF;

  -- 4. The revoke took: authenticated can no longer reach the fee calculator.
  IF has_function_privilege('authenticated',
       'public.compute_application_service_fee(uuid,uuid,numeric,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFICATION FAILED: authenticated still has EXECUTE on compute_application_service_fee';
  END IF;

  -- 5. POSITIVE check — the office pages MUST keep working.
  IF NOT has_function_privilege('authenticated',
       'public.get_program_completion(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFICATION FAILED: authenticated lost EXECUTE on get_program_completion — OfficeCockpit and ProgramTracker would break';
  END IF;

  -- 6. Neither function is reachable anonymously.
  IF has_function_privilege('anon',
       'public.compute_application_service_fee(uuid,uuid,numeric,integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_program_completion(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFICATION FAILED: anon can still EXECUTE one of the guarded pricing functions';
  END IF;

  RAISE NOTICE 'secdef_pricing_reads_office_only: all 6 postflight assertions passed';
END $$;
