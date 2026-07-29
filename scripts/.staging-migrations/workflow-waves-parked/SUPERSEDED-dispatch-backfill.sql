-- SUPERSEDED 2026-07-29 — RETIRED, DO NOT APPLY. Kept for history only.
--
-- WHY RETIRED: the legacy population this was written for is gone, and the live sync
-- triggers cover the ordinary assignment paths. Verified read-only against live on
-- 2026-07-29:
--   * count check below returns 0 rows (same as when it was parked on 2026-07-10);
--   * no open assigned job is missing a dispatch row at all (0 across every assignee,
--     not just currently-qualifying ones);
--   * trg_sync_job_location_dispatch_on_applicator_change is live on public.jobs, and
--     trg_sync_job_location_dispatch_on_field_insert is live on public.job_fields —
--     between them, assigning an active applicator or adding a field to such a job
--     writes the dispatch row automatically.
--
-- NOT a claim that a gap can never reopen (cross-model review, 2026-07-29). Both sync
-- triggers silently skip when the assignee is not (is_active AND role = 'applicator'),
-- nothing in the database stops a job being assigned to such a profile
-- (_enforce_applicator_license only checks license expiry; assign_job_applicator checks
-- the CALLER's role, not the assignee's), and no trigger on public.profiles re-syncs
-- dispatches when a profile is later reactivated or made an applicator. Confirmed live:
-- 2 open jobs are assigned to an admin-role profile today. So a
-- deactivate/assign/reactivate sequence could leave a job off the dispatch board.
-- That is a trigger-coverage defect, tracked in docs/manual/KNOWN_ISSUES.md — the fix
-- belongs at the write path, NOT in a bulk backfill run after the fact. This file stays
-- retired either way: it is a no-op today, and resurrecting it would paper over the
-- defect instead of closing it.
-- Retiring it with the SUPERSEDED- prefix takes it out of the fleet "parked migrations
-- awaiting apply" count, which was reporting work that does not exist.
--
-- Original header follows.
--
-- PARKED — DO NOT APPLY WITHOUT MASON'S EXPLICIT OK (Delivery-gate item: business-data write)
-- Workflow-waves Sprint E (2026-07-10). One-time backfill: give LEGACY-assigned open jobs
-- (jobs.applicator_id set the old way, no per-location dispatch rows) their
-- job_location_dispatches rows, so the dispatch-centric surfaces (My Day RPC, Dispatch
-- Board, unassigned-jobs action category) see them without waiting for the sync trigger
-- to fire on the next edit.
--
-- PLAIN ENGLISH: some older jobs were assigned to an applicator before the new
-- per-field dispatch system existed. Those jobs work fine (the app has client-side
-- fallbacks), but they're invisible to the new dispatch lists until someone edits them.
-- This script creates the missing dispatch rows for OPEN (scheduled/in_progress) jobs
-- whose assigned applicator is still an active applicator — mirroring exactly what the
-- assignment trigger would have written.
--
-- ROW COUNT (live, 2026-07-10T02:0xZ): 0 jobs / 0 rows — currently a NO-OP. Parked for
-- the future case; re-run the count below before applying.
--
-- Count check (run first):
--   SELECT count(*) FROM jobs j JOIN job_fields jf ON jf.job_id = j.id
--    WHERE j.status IN ('scheduled','in_progress') AND j.deleted_at IS NULL
--      AND j.applicator_id IS NOT NULL
--      AND EXISTS (SELECT 1 FROM profiles p WHERE p.id = j.applicator_id AND p.is_active AND p.role='applicator')
--      AND NOT EXISTS (SELECT 1 FROM job_location_dispatches d WHERE d.job_field_id = jf.id);
--
-- Validation done 2026-07-10: BEGIN; <this insert>; ROLLBACK; executed clean against live (0 rows).

INSERT INTO public.job_location_dispatches
  (job_field_id, job_id, applicator_id, crew_id, dispatched_at, dispatch_status, dispatched_by)
SELECT
  jf.id, j.id, j.applicator_id, NULL, now(), 'dispatched',
  -- Attribution: the job's own assigner trail — mirrors the sync trigger's
  -- COALESCE(auth.uid(), NEW.updated_by, NEW.created_by); no auth context in a
  -- backfill, so updated_by/created_by.
  COALESCE(j.updated_by, j.created_by)
FROM public.jobs j
JOIN public.job_fields jf ON jf.job_id = j.id
WHERE j.status IN ('scheduled', 'in_progress')
  AND j.deleted_at IS NULL
  AND j.applicator_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = j.applicator_id AND p.is_active = true AND p.role = 'applicator'
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.job_location_dispatches d WHERE d.job_field_id = jf.id
  )
ON CONFLICT (job_field_id) DO NOTHING;
