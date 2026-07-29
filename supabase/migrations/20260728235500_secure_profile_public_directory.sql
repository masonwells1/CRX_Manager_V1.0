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

-- `authenticated` and `metabase_ro` must be named explicitly, not just PUBLIC and
-- anon.  The ACL baseline (supabase/baselines/20260727174805_acl_lockdown.sql)
-- re-grants default privileges on every new table in public: `authenticated` gets
-- DELETE, INSERT, TRUNCATE, UPDATE (and more), `metabase_ro` gets SELECT.  Those
-- arrive independently of any grant here, so a REVOKE that names only PUBLIC and
-- anon leaves them standing.  TRUNCATE matters most: PostgreSQL does not apply RLS
-- to it, so the read-only policies below would not stop a signed-in caller from
-- emptying the directory and blanking every staff picker in the app.
REVOKE ALL ON TABLE public.profile_public_directory
  FROM PUBLIC, anon, authenticated, metabase_ro;
GRANT SELECT ON TABLE public.profile_public_directory TO authenticated;
-- Analytics keeps the read it already had: the baseline grants metabase_ro SELECT
-- on public.profile_public_view (line 453) and on public.profiles (line 457).  The
-- view becomes security_invoker below, so without this grant plus the policy that
-- follows, metabase_ro would satisfy the view but see zero rows through it.
GRANT SELECT ON TABLE public.profile_public_directory TO metabase_ro;

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

-- metabase_ro is NOBYPASSRLS and is a member of no role, so the policy above can
-- never apply to it.  This directory holds only id/full_name/role/is_active, and
-- metabase_ro already reads public.profiles itself, so a full read here grants it
-- nothing it did not already have.
DROP POLICY IF EXISTS profile_public_directory_analytics_select
  ON public.profile_public_directory;
CREATE POLICY profile_public_directory_analytics_select
  ON public.profile_public_directory
  FOR SELECT TO metabase_ro
  USING (true);

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

-- The trigger is installed BEFORE the backfill, not after.  Backfilling first
-- leaves a window: a profile written after the INSERT ... SELECT takes its
-- snapshot but before the trigger exists is captured stale by the backfill and
-- fires no trigger, so the directory would serve an out-of-date name, role, or
-- active flag indefinitely -- until that profile happened to change again.
-- CREATE TRIGGER takes SHARE ROW EXCLUSIVE on public.profiles and holds it to
-- commit, so once it runs no concurrent writer can slip past the backfill below.
DROP TRIGGER IF EXISTS trg_sync_profile_public_directory ON public.profiles;
CREATE TRIGGER trg_sync_profile_public_directory
AFTER INSERT OR UPDATE OF full_name, role, is_active OR DELETE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.sync_profile_public_directory();

INSERT INTO public.profile_public_directory (id, full_name, role, is_active)
SELECT id, full_name, role, is_active
FROM public.profiles
ON CONFLICT (id) DO UPDATE
SET full_name = EXCLUDED.full_name,
    role = EXCLUDED.role,
    is_active = EXCLUDED.is_active;

CREATE OR REPLACE VIEW public.profile_public_view AS
SELECT id, full_name, role, is_active
FROM public.profile_public_directory;

ALTER VIEW public.profile_public_view
  SET (security_invoker = true, security_barrier = false);

REVOKE ALL ON public.profile_public_view FROM PUBLIC, anon;
GRANT SELECT ON public.profile_public_view TO authenticated;
-- Restated rather than relied upon: CREATE OR REPLACE VIEW keeps the existing ACL
-- on live, but on a from-scratch replay this makes the analytics grant explicit
-- instead of inherited from whichever earlier migration first created the view.
GRANT SELECT ON public.profile_public_view TO metabase_ro;

COMMENT ON VIEW public.profile_public_view IS
  'Non-sensitive employee directory for signed-in active users. Uses security_invoker=true over profile_public_directory so it cannot bypass profiles RLS.';

DO $$
DECLARE
  v_security_invoker text;
  v_writes text;
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

  -- The directory is trigger-maintained and read-only to every client role.
  -- TRUNCATE is the one that is not covered by RLS, so assert it directly rather
  -- than trusting the policies to hold the line.
  SELECT string_agg(p, ', ' ORDER BY p) INTO v_writes
  FROM unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p
  WHERE has_table_privilege('authenticated', 'public.profile_public_directory', p);

  IF v_writes IS NOT NULL THEN
    RAISE EXCEPTION 'PROFILE_PUBLIC_DIRECTORY_AUTHENTICATED_WRITE_REMAINS: %', v_writes;
  END IF;

  -- Analytics must still be able to read through the now-invoker view.  A grant
  -- without a matching policy yields zero rows, so check the rows, not the ACL.
  IF NOT has_table_privilege('metabase_ro', 'public.profile_public_directory', 'SELECT')
     OR NOT has_table_privilege('metabase_ro', 'public.profile_public_view', 'SELECT')
     OR NOT EXISTS (
          SELECT 1 FROM pg_policies
          WHERE schemaname = 'public'
            AND tablename = 'profile_public_directory'
            AND policyname = 'profile_public_directory_analytics_select'
            AND 'metabase_ro' = ANY (roles)
        ) THEN
    RAISE EXCEPTION 'PROFILE_PUBLIC_DIRECTORY_ANALYTICS_READ_LOST';
  END IF;
END;
$$;
