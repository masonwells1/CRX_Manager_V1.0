-- ============================================================================
-- FIELD-APP PARITY #21: Ground crew + ground crew members on an applied record
-- CRX Manager V1.0
-- Date: 2026-06-24
--
-- ChemMan's "Add Applied Info" captures a Ground Crew and one-or-more Ground
-- Crew Members on the application record (the extra hands on the ground for a
-- pass, beyond the lead applicator). Ground Crew Member is ALSO a filter on the
-- Posted Field Application Report, so crew membership must be a stored,
-- queryable reference — not free text.
--
-- WHAT ALREADY EXISTS (section #6 — REUSE, do NOT recreate):
--   * ground_crews         — managed catalog of crews (create/rename/deactivate)
--   * ground_crew_members  — people belonging to a crew (crew has-many members)
--   Both with RLS + a GroundCrewsManager UI. jobs.ground_crew_id ties a crew to a
--   job at the JOB level (#6). This section attaches crew MEMBERS to a specific
--   as-applied ENTRY (job_applied_records, the #17 anchor) — a different grain.
--
-- WHAT THIS MIGRATION ADDS — one new link table:
--   job_applied_record_crew(application_record_id -> job_applied_records, member_id
--   -> ground_crew_members) with job-scoped RLS (admin/sales_rep OR applicator on
--   their own job), walked link -> record -> job, mirroring #18's child-table RLS.
--
-- FK ON DELETE — the load-bearing legal-record decision (per #18 LESSON):
--   * application_record_id -> ON DELETE CASCADE. Correct: deleting an as-applied
--     entry SHOULD drop its crew links (the entry no longer exists).
--   * member_id -> ON DELETE SET NULL (NOT cascade). A member later removed from
--     the catalog must NOT silently erase the legal record of who was on the crew
--     that day. SET NULL keeps the link row; the captured member_name_snapshot
--     (and crew_name_snapshot) still show WHO was present. This is the same
--     "preserve the legal as-applied proof" rule #17/#18 used (applicator/vehicle
--     SET NULL, field-acres survive a job<->field unlink).
--
-- SNAPSHOTS — names preserved even if the member/crew is later deleted or renamed:
--   member_name_snapshot (NOT NULL) + crew_id_snapshot + crew_name_snapshot are
--   captured AT ATTACH TIME from the catalog. The live FK (member_id) gives
--   reference integrity while the member exists (a renamed member resolves live);
--   the snapshot is the durable fallback once the member is gone (member_id NULL).
--   So: live member present -> show the live (possibly renamed) name; member
--   deleted -> show the snapshot. Both paths keep the historical record intact.
--
-- ALL changes are ADDITIVE: one new table with RLS. No existing column, table,
-- policy, trigger, or RPC is removed or weakened. The #18 acres rollup reads only
-- job_applied_record_fields and is UNTOUCHED. No money, no lifecycle transition,
-- no actor-sensitive financial write -> plain RLS-gated mutations, no RPC.
-- ============================================================================

CREATE TABLE IF NOT EXISTS job_applied_record_crew (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The as-applied entry these crew members were present for. CASCADE: deleting
  -- the entry removes its crew links (they describe that entry, nothing else).
  application_record_id uuid NOT NULL REFERENCES job_applied_records(id) ON DELETE CASCADE,
  -- The crew member who was present. SET NULL (NOT cascade) so removing a member
  -- from the catalog never erases the legal record of who was on the crew that
  -- day — the link row survives and member_name_snapshot still identifies them.
  member_id             uuid REFERENCES ground_crew_members(id) ON DELETE SET NULL,
  -- Durable snapshot of the member's name AT ATTACH TIME. NOT NULL — even after
  -- member_id is SET NULL by a catalog delete, the record shows who was present.
  member_name_snapshot  text NOT NULL,
  -- Which crew the member belonged to at attach time (snapshot, for reporting /
  -- grouping). crew_id_snapshot is a soft reference (no FK ON DELETE worry — it
  -- is a captured value, not a live link); crew_name_snapshot is the display name.
  crew_id_snapshot      uuid,
  crew_name_snapshot    text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  -- A member appears at most once per entry (you are either on the crew for this
  -- pass or you are not). NULLS NOT DISTINCT so two SET-NULL'd (deleted-member)
  -- rows on the same entry can't be re-inserted as duplicates either — but the
  -- common case is one row per (entry, member).
  UNIQUE (application_record_id, member_id)
);

CREATE INDEX IF NOT EXISTS idx_jarc_record ON job_applied_record_crew(application_record_id);
CREATE INDEX IF NOT EXISTS idx_jarc_member ON job_applied_record_crew(member_id);

ALTER TABLE job_applied_record_crew ENABLE ROW LEVEL SECURITY;

-- RLS mirrors job_applied_record_fields (#18): admin + sales_rep manage; an
-- applicator assigned to the job can read AND write its own job's crew links. The
-- gate walks link -> parent record -> job, then applies the same job-scoped
-- predicate as the parent table (#17). No SELECT-true catalog-style policy here:
-- crew ATTACHMENTS are job-scoped data (who was on which job), not the public
-- crew catalog (ground_crews/ground_crew_members keep their own SELECT-true).
DROP POLICY IF EXISTS job_applied_record_crew_select ON job_applied_record_crew;
CREATE POLICY job_applied_record_crew_select ON job_applied_record_crew
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM job_applied_records r
    JOIN jobs j ON j.id = r.job_id
    WHERE r.id = job_applied_record_crew.application_record_id AND (
      is_admin() OR is_sales_rep()
      OR (is_applicator() AND j.applicator_id = (SELECT auth.uid()))
    )
  ));

DROP POLICY IF EXISTS job_applied_record_crew_insert ON job_applied_record_crew;
CREATE POLICY job_applied_record_crew_insert ON job_applied_record_crew
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM job_applied_records r
    JOIN jobs j ON j.id = r.job_id
    WHERE r.id = job_applied_record_crew.application_record_id AND (
      is_admin() OR is_sales_rep()
      OR (is_applicator() AND j.applicator_id = (SELECT auth.uid()))
    )
  ));

DROP POLICY IF EXISTS job_applied_record_crew_update ON job_applied_record_crew;
CREATE POLICY job_applied_record_crew_update ON job_applied_record_crew
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM job_applied_records r
    JOIN jobs j ON j.id = r.job_id
    WHERE r.id = job_applied_record_crew.application_record_id AND (
      is_admin() OR is_sales_rep()
      OR (is_applicator() AND j.applicator_id = (SELECT auth.uid()))
    )
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM job_applied_records r
    JOIN jobs j ON j.id = r.job_id
    WHERE r.id = job_applied_record_crew.application_record_id AND (
      is_admin() OR is_sales_rep()
      OR (is_applicator() AND j.applicator_id = (SELECT auth.uid()))
    )
  ));

DROP POLICY IF EXISTS job_applied_record_crew_delete ON job_applied_record_crew;
CREATE POLICY job_applied_record_crew_delete ON job_applied_record_crew
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM job_applied_records r
    JOIN jobs j ON j.id = r.job_id
    WHERE r.id = job_applied_record_crew.application_record_id AND (
      is_admin() OR is_sales_rep()
      OR (is_applicator() AND j.applicator_id = (SELECT auth.uid()))
    )
  ));
