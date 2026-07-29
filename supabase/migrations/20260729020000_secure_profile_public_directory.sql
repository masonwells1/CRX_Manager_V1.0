-- Replace the SECURITY DEFINER profile directory view with a caller-permission
-- view over a deliberately non-sensitive directory table.  The existing
-- profiles policy allows administrators and a user themself to read profiles;
-- pointing a security-invoker view directly at profiles would therefore break
-- every non-admin name/assignment picker.

-- full_name/role/is_active are NOT NULL to match both the source columns and the
-- `ProfilePublic` contract in src/types/index.ts, which declares all three non-null.
-- Verified live 2026-07-29: all three are attnotnull on public.profiles with zero
-- NULL rows, so the sync trigger below can never produce a NULL and be rejected.
--
-- Deliberately NOT mirroring `profiles_role_check` here.  `role` only ever arrives
-- from public.profiles, which already enforces that CHECK, so a copy could never
-- reject a value the source accepted -- it would add no protection while creating a
-- drift hazard: widening the role list on profiles alone would make this table
-- reject the sync and block every profile write.
CREATE TABLE IF NOT EXISTS public.profile_public_directory (
  id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  full_name text NOT NULL,
  role text NOT NULL,
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
-- never apply to it.  This directory holds only id/full_name/role/is_active.
--
-- Be precise about where metabase_ro's current read actually comes from, because
-- the obvious answer is wrong: it is NOT reading public.profiles directly.  It
-- holds SELECT on profiles, but `profiles_select` has no TO clause, so it applies
-- to metabase_ro too, and its `is_admin() OR id = auth.uid()` predicate matches
-- nothing for a NOLOGIN role with no auth.uid() -- zero rows.  What metabase_ro
-- reads today is this view, under the definer semantics this migration removes.
-- So the policy below is not a convenience restating an existing privilege; it is
-- what keeps Metabase working at all once the view becomes security_invoker.
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

-- `authenticated` and `metabase_ro` are named here deliberately, not just PUBLIC
-- and anon.  CREATE OR REPLACE VIEW keeps the existing ACL, and the live ACL on
-- this view is `authenticated=arwdDxtm/postgres` -- INSERT, UPDATE, DELETE and
-- TRUNCATE included, inherited from the ALTER DEFAULT PRIVILEGES ... ON TABLES
-- grants in the ACL baseline (default privileges cover views, not just tables).
-- Granting SELECT does not remove them, so a REVOKE that skips `authenticated`
-- leaves a fully auto-updatable write path standing.  Verified live 2026-07-29
-- before this change: has_table_privilege('authenticated', view, 'DELETE') was
-- true and pg_relation_is_updatable returned 28 (UPDATE|INSERT|DELETE).
REVOKE ALL ON public.profile_public_view FROM PUBLIC, anon, authenticated, metabase_ro;
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

  -- Same assertion for the view itself.  security_invoker = true already forces
  -- base-table permission checks onto the caller, so the grants above are not
  -- individually exploitable once both hold -- but the view is auto-updatable
  -- (single table, no joins or aggregates), so a stale write grant here plus any
  -- future loss of security_invoker re-opens an RLS-bypassing write path.  Assert
  -- both independently rather than letting either one carry the other.
  SELECT string_agg(p, ', ' ORDER BY p) INTO v_writes
  FROM unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p
  WHERE has_table_privilege('authenticated', 'public.profile_public_view', p);

  IF v_writes IS NOT NULL THEN
    RAISE EXCEPTION 'PROFILE_PUBLIC_VIEW_AUTHENTICATED_WRITE_REMAINS: %', v_writes;
  END IF;

  -- Every read path here is RLS-filtered, so RLS being ON is what makes the
  -- authenticated/metabase_ro split mean anything.  If a later rework drops it,
  -- authenticated's SELECT grant silently becomes an unfiltered read available to
  -- deactivated users -- exactly what broad_reads_require_active_profile and
  -- deactivation_revokes_auth_access were written to prevent -- and every other
  -- assertion in this block would still pass.  Assert it directly.
  IF NOT (SELECT relrowsecurity FROM pg_class
          WHERE oid = 'public.profile_public_directory'::regclass) THEN
    RAISE EXCEPTION 'PROFILE_PUBLIC_DIRECTORY_RLS_DISABLED';
  END IF;

  -- The backfill is the whole directory; the view is the only source for every
  -- staff picker in the app.  If the INSERT ... SELECT silently moved no rows, or
  -- the authenticated read policy failed to create, all the privilege assertions
  -- above still pass and the migration reports success while every picker in the
  -- UI goes empty.  Assert the outcome, not just the permissions.
  IF (SELECT count(*) FROM public.profile_public_directory)
     <> (SELECT count(*) FROM public.profiles) THEN
    RAISE EXCEPTION 'PROFILE_PUBLIC_DIRECTORY_BACKFILL_INCOMPLETE: % of % profiles',
      (SELECT count(*) FROM public.profile_public_directory),
      (SELECT count(*) FROM public.profiles);
  END IF;

  -- Reading needs BOTH a grant and a policy, so both are asserted.  The REVOKE ALL
  -- above strips `authenticated` down to nothing before the GRANT SELECT re-adds it;
  -- if that GRANT were ever dropped, the policy below would still exist and this
  -- check would pass while every staff picker in the app silently went empty.  The
  -- view is checked too -- it is the object the app actually selects from.
  IF NOT has_table_privilege('authenticated', 'public.profile_public_directory', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.profile_public_view', 'SELECT')
     OR NOT EXISTS (
          SELECT 1 FROM pg_policies
          WHERE schemaname = 'public'
            AND tablename = 'profile_public_directory'
            AND policyname = 'profile_public_directory_authenticated_select'
            AND permissive = 'PERMISSIVE'
            AND cmd = 'SELECT'
            AND 'authenticated' = ANY (roles)
        ) THEN
    RAISE EXCEPTION 'PROFILE_PUBLIC_DIRECTORY_AUTHENTICATED_READ_LOST';
  END IF;

  -- Analytics must still be able to read through the now-invoker view.  A grant
  -- without a matching policy yields zero rows, so the policy is load-bearing and
  -- checked alongside the ACL.  permissive/cmd are pinned too: a RESTRICTIVE
  -- policy, or one scoped to the wrong command, would carry the same name while
  -- metabase_ro still read nothing.
  IF NOT has_table_privilege('metabase_ro', 'public.profile_public_directory', 'SELECT')
     OR NOT has_table_privilege('metabase_ro', 'public.profile_public_view', 'SELECT')
     OR NOT EXISTS (
          SELECT 1 FROM pg_policies
          WHERE schemaname = 'public'
            AND tablename = 'profile_public_directory'
            AND policyname = 'profile_public_directory_analytics_select'
            AND permissive = 'PERMISSIVE'
            AND cmd = 'SELECT'
            AND 'metabase_ro' = ANY (roles)
        ) THEN
    RAISE EXCEPTION 'PROFILE_PUBLIC_DIRECTORY_ANALYTICS_READ_LOST';
  END IF;
END;
$$;
