-- ============================================================================
-- Migration: Batch Year-End Summaries + Storage Policy Auth Fix
-- Description:
--   Part A: New RPC get_batch_year_end_summaries() — eliminates N+1 network
--           round-trips when generating year-end PDFs for multiple customers.
--   Part B: Fix document-uploads storage policies to use (select auth.uid())
--           wrapper for planner efficiency (prevents per-row re-evaluation).
-- ============================================================================

-- ── Part A: Batch Year-End Summary RPC ──────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_batch_year_end_summaries(
  p_customer_ids uuid[],
  p_season       integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_results jsonb := '[]'::jsonb;
  v_cid     uuid;
  v_summary jsonb;
BEGIN
  FOREACH v_cid IN ARRAY p_customer_ids LOOP
    SELECT public.get_customer_year_end_summary(v_cid, p_season) INTO v_summary;
    IF v_summary IS NOT NULL THEN
      v_results := v_results || jsonb_build_array(v_summary);
    END IF;
  END LOOP;
  RETURN v_results;
END;
$$;

COMMENT ON FUNCTION public.get_batch_year_end_summaries(uuid[], integer)
  IS 'Batch wrapper around get_customer_year_end_summary — one RPC call for N customers';

-- ── Part B: Fix document-uploads storage policies ───────────────────────────
-- Replace bare auth.uid() with (select auth.uid()) for query planner efficiency.
-- The INSERT policy ("Authenticated users can upload documents") has no auth.uid()
-- reference so it does not need fixing.

DROP POLICY IF EXISTS "Users can read own document uploads" ON storage.objects;
CREATE POLICY "Users can read own document uploads"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'document-uploads'
    AND (storage.foldername(name))[1] = (select auth.uid())::text
  );

DROP POLICY IF EXISTS "Users can delete own document uploads" ON storage.objects;
CREATE POLICY "Users can delete own document uploads"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'document-uploads'
    AND (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- Also fix the document_processing_log policies that use bare auth.uid()

DROP POLICY IF EXISTS "Users can insert own processing logs" ON document_processing_log;
CREATE POLICY "Users can insert own processing logs"
  ON document_processing_log FOR INSERT
  TO authenticated
  WITH CHECK (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "Users can view own processing logs" ON document_processing_log;
CREATE POLICY "Users can view own processing logs"
  ON document_processing_log FOR SELECT
  TO authenticated
  USING (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "Admins can view all processing logs" ON document_processing_log;
CREATE POLICY "Admins can view all processing logs"
  ON document_processing_log FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = (select auth.uid())
      AND profiles.role = 'admin'
    )
  );
