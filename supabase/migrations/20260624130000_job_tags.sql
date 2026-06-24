-- ============================================================================
-- FIELD-APP PARITY #4: Color-coded job tags
-- CRX Manager V1.0
-- Date: 2026-06-24
--
-- ChemMan's EDIT JOB TAGS modal is a full tag manager: each tag has a name +
-- a color, renders as a colored chip on each job row, drives a "Job Tags"
-- multi-select filter, and a bulk action assigns/removes tags across selected
-- jobs. The existing jobs.tags text[] column is DEAD (no UI reads/writes it)
-- and cannot carry a per-tag color, so this introduces proper relational
-- storage instead of reusing it. The team-note tag tables (note_tags /
-- team_note_tags) are a DIFFERENT feature and are left untouched.
--
-- ALL changes here are ADDITIVE: two new tables, each with RLS. No existing
-- column, table, RLS policy, or RPC is removed or weakened. jobs.tags stays
-- in place (still dead) to avoid touching the 6-arg save_job contract.
--
-- What this adds:
--   1. job_tags          — tag definitions (name UNIQUE, color hex).
--   2. job_tag_assignments — many-to-many link (job_id, tag_id), cascade both
--      ways so deleting a tag clears it from every job and deleting a job
--      clears its assignments.
--
-- No RPC: tag CRUD + assignment are plain mutations (mirrors the existing
-- team TagsManager). There is no money, lifecycle, or actor-sensitive write
-- here, so the strict-actor/idempotency RPC machinery does not apply.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. job_tags: tag definitions (name + color)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_tags (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  -- Hex color (e.g. '#3b82f6'). Validated to a 7-char hex string so a chip
  -- always has a usable color. Defaults to the brand blue.
  color       text NOT NULL DEFAULT '#3b82f6'
                CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
  created_by  uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER set_job_tags_updated_at
  BEFORE UPDATE ON job_tags
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

ALTER TABLE job_tags ENABLE ROW LEVEL SECURITY;

-- Any authenticated user can SEE the tag catalog (so applicators on a job can
-- render its chips). Only admin + sales_rep create / rename / recolor / delete.
DROP POLICY IF EXISTS job_tags_select ON job_tags;
CREATE POLICY job_tags_select ON job_tags
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS job_tags_insert ON job_tags;
CREATE POLICY job_tags_insert ON job_tags
  FOR INSERT TO authenticated
  WITH CHECK (is_admin() OR is_sales_rep());

DROP POLICY IF EXISTS job_tags_update ON job_tags;
CREATE POLICY job_tags_update ON job_tags
  FOR UPDATE TO authenticated
  USING (is_admin() OR is_sales_rep())
  WITH CHECK (is_admin() OR is_sales_rep());

DROP POLICY IF EXISTS job_tags_delete ON job_tags;
CREATE POLICY job_tags_delete ON job_tags
  FOR DELETE TO authenticated
  USING (is_admin() OR is_sales_rep());

-- ----------------------------------------------------------------------------
-- 2. job_tag_assignments: many-to-many link
--    Deleting a tag removes it from every job; deleting a job removes its
--    assignments. Both via ON DELETE CASCADE (the "sane handling" criterion).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_tag_assignments (
  job_id      uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  tag_id      uuid NOT NULL REFERENCES job_tags(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_job_tag_assignments_job ON job_tag_assignments(job_id);
CREATE INDEX IF NOT EXISTS idx_job_tag_assignments_tag ON job_tag_assignments(tag_id);

ALTER TABLE job_tag_assignments ENABLE ROW LEVEL SECURITY;

-- Assignments inherit the parent job's visibility (matches job_field_shares /
-- job_chemicals): admin + sales_rep manage; an applicator assigned to the job
-- can read its tag chips.
DROP POLICY IF EXISTS job_tag_assignments_select ON job_tag_assignments;
CREATE POLICY job_tag_assignments_select ON job_tag_assignments
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM jobs WHERE jobs.id = job_tag_assignments.job_id AND (
    is_admin() OR is_sales_rep()
    OR (is_applicator() AND jobs.applicator_id = (SELECT auth.uid()))
  )));

DROP POLICY IF EXISTS job_tag_assignments_insert ON job_tag_assignments;
CREATE POLICY job_tag_assignments_insert ON job_tag_assignments
  FOR INSERT TO authenticated
  WITH CHECK (is_admin() OR is_sales_rep());

DROP POLICY IF EXISTS job_tag_assignments_delete ON job_tag_assignments;
CREATE POLICY job_tag_assignments_delete ON job_tag_assignments
  FOR DELETE TO authenticated
  USING (is_admin() OR is_sales_rep());
-- NOTE: no UPDATE policy — an assignment is just (job_id, tag_id); changing it
-- means delete + insert, never an in-place UPDATE.
