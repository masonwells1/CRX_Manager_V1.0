-- ============================================================================
-- FIELD-APP PARITY #3: Job batches (group jobs into named batches)
-- CRX Manager V1.0
-- Date: 2026-06-24
--
-- ChemMan has a JOB BATCHES toolbar action on the job list that groups
-- checkbox-selected jobs into NAMED batches for batch processing / printing.
-- Today CRX only has a single FREE-TEXT jobs.batch_id label on the editor —
-- there is no batches catalog, no name, no list-level assign, and no group
-- view/filter. This adds proper relational storage instead.
--
-- DESIGN — additive, free-text column LEFT INTACT:
--   * jobs.batch_id (text) is the OLD free-text "group related jobs" label set
--     on the editor. It is NOT retyped or dropped (that would break existing
--     rows and the 6-arg save_job contract that writes it). It stays exactly
--     as-is.
--   * A NEW nullable jobs.batch_ref (uuid) FK points a job at a named batch.
--     A job belongs to AT MOST ONE batch (ChemMan batches are one-to-many over
--     jobs). Membership is managed by a direct .update() from the list — NOT
--     through save_job — so the frozen 6-arg save_job contract is untouched
--     (same pattern #6 used for jobs.ground_crew_id).
--   * ON DELETE SET NULL: deleting a batch un-batches its jobs (never deletes a
--     job); the jobs survive, just lose their batch membership.
--
-- No RPC: batch CRUD + assign/remove are plain mutations (mirrors #4's job_tags
-- TagsManager). There is no money, lifecycle, or actor-sensitive write here, so
-- the strict-actor / idempotency RPC machinery does not apply.
--
-- ALL changes are ADDITIVE: one new table (with RLS) + one new nullable column
-- + one index. No existing column, table, RLS policy, or RPC is removed or
-- weakened.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. job_batches: named batch definitions
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_batches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  -- Optional free-text note describing the batch (e.g. "Tuesday corn run").
  description text,
  created_by  uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER set_job_batches_updated_at
  BEFORE UPDATE ON job_batches
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

ALTER TABLE job_batches ENABLE ROW LEVEL SECURITY;

-- Any authenticated user can SEE the batch catalog (so an applicator on a
-- batched job can render its batch label). Only admin + sales_rep create /
-- rename / delete — mirrors job_tags.
DROP POLICY IF EXISTS job_batches_select ON job_batches;
CREATE POLICY job_batches_select ON job_batches
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS job_batches_insert ON job_batches;
CREATE POLICY job_batches_insert ON job_batches
  FOR INSERT TO authenticated
  WITH CHECK (is_admin() OR is_sales_rep());

DROP POLICY IF EXISTS job_batches_update ON job_batches;
CREATE POLICY job_batches_update ON job_batches
  FOR UPDATE TO authenticated
  USING (is_admin() OR is_sales_rep())
  WITH CHECK (is_admin() OR is_sales_rep());

DROP POLICY IF EXISTS job_batches_delete ON job_batches;
CREATE POLICY job_batches_delete ON job_batches
  FOR DELETE TO authenticated
  USING (is_admin() OR is_sales_rep());

-- ----------------------------------------------------------------------------
-- 2. jobs.batch_ref: nullable FK linking a job to a named batch
--    Deleting a batch un-batches its jobs (SET NULL) — the jobs survive.
--    The OLD free-text jobs.batch_id is untouched and remains in place.
-- ----------------------------------------------------------------------------
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS batch_ref uuid REFERENCES job_batches(id) ON DELETE SET NULL;

-- Index the membership column so the "filter by batch" server-side query
-- (jobs.batch_ref IN (...)) is cheap, matching the #6 filter-index pattern.
CREATE INDEX IF NOT EXISTS idx_jobs_batch_ref ON jobs(batch_ref) WHERE batch_ref IS NOT NULL;

-- jobs already has RLS (jobs_update = is_admin() OR is_sales_rep() for USING +
-- WITH CHECK), so the direct .update({ batch_ref }) from the list is already
-- gated to admin + sales_rep. No new jobs policy is needed.
