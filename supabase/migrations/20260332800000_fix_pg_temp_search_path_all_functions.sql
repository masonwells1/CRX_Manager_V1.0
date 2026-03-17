-- Fix pg_temp search_path on ALL public functions
-- ================================================
-- Why: SECURITY DEFINER functions without pg_temp in search_path are vulnerable
-- to search path hijacking. An attacker could create a temp table shadowing a
-- real table and intercept queries. Adding pg_temp ensures temp schemas are
-- searched but placed LAST (after public), preventing this attack vector.
--
-- Strategy: Use ALTER FUNCTION ... SET search_path = public, pg_temp
-- This only changes the function config without touching the body — zero risk
-- of introducing bugs from function rewrites.
--
-- Scope: All public functions where search_path is set to 'public' without pg_temp,
-- OR where search_path is not set at all.

DO $$
DECLARE
  _rec RECORD;
  _fixed INT := 0;
  _skipped INT := 0;
  _current_path TEXT;
BEGIN
  -- Find all public functions that are SECURITY DEFINER
  -- and either have search_path = 'public' (without pg_temp)
  -- or have no search_path set at all
  FOR _rec IN
    SELECT p.oid,
           p.proname,
           pg_get_function_identity_arguments(p.oid) AS args,
           -- Get current search_path setting from proconfig
           (SELECT val FROM unnest(p.proconfig) AS val WHERE val LIKE 'search_path=%') AS sp_config
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
      AND p.prosecdef = true  -- SECURITY DEFINER only
    ORDER BY p.proname
  LOOP
    _current_path := _rec.sp_config;

    -- Skip if already has pg_temp
    IF _current_path IS NOT NULL AND _current_path LIKE '%pg_temp%' THEN
      _skipped := _skipped + 1;
      CONTINUE;
    END IF;

    -- Apply the fix: SET search_path = public, pg_temp
    EXECUTE format(
      'ALTER FUNCTION public.%I(%s) SET search_path = public, pg_temp',
      _rec.proname,
      _rec.args
    );

    _fixed := _fixed + 1;
    RAISE NOTICE 'Fixed: %(%)', _rec.proname, _rec.args;
  END LOOP;

  RAISE NOTICE '========================================';
  RAISE NOTICE 'pg_temp fix complete: % fixed, % already had pg_temp', _fixed, _skipped;
  RAISE NOTICE '========================================';
END $$;

-- Verification: No SECURITY DEFINER function should be missing pg_temp now
DO $$
DECLARE
  _count INT;
BEGIN
  SELECT count(*) INTO _count
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public'
    AND p.prosecdef = true
    AND NOT EXISTS (
      SELECT 1 FROM unnest(p.proconfig) AS val
      WHERE val LIKE '%pg_temp%'
    );

  IF _count > 0 THEN
    RAISE EXCEPTION 'VERIFICATION FAILED: % SECURITY DEFINER functions still missing pg_temp', _count;
  END IF;

  RAISE NOTICE 'VERIFICATION PASSED: All SECURITY DEFINER functions have pg_temp in search_path';
END $$;
