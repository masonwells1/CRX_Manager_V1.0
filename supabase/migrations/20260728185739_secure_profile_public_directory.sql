-- Replace the SECURITY DEFINER profile directory view with a caller-permission
-- view over a deliberately non-sensitive directory table.  The existing
-- profiles policy allows administrators and a user themself to read profiles;
-- pointing a security-invoker view directly at profiles would therefore break
-- every non-admin name/assignment picker.

CREATE TABLE IF NOT EXISTS public.profile_public_directory (
  id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  full_name text,
  role text,
  is_active boolean NOT NULL DEFAULT true
);

ALTER TABLE public.profile_public_directory ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.profile_public_directory FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.profile_public_directory TO authenticated;

DROP POLICY IF EXISTS profile_public_directory_authenticated_select
  ON public.profile_public_directory;
CREATE POLICY profile_public_directory_authenticated_select
  ON public.profile_public_directory
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.profiles AS current_profile
      WHERE current_profile.id = (SELECT auth.uid())
        AND current_profile.is_active = true
    )
  );

INSERT INTO public.profile_public_directory (id, full_name, role, is_active)
SELECT id, full_name, role, is_active
FROM public.profiles
ON CONFLICT (id) DO UPDATE
SET full_name = EXCLUDED.full_name,
    role = EXCLUDED.role,
    is_active = EXCLUDED.is_active;

CREATE OR REPLACE FUNCTION public.sync_profile_public_directory()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.profile_public_directory WHERE id = OLD.id;
    RETURN OLD;
  END IF;

  INSERT INTO public.profile_public_directory (id, full_name, role, is_active)
  VALUES (NEW.id, NEW.full_name, NEW.role, NEW.is_active)
  ON CONFLICT (id) DO UPDATE
  SET full_name = EXCLUDED.full_name,
      role = EXCLUDED.role,
      is_active = EXCLUDED.is_active;

  RETURN NEW;
END;
$$;

-- caller-analysis: trigger-only profile-directory synchronizer; no RPC callers.
REVOKE ALL ON FUNCTION public.sync_profile_public_directory() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_sync_profile_public_directory ON public.profiles;
CREATE TRIGGER trg_sync_profile_public_directory
AFTER INSERT OR UPDATE OF full_name, role, is_active OR DELETE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.sync_profile_public_directory();

CREATE OR REPLACE VIEW public.profile_public_view AS
SELECT id, full_name, role, is_active
FROM public.profile_public_directory;

ALTER VIEW public.profile_public_view
  SET (security_invoker = true, security_barrier = false);

REVOKE ALL ON public.profile_public_view FROM PUBLIC, anon;
GRANT SELECT ON public.profile_public_view TO authenticated;

COMMENT ON VIEW public.profile_public_view IS
  'Non-sensitive employee directory for signed-in active users. Uses security_invoker=true over profile_public_directory so it cannot bypass profiles RLS.';

DO $$
DECLARE
  v_security_invoker text;
BEGIN
  SELECT option_value INTO v_security_invoker
  FROM pg_options_to_table((SELECT reloptions FROM pg_class WHERE oid = 'public.profile_public_view'::regclass))
  WHERE option_name = 'security_invoker';

  IF v_security_invoker IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'PROFILE_PUBLIC_VIEW_NOT_SECURITY_INVOKER';
  END IF;

  IF has_table_privilege('anon', 'public.profile_public_view', 'SELECT')
     OR has_table_privilege('anon', 'public.profile_public_directory', 'SELECT')
     OR has_function_privilege('anon', 'public.sync_profile_public_directory()', 'EXECUTE') THEN
    RAISE EXCEPTION 'PROFILE_PUBLIC_DIRECTORY_ANON_ACCESS_REMAINS';
  END IF;
END;
$$;
