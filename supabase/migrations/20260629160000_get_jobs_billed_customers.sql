-- 20260629160000_get_jobs_billed_customers.sql
--
-- FIELD-APP PARITY remediation (Wave 2a, FIX 2 — P2 SECURITY / co-billed visibility).
--
-- THE BUG (Jobs.tsx ~405 embed + ~480-491 shareCustomers map):
--   The jobs list embeds job_field_shares.customer(farm_name, account_number). For an
--   APPLICATOR that embed is RLS-blocked — the customers_select policy exposes only the
--   job's PRIMARY customer, never the co-billed split owners referenced by
--   job_field_shares / field_billing_defaults. So co-billed customers come back NULL and
--   the map drops them: an applicator sees only the primary customer on a split job.
--
-- THE FIX — a BATCHED, read-only SECURITY DEFINER resolver, modeled on the existing
-- per-job get_job_billed_customers (20260625180000): same field precedence (saved
-- job_field_shares -> field_billing_defaults -> primary customer_id), self-gated per job
-- on the FULL live jobs visibility, bypassing per-customer RLS so the co-billed NAMES
-- resolve. It runs over MANY job ids in one round-trip (the list calls it once over the
-- visible page) and SKIPS — never RAISES on — a job the caller can't view (the list
-- naturally contains only viewable jobs, but if a stray id slips in we silently omit it
-- rather than failing the whole batch). The per-job RPC still RAISES for the single-doc
-- compliance path; this batch variant is for the list and is fail-soft per row.
--
-- SELF-GATE = BOTH live jobs SELECT policies OR'd (so a per-location-dispatched applicator
-- — visible via jobs_select_location_dispatchee / _is_dispatched_to_me — still gets the
-- co-billed split owners, not a primary-only fallback). See the visible_jobs CTE.
--
-- RETURNS (job_id, customer_id, farm_name, account_number, is_primary) — the per-job
-- shape PLUS job_id so the client can build a Map<job_id, customers[]>.
--
-- READ-ONLY: no mutation -> no p_idempotency_key (read-RPC convention). STABLE,
-- SECURITY DEFINER + SET search_path = public, pg_temp. anon EXECUTE revoked,
-- authenticated granted (mirrors get_job_billed_customers). Single overload (verified:
-- no existing get_jobs_billed_customers). Em-dashes below are real U+2014.

CREATE OR REPLACE FUNCTION public.get_jobs_billed_customers(p_job_ids uuid[])
RETURNS TABLE (
  job_id uuid,
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
BEGIN
  IF p_job_ids IS NULL OR array_length(p_job_ids, 1) IS NULL THEN
    RETURN;  -- empty input -> empty set
  END IF;

  RETURN QUERY
  WITH input_jobs AS (
    SELECT DISTINCT v.job_id FROM unnest(p_job_ids) AS v(job_id)
  ),
  -- VISIBLE jobs only: self-gate per job on the FULL live jobs visibility — BOTH
  -- SELECT policies OR'd together, so we never under-resolve a job the caller can
  -- actually see:
  --   jobs_select:                     is_admin OR is_sales_rep OR (is_applicator AND applicator_id = auth.uid())
  --   jobs_select_location_dispatchee: _is_dispatched_to_me(job_id)  (per-location / crew dispatch)
  -- Without the dispatch leg, a per-location-dispatched applicator's /jobs row would
  -- fall back to primary-only and HIDE co-billed split owners — the exact bug FIX 2
  -- closes (Codex). A job the caller can't view is SKIPPED (fail-soft), never raised on.
  visible_jobs AS (
    SELECT j.id AS job_id, j.customer_id AS primary_customer_id
    FROM jobs j
    JOIN input_jobs ij ON ij.job_id = j.id
    WHERE is_admin()
       OR is_sales_rep()
       OR (is_applicator() AND j.applicator_id = (SELECT auth.uid()))
       OR _is_dispatched_to_me(j.id)
  ),
  job_field_ids AS (
    -- Every field on each visible job (the unit of billing precedence).
    SELECT vj.job_id, jf.field_id
    FROM visible_jobs vj
    JOIN job_fields jf ON jf.job_id = vj.job_id AND jf.field_id IS NOT NULL
  ),
  fields_with_share AS (
    -- Shares whose field is ACTUALLY on the job (ignore an orphan share row).
    SELECT DISTINCT jfs.job_id, jfs.field_id
    FROM job_field_shares jfs
    JOIN job_field_ids jfi ON jfi.job_id = jfs.job_id AND jfi.field_id = jfs.field_id
  ),
  resolved AS (
    -- 1. Saved per-field shares (explicit split) — only for fields on the job.
    SELECT jfs.job_id, jfs.customer_id
    FROM job_field_shares jfs
    JOIN job_field_ids jfi ON jfi.job_id = jfs.job_id AND jfi.field_id = jfs.field_id
    WHERE jfs.customer_id IS NOT NULL

    UNION ALL

    -- 2. field_billing_defaults for fields WITHOUT a saved share.
    SELECT jfi.job_id, fbd.customer_id
    FROM job_field_ids jfi
    JOIN field_billing_defaults fbd ON fbd.field_id = jfi.field_id
    WHERE NOT EXISTS (
            SELECT 1 FROM fields_with_share fws
            WHERE fws.job_id = jfi.job_id AND fws.field_id = jfi.field_id
          )
      AND fbd.customer_id IS NOT NULL

    UNION ALL

    -- 3. The job's PRIMARY customer for fields with neither a share nor a default.
    SELECT jfi.job_id, vj.primary_customer_id
    FROM job_field_ids jfi
    JOIN visible_jobs vj ON vj.job_id = jfi.job_id
    WHERE NOT EXISTS (
            SELECT 1 FROM fields_with_share fws
            WHERE fws.job_id = jfi.job_id AND fws.field_id = jfi.field_id
          )
      AND NOT EXISTS (
            SELECT 1 FROM field_billing_defaults fbd WHERE fbd.field_id = jfi.field_id
          )
      AND vj.primary_customer_id IS NOT NULL

    UNION ALL

    -- 4. SAFETY FALLBACK: a visible job with NO fields still has a primary customer.
    SELECT vj.job_id, vj.primary_customer_id
    FROM visible_jobs vj
    WHERE NOT EXISTS (SELECT 1 FROM job_field_ids jfi WHERE jfi.job_id = vj.job_id)
      AND vj.primary_customer_id IS NOT NULL
  ),
  distinct_pairs AS (
    SELECT DISTINCT r.job_id, r.customer_id FROM resolved r
  )
  -- LEFT JOIN so a since-removed customer_id still surfaces (NULL farm_name); the
  -- client treats a NULL name as INCOMPLETE for compliance docs, but for the LIST
  -- it just shows whatever resolves. is_primary = the job's primary customer.
  SELECT
    d.job_id,
    d.customer_id,
    c.farm_name,
    c.account_number,
    (d.customer_id = vj.primary_customer_id) AS is_primary
  FROM distinct_pairs d
  JOIN visible_jobs vj ON vj.job_id = d.job_id
  LEFT JOIN customers c ON c.id = d.customer_id
  ORDER BY d.job_id, (d.customer_id = vj.primary_customer_id) DESC, c.farm_name NULLS LAST;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_jobs_billed_customers(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_jobs_billed_customers(uuid[]) TO authenticated;

COMMENT ON FUNCTION public.get_jobs_billed_customers(uuid[]) IS
  'Field-app FIX 2 (Wave 2a): batched, read-only resolver for many jobs'' billed '
  'customers (job_field_shares -> field_billing_defaults -> primary customer_id), '
  'bypassing per-customer RLS so an applicator''s /jobs list shows co-billed split '
  'customers. Self-gates per job on the live jobs_select applicator predicate; a '
  'non-viewable job is SKIPPED (fail-soft), never raised on. Batch sibling of '
  'get_job_billed_customers.';
