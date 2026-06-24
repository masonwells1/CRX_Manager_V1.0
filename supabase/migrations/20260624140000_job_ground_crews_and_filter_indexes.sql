-- ============================================================================
-- FIELD-APP PARITY #6: Full filter set (AND-combined) — DB support
-- CRX Manager V1.0
-- Date: 2026-06-24
--
-- ChemMan's job-list filter bar AND-combines ~14 filters. Every required filter
-- already reads existing data EXCEPT one: GROUND CREW. There is no ground-crew
-- entity anywhere in the schema, so this migration introduces it (managed list
-- of crews + their members), plus a nullable jobs.ground_crew_id so a job can
-- be filtered/grouped by crew. The Applied-Info capture section (#13) will later
-- attach crew/members per application; this section needs the crew to exist as a
-- *filterable* job attribute, matching ChemMan's "Ground Crews" filter chip.
--
-- ALL changes are ADDITIVE: two new tables (each with RLS), one new nullable FK
-- column on jobs, and a handful of indexes that keep the new server-side and
-- joined filters fast at the 500-row list cap. No existing column, table, RLS
-- policy, RPC, or CHECK is removed or weakened. No money, lifecycle, or actor-
-- sensitive write is introduced, so the strict-actor/idempotency RPC machinery
-- does not apply (crew CRUD + the FK set are plain RLS-gated mutations, mirroring
-- the job_tags pattern from #4).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. ground_crews: managed list of crews (create / rename / deactivate)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ground_crews (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  is_active   boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER set_ground_crews_updated_at
  BEFORE UPDATE ON ground_crews
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

ALTER TABLE ground_crews ENABLE ROW LEVEL SECURITY;

-- Any authenticated user can SEE the crew catalog (so the filter + applied-info
-- pickers render). Only admin + sales_rep create / rename / deactivate / delete.
DROP POLICY IF EXISTS ground_crews_select ON ground_crews;
CREATE POLICY ground_crews_select ON ground_crews
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS ground_crews_insert ON ground_crews;
CREATE POLICY ground_crews_insert ON ground_crews
  FOR INSERT TO authenticated
  WITH CHECK (is_admin() OR is_sales_rep());

DROP POLICY IF EXISTS ground_crews_update ON ground_crews;
CREATE POLICY ground_crews_update ON ground_crews
  FOR UPDATE TO authenticated
  USING (is_admin() OR is_sales_rep())
  WITH CHECK (is_admin() OR is_sales_rep());

DROP POLICY IF EXISTS ground_crews_delete ON ground_crews;
CREATE POLICY ground_crews_delete ON ground_crews
  FOR DELETE TO authenticated
  USING (is_admin() OR is_sales_rep());

-- ----------------------------------------------------------------------------
-- 2. ground_crew_members: people belonging to a crew (crew has-many members)
--    Deleting a crew removes its members (ON DELETE CASCADE).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ground_crew_members (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  crew_id     uuid NOT NULL REFERENCES ground_crews(id) ON DELETE CASCADE,
  name        text NOT NULL,
  -- Optional link to a real profile when the member is a system user. A member
  -- can also just be a typed name (seasonal hand with no login), so this is
  -- nullable; SET NULL keeps the member row if the profile is later removed.
  profile_id  uuid REFERENCES profiles(id) ON DELETE SET NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER set_ground_crew_members_updated_at
  BEFORE UPDATE ON ground_crew_members
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

CREATE INDEX IF NOT EXISTS idx_ground_crew_members_crew ON ground_crew_members(crew_id);

ALTER TABLE ground_crew_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ground_crew_members_select ON ground_crew_members;
CREATE POLICY ground_crew_members_select ON ground_crew_members
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS ground_crew_members_insert ON ground_crew_members;
CREATE POLICY ground_crew_members_insert ON ground_crew_members
  FOR INSERT TO authenticated
  WITH CHECK (is_admin() OR is_sales_rep());

DROP POLICY IF EXISTS ground_crew_members_update ON ground_crew_members;
CREATE POLICY ground_crew_members_update ON ground_crew_members
  FOR UPDATE TO authenticated
  USING (is_admin() OR is_sales_rep())
  WITH CHECK (is_admin() OR is_sales_rep());

DROP POLICY IF EXISTS ground_crew_members_delete ON ground_crew_members;
CREATE POLICY ground_crew_members_delete ON ground_crew_members
  FOR DELETE TO authenticated
  USING (is_admin() OR is_sales_rep());

-- ----------------------------------------------------------------------------
-- 3. jobs.ground_crew_id: nullable FK so a job can be filtered/grouped by crew.
--    SET NULL on crew delete so deleting a crew never orphans/breaks a job.
-- ----------------------------------------------------------------------------
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS ground_crew_id uuid REFERENCES ground_crews(id) ON DELETE SET NULL;

-- Partial index: only jobs that actually carry a crew (most won't), keeps the
-- Ground Crew filter's WHERE ground_crew_id = ... fast without bloating the index.
CREATE INDEX IF NOT EXISTS idx_jobs_ground_crew
  ON jobs(ground_crew_id) WHERE ground_crew_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 4. Indexes for the new joined client/server filters (multi-filter speed).
--    Crop lives on job_fields; the Crop filter narrows by it. The product-name
--    chemical search joins job_chemicals -> products (product_id already indexed
--    on job_chemicals). county/state already filter on fields via field_id.
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_job_fields_crop
  ON job_fields(crop) WHERE crop IS NOT NULL;

-- fields.county / fields.state back the County/State filters (joined via the
-- job's selected fields). Small partial indexes keep those lookups cheap.
CREATE INDEX IF NOT EXISTS idx_fields_county
  ON fields(county) WHERE county IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fields_state
  ON fields(state) WHERE state IS NOT NULL;
