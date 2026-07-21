-- Make the final sales-rep authorization helper self-contained and immune to
-- temporary-schema object shadowing, including for Storage RLS policy callers.
BEGIN;

CREATE OR REPLACE FUNCTION public.is_sales_rep()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id = (SELECT auth.uid())
      AND role = 'sales_rep'
      AND is_active = true
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.is_sales_rep() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_sales_rep() TO authenticated, service_role;

DO $postflight$
DECLARE
  v_config text[];
  v_source text;
BEGIN
  SELECT p.proconfig, p.prosrc
  INTO v_config, v_source
  FROM pg_proc p
  WHERE p.oid = 'public.is_sales_rep()'::regprocedure;

  IF v_config IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[] THEN
    RAISE EXCEPTION 'POSTFLIGHT: is_sales_rep search_path is not public, pg_temp: %', v_config;
  END IF;

  IF position('FROM public.profiles' IN v_source) = 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT: is_sales_rep does not qualify public.profiles';
  END IF;

  -- anon inherits PUBLIC privileges, so false proves both lanes are closed.
  IF has_function_privilege('anon', 'public.is_sales_rep()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.is_sales_rep()', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.is_sales_rep()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT: is_sales_rep EXECUTE grants are not least-privilege';
  END IF;
END;
$postflight$;

COMMIT;
