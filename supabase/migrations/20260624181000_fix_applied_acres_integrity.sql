-- ============================================================================
-- FIELD-APP PARITY #18 — CORRECTIVE: applied-acres integrity fixes
-- CRX Manager V1.0
-- Date: 2026-06-24
--
-- Fixes findings from the independent review of #18 (20260624180000). This is a
-- NEW migration; the original is NOT modified. All changes are additive/hardening
-- and do not remove any RLS policy or table.
--
-- HIGH — field delete silently destroyed legal as-applied detail.
--   job_applied_record_fields.field_id was FK ... ON DELETE CASCADE, so deleting a
--   field erased the per-location as-applied acres (legal proof) and silently
--   dropped jobs.applied_acres. Siblings (application_record_id, and the #17
--   tables) all use NO ACTION. FIX: re-create that FK as ON DELETE RESTRICT so a
--   field carrying as-applied detail cannot be deleted out from under the record.
--
-- MED 2 — recompute_job_applied_acres(uuid) was SECURITY DEFINER with the default
--   PUBLIC EXECUTE grant and no in-body actor gate, so anon/any role could call it
--   directly and desync a job's acres (bypassing jobs RLS). The triggers run as
--   definer regardless of caller grant, so revoking is safe. FIX: REVOKE EXECUTE
--   FROM PUBLIC (and anon).
--
-- MED 1 + MED 3 — recompute + frontend must agree on one rule so per-entry figures
--   and the job total never contradict, and #17-era manual-only records ARE counted:
--     * The record(s) AFFECTED by a job_applied_record_fields change are settled to
--       applied_acres = COALESCE(sum of their child rows, 0) — INCLUDING 0 when the
--       last child was deleted (a record touched by the field trigger is per-location
--       by definition, so zeroing is correct, not stale). This per-entry settling
--       now lives in the CHILD trigger (which knows the exact affected record id),
--       so it only ever touches records that have / just had child rows. A #17-era
--       manual-only record (applied_acres set, no child rows) is NEVER touched by
--       this path — its manual figure is left alone.
--     * recompute_job_applied_acres(job_id) now does ONLY the per-JOB roll-up:
--       jobs.applied_acres = SUM(applied_acres) over ALL of the job's
--       job_applied_records (manual-only records included; per-location records
--       contribute the child-sum the child trigger keeps current). NEVER writes
--       jobs.remaining_acres (GENERATED).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- HIGH: field_id FK CASCADE -> RESTRICT
-- ---------------------------------------------------------------------------
-- Drop the lone CASCADE outlier and re-add it as RESTRICT. A field that carries
-- as-applied detail can no longer be deleted out from under the legal record;
-- the field delete will raise instead of silently erasing acres.
ALTER TABLE job_applied_record_fields
  DROP CONSTRAINT IF EXISTS job_applied_record_fields_field_id_fkey;

ALTER TABLE job_applied_record_fields
  ADD CONSTRAINT job_applied_record_fields_field_id_fkey
  FOREIGN KEY (field_id) REFERENCES fields(id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- MED 1 + MED 3: recompute is now per-JOB roll-up ONLY (sums ALL records)
-- ---------------------------------------------------------------------------
-- Same signature (single existing definition -> CREATE OR REPLACE is safe, no
-- overload). SECURITY DEFINER + SET search_path retained. The per-ENTRY settling
-- moved to the child trigger (below) which knows the exact affected record, so this
-- fn no longer risks clobbering a manual-only record. It only writes the job total.
CREATE OR REPLACE FUNCTION recompute_job_applied_acres(p_job_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_job_id IS NULL THEN
    RETURN;
  END IF;

  -- Per-JOB total feeding remaining_acres: sum applied_acres across ALL of the
  -- job's records (manual-only #17 records included; per-location records contribute
  -- the child-sum the child trigger keeps current). NEVER writes remaining_acres.
  UPDATE jobs
  SET applied_acres = COALESCE((
    SELECT SUM(r.applied_acres)
    FROM job_applied_records r
    WHERE r.job_id = p_job_id
  ), 0)
  WHERE jobs.id = p_job_id;
END;
$$;

-- MED 2: anon/PUBLIC can no longer call the recompute directly. Triggers run as the
-- function owner (SECURITY DEFINER) regardless of caller grant, so revoking is safe.
REVOKE EXECUTE ON FUNCTION public.recompute_job_applied_acres(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.recompute_job_applied_acres(uuid) FROM anon;

-- ---------------------------------------------------------------------------
-- MED 1 + MED 3: child trigger settles the AFFECTED record(s), then rolls the job
-- ---------------------------------------------------------------------------
-- For each record affected by the INSERT/UPDATE/DELETE, set its applied_acres to
-- the COALESCE(sum of its child rows, 0) — including 0 when the last child was
-- deleted. A helper keeps this DRY across the old/new record ids. Then recompute
-- the affected job total(s). Because this only ever runs for records named by a
-- child row, it NEVER touches a manual-only record.
CREATE OR REPLACE FUNCTION settle_applied_record_acres(p_record_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_record_id IS NULL THEN
    RETURN;
  END IF;
  UPDATE job_applied_records r
  SET applied_acres = COALESCE((
    SELECT SUM(f.applied_acres)
    FROM job_applied_record_fields f
    WHERE f.application_record_id = p_record_id
  ), 0)
  WHERE r.id = p_record_id
    AND r.applied_acres IS DISTINCT FROM COALESCE((
      SELECT SUM(f.applied_acres)
      FROM job_applied_record_fields f
      WHERE f.application_record_id = p_record_id
    ), 0);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.settle_applied_record_acres(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.settle_applied_record_acres(uuid) FROM anon;

-- Replace the child trigger fn: settle the affected record(s) to their child-sum
-- (0 when their last child is gone), then roll up the affected job(s).
CREATE OR REPLACE FUNCTION trg_jarf_recompute()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_old_record uuid;
  v_new_record uuid;
  v_old_job uuid;
  v_new_job uuid;
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'UPDATE' THEN
    v_old_record := OLD.application_record_id;
  END IF;
  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    v_new_record := NEW.application_record_id;
  END IF;

  -- Settle the per-entry roll-up for each affected record (0 when childless now).
  -- NOTE: on a parent-record DELETE, child rows are CASCADE-removed and this fires
  -- per child; the parent record may already be gone, so the UPDATE simply matches
  -- no row (the parent-delete trigger handles the job total). That is harmless.
  IF v_old_record IS NOT NULL THEN
    PERFORM settle_applied_record_acres(v_old_record);
    SELECT r.job_id INTO v_old_job FROM job_applied_records r WHERE r.id = v_old_record;
  END IF;
  IF v_new_record IS NOT NULL AND v_new_record IS DISTINCT FROM v_old_record THEN
    PERFORM settle_applied_record_acres(v_new_record);
    SELECT r.job_id INTO v_new_job FROM job_applied_records r WHERE r.id = v_new_record;
  ELSIF v_new_record IS NOT NULL THEN
    SELECT r.job_id INTO v_new_job FROM job_applied_records r WHERE r.id = v_new_record;
  END IF;

  IF v_old_job IS NOT NULL THEN
    PERFORM recompute_job_applied_acres(v_old_job);
  END IF;
  IF v_new_job IS NOT NULL AND v_new_job IS DISTINCT FROM v_old_job THEN
    PERFORM recompute_job_applied_acres(v_new_job);
  END IF;

  RETURN NULL; -- AFTER trigger, return value ignored
END;
$$;
