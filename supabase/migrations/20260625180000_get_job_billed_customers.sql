-- 20260625180000_get_job_billed_customers.sql
-- Field-app parity #11 (+#10) COMPLIANCE FIX — safe billed-customer resolver.
--
-- THE BUG (verified live): on a SPLIT-BILLED job, an APPLICATOR who generates a
-- compliance document (Chemical Application Report #11 / Loader Worksheet #10)
-- receives a PDF that SILENTLY OMITS the co-billed customers, while the code still
-- stamps jobs.printed_at as if the document were complete.
--
-- ROOT CAUSE: the customers_select RLS policy lets an applicator see ONLY the
-- job's PRIMARY customer (customers.id = jobs.customer_id, job_date within ~7 days).
-- It has NO path to the CO-billed customers referenced by job_field_shares /
-- field_billing_defaults. Those customer embeds/lookups therefore return NULL names
-- and the report code drops them. The applicator CAN read job_field_shares /
-- job_fields / field_billing_defaults for their own job — only the customers.* NAMES
-- are hidden.
--
-- THE FIX: a READ-ONLY SECURITY DEFINER function that resolves the job's billed
-- customers (names + account) using the SAME precedence the report already uses,
-- WITHOUT depending on per-customer row RLS. It SELF-GATES on the exact
-- applicator-visibility predicate the live jobs_select policy uses, so it never
-- widens who can see a job — it only un-hides the co-billed NAMES for a caller who
-- is already allowed to view that job. If the caller can't view the job it RAISES
-- (never returns a partial set). The frontend then ABORTS the PDF (and the
-- printed_at stamp) if any billed customer still fails to resolve to a name — a
-- compliance document is complete-or-refused, never silently partial.
--
-- READ-ONLY: no mutation, so NO p_idempotency_key (per the read-RPC convention).
-- Single overload (verified: no existing get_job_billed_customers).
-- Em-dashes below are real U+2014.

-- ─────────────────────────────────────────────────────────────────────────────
-- get_job_billed_customers(p_job_id)
--   Returns the DISTINCT billed customers for a job, resolved by the report's
--   precedence per field:
--     1. saved job_field_shares (the explicit per-field split — multi-customer),
--     2. field_billing_defaults for any field with NO saved share,
--     3. the job's PRIMARY customer_id for a field with neither.
--   is_primary = true for the row whose customer_id equals the job's primary
--   customer_id (useful to the report header). DISTINCT on customer_id.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_job_billed_customers(p_job_id uuid)
RETURNS TABLE (
  customer_id uuid,
  farm_name text,
  account_number text,
  is_primary boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_primary_customer_id uuid;
  v_applicator_id uuid;
BEGIN
  -- Load the job's gate columns (definer-privileged read).
  SELECT j.customer_id, j.applicator_id
    INTO v_primary_customer_id, v_applicator_id
  FROM jobs j
  WHERE j.id = p_job_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'no_data_found';
  END IF;

  -- SELF-GATE: mirror the live jobs_select RLS predicate EXACTLY —
  --   is_admin() OR is_sales_rep() OR (is_applicator() AND applicator_id = auth.uid())
  -- so this RPC never lets anyone see a job they couldn't already see. Reject a
  -- caller who can't view the job (do NOT return a partial set).
  IF NOT (
    is_admin()
    OR is_sales_rep()
    OR (is_applicator() AND v_applicator_id = auth.uid())
  ) THEN
    RAISE EXCEPTION 'Not authorized to view this job''s billed customers'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  WITH job_field_ids AS (
    -- Every field on the job (field_id is the unit of billing precedence).
    SELECT DISTINCT jf.field_id
    FROM job_fields jf
    WHERE jf.job_id = p_job_id AND jf.field_id IS NOT NULL
  ),
  fields_with_share AS (
    -- Only shares whose field is ACTUALLY on the job (guard against an orphan
    -- job_field_shares row for a field no longer on the job).
    SELECT DISTINCT jfs.field_id
    FROM job_field_shares jfs
    JOIN job_field_ids jfi ON jfi.field_id = jfs.field_id
    WHERE jfs.job_id = p_job_id
  ),
  resolved AS (
    -- 1. Saved per-field shares (explicit split) — only for fields on the job, so an
    --    orphan share (field removed from the job) never adds a customer (Codex LOW).
    SELECT jfs.customer_id
    FROM job_field_shares jfs
    JOIN job_field_ids jfi ON jfi.field_id = jfs.field_id
    WHERE jfs.job_id = p_job_id AND jfs.customer_id IS NOT NULL

    UNION ALL

    -- 2. field_billing_defaults for fields WITHOUT a saved share.
    SELECT fbd.customer_id
    FROM job_field_ids jfi
    JOIN field_billing_defaults fbd ON fbd.field_id = jfi.field_id
    WHERE jfi.field_id NOT IN (SELECT field_id FROM fields_with_share)
      AND fbd.customer_id IS NOT NULL

    UNION ALL

    -- 3. The job's PRIMARY customer for fields that have neither a saved share
    --    nor a billing default.
    SELECT v_primary_customer_id
    FROM job_field_ids jfi
    WHERE jfi.field_id NOT IN (SELECT field_id FROM fields_with_share)
      AND NOT EXISTS (
        SELECT 1 FROM field_billing_defaults fbd WHERE fbd.field_id = jfi.field_id
      )
      AND v_primary_customer_id IS NOT NULL

    UNION ALL

    -- 4. SAFETY FALLBACK: a job with NO fields at all still has a primary customer
    --    — surface it so the resolver never returns an empty set for a real job
    --    (mirrors the frontend "if custMap empty → add primary" fallback).
    SELECT v_primary_customer_id
    WHERE NOT EXISTS (SELECT 1 FROM job_field_ids)
      AND v_primary_customer_id IS NOT NULL
  )
  -- LEFT JOIN (not INNER) so a billed customer_id that does NOT resolve to a
  -- customers row (e.g. a since-removed customer) still surfaces — as a row with a
  -- NULL farm_name. The frontend resolver treats a NULL/blank name as an INCOMPLETE
  -- resolution and ABORTS the compliance PDF, rather than silently omitting that
  -- billed party. (With the FK + NOT NULL farm_name this is belt-and-suspenders, but
  -- it makes the complete-or-refused guard genuinely enforceable.)
  SELECT
    d.customer_id,
    c.farm_name,
    c.account_number,
    (d.customer_id = v_primary_customer_id) AS is_primary
  FROM (SELECT DISTINCT r.customer_id FROM resolved r) d
  LEFT JOIN customers c ON c.id = d.customer_id
  ORDER BY (d.customer_id = v_primary_customer_id) DESC, c.farm_name NULLS LAST;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_job_billed_customers(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_job_billed_customers(uuid) TO authenticated;

COMMENT ON FUNCTION public.get_job_billed_customers(uuid) IS
  'Field-app #11/#10 compliance: read-only resolver for a job''s billed customers '
  '(job_field_shares -> field_billing_defaults -> primary customer_id), bypassing '
  'per-customer RLS so an applicator''s compliance PDF includes co-billed customers. '
  'Self-gates on the live jobs_select applicator predicate; RAISES if the caller '
  'cannot view the job.';
