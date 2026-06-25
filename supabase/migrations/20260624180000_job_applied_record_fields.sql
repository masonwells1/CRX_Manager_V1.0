-- ============================================================================
-- FIELD-APP PARITY #18: Applied acres per location + remaining-acres tracking
-- CRX Manager V1.0
-- Date: 2026-06-24
--
-- Builds on #17's job_applied_records (one job -> many as-applied entries).
-- ChemMan's "Add Applied Info" records, per entry, applied acres PER LOCATION
-- (e.g. "All Locations [100%] for a total of 245.40 ac", or a partial subset),
-- and shows a live "Job Total Remaining Acres: X of Y" counter. Applied acres
-- accumulate across multiple entries so a job can be sprayed partially now and
-- the rest later (multi-day). The job list then shows real Tot.ac / Rem.ac.
--
-- HOW REMAINING ACRES IS TRACKED (the load-bearing requirement):
--   jobs.total_acres      = planned acres (sum of job_fields.acres_to_treat) [#1]
--   jobs.applied_acres    = sum of ALL applied acres across ALL of a job's
--                           applied records, driven HERE by a trigger from the
--                           per-location child rows. NEVER set by hand.
--   jobs.remaining_acres  = GENERATED GREATEST(total_acres - applied_acres, 0) [#1]
--                           -> NEVER written directly (it's a generated column).
--
-- This migration:
--   1. Adds job_applied_record_fields(record_id -> CASCADE, field_id, acres) —
--      the per-location detail for an as-applied entry, with job-scoped RLS that
--      mirrors job_applied_records (#17).
--   2. Adds a trigger function recompute_job_applied_acres(p_job_id) that sets
--      jobs.applied_acres = SUM(job_applied_record_fields.applied_acres) over all
--      of that job's applied records. Fired AFTER INSERT/UPDATE/DELETE on the
--      child table AND AFTER DELETE on job_applied_records (so deleting a whole
--      entry drops its acres too). Idempotent: it always recomputes from the
--      current rows, so it can run any number of times and never drifts.
--
-- The parent record's own job_applied_records.applied_acres column (#17) is kept
-- in sync as a per-entry roll-up of its child rows too (so the entry list shows
-- the entry's own total). That is a convenience denormalization; the AUTHORITATIVE
-- per-job total flows child rows -> jobs.applied_acres -> remaining_acres.
--
-- ALL changes are ADDITIVE: one new table + one trigger fn + two triggers. No
-- existing column, table, policy, or RPC is removed or weakened. No money, no
-- lifecycle transition -> plain RLS-gated mutations, no RPC needed.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Per-location applied acres (child of an as-applied entry)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_applied_record_fields (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The as-applied entry this row belongs to. CASCADE so deleting an entry
  -- removes its per-location detail (and the AFTER-DELETE trigger on the parent
  -- recomputes the job total).
  application_record_id  uuid NOT NULL REFERENCES job_applied_records(id) ON DELETE CASCADE,
  -- Which location (field) this much was applied on. ON DELETE CASCADE: if the
  -- field record itself is deleted, its applied detail goes too. field_id is NOT
  -- a FK to job_fields (a job<->field link row) because that link can be removed
  -- while the legal as-applied proof must persist; it references the field.
  field_id               uuid NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  -- Acres applied on THIS field in THIS pass. Non-negative (mirrors the spec).
  applied_acres          numeric NOT NULL DEFAULT 0 CHECK (applied_acres >= 0),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  -- One row per (entry, field): a single pass applies one figure to a field.
  -- Re-applying that field in a LATER pass is a new entry (new record_id).
  UNIQUE (application_record_id, field_id)
);

CREATE INDEX IF NOT EXISTS idx_jarf_record ON job_applied_record_fields(application_record_id);
CREATE INDEX IF NOT EXISTS idx_jarf_field ON job_applied_record_fields(field_id);

CREATE TRIGGER set_job_applied_record_fields_updated_at
  BEFORE UPDATE ON job_applied_record_fields
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

ALTER TABLE job_applied_record_fields ENABLE ROW LEVEL SECURITY;

-- RLS mirrors job_applied_records (#17): admin + sales_rep manage; an applicator
-- assigned to the job can read AND write its own job's per-location detail. The
-- gate walks child -> parent record -> job, then applies the same job-scoped
-- predicate as the parent table.
DROP POLICY IF EXISTS job_applied_record_fields_select ON job_applied_record_fields;
CREATE POLICY job_applied_record_fields_select ON job_applied_record_fields
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM job_applied_records r
    JOIN jobs j ON j.id = r.job_id
    WHERE r.id = job_applied_record_fields.application_record_id AND (
      is_admin() OR is_sales_rep()
      OR (is_applicator() AND j.applicator_id = (SELECT auth.uid()))
    )
  ));

DROP POLICY IF EXISTS job_applied_record_fields_insert ON job_applied_record_fields;
CREATE POLICY job_applied_record_fields_insert ON job_applied_record_fields
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM job_applied_records r
    JOIN jobs j ON j.id = r.job_id
    WHERE r.id = job_applied_record_fields.application_record_id AND (
      is_admin() OR is_sales_rep()
      OR (is_applicator() AND j.applicator_id = (SELECT auth.uid()))
    )
  ));

DROP POLICY IF EXISTS job_applied_record_fields_update ON job_applied_record_fields;
CREATE POLICY job_applied_record_fields_update ON job_applied_record_fields
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM job_applied_records r
    JOIN jobs j ON j.id = r.job_id
    WHERE r.id = job_applied_record_fields.application_record_id AND (
      is_admin() OR is_sales_rep()
      OR (is_applicator() AND j.applicator_id = (SELECT auth.uid()))
    )
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM job_applied_records r
    JOIN jobs j ON j.id = r.job_id
    WHERE r.id = job_applied_record_fields.application_record_id AND (
      is_admin() OR is_sales_rep()
      OR (is_applicator() AND j.applicator_id = (SELECT auth.uid()))
    )
  ));

DROP POLICY IF EXISTS job_applied_record_fields_delete ON job_applied_record_fields;
CREATE POLICY job_applied_record_fields_delete ON job_applied_record_fields
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM job_applied_records r
    JOIN jobs j ON j.id = r.job_id
    WHERE r.id = job_applied_record_fields.application_record_id AND (
      is_admin() OR is_sales_rep()
      OR (is_applicator() AND j.applicator_id = (SELECT auth.uid()))
    )
  ));

-- ---------------------------------------------------------------------------
-- 2. Recompute roll-ups: per-job jobs.applied_acres + per-entry applied_acres
-- ---------------------------------------------------------------------------
-- Idempotent: always recomputes from the CURRENT child rows, so re-running it
-- can never drift. Never writes jobs.remaining_acres (GENERATED). SECURITY
-- DEFINER so the trigger can update jobs / parent record even when fired by a
-- sales_rep / applicator whose RLS wouldn't allow a direct UPDATE on jobs.
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

  -- Per-entry roll-up: each applied record's own applied_acres = sum of its
  -- per-location child rows (so the entry list shows the entry's own total).
  -- Only records that HAVE child rows are touched here; a record with no child
  -- rows keeps whatever applied_acres it had (a #17-era manual figure), and the
  -- per-job total below counts child rows only.
  UPDATE job_applied_records r
  SET applied_acres = sub.s
  FROM (
    SELECT application_record_id, SUM(applied_acres) AS s
    FROM job_applied_record_fields
    GROUP BY application_record_id
  ) sub
  WHERE r.id = sub.application_record_id
    AND r.job_id = p_job_id
    AND r.applied_acres IS DISTINCT FROM sub.s;

  -- Per-JOB total (the authoritative figure feeding remaining_acres): sum of
  -- ALL per-location child rows across ALL of the job's applied records.
  UPDATE jobs
  SET applied_acres = COALESCE((
    SELECT SUM(f.applied_acres)
    FROM job_applied_record_fields f
    JOIN job_applied_records r ON r.id = f.application_record_id
    WHERE r.job_id = p_job_id
  ), 0)
  WHERE jobs.id = p_job_id;
END;
$$;

-- Trigger fn on the child table: recompute the affected job after any change.
-- On UPDATE that moves a row to a different parent record (rare), recompute both
-- old and new jobs.
CREATE OR REPLACE FUNCTION trg_jarf_recompute()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_old_job uuid;
  v_new_job uuid;
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'UPDATE' THEN
    SELECT r.job_id INTO v_old_job FROM job_applied_records r WHERE r.id = OLD.application_record_id;
  END IF;
  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    SELECT r.job_id INTO v_new_job FROM job_applied_records r WHERE r.id = NEW.application_record_id;
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

DROP TRIGGER IF EXISTS jarf_recompute_aiud ON job_applied_record_fields;
CREATE TRIGGER jarf_recompute_aiud
  AFTER INSERT OR UPDATE OR DELETE ON job_applied_record_fields
  FOR EACH ROW
  EXECUTE FUNCTION trg_jarf_recompute();

-- Trigger fn on the PARENT record: when a whole as-applied entry is DELETED, its
-- child rows are CASCADE-removed, but the child AFTER-DELETE trigger fires per
-- row and the parent's job is gone from the row's perspective only after the
-- parent row is deleted. To be safe and explicit, recompute the job here too on
-- parent delete. (CASCADE deletes children first, then the parent; recomputing
-- on the parent delete guarantees the job total settles.)
CREATE OR REPLACE FUNCTION trg_job_applied_record_recompute()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.job_id IS NOT NULL THEN
    PERFORM recompute_job_applied_acres(OLD.job_id);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS job_applied_record_recompute_ad ON job_applied_records;
CREATE TRIGGER job_applied_record_recompute_ad
  AFTER DELETE ON job_applied_records
  FOR EACH ROW
  EXECUTE FUNCTION trg_job_applied_record_recompute();
