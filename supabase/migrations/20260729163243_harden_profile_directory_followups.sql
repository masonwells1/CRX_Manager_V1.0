-- Migration: harden profile-directory follow-ups
--
-- The directory is maintained only by the postgres-owned
-- sync_profile_public_directory() SECURITY DEFINER trigger. No application or
-- Edge Function writes this table directly, so service_role needs read access
-- only. This migration also replaces a duplicated active-profile predicate
-- with the canonical is_active_profile() helper so future deactivation-rule
-- changes cannot drift between policies.
--
-- No business rows are changed.

-- Policy and ACL DDL takes heavyweight relation locks. Fail closed instead of
-- waiting behind a long-running reader and queuing new staff-directory reads.
SET LOCAL lock_timeout = '5s';

DROP POLICY IF EXISTS profile_public_directory_authenticated_select
  ON public.profile_public_directory;
CREATE POLICY profile_public_directory_authenticated_select
  ON public.profile_public_directory
  FOR SELECT TO authenticated
  USING ((SELECT public.is_active_profile()));

-- Default privileges gave service_role every table/view privilege when these
-- objects were created. Keep the trusted backend's read compatibility while
-- removing every direct mutation and object-management route. The owner-run
-- trigger does not depend on caller table privileges.
REVOKE ALL ON TABLE public.profile_public_directory FROM service_role;
GRANT SELECT ON TABLE public.profile_public_directory TO service_role;

REVOKE ALL ON TABLE public.profile_public_view FROM service_role;
GRANT SELECT ON TABLE public.profile_public_view TO service_role;

-- Trigger execution does not require the triggering role to retain EXECUTE.
-- This is a trigger-only function and must not remain a callable API surface.
REVOKE ALL ON FUNCTION public.sync_profile_public_directory()
  FROM PUBLIC, anon, authenticated, service_role;

DO $$
DECLARE
  v_policy_qual text;
  v_directory_non_select text;
  v_view_non_select text;
BEGIN
  SELECT qual
    INTO v_policy_qual
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename = 'profile_public_directory'
     AND policyname = 'profile_public_directory_authenticated_select'
     AND permissive = 'PERMISSIVE'
     AND cmd = 'SELECT'
     AND 'authenticated' = ANY (roles);

  IF v_policy_qual IS NULL
     OR v_policy_qual NOT LIKE '%is_active_profile()%'
     OR v_policy_qual LIKE '%FROM profiles%' THEN
    RAISE EXCEPTION
      'PROFILE_PUBLIC_DIRECTORY_SHARED_ACTIVE_POLICY_MISSING: %',
      coalesce(v_policy_qual, '<missing>');
  END IF;

  IF NOT has_function_privilege(
           'authenticated',
           'public.is_active_profile()',
           'EXECUTE'
         )
     OR has_function_privilege(
          'anon',
          'public.is_active_profile()',
          'EXECUTE'
        ) THEN
    RAISE EXCEPTION 'PROFILE_PUBLIC_DIRECTORY_ACTIVE_HELPER_ACL_INVALID';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc AS p
      JOIN pg_namespace AS n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'is_active_profile'
       AND p.pronargs = 0
       AND p.prosecdef
       AND p.proconfig @> ARRAY['search_path=public, pg_temp']::text[]
  ) THEN
    RAISE EXCEPTION 'PROFILE_PUBLIC_DIRECTORY_ACTIVE_HELPER_NOT_HARDENED';
  END IF;

  SELECT string_agg(privilege_name, ', ' ORDER BY privilege_name)
    INTO v_directory_non_select
    FROM unnest(
      ARRAY[
        'INSERT',
        'UPDATE',
        'DELETE',
        'TRUNCATE',
        'REFERENCES',
        'TRIGGER',
        'MAINTAIN'
      ]
    ) AS privilege_name
   WHERE has_table_privilege(
           'service_role',
           'public.profile_public_directory',
           privilege_name
         );

  SELECT string_agg(privilege_name, ', ' ORDER BY privilege_name)
    INTO v_view_non_select
    FROM unnest(
      ARRAY[
        'INSERT',
        'UPDATE',
        'DELETE',
        'TRUNCATE',
        'REFERENCES',
        'TRIGGER',
        'MAINTAIN'
      ]
    ) AS privilege_name
   WHERE has_table_privilege(
           'service_role',
           'public.profile_public_view',
           privilege_name
         );

  IF NOT has_table_privilege(
           'service_role',
           'public.profile_public_directory',
           'SELECT'
         )
     OR NOT has_table_privilege(
              'service_role',
              'public.profile_public_view',
              'SELECT'
            )
     OR v_directory_non_select IS NOT NULL
     OR v_view_non_select IS NOT NULL THEN
    RAISE EXCEPTION
      'PROFILE_PUBLIC_DIRECTORY_SERVICE_ROLE_NOT_READ_ONLY: table=%, view=%',
      coalesce(v_directory_non_select, '<select-only>'),
      coalesce(v_view_non_select, '<select-only>');
  END IF;

  IF has_function_privilege(
       'service_role',
       'public.sync_profile_public_directory()',
       'EXECUTE'
     )
     OR has_function_privilege(
          'authenticated',
          'public.sync_profile_public_directory()',
          'EXECUTE'
        )
     OR has_function_privilege(
          'anon',
          'public.sync_profile_public_directory()',
          'EXECUTE'
        ) THEN
    RAISE EXCEPTION 'PROFILE_PUBLIC_DIRECTORY_TRIGGER_FUNCTION_EXECUTE_REMAINS';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_proc AS p
      JOIN pg_namespace AS n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'sync_profile_public_directory'
       AND p.pronargs = 0
       AND p.prorettype = 'trigger'::regtype
       AND p.prosecdef
       AND p.proconfig @> ARRAY['search_path=public, pg_temp']::text[]
  ) OR NOT EXISTS (
    SELECT 1
      FROM pg_trigger AS t
     WHERE t.tgrelid = 'public.profiles'::regclass
       AND t.tgname = 'trg_sync_profile_public_directory'
       AND t.tgenabled IN ('O', 'A')
       AND t.tgfoid = 'public.sync_profile_public_directory()'::regprocedure
  ) THEN
    RAISE EXCEPTION 'PROFILE_PUBLIC_DIRECTORY_OWNER_TRIGGER_LOST';
  END IF;

  IF (SELECT count(*) FROM public.profile_public_directory)
     <> (SELECT count(*) FROM public.profiles)
     OR EXISTS (
       SELECT 1
         FROM public.profiles AS p
         FULL JOIN public.profile_public_directory AS d USING (id)
        WHERE p.id IS NULL
           OR d.id IS NULL
           OR p.full_name IS DISTINCT FROM d.full_name
           OR p.role IS DISTINCT FROM d.role
           OR p.is_active IS DISTINCT FROM d.is_active
     ) THEN
    RAISE EXCEPTION 'PROFILE_PUBLIC_DIRECTORY_SYNC_DRIFT';
  END IF;
END;
$$;
