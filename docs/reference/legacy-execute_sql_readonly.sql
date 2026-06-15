-- ============================================================================
-- REFERENCE ONLY — NOT A RUNNABLE MIGRATION. DO NOT place under supabase/migrations/.
-- ============================================================================
-- Foundation Ultra Review 2026-06-15, M3: `execute_sql_readonly(text)` exists in the
-- live database but its CREATE FUNCTION is not present in any disk migration (legacy
-- debt). This file captures the EXACT live definition (pg_get_functiondef, 2026-06-15)
-- for reproducibility/audit. It is intentionally NOT a migration:
--   * the function is already correctly locked down — EXECUTE is REVOKED from anon,
--     authenticated, and PUBLIC (migrations 20260526151856 / 20260614153000); only
--     service_role + the postgres owner can call it;
--   * re-emitting an arbitrary-SQL SECURITY DEFINER function via a new migration is
--     higher-risk than the documentation benefit.
-- If a clean rebuild ever needs it, fold this definition into a reviewed squashed
-- baseline (see H5) — do not apply it standalone.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.execute_sql_readonly(sql_query text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
  v_trimmed text;
BEGIN
  -- Trim whitespace and normalize
  v_trimmed := btrim(regexp_replace(sql_query, E'^\\s+', '', 'g'));
  v_trimmed := lower(v_trimmed);

  -- Only allow queries that START with SELECT or WITH (CTEs)
  IF NOT (v_trimmed LIKE 'select%' OR v_trimmed LIKE 'with%') THEN
    RAISE EXCEPTION 'Only SELECT queries are allowed';
  END IF;

  EXECUTE 'SELECT jsonb_agg(row_to_json(t)) FROM (' || sql_query || ') t'
    INTO v_result;

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$function$;

-- Live grant matrix (verified 2026-06-15): anon=FALSE, authenticated=FALSE, PUBLIC=FALSE,
-- service_role=TRUE, owner(postgres)=TRUE.
