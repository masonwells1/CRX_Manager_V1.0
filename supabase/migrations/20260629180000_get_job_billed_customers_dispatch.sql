-- 20260629180000_get_job_billed_customers_dispatch.sql
--
-- FIELD-APP PARITY remediation (Wave 2b, FIX 5 — folded P2 dispatch visibility).
--
-- THE BUG: get_job_billed_customers(p_job_id) (the per-job compliance resolver from
-- 20260625180000) self-gates on the NARROW jobs_select predicate only:
--     is_admin() OR is_sales_rep() OR (is_applicator() AND applicator_id = auth.uid())
-- It MISSES the per-location dispatch leg. So a per-location-DISPATCHED applicator —
-- who CAN see the job via jobs_select_location_dispatchee / _is_dispatched_to_me — is
-- REFUSED ('insufficient_privilege') when generating the job's Chemical Application
-- Report (#11) / Loader Worksheet (#10). This is the SAME narrow self-gate Wave 2a
-- already fixed in the batch sibling get_jobs_billed_customers (20260629160000): that
-- one ORs in _is_dispatched_to_me; this per-job RPC was left behind.
--
-- THE FIX: CREATE OR REPLACE the per-job function adding the dispatch leg to its
-- self-gate, mirroring EXACTLY how the batch sibling gates:
--     ... OR _is_dispatched_to_me(p_job_id)
-- Everything else is faithful to 20260625180000 — same RETURNS shape, same field
-- precedence (saved job_field_shares -> field_billing_defaults -> primary customer_id),
-- same RAISE-on-not-viewable contract (complete-or-refused for the compliance PDF),
-- STABLE, SECURITY DEFINER, SET search_path = public, pg_temp, anon EXECUTE revoked,
-- authenticated granted, ONE overload (verified: only the p_job_id uuid overload
-- exists). Em-dashes below are real U+2014.

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

  -- SELF-GATE: mirror the FULL live jobs visibility — BOTH SELECT policies OR'd:
  --   jobs_select:                     is_admin OR is_sales_rep OR (is_applicator AND applicator_id = auth.uid())
  --   jobs_select_location_dispatchee: _is_dispatched_to_me(job_id)  (per-location / crew dispatch)
  -- Without the dispatch leg a per-location-dispatched applicator (who CAN see the
  -- job) is refused here and their compliance PDF is blocked — the exact bug FIX 5
  -- closes. The dispatch helper is SECURITY DEFINER + re-checks active profile / active
  -- crew, so it never widens visibility beyond the live policy. Reject a caller who
  -- can't view the job (do NOT return a partial set — compliance is complete-or-refused).
  IF NOT (
    is_admin()
    OR is_sales_rep()
    OR (is_applicator() AND v_applicator_id = (SELECT auth.uid()))
    OR _is_dispatched_to_me(p_job_id)
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
  -- billed party.
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
  'Self-gates on the FULL live jobs visibility (jobs_select applicator predicate OR '
  '_is_dispatched_to_me, Wave 2b FIX 5); RAISES if the caller cannot view the job.';
