-- A1: keep just-completed jobs visible in FieldView "My Day". The job-terminal
-- trigger closes their dispatch rows, while the prior RPC filter immediately hid
-- those rows. Signature, RETURNS, and ACL are UNCHANGED: this is a drop-in re-emit
-- whose only behavior change is an additive seven-day completed-row tail.

CREATE OR REPLACE FUNCTION public.get_dispatched_list(p_applicator_id uuid DEFAULT NULL::uuid, p_crew_id uuid DEFAULT NULL::uuid)
 RETURNS SETOF jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'dispatch_id',     d.id,
    'job_field_id',    d.job_field_id,
    'job_id',          d.job_id,
    'job_number',      j.job_number,
    'job_status',      j.status,
    -- U12 addition: the job's scheduled date, so the FieldView card shows it
    -- and can sort Today-first / group a Done section without an extra fetch.
    'job_date',        j.job_date,
    -- U12 addition (Codex R1 P1): the underlying fields.id, so the FieldView
    -- completion form can send per-field applied acres keyed by the REAL field id
    -- (job_field_id is the join-row id — application_record_fields.field_id
    -- references fields.id, so the client needs this to build 'field_acres').
    -- Gated to the same role set as field_name (RLS R2 M3): the only consumer
    -- (the completion form) requires is_applicator() anyway, and a dispatched
    -- non-applicator crew member shouldn't get a dereferenceable fields.id when
    -- field_name is deliberately withheld from them.
    'field_id',        CASE WHEN (is_admin() OR is_sales_rep() OR is_applicator())
                            THEN jf.field_id ELSE NULL END,
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
   WHERE (
       d.dispatch_status = 'dispatched'
       -- A1: also return RECENTLY-completed dispatch rows (the job-terminal trigger
       -- flips rows to 'completed' when the job completes) so a just-finished job
       -- moves to the FieldView "Done" section instead of vanishing. 7-day window
       -- bounds the tail; 'cancelled' rows stay EXCLUDED — an undispatched
       -- applicator must not keep seeing the job (undispatch_job_locations also
       -- writes 'cancelled').
       OR (d.dispatch_status = 'completed' AND d.updated_at >= now() - interval '7 days')
     )
     AND (p_applicator_id IS NULL OR d.applicator_id = p_applicator_id)
     AND (p_crew_id IS NULL OR d.crew_id = p_crew_id)
     -- VISIBILITY GATE — mirrors job_location_dispatches_select, with ONE deliberate
     -- A1 relaxation: the table policy's assignee/crew branches require
     -- dispatch_status='dispatched', but this gate intentionally does NOT — otherwise
     -- a per-location assignee's just-completed rows would never reach their Done
     -- section (the whole point of the 7-day completed tail). The rows are still
     -- bounded to the caller's OWN dispatches (or their active crew's) — data they
     -- could already read while the row was 'dispatched'. is_admin()/is_sales_rep()/
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
$function$;

-- caller-analysis: get_dispatched_list :: ACL unchanged from live — REVOKE strips PUBLIC+anon; GRANT re-grants authenticated+service_role.
REVOKE EXECUTE ON FUNCTION public.get_dispatched_list(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_dispatched_list(uuid, uuid) TO authenticated, service_role;

DO $$
DECLARE
  v_overload_count integer;
BEGIN
  SELECT count(*)
    INTO v_overload_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'get_dispatched_list';

  IF v_overload_count <> 1 THEN
    RAISE EXCEPTION 'A1 post-check failed: expected exactly one public.get_dispatched_list overload, found %', v_overload_count;
  END IF;

  IF has_function_privilege('anon', 'public.get_dispatched_list(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'A1 post-check failed: anon retains EXECUTE on public.get_dispatched_list(uuid, uuid)';
  END IF;
END
$$;
