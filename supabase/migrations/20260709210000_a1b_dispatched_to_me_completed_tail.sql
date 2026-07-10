-- A1b: close the split-assignee FieldView Done-card gap where a just-completed
-- location-only assignment showed customer "Unknown" and empty expanded detail.
-- This helper now mirrors A1's seven-day completed window. Its four dependent
-- SELECT-only policies -- jobs_select_location_dispatchee,
-- job_fields_select_location_dispatchee, job_chemicals_select_location_dispatchee,
-- and customers_select_location_dispatchee -- inherit the same widening.
-- Signature, RETURNS, and ACL are unchanged; 'cancelled' remains excluded.

CREATE OR REPLACE FUNCTION public._is_dispatched_to_me(p_job_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- The caller must be an ACTIVE profile — mirror is_applicator()/is_admin(), which
  -- re-check profiles.is_active, so a DEACTIVATED user with a still-valid token loses
  -- dispatch visibility immediately (Codex re-review-6 P2).
  SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = (select auth.uid()) AND p.is_active)
  AND EXISTS (
    SELECT 1 FROM public.job_location_dispatches d
     WHERE d.job_id = p_job_id
       -- Only an ACTIVE ('dispatched') assignment — or, since A1b, the caller's own
       -- assignment COMPLETED within the last 7 days — grants visibility. The completed
       -- tail mirrors get_dispatched_list's A1 Done-section window exactly, so a split
       -- assignee's just-finished job keeps its customer name + expanded detail readable
       -- while it sits in Done. A 'cancelled' dispatch must still NOT keep granting the
       -- former assignee/crew read access to the parent job (Codex re-review P2).
       AND (
         d.dispatch_status = 'dispatched'
         OR (d.dispatch_status = 'completed' AND d.updated_at >= now() - interval '7 days')
       )
       AND (
         d.applicator_id = (select auth.uid())
         OR (
           d.crew_id IS NOT NULL
           AND EXISTS (
             -- the CREW must still be active AND the caller an active member —
             -- deactivating the crew revokes visibility even if member rows linger
             -- (Codex re-review-9 P2).
             SELECT 1 FROM public.ground_crew_members gcm
              JOIN public.ground_crews gc ON gc.id = gcm.crew_id
              WHERE gcm.crew_id = d.crew_id
                AND gcm.profile_id = (select auth.uid())
                AND gcm.is_active
                AND gc.is_active
           )
         )
       )
  );
$function$;

DO $$
DECLARE
  v_overload_count integer;
BEGIN
  SELECT count(*)
    INTO v_overload_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = '_is_dispatched_to_me';

  IF v_overload_count <> 1 THEN
    RAISE EXCEPTION 'A1b post-check failed: expected exactly one public._is_dispatched_to_me overload, found %', v_overload_count;
  END IF;

  IF has_function_privilege('anon', 'public._is_dispatched_to_me(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'A1b post-check failed: anon retains EXECUTE on public._is_dispatched_to_me(uuid)';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = '_is_dispatched_to_me'
       AND p.prosrc LIKE '%dispatch_status = ''completed''%'
  ) THEN
    RAISE EXCEPTION 'A1b post-check failed: public._is_dispatched_to_me(uuid) lacks the completed-tail predicate';
  END IF;
END
$$;
