-- Field-app parity #37 (2026-06-26): Dispatched List + undispatch.
-- ---------------------------------------------------------------------------
-- Section #37 builds the "View Dispatched List" tracker on the Dispatch board: a
-- running list of every CURRENTLY-dispatched location, who it went to, its status,
-- and applied-of-total acres. Reassign reuses #36's dispatch_job_locations (upsert).
-- This migration adds the two server objects #37 needs that #36 did not provide:
--
--   1. undispatch_job_locations(p_job_field_ids uuid[], ...) — a SECDEF WRITE RPC
--      that REMOVES a location from dispatch. Because job_location_dispatches has
--      NO client write policy (writes are RPC-only, #36), undispatch must be an RPC.
--      It sets the matched CURRENT rows to dispatch_status='cancelled' (NOT a hard
--      DELETE) so the dispatch history is kept and the action is reversible by simply
--      re-dispatching. Cancelling REVOKES the former assignee's visibility (the #36
--      RLS predicates and _is_dispatched_to_me only grant on dispatch_status='dispatched'),
--      which is the desired effect. The 'cancelled' value is already allowed by the
--      existing job_location_dispatches dispatch_status CHECK — no constraint change.
--
--   2. get_dispatched_list(p_applicator_id, p_crew_id) — a SECDEF read RPC returning
--      the FULLY-SHAPED current-dispatch rows the board renders (assignee NAME resolved
--      server-side from profiles/ground_crews — never a profiles embed, which RLS nulls
--      for non-admins), each with the job number, field/location identity, status, and
--      acres (the location's acres_to_treat + the job's applied/total). This mirrors
--      get_dispatch_board_jobs: it resolves the list ENTIRELY in SQL so NO client-side
--      unbounded id-list (a 500-uuid id.in URL already fails the gateway — #36 lesson).
--
-- SECURITY: both functions mirror the live job_location_dispatches_select / jobs_select
-- visibility, so neither widens what the caller could already read. The write RPC gates
-- is_admin() OR is_sales_rep() (the dispatcher roles, same as dispatch_job_locations).
--
-- ADDITIVE ONLY: two new functions. No table/policy/RPC is dropped or rewritten; the
-- dispatch_status CHECK is unchanged (it already allows 'cancelled'). anon EXECUTE revoked.
-- ---------------------------------------------------------------------------

-- ── 1) WRITE RPC: undispatch_job_locations ──────────────────────────────────
-- Cancels the CURRENT dispatch for each given location. Returns
-- { undispatched: <count of rows actually cancelled> }. Idempotent: a second call
-- with the same key returns the cached result; a location with no current dispatch
-- is simply skipped (not an error) so undispatching an already-undispatched location
-- is a no-op, not a failure.
DROP FUNCTION IF EXISTS public.undispatch_job_locations(uuid[], uuid, text);

CREATE OR REPLACE FUNCTION public.undispatch_job_locations(
  p_job_field_ids   uuid[],
  p_performed_by    uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor      uuid;
  v_role       text;
  v_existing   jsonb;
  v_count      int := 0;
  v_row        record;
  v_assignee   text;
  v_field      text;
  v_result     jsonb;
  v_dispatchable_jobs uuid[];  -- the locked, dispatchable parent jobs (TOCTOU guard)
BEGIN
  -- actor / strict-actor / role gate (mirrors dispatch_job_locations).
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT role INTO v_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: admin or sales_rep required';
  END IF;

  -- idempotency: return the cached result if this key already ran for THIS op.
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'undispatch_job_locations');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  IF p_job_field_ids IS NULL OR array_length(p_job_field_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'NO_LOCATIONS: at least one job_field_id required';
  END IF;

  -- LOCK the distinct DISPATCHABLE parent jobs of the target locations BEFORE touching
  -- their dispatch rows. A bare EXISTS on jobs only reads a snapshot, so a concurrent
  -- complete/cancel of the same job could slip its status out of scheduled/in_progress
  -- between the check and the UPDATE — cancelling a dispatch on a now-finished job
  -- (TOCTOU). The status-transition enforcer takes a FOR UPDATE row lock on the job, so
  -- locking the same rows here serializes against it: any in-flight transition either
  -- already committed (and we skip a non-dispatchable job) or waits behind us (and sees
  -- our cancel). Mirrors dispatch_job_locations's FOR UPDATE guard (Codex #37 final-2 P2).
  -- We lock each job individually in a deterministic (id-ordered) loop — FOR UPDATE cannot
  -- be combined with array_agg in one statement — collecting the dispatchable ids; the
  -- id ORDER avoids deadlocks with a concurrent dispatch over an overlapping job set.
  v_dispatchable_jobs := '{}';
  FOR v_row IN
    SELECT j.id
      FROM jobs j
     WHERE j.deleted_at IS NULL
       AND j.status IN ('scheduled', 'in_progress')
       AND j.id IN (
         SELECT DISTINCT d.job_id
           FROM job_location_dispatches d
          WHERE d.job_field_id = ANY(p_job_field_ids)
            AND d.dispatch_status = 'dispatched'
       )
     ORDER BY j.id
     FOR UPDATE
  LOOP
    v_dispatchable_jobs := array_append(v_dispatchable_jobs, v_row.id);
  END LOOP;

  -- Cancel each CURRENT ('dispatched') dispatch for the given locations whose parent job
  -- is in the LOCKED dispatchable set. A location whose job is not dispatchable (or got
  -- finished by a transaction that beat our lock) matches nothing and is silently skipped
  -- (reflected in the undispatched count), consistent with the no-op semantics. This RPC
  -- is SECURITY DEFINER and bypasses RLS, so this lifecycle gate is the real write
  -- boundary (the UI hiding the controls is not enough). RETURNING drives the per-row
  -- activity log + the accurate undispatched count.
  FOR v_row IN
    UPDATE job_location_dispatches d
       SET dispatch_status = 'cancelled',
           updated_at = now()
     WHERE d.job_field_id = ANY(p_job_field_ids)
       AND d.dispatch_status = 'dispatched'
       AND d.job_id = ANY(v_dispatchable_jobs)
     RETURNING d.job_id, d.job_field_id, d.applicator_id, d.crew_id
  LOOP
    -- Resolve the assignee + field label for the audit row.
    IF v_row.applicator_id IS NOT NULL THEN
      SELECT full_name INTO v_assignee FROM profiles WHERE id = v_row.applicator_id;
      v_assignee := 'applicator ' || coalesce(v_assignee, v_row.applicator_id::text);
    ELSE
      SELECT name INTO v_assignee FROM ground_crews WHERE id = v_row.crew_id;
      v_assignee := 'crew ' || coalesce(v_assignee, v_row.crew_id::text);
    END IF;
    SELECT f.field_name INTO v_field
      FROM job_fields jf JOIN fields f ON f.id = jf.field_id WHERE jf.id = v_row.job_field_id;

    INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
    SELECT
      'job_location_undispatched',
      'Location ' || coalesce(v_field, '') || ' undispatched from ' || v_assignee,
      v_actor, 'job', v_row.job_id, j.customer_id
    FROM jobs j WHERE j.id = v_row.job_id;

    v_count := v_count + 1;
  END LOOP;

  v_result := jsonb_build_object('undispatched', v_count);

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'undispatch_job_locations', v_result);
  END IF;

  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.undispatch_job_locations(uuid[], uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.undispatch_job_locations(uuid[], uuid, text) TO authenticated, service_role;

-- ── 2) READ RPC: get_dispatched_list ────────────────────────────────────────
-- Returns one jsonb per CURRENT ('dispatched') location dispatch the caller can see,
-- each fully shaped for the Dispatched List row. Optional p_applicator_id / p_crew_id
-- narrow to a single assignee (the assignee filter) — both null = every visible row.
-- Resolves the assignee NAME server-side (profiles.full_name / ground_crews.name) so
-- the client never needs a profiles embed (which RLS nulls for non-admins).
DROP FUNCTION IF EXISTS public.get_dispatched_list(uuid, uuid);

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
   ORDER BY j.job_number, d.dispatched_at DESC;
$$;

REVOKE EXECUTE ON FUNCTION public.get_dispatched_list(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_dispatched_list(uuid, uuid) TO authenticated, service_role;

-- ── Verification ────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_count int;
BEGIN
  -- exactly one overload of each new function
  SELECT count(*) INTO v_count FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'undispatch_job_locations';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'undispatch_job_locations overload count is % (expected 1)', v_count;
  END IF;
  SELECT count(*) INTO v_count FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'get_dispatched_list';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'get_dispatched_list overload count is % (expected 1)', v_count;
  END IF;

  -- both must be SECURITY DEFINER with a pinned search_path
  SELECT count(*) INTO v_count FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND proname IN ('undispatch_job_locations', 'get_dispatched_list')
     AND prosecdef = true
     AND array_to_string(coalesce(proconfig, '{}'), ',') LIKE '%search_path=public, pg_temp%';
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'both new fns must be SECURITY DEFINER with search_path=public, pg_temp (found %)', v_count;
  END IF;

  -- anon must NOT be able to execute either
  SELECT count(*) INTO v_count
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('undispatch_job_locations', 'get_dispatched_list')
     AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'anon must NOT have EXECUTE on the new dispatch fns (found %)', v_count;
  END IF;
END $$;
