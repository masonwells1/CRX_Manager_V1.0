-- Harden the canonical active-admin helper used by RLS policies and admin RPCs.
--
-- The helper already required role='admin' and is_active=true. Re-emitting it
-- here keeps that behavior while aligning the SECURITY DEFINER search_path with
-- CRX's public, pg_temp standard and qualifying the profiles table reference.

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
      FROM public.profiles
     WHERE id = (SELECT auth.uid())
       AND role = 'admin'
       AND is_active = true
  );
END;
$$;

DO $$
DECLARE
  v_search_path text[];
  v_source text;
BEGIN
  SELECT p.proconfig,
         p.prosrc
    INTO v_search_path,
         v_source
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'is_admin'
     AND p.proargtypes = ''::oidvector;

  IF v_search_path IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] THEN
    RAISE EXCEPTION 'is_admin() must use SET search_path = public, pg_temp';
  END IF;

  IF v_source !~* 'FROM\s+public\.profiles'
     OR v_source !~* 'is_active\s*=\s*true'
     OR v_source !~* 'role\s*=\s*''admin''' THEN
    RAISE EXCEPTION
      'is_admin() must remain active-admin only and reference public.profiles';
  END IF;
END;
$$;
