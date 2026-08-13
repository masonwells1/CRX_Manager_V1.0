-- predicate: quote-version-restore-quarantine
-- Installed atomically by 20260813080000. Before quote_versions became RPC-owned, a
-- browser could author plausible snapshot money that no heuristic can prove
-- came from the server. Those rows remain readable history but may never reach
-- the authoritative restore path.
-- Contract: EXPECT ZERO rows.

SELECT 'quote-version-quarantine:relation-missing' AS violation_key,
       'public.quote_version_restore_quarantine is missing; pre-RPC-owned snapshots are restorable again' AS reason
 WHERE to_regclass('public.quote_version_restore_quarantine') IS NULL

UNION ALL

SELECT 'quote-version-quarantine:table-boundary-drifted' AS violation_key,
       'the quarantine table must keep RLS enabled+forced, no policies, and no API-role privilege' AS reason
 WHERE CASE
   WHEN to_regclass('public.quote_version_restore_quarantine') IS NULL THEN false
   ELSE NOT EXISTS (
          SELECT 1
          FROM pg_class c
          WHERE c.oid = 'public.quote_version_restore_quarantine'::regclass
            AND c.relrowsecurity
            AND c.relforcerowsecurity
            AND c.relowner = 'postgres'::regrole
        )
     OR EXISTS (
          SELECT 1 FROM pg_policies
          WHERE schemaname = 'public'
            AND tablename = 'quote_version_restore_quarantine'
        )
     OR EXISTS (
          SELECT 1
          FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) role_name
          CROSS JOIN unnest(ARRAY[
            'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES'
          ]) privilege_name
          WHERE has_table_privilege(
            role_name,
            'public.quote_version_restore_quarantine',
            privilege_name
          )
        )
 END

UNION ALL

SELECT 'quote-version-quarantine:immutability-guard-drifted' AS violation_key,
       'the quarantine population must not be updateable or removable after the complete legacy set is captured' AS reason
 WHERE CASE
   WHEN to_regclass('public.quote_version_restore_quarantine') IS NULL THEN false
   WHEN to_regprocedure('public._guard_quote_version_restore_quarantine_immutable()') IS NULL THEN true
   ELSE NOT EXISTS (
          SELECT 1
          FROM pg_trigger t
          WHERE t.tgrelid = 'public.quote_version_restore_quarantine'::regclass
            AND t.tgname = 'guard_quote_version_restore_quarantine_immutable'
            AND t.tgfoid = 'public._guard_quote_version_restore_quarantine_immutable()'::regprocedure
            AND t.tgenabled IN ('O', 'A')
            AND NOT t.tgisinternal
        )
     OR has_function_privilege(
          'anon', 'public._guard_quote_version_restore_quarantine_immutable()', 'EXECUTE')
     OR has_function_privilege(
          'authenticated', 'public._guard_quote_version_restore_quarantine_immutable()', 'EXECUTE')
     OR has_function_privilege(
          'service_role', 'public._guard_quote_version_restore_quarantine_immutable()', 'EXECUTE')
     OR NOT EXISTS (
          SELECT 1
          FROM pg_proc p
          WHERE p.oid = 'public._guard_quote_version_restore_quarantine_immutable()'::regprocedure
            AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
            AND position('QUOTE_VERSION_RESTORE_QUARANTINE_IMMUTABLE' in p.prosrc) > 0
        )
 END

UNION ALL

SELECT 'quote-version-quarantine:restore-wrapper-drifted' AS violation_key,
       'restore_quote_version must reject quarantined ids before delegating to the authoritative restore implementation' AS reason
 WHERE CASE
   WHEN to_regprocedure('public.restore_quote_version(uuid,uuid,uuid,text,bigint,text)') IS NULL THEN true
   ELSE NOT EXISTS (
          SELECT 1
          FROM pg_proc p
          WHERE p.oid = 'public.restore_quote_version(uuid,uuid,uuid,text,bigint,text)'::regprocedure
            AND p.prosecdef
            AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
            AND position('quote_version_restore_quarantine' in p.prosrc) > 0
            AND position('QUOTE_VERSION_RESTORE_QUARANTINED' in p.prosrc) > 0
            AND position('quote_version_restore_quarantine' in p.prosrc)
              < position('_restore_quote_version_below_cost_impl_20260810' in p.prosrc)
        )
 END;
