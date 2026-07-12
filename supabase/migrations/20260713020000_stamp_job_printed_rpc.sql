-- ChemMan parity follow-up: print-audit stamping RPC.
--
-- The print flows stamp jobs.printed_at / jobs.last_printed_by with a direct
-- `.from('jobs').update(...)`. jobs_update RLS is admin/sales-only, so for an
-- applicator-role user the stamp is a silent no-op (the frontend deliberately
-- treats stamping as non-blocking). This RPC lets any user who can SEE the job
-- (the exact jobs_select + jobs_select_location_dispatchee breadth) record the
-- print audit, without widening jobs_update itself.

CREATE OR REPLACE FUNCTION public.stamp_job_printed(
  p_job_id uuid,
  p_idempotency_key text DEFAULT NULL
) RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_cached jsonb;
BEGIN
  -- Visibility gate FIRST (Codex P2 hardening: never serve a cached replay to a
  -- caller who can't see the job). Mirror jobs_select (admin / sales / assigned
  -- applicator) plus jobs_select_location_dispatchee (_is_dispatched_to_me).
  -- Anyone who can read the job can print it, so they must be able to record
  -- that they did.
  IF NOT EXISTS (
    SELECT 1 FROM public.jobs j
    WHERE j.id = p_job_id
      AND (
        is_admin()
        OR is_sales_rep()
        OR (is_applicator() AND j.applicator_id = (SELECT auth.uid()))
        OR _is_dispatched_to_me(j.id)
      )
  ) THEN
    RETURN json_build_object('success', false, 'error', 'Job not found or not visible');
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_cached := check_idempotency(p_idempotency_key, 'stamp_job_printed');
    IF v_cached IS NOT NULL THEN
      -- Codex P2 hardening: check_idempotency keys on (key, operation) only, so a
      -- reused key with a DIFFERENT job must not replay the other job's result.
      IF v_cached->>'job_id' IS DISTINCT FROM p_job_id::text THEN
        RETURN json_build_object('success', false, 'error', 'IDEMPOTENCY_ARGUMENT_MISMATCH');
      END IF;
      RETURN v_cached::json;
    END IF;
  END IF;

  UPDATE public.jobs
     SET printed_at = now(),
         last_printed_by = (SELECT auth.uid())
   WHERE id = p_job_id;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'stamp_job_printed',
      jsonb_build_object('success', true, 'job_id', p_job_id));
  END IF;

  RETURN json_build_object('success', true, 'job_id', p_job_id);
END;
$$;

REVOKE ALL ON FUNCTION public.stamp_job_printed(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.stamp_job_printed(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.stamp_job_printed(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.stamp_job_printed(uuid, text) IS
  'Records the print audit (printed_at + last_printed_by) for any user who can see the job. SECURITY DEFINER because jobs_update RLS is admin/sales-only.';
