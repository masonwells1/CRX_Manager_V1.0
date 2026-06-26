-- Field-app parity #37 follow-up (2026-06-26): stable paging order for get_dispatched_list.
-- ---------------------------------------------------------------------------
-- get_dispatched_list (added in 20260626140000) returns the current-dispatch rows the
-- Dispatch board's "View Dispatched List" renders, paged client-side via .range() in
-- DISPATCH_PAGE (1000-row) windows. Its ORDER BY was:
--
--     ORDER BY j.job_number, d.dispatched_at DESC
--
-- which is NOT a total order: two locations of the SAME job dispatched in the SAME
-- transaction share dispatched_at = now(). When such a tie straddles a 1000-row page
-- boundary, offset/limit paging can SKIP or DUPLICATE a row over the tie (a real but
-- latent paging-correctness bug — only bites past 1000 concurrent current dispatches).
--
-- FIX: add the row's primary key d.id as a final, unique tiebreaker so the sort is a
-- TOTAL order and paging is deterministic. This is the ONLY change — the body, signature,
-- security (SECURITY DEFINER + SET search_path=public, pg_temp), STABLE volatility,
-- visibility gate, and grants are replicated verbatim from 20260626140000.
--
-- ADDITIVE ONLY: a CREATE OR REPLACE of one existing function (still exactly one overload).
-- No table/policy/RPC is dropped. anon EXECUTE stays revoked.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_dispatched_list(
  p_applicator_id uuid DEFAULT NULL,
  p_crew_id       uuid DEFAULT NULL
) RETURNS SETOF jsonb
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'dispatch_id',     d.id,
    'job_field_id',    d.job_field_id,
    'job_id',          d.job_id,
    'job_number',      j.job_number,
    'job_status',      j.status,
    'dispatch_status', d.dispatch_status,
    'dispatched_at',   d.dispatched_at,
    'assignee_kind',   CASE WHEN d.applicator_id IS NOT NULL THEN 'applicator' ELSE 'crew' END,
    'applicator_id',   d.applicator_id,
    'crew_id',         d.crew_id,
    -- assignee NAME resolved server-side. field_name gated to the fields_select roles
    -- (admin/sales_rep/applicator) so a dispatched crew member whose role is not
    -- applicator never receives a field name they couldn't read under RLS (null ->
    -- the client falls back to 'Field'). Customer name gated likewise.
    'assignee_name',   CASE WHEN d.applicator_id IS NOT NULL
                            THEN (SELECT p.full_name FROM profiles p WHERE p.id = d.applicator_id)
                            ELSE (SELECT g.name FROM ground_crews g WHERE g.id = d.crew_id) END,
    'field_name',      CASE WHEN (is_admin() OR is_sales_rep() OR is_applicator())
                            THEN (SELECT f.field_name FROM fields f WHERE f.id = jf.field_id)
                            ELSE NULL END,
    'customer_name',   CASE WHEN (
                              is_admin()
                              OR (is_sales_rep() AND c.assigned_sales_rep = (select auth.uid()))
                              OR (is_applicator() AND EXISTS (
                                    SELECT 1 FROM public.jobs j2
                                     WHERE j2.customer_id = c.id
                                       AND j2.applicator_id = (select auth.uid())
                                       AND j2.job_date >= (CURRENT_DATE - interval '7 days')))
                              OR EXISTS (
                                    SELECT 1 FROM public.jobs j3
                                     WHERE j3.customer_id = c.id
                                       AND public._is_dispatched_to_me(j3.id))
                            ) THEN c.farm_name ELSE NULL END,
    'location_acres',  jf.acres_to_treat,
    'job_applied_acres', j.applied_acres,
    'job_total_acres',   j.total_acres
  )
    FROM public.job_location_dispatches d
    JOIN public.jobs j        ON j.id = d.job_id AND j.deleted_at IS NULL
    JOIN public.job_fields jf ON jf.id = d.job_field_id
    JOIN public.customers c   ON c.id = j.customer_id
   WHERE d.dispatch_status = 'dispatched'
     AND (p_applicator_id IS NULL OR d.applicator_id = p_applicator_id)
     AND (p_crew_id IS NULL OR d.crew_id = p_crew_id)
     -- VISIBILITY GATE — mirror job_location_dispatches_select EXACTLY: never return a
     -- row the caller couldn't already SELECT on the table. is_admin()/is_sales_rep()/
     -- is_applicator() each re-check profiles.is_active internally, BUT the bare
     -- `applicator_id = auth.uid()` and crew-member branches must ALSO re-check is_active
     -- — this is a SECURITY DEFINER read that bypasses RLS, so without the re-check a
     -- DEACTIVATED user with a still-valid token would keep seeing their dispatch rows
     -- (the #36 policy includes this active-profile guard for exactly this reason —
     -- Codex #37 P1).
     AND (
       is_admin()
       OR is_sales_rep()
       OR (is_applicator() AND j.applicator_id = (select auth.uid()))
       OR (
         d.applicator_id = (select auth.uid())
         AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = (select auth.uid()) AND p.is_active)
       )
       OR (
         d.crew_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = (select auth.uid()) AND p.is_active)
         AND EXISTS (
           SELECT 1 FROM public.ground_crew_members gcm
             JOIN public.ground_crews gc ON gc.id = gcm.crew_id
            WHERE gcm.crew_id = d.crew_id
              AND gcm.profile_id = (select auth.uid())
              AND gcm.is_active
              AND gc.is_active
         )
       )
     )
   -- d.id is the UNIQUE tiebreaker that makes this a TOTAL order — without it two
   -- same-job/same-transaction rows (equal dispatched_at) can be skipped/duplicated
   -- across a .range() page boundary (Codex #37 follow-up LOW).
   ORDER BY j.job_number, d.dispatched_at DESC, d.id;
$$;

REVOKE EXECUTE ON FUNCTION public.get_dispatched_list(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_dispatched_list(uuid, uuid) TO authenticated, service_role;

-- ── Verification ────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_count int;
BEGIN
  -- still exactly one overload
  SELECT count(*) INTO v_count FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'get_dispatched_list';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'get_dispatched_list overload count is % (expected 1)', v_count;
  END IF;

  -- still SECURITY DEFINER with a pinned search_path
  SELECT count(*) INTO v_count FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND proname = 'get_dispatched_list'
     AND prosecdef = true
     AND array_to_string(coalesce(proconfig, '{}'), ',') LIKE '%search_path=public, pg_temp%';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'get_dispatched_list must stay SECURITY DEFINER with search_path=public, pg_temp';
  END IF;

  -- (The ORDER BY tiebreaker `d.id` is the sole change vs 20260626140000 — it is visible
  -- in the CREATE OR REPLACE body above; we don't assert it via pg_get_functiondef(), which
  -- the migration validator bans as a clone-by-regex footgun.)

  -- anon must NOT be able to execute it
  SELECT count(*) INTO v_count
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'get_dispatched_list'
     AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'anon must NOT have EXECUTE on get_dispatched_list (found %)', v_count;
  END IF;
END $$;
