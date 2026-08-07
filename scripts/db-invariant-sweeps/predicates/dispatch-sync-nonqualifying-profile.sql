-- =============================================================================
-- dispatch-sync-nonqualifying-profile.sql — dispatch board permanently missing
-- a job because its assigned profile never qualified as an active applicator
-- =============================================================================
--
-- KNOWN_ISSUES.md (2026-07-29): the dispatch-sync trigger pair
-- (`_sync_job_location_dispatch_on_field_insert` AFTER INSERT ON job_fields,
-- `_sync_job_location_dispatch_on_applicator_change` AFTER UPDATE OF
-- applicator_id ON jobs — both in supabase/migrations/20260707020000_
-- assignment_unification.sql) each defensively mirror
-- dispatch_job_locations's INVALID_APPLICATOR check:
--   IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = <applicator>
--                  AND is_active = true AND role = 'applicator')
--   THEN RETURN NEW; END IF;
-- and silently no-op (never RAISE) when the assigned profile does not
-- currently qualify. Nothing re-fires the trigger later: the field-insert
-- trigger only runs once per job_fields row, and the applicator-change
-- trigger only runs when jobs.applicator_id itself CHANGES. If a job is
-- assigned to a profile that is inactive, or not role='applicator', at the
-- moment either trigger fires, that job's job_fields rows never get a
-- job_location_dispatches row — and if applicator_id never changes again,
-- they never will. The job silently and permanently never appears on the
-- Dispatch Board even though it is open/scheduled work.
--
-- WOULD HAVE CAUGHT: any open/scheduled/in_progress job whose applicator_id
-- names a profile that is inactive or has since changed role away from
-- 'applicator' (a common real shape — a technician demoted/deactivated after
-- being assigned jobs), leaving its fields permanently dispatch-less.
--
-- EXPECTED RESULT: zero rows in normal operation (WITH CAUTION — this is a
-- descriptive gap, not yet fixed; see the FIX NEEDED note below). Any row
-- names a job_fields location that SHOULD carry an active dispatch row (the
-- job is open/scheduled work with a named applicator) but does not, because
-- the applicator on file does not currently pass the qualifying check the
-- sync triggers use.
--
-- FIX NEEDED (parked, not this sweep's job): the sync triggers should either
-- re-run the check at read time (dispatch board query joins profiles live)
-- or a periodic re-sync sweep should re-fire for jobs stuck in this state.
-- This predicate exists to make the gap measurable, not to close it.
--
-- KNOWN FALSE-POSITIVE MODES
--   * A job intentionally left unassigned (applicator_id IS NULL) is excluded
--     — that is normal "needs dispatch" state, not this bug.
--   * A location the Dispatch Board wizard deliberately split to a DIFFERENT,
--     currently-qualifying applicator/crew (a job_location_dispatches row
--     already exists with dispatch_status IN ('dispatched','completed',
--     'cancelled')) is excluded — the wizard's per-location override is
--     working as designed, not a sync failure.
--   * A job whose applicator_id profile qualifies right now is excluded even
--     if it once did not — this predicate looks at CURRENT profile state,
--     which is exactly what the trigger would see if it fired again.
--
-- SCHEMA FACTS (verified live 2026-08-07 against rhyzpcqhnizqbxphqdkr)
--   jobs(id, status, applicator_id uuid NULLABLE)
--   job_fields(id, job_id, field_id)
--   job_location_dispatches(id, job_field_id, job_id, applicator_id,
--     dispatch_status)
--   profiles(id, is_active boolean, role text)
-- =============================================================================

WITH nonqualifying_assignment AS (
  SELECT j.id AS job_id, j.applicator_id
  FROM jobs j
  WHERE j.status IN ('scheduled', 'in_progress')
    AND j.applicator_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM profiles p
       WHERE p.id = j.applicator_id
         AND p.is_active = true
         AND p.role = 'applicator'
    )
)
SELECT
  'job_field:' || jf.id::text                                     AS identity_key,
  'dispatch_missing_nonqualifying_profile'::text                  AS violation_type,
  na.job_id                                                        AS job_id,
  jf.id                                                             AS job_field_id,
  na.applicator_id                                                 AS assigned_applicator_id,
  'job ' || na.job_id::text
    || ' field ' || jf.id::text
    || ' has no active job_location_dispatches row; assigned applicator '
    || na.applicator_id::text
    || ' is not an active, role=applicator profile'                AS detail
FROM job_fields jf
JOIN nonqualifying_assignment na ON na.job_id = jf.job_id
WHERE NOT EXISTS (
  SELECT 1 FROM job_location_dispatches jld
   WHERE jld.job_field_id = jf.id
     AND jld.dispatch_status IN ('dispatched', 'completed', 'cancelled')
)
ORDER BY na.job_id, jf.id;
