-- ============================================================================
-- FIELD-APP PARITY #17: As-applied entry record (applicator, vehicle, date)
-- CRX Manager V1.0
-- Date: 2026-06-24
--
-- ChemMan's "Add Applied Info" records, PER ENTRY: Applicator (dropdown),
-- Vehicle (auto-fills from the applicator/loader, editable), and Application
-- Date. A single job can have MULTIPLE applied-info entries (several passes on
-- different days, by different people / machines). This is the legal proof of
-- who sprayed, with what machine, on what day.
--
-- WHY A NEW TABLE (not extend job_applied_info):
--   The existing `job_applied_info` is 1:1 with a job (UNIQUE(job_id)) and is
--   the WEATHER/COMPLETION snapshot written by complete_job() and read by the
--   as-applied invoice feature. It cannot become many-per-job without breaking
--   that UNIQUE contract and the readers (JobDetail completion view, invoice
--   applied-info). So this adds a SEPARATE child table that is many-per-job and
--   references REAL applicator (profiles) + vehicle (vehicles) records — exactly
--   the by-reference model the spec requires. job_applied_info is UNTOUCHED.
--
-- FOUNDATION FOR PHASE 2 — leave clean extension points:
--   * #18 applied-acres-per-location + remaining-acres -> applied_acres column
--     here is the per-record applied total; #18 will add a per-location child
--     (job_applied_record_fields) and drive jobs.applied_acres from the sum.
--   * #19 START + END weather pair -> add start_/end_ weather columns (or a 1:1
--     child) keyed on this record's id.
--   * #20 tach hours -> add beginning_tach / end_tach / net_tach columns here.
--   * #21 ground crew -> add a job_applied_record_crew link (record_id ->
--     ground_crew_members) reusing the ground_crews catalog from #6.
--   The record's id (uuid PK) is the anchor all four hang off.
--
-- ALL changes are ADDITIVE: one new table with RLS. No existing column, table,
-- policy, or RPC is removed or weakened. No money, no lifecycle transition, no
-- actor-sensitive financial write here -> plain RLS-gated mutations, no RPC.
-- ============================================================================

CREATE TABLE IF NOT EXISTS job_applied_records (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id            uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  -- Applicator: a REAL profile reference (NOT free text). ON DELETE SET NULL so
  -- deactivating/removing a profile never orphan-deletes the legal record; the
  -- record survives, the applicator simply shows as "(removed)".
  applicator_id     uuid REFERENCES profiles(id) ON DELETE SET NULL,
  -- Vehicle: a REAL vehicle reference, defaults from the chosen applicator's
  -- most-recent prior record (computed in the UI) but is editable. SET NULL on
  -- vehicle delete for the same reason.
  vehicle_id        uuid REFERENCES vehicles(id) ON DELETE SET NULL,
  -- Application Date: which day this pass was applied. Required — a record with
  -- no date is not a usable legal record.
  application_date  date NOT NULL,
  -- Per-record applied acres total. #18 drives this from per-location detail and
  -- rolls the sum into jobs.applied_acres (which feeds the GENERATED
  -- jobs.remaining_acres). For #17 it is an optional manual figure.
  applied_acres     numeric CHECK (applied_acres IS NULL OR applied_acres >= 0),
  notes             text,
  created_by        uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_applied_records_job ON job_applied_records(job_id);
CREATE INDEX IF NOT EXISTS idx_job_applied_records_applicator ON job_applied_records(applicator_id);
CREATE INDEX IF NOT EXISTS idx_job_applied_records_vehicle ON job_applied_records(vehicle_id);

CREATE TRIGGER set_job_applied_records_updated_at
  BEFORE UPDATE ON job_applied_records
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

ALTER TABLE job_applied_records ENABLE ROW LEVEL SECURITY;

-- Visibility mirrors job_applied_info / job_chemicals: admin + sales_rep manage;
-- an applicator assigned to the job can read AND write its own job's records
-- (they are the ones in the field recording the pass).
DROP POLICY IF EXISTS job_applied_records_select ON job_applied_records;
CREATE POLICY job_applied_records_select ON job_applied_records
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM jobs WHERE jobs.id = job_applied_records.job_id AND (
    is_admin() OR is_sales_rep()
    OR (is_applicator() AND jobs.applicator_id = (SELECT auth.uid()))
  )));

DROP POLICY IF EXISTS job_applied_records_insert ON job_applied_records;
CREATE POLICY job_applied_records_insert ON job_applied_records
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM jobs j WHERE j.id = job_applied_records.job_id AND (
    is_admin() OR is_sales_rep()
    OR (is_applicator() AND j.applicator_id = (SELECT auth.uid()))
  )));

DROP POLICY IF EXISTS job_applied_records_update ON job_applied_records;
CREATE POLICY job_applied_records_update ON job_applied_records
  FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM jobs j WHERE j.id = job_applied_records.job_id AND (
    is_admin() OR is_sales_rep()
    OR (is_applicator() AND j.applicator_id = (SELECT auth.uid()))
  )))
  WITH CHECK (EXISTS (SELECT 1 FROM jobs j WHERE j.id = job_applied_records.job_id AND (
    is_admin() OR is_sales_rep()
    OR (is_applicator() AND j.applicator_id = (SELECT auth.uid()))
  )));

DROP POLICY IF EXISTS job_applied_records_delete ON job_applied_records;
CREATE POLICY job_applied_records_delete ON job_applied_records
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM jobs j WHERE j.id = job_applied_records.job_id AND (
    is_admin() OR is_sales_rep()
    OR (is_applicator() AND j.applicator_id = (SELECT auth.uid()))
  )));
