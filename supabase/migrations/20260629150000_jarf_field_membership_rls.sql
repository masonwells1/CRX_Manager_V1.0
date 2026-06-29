-- 20260629150000_jarf_field_membership_rls.sql
--
-- FIELD-APP PARITY remediation (Wave 2a, FIX 1 — P2 SECURITY).
--
-- THE HOLE (original migration 20260624180000_job_applied_record_fields.sql,
-- lines 91-101 INSERT / 103-121 UPDATE):
--   The INSERT/UPDATE RLS on job_applied_record_fields checks ONLY that the caller
--   may edit the PARENT applied record (its job is admin/sales-owned, or the caller
--   is the assigned applicator). It does NOT check that the row's field_id is one of
--   the job's fields. So an authenticated sales_rep / applicator could POST acreage
--   for ANY field UUID — a field not on the job, or a field on someone else's job —
--   and the recompute trigger sums it into jobs.applied_acres / remaining_acres,
--   corrupting the as-applied totals (and the loader/applicator compliance figures).
--
-- THE FIX:
--   DROP + recreate ONLY the INSERT and UPDATE policies, ANDing the EXISTING
--   parent-authorization predicate (reproduced verbatim from live) with a NEW
--   field-membership predicate:
--     EXISTS (SELECT 1 FROM job_fields jf
--             JOIN job_applied_records r ON r.job_id = jf.job_id
--             WHERE r.id = job_applied_record_fields.application_record_id
--               AND jf.field_id = job_applied_record_fields.field_id)
--   i.e. the field being written MUST be a field on the SAME job that owns the
--   parent applied record. A foreign field_id now fails the WITH CHECK and the row
--   is rejected. The parent-auth gate is KEPT (AND-ed, not replaced), so this only
--   TIGHTENS who/what can be written — it never widens it.
--
-- SCOPE / SAFETY:
--   * SELECT and DELETE policies are LEFT UNTOUCHED (a delete of a corrupt/foreign
--     row must still be possible by an authorized parent editor; and read is already
--     parent-gated). Only the two WRITE paths that can INSERT a foreign field gain
--     the membership check.
--   * The column is application_record_id (verified live), job_applied_records has
--     job_id, job_fields has (job_id, field_id) (all verified live before writing).
--   * Additive-security only: no table/function/data touched; policies are RLS,
--     re-runnable (DROP POLICY IF EXISTS ... CREATE POLICY).
--   * UPDATE policy keeps the same USING (visibility of the row to update) and adds
--     the membership predicate to BOTH USING and WITH CHECK, so you can neither move
--     an existing row onto a foreign field nor edit a row already pointing at one.
--   Em-dashes below are real U+2014.

-- ── INSERT: parent-auth AND field-membership ────────────────────────────────
DROP POLICY IF EXISTS job_applied_record_fields_insert ON job_applied_record_fields;
CREATE POLICY job_applied_record_fields_insert ON job_applied_record_fields
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM job_applied_records r
      JOIN jobs j ON j.id = r.job_id
      WHERE r.id = job_applied_record_fields.application_record_id AND (
        is_admin() OR is_sales_rep()
        OR (is_applicator() AND j.applicator_id = (SELECT auth.uid()))
      )
    )
    AND EXISTS (
      -- The field must belong to the SAME job as the parent applied record.
      SELECT 1 FROM job_fields jf
      JOIN job_applied_records r2 ON r2.job_id = jf.job_id
      WHERE r2.id = job_applied_record_fields.application_record_id
        AND jf.field_id = job_applied_record_fields.field_id
    )
  );

-- ── UPDATE: parent-auth AND field-membership (USING + WITH CHECK) ────────────
DROP POLICY IF EXISTS job_applied_record_fields_update ON job_applied_record_fields;
CREATE POLICY job_applied_record_fields_update ON job_applied_record_fields
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM job_applied_records r
      JOIN jobs j ON j.id = r.job_id
      WHERE r.id = job_applied_record_fields.application_record_id AND (
        is_admin() OR is_sales_rep()
        OR (is_applicator() AND j.applicator_id = (SELECT auth.uid()))
      )
    )
    AND EXISTS (
      SELECT 1 FROM job_fields jf
      JOIN job_applied_records r2 ON r2.job_id = jf.job_id
      WHERE r2.id = job_applied_record_fields.application_record_id
        AND jf.field_id = job_applied_record_fields.field_id
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM job_applied_records r
      JOIN jobs j ON j.id = r.job_id
      WHERE r.id = job_applied_record_fields.application_record_id AND (
        is_admin() OR is_sales_rep()
        OR (is_applicator() AND j.applicator_id = (SELECT auth.uid()))
      )
    )
    AND EXISTS (
      SELECT 1 FROM job_fields jf
      JOIN job_applied_records r2 ON r2.job_id = jf.job_id
      WHERE r2.id = job_applied_record_fields.application_record_id
        AND jf.field_id = job_applied_record_fields.field_id
    )
  );
