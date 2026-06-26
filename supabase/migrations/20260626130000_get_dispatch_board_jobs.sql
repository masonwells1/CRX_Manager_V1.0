-- Field-app parity #36 follow-on (2026-06-26): bounded server-side resolution of
-- the dispatch-board Applicator filter.
-- ---------------------------------------------------------------------------
-- THE BUG (review #36 MED — latent prod time-bomb):
--   When the dispatch board has an Applicator filter active, DispatchBoard.tsx
--   built `id.not.in.(<EVERY globally-dispatched job id>)` from an UNSCOPED read of
--   the whole job_location_dispatches table, and embedded `id.in.(<loc ids>)` too.
--   Both comma-joined UUID lists GROW UNBOUNDED with that table, so over seasons the
--   PostgREST request URL exceeds the server length limit and the jobs query throws,
--   hard-failing the ENTIRE board whenever any applicator filter is set.
--   (Measured: a 500-id `id=in.(...)` jobs URL is ~19.7KB and already FAILS the local
--   gateway — so even a client-side 500 cap does not make the id-list approach safe.)
--
-- THE FIX:
--   Resolve the applicator filter ENTIRELY in SQL and return the FULLY-SHAPED job rows
--   (not ids) the board renders, so the filtered path makes NO follow-on jobs query and
--   NO follow-on dispatch-aggregation read — i.e. NO comma-joined id list ever enters a
--   request URL. Each returned row matches the board's PostgREST embed shape plus a
--   `_dispatches` array (the per-location applicator/crew rows the CALLER can see) so the
--   client can aggregate the 'Assigned To' label without a second round-trip.
--   The applicator match mirrors the board's client logic:
--     (a) jobs with a CURRENT ('dispatched') per-location dispatch to this applicator
--         that the CALLER can SEE (a "Bob" location on a now-split job surfaces under
--         Bob's filter for the dispatcher / the whole-job applicator / Bob himself), UNION
--     (b) jobs whose WHOLE-JOB applicator is this one AND which have NO per-location
--         dispatch at all (a stale job-level assignment on a now-split job must NOT
--         show under the old applicator — mirrors aggregateAssignedTo / selectDispatchView).
--   Ordered job_date DESC + LIMIT 500 to match the board's own cap (the same newest-500
--   slice it would render).
--
-- SECURITY — MUST NOT widen visibility:
--   SECURITY DEFINER (so it can read job_location_dispatches / ground_crew_members
--   without tripping their RLS), but it returns ONLY rows the caller could already SELECT
--   on `jobs`, by replicating the live jobs SELECT predicate (jobs_select OR
--   jobs_select_location_dispatchee) as a WHERE clause; and the per-location match +
--   embedded `_dispatches` only count dispatch rows the caller could SELECT under
--   job_location_dispatches_select (admin/sales see all; the whole-job applicator sees
--   every row on their job; a field user sees their own / their active crew's rows).
--   So a field user never receives a job — or an assignee — they couldn't already read.
--
-- ADDITIVE ONLY: one new read-only SECURITY DEFINER function. No table/policy/RPC
-- is dropped or rewritten. anon EXECUTE revoked.
-- ---------------------------------------------------------------------------

-- Older id-returning shape (if a prior copy applied locally) must not linger.
DROP FUNCTION IF EXISTS public.get_dispatch_board_job_ids(uuid, text, date, date);
DROP FUNCTION IF EXISTS public.get_dispatch_board_jobs(uuid, text, date, date);

CREATE OR REPLACE FUNCTION public.get_dispatch_board_jobs(
  p_applicator_id uuid,
  p_status        text DEFAULT NULL,
  p_start_date    date DEFAULT NULL,
  p_end_date      date DEFAULT NULL
) RETURNS SETOF jsonb
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  -- A dispatch row is VISIBLE to the caller (mirrors job_location_dispatches_select):
  --   admin/sales see all; the job's whole-job applicator sees every row on their job;
  --   otherwise a field user sees a row where they are the assignee or an active member
  --   of the assigned active crew.
  WITH matched AS (
    SELECT j.*
      FROM public.jobs j
     WHERE j.deleted_at IS NULL
       AND p_applicator_id IS NOT NULL
       AND (p_status IS NULL OR j.status = p_status)
       AND (p_start_date IS NULL OR j.job_date >= p_start_date)
       AND (p_end_date IS NULL OR j.job_date <= p_end_date)
       AND (
         -- (a) a CURRENT per-location dispatch to this applicator the CALLER can see
         EXISTS (
           SELECT 1 FROM public.job_location_dispatches d
            WHERE d.job_id = j.id
              AND d.dispatch_status = 'dispatched'
              AND d.applicator_id = p_applicator_id
              AND (
                is_admin()
                OR is_sales_rep()
                OR (is_applicator() AND j.applicator_id = (select auth.uid()))
                OR d.applicator_id = (select auth.uid())
              )
         )
         OR (
           -- (b) whole-job applicator = this one AND the job has NO per-location dispatch
           j.applicator_id = p_applicator_id
           AND NOT EXISTS (
             SELECT 1 FROM public.job_location_dispatches d2
              WHERE d2.job_id = j.id
                AND d2.dispatch_status = 'dispatched'
           )
         )
       )
       -- VISIBILITY GATE — the live jobs SELECT predicate. Never return a hidden job.
       AND (
         is_admin()
         OR is_sales_rep()
         OR (is_applicator() AND j.applicator_id = (select auth.uid()))
         OR public._is_dispatched_to_me(j.id)
       )
     ORDER BY j.job_date DESC NULLS LAST
     LIMIT 500
  )
  SELECT
    to_jsonb(m)
    || jsonb_build_object(
         -- CUSTOMER NAME — RLS-equivalent (Codex re-review-3 P2): this function is
         -- SECURITY DEFINER, so a raw `customers` read would bypass customers_select and
         -- could leak a farm_name the caller can't otherwise see (a sales_rep is limited
         -- to assigned customers; an applicator/driver to a time-windowed set). Return the
         -- name ONLY when the caller would pass customers_select OR
         -- customers_select_location_dispatchee for THIS job's customer; else farm_name
         -- is null (the board renders 'Unknown', exactly as the unfiltered RLS embed would).
         'customer',
         (SELECT jsonb_build_object(
                   'farm_name',
                   CASE WHEN (
                     is_admin()
                     OR (is_sales_rep() AND c.assigned_sales_rep = (select auth.uid()))
                     OR (is_driver() AND EXISTS (
                           SELECT 1 FROM public.deliveries d
                            WHERE d.customer_id = c.id
                              AND d.assigned_driver = (select auth.uid())
                              AND d.scheduled_date >= (CURRENT_DATE - interval '1 day')))
                     OR (is_applicator() AND EXISTS (
                           SELECT 1 FROM public.jobs j2
                            WHERE j2.customer_id = c.id
                              AND j2.applicator_id = (select auth.uid())
                              AND j2.job_date >= (CURRENT_DATE - interval '7 days')))
                     OR EXISTS (
                           SELECT 1 FROM public.jobs j3
                            WHERE j3.customer_id = c.id
                              AND public._is_dispatched_to_me(j3.id))
                   ) THEN c.farm_name ELSE NULL END)
            FROM public.customers c WHERE c.id = m.customer_id),
         -- JOB_FIELDS — job_fields_select is satisfied for every job that passed this
         -- function's visibility gate (admin/sales_rep/whole-job applicator/_is_dispatched_to_me
         -- are exactly its conditions), so listing the rows leaks nothing. field_name is
         -- gated to the fields_select predicate (admin/sales_rep/applicator) so a dispatched
         -- crew member whose role is NOT applicator doesn't get a field name they couldn't
         -- read under RLS (null → the board falls back to 'Field'). (Codex re-review-3 P2.)
         'job_fields',
         coalesce((
           SELECT jsonb_agg(
                    jsonb_build_object(
                      'id', jf.id,
                      'field_id', jf.field_id,
                      'acres_to_treat', jf.acres_to_treat,
                      'sort_order', jf.sort_order,
                      'field', jsonb_build_object(
                        'id', f.id,
                        'field_name', CASE WHEN (is_admin() OR is_sales_rep() OR is_applicator())
                                           THEN f.field_name ELSE NULL END)
                    ) ORDER BY jf.sort_order
                  )
             FROM public.job_fields jf
             JOIN public.fields f ON f.id = jf.field_id
            WHERE jf.job_id = m.id
         ), '[]'::jsonb),
         -- per-location dispatch rows the CALLER can see, for client-side label aggregation
         '_dispatches',
         coalesce((
           SELECT jsonb_agg(jsonb_build_object('applicator_id', d.applicator_id, 'crew_id', d.crew_id))
             FROM public.job_location_dispatches d
            WHERE d.job_id = m.id
              AND d.dispatch_status = 'dispatched'
              AND (
                is_admin()
                OR is_sales_rep()
                OR (is_applicator() AND m.applicator_id = (select auth.uid()))
                OR d.applicator_id = (select auth.uid())
                OR (
                  d.crew_id IS NOT NULL
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
         ), '[]'::jsonb)
       )
    FROM matched m;
$$;

REVOKE EXECUTE ON FUNCTION public.get_dispatch_board_jobs(uuid, text, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_dispatch_board_jobs(uuid, text, date, date) TO authenticated, service_role;

-- ── Verification ────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_count int;
BEGIN
  -- exactly one overload
  SELECT count(*) INTO v_count FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'get_dispatch_board_jobs';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'get_dispatch_board_jobs overload count is % (expected 1)', v_count;
  END IF;

  -- the old id-returning shape must be gone (renamed to the rows-returning version)
  SELECT count(*) INTO v_count FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'get_dispatch_board_job_ids';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'stale get_dispatch_board_job_ids still present (expected 0)';
  END IF;

  -- must be SECURITY DEFINER with a pinned search_path
  SELECT count(*) INTO v_count FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'get_dispatch_board_jobs'
     AND prosecdef = true
     AND array_to_string(coalesce(proconfig, '{}'), ',') LIKE '%search_path=public, pg_temp%';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'get_dispatch_board_jobs must be SECURITY DEFINER with search_path=public, pg_temp';
  END IF;

  -- anon must NOT be able to execute
  SELECT count(*) INTO v_count
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'get_dispatch_board_jobs'
     AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'anon must NOT have EXECUTE on get_dispatch_board_jobs';
  END IF;
END $$;
