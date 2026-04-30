-- =============================================================================
-- Migration: 20260430180000_field_app_workflow_phase5.sql
-- Phase 5 of the Field Application Workflow rewrite — RLS Hardening.
--
-- See: docs/audits/2026-04-28-field-application-workflow-response-to-codex.md
-- Bundles fixes for codex audit item: #10.
--
-- Problem: jobs_update RLS allows the assigned applicator to UPDATE any column
-- on the jobs row, which means an applicator with PostgREST access could
-- silently change total_price_cents, customer_id, or applicator_id (reassigning
-- the job to themselves) WITHOUT going through any RPC.
--
-- Same bug on job_applied_info: insert/update require only that the user is
-- some applicator, not that they're the applicator assigned to THIS job.
--
-- Acceptance (per audit): applicator role can complete an assigned job through
-- the RPCs only, cannot mutate price/customer/applicator via direct table writes.
--
-- Strategy: tighten the policies. SECURITY DEFINER RPCs (start_job, complete_job)
-- are unaffected — they bypass RLS entirely. Applicators continue to do their
-- work through those RPCs.
-- =============================================================================


-- ── jobs.UPDATE: admin/sales only ──────────────────────────────────────────────
-- Applicators MUST use start_job / complete_job (SECURITY DEFINER) to transition
-- a job. Direct UPDATE was a privilege-escalation vector.
DROP POLICY IF EXISTS jobs_update ON jobs;
CREATE POLICY jobs_update ON jobs
  FOR UPDATE
  USING      (is_admin() OR is_sales_rep())
  WITH CHECK (is_admin() OR is_sales_rep());


-- ── job_applied_info.INSERT: ownership-gated ───────────────────────────────────
-- Applicator can only insert applied-info rows for jobs assigned to them.
DROP POLICY IF EXISTS job_applied_info_insert ON job_applied_info;
CREATE POLICY job_applied_info_insert ON job_applied_info
  FOR INSERT
  WITH CHECK (
    is_admin()
    OR is_sales_rep()
    OR (
      is_applicator()
      AND EXISTS (
        SELECT 1 FROM jobs j
         WHERE j.id = job_applied_info.job_id
           AND j.applicator_id = (SELECT auth.uid())
      )
    )
  );


-- ── job_applied_info.UPDATE: ownership-gated ──────────────────────────────────
DROP POLICY IF EXISTS job_applied_info_update ON job_applied_info;
CREATE POLICY job_applied_info_update ON job_applied_info
  FOR UPDATE
  USING (
    is_admin()
    OR is_sales_rep()
    OR (
      is_applicator()
      AND EXISTS (
        SELECT 1 FROM jobs j
         WHERE j.id = job_applied_info.job_id
           AND j.applicator_id = (SELECT auth.uid())
      )
    )
  )
  WITH CHECK (
    is_admin()
    OR is_sales_rep()
    OR (
      is_applicator()
      AND EXISTS (
        SELECT 1 FROM jobs j
         WHERE j.id = job_applied_info.job_id
           AND j.applicator_id = (SELECT auth.uid())
      )
    )
  );


-- ── Verification ───────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_jobs_update_qual text;
  v_jai_insert_check text;
BEGIN
  SELECT pg_get_expr(polqual, polrelid) INTO v_jobs_update_qual
    FROM pg_policy WHERE polrelid='jobs'::regclass AND polname='jobs_update';
  IF v_jobs_update_qual ILIKE '%applicator%' THEN
    RAISE EXCEPTION 'VERIFICATION FAILED: jobs_update still references applicator (qual = %)', v_jobs_update_qual;
  END IF;

  SELECT pg_get_expr(polwithcheck, polrelid) INTO v_jai_insert_check
    FROM pg_policy WHERE polrelid='job_applied_info'::regclass AND polname='job_applied_info_insert';
  IF v_jai_insert_check NOT ILIKE '%applicator_id%' THEN
    RAISE EXCEPTION 'VERIFICATION FAILED: job_applied_info_insert does not enforce applicator ownership (with_check = %)', v_jai_insert_check;
  END IF;

  RAISE NOTICE 'Phase 5 verified: jobs_update is admin/sales only, job_applied_info_insert/update enforce ownership';
END $$;
